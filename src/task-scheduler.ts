import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { getDueTasks, updateTaskAfterRun, logTaskRun, getTaskById, getAllTasks } from './db.js';
import { ScheduledTask, RegisteredGroup, AgentType, Session } from './types.js';
import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  DATA_DIR,
  TIMEZONE,
  DEFAULT_AGENT,
  IDLE_TIMEOUT,
} from './config.js';
import { runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Session;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  assistantName: string;
}

function normalizeAgent(agent?: string): AgentType {
  if (agent === 'claude' || agent === 'codex') return agent;
  return DEFAULT_AGENT === 'codex' ? 'codex' : 'claude';
}

function getSessionForAgent(sessions: Session, sessionKey: string, agent: AgentType): string | undefined {
  const entry = sessions[sessionKey];
  if (!entry) return undefined;
  if (typeof entry === 'string') {
    return agent === 'claude' ? entry : undefined;
  }
  return entry[agent];
}

async function runTask(task: ScheduledTask, deps: SchedulerDependencies): Promise<void> {
  const startTime = Date.now();
  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info({ taskId: task.id, group: task.group_folder }, 'Running scheduled task');

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(g => g.folder === task.group_folder);

  if (!group) {
    logger.error({ taskId: task.id, groupFolder: task.group_folder }, 'Group not found for task');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const agent = normalizeAgent(group.agent);
  const tasks = getAllTasks();
  writeTasksSnapshot(task.group_folder, isMain, tasks.map(t => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run
  })));

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the chat's current session
  const sessions = deps.getSessions();
  const sessionId = task.context_mode === 'group'
    ? getSessionForAgent(sessions, task.chat_jid, agent)
    : undefined;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => deps.queue.closeStdin(task.chat_jid), IDLE_TIMEOUT);
  };
  resetIdleTimer();

  try {
    const output = await runContainerAgent(group, {
      prompt: task.prompt,
      sessionId,
      groupFolder: task.group_folder,
      chatJid: task.chat_jid,
      isMain,
      isScheduledTask: true,
      agent
    },
    (proc, name) => deps.onProcess(task.chat_jid, proc, name, task.group_folder),
    async (streamedOutput) => {
      if (streamedOutput.result?.outputType === 'message' && streamedOutput.result?.userMessage) {
        await deps.sendMessage(task.chat_jid, `${deps.assistantName}: ${streamedOutput.result.userMessage}`);
      }
      if (streamedOutput.result) resetIdleTimer();
    });

    if (idleTimer) clearTimeout(idleTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    }
    // Results were already sent via streaming callback, just log
    result = 'Streamed';

    logger.info({ taskId: task.id, durationMs: Date.now() - startTime }, 'Task completed');
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error
  });

  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  // 'once' tasks have no next run

  const resultSummary = error ? `Error: ${error}` : (result ? result.slice(0, 200) : 'Completed');
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () => runTask(currentTask, deps));
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
