import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { getDueTasks, updateTaskAfterRun, logTaskRun, getTaskById, getAllTasks } from './db.js';
import { ScheduledTask, RegisteredGroup, Session } from './types.js';
import {
  ASSISTANT_NAME,
  GROUPS_DIR,
  MAIN_GROUP_FOLDER,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
  DEFAULT_MODEL,
  getModelOverride,
  getThinkingLevelOverride,
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
  processIpcMessages: (groupFolder: string, isMain: boolean) => Promise<string[]>;
  assistantName: string;
  registerIdleResetter?: (groupJid: string, resetFn: () => void) => void;
  unregisterIdleResetter?: (groupJid: string) => void;
}

function normalizeModelSpec(model?: string): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'claude' || trimmed === 'codex') return undefined;
  return trimmed;
}

function getGroupModel(group: RegisteredGroup): string | undefined {
  return normalizeModelSpec(group.agent) || getModelOverride() || DEFAULT_MODEL || undefined;
}

function getSession(sessions: Session, sessionKey: string): string | undefined {
  return sessions[sessionKey];
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
  const model = getGroupModel(group);
  const thinkingLevel = getThinkingLevelOverride() || undefined;
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
    ? getSession(sessions, task.chat_jid)
    : undefined;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => deps.queue.closeStdin(task.chat_jid), IDLE_TIMEOUT);
  };
  resetIdleTimer();

  // Register so piped messages can reset the idle timer during task execution
  if (deps.registerIdleResetter) deps.registerIdleResetter(task.chat_jid, resetIdleTimer);

  try {
    const output = await runContainerAgent(group, {
      prompt: task.prompt,
      sessionId,
      groupFolder: task.group_folder,
      chatJid: task.chat_jid,
      isMain,
      isScheduledTask: true,
      model,
      thinkingLevel
    },
    (proc, name) => deps.onProcess(task.chat_jid, proc, name, task.group_folder),
    async (streamedOutput) => {
      // Process IPC messages inline during streaming (send_message tool calls)
      await deps.processIpcMessages(task.group_folder, isMain);

      if (streamedOutput.result?.outputType === 'message' && streamedOutput.result?.userMessage) {
        await deps.sendMessage(task.chat_jid, `${deps.assistantName}: ${streamedOutput.result.userMessage}`);
      }
      if (streamedOutput.result) resetIdleTimer();
    });

    if (idleTimer) clearTimeout(idleTimer);

    // Process any remaining IPC messages after container completes
    await deps.processIpcMessages(task.group_folder, isMain);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    }
    // Results were already sent via streaming callback, just log
    result = 'Streamed';

    logger.info({ taskId: task.id, durationMs: Date.now() - startTime }, 'Task completed');
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (deps.unregisterIdleResetter) deps.unregisterIdleResetter(task.chat_jid);
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

  // Track tasks that are already enqueued or running to avoid duplicate execution
  const inflightTasks = new Set<string>();

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Skip tasks already enqueued or running
        if (inflightTasks.has(task.id)) {
          logger.debug({ taskId: task.id }, 'Task already in-flight, skipping');
          continue;
        }

        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        inflightTasks.add(currentTask.id);
        const taskId = currentTask.id;
        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, async () => {
          try {
            await runTask(currentTask, deps);
          } finally {
            inflightTasks.delete(taskId);
          }
        });
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}
