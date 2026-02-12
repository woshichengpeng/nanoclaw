import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  pendingMessages: boolean;
  pendingTasks: Array<{ taskId: string; fn: () => Promise<void> }>;
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((chatJid: string) => Promise<void>) | null = null;
  private shuttingDown = false;

  private getOrCreate(chatJid: string): GroupState {
    if (!this.groups.has(chatJid)) {
      this.groups.set(chatJid, {
        active: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0
      });
    }
    return this.groups.get(chatJid)!;
  }

  setProcessMessagesFn(fn: (chatJid: string) => Promise<void>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(chatJid: string): void {
    if (this.shuttingDown) return;
    const state = this.getOrCreate(chatJid);
    state.pendingMessages = true;
    if (!state.active) {
      this.scheduleGroup(chatJid);
    }
  }

  enqueueTask(chatJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;
    const state = this.getOrCreate(chatJid);
    state.pendingTasks.push({ taskId, fn });
    if (!state.active) {
      this.scheduleGroup(chatJid);
    } else {
      // Close the active streaming container so the task can run
      logger.info({ chatJid, taskId }, 'Closing active container to run pending task');
      this.closeStdin(chatJid);
    }
  }

  sendMessage(chatJid: string, text: string): boolean {
    const state = this.groups.get(chatJid);
    if (!state?.active || !state.groupFolder) return false;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      const filePath = path.join(inputDir, filename);
      const tempPath = `${filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ prompt: text }));
      fs.renameSync(tempPath, filePath);
      logger.debug({ chatJid, filename }, 'Piped message to active container');
      return true;
    } catch (err) {
      logger.error({ chatJid, err }, 'Failed to pipe message to container');
      return false;
    }
  }

  closeStdin(chatJid: string): void {
    const state = this.groups.get(chatJid);
    if (!state?.groupFolder) return;

    const closePath = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input', '_close');
    try {
      fs.writeFileSync(closePath, '');
      logger.debug({ chatJid }, 'Wrote _close sentinel');
    } catch (err) {
      logger.error({ chatJid, err }, 'Failed to write _close sentinel');
    }
  }

  registerProcess(chatJid: string, proc: ChildProcess, containerName: string, groupFolder: string): void {
    const state = this.getOrCreate(chatJid);
    state.process = proc;
    state.containerName = containerName;
    state.groupFolder = groupFolder;
    logger.debug({ chatJid, containerName }, 'Container process registered');
  }

  isActive(chatJid: string): boolean {
    return this.groups.get(chatJid)?.active || false;
  }

  private scheduleGroup(chatJid: string): void {
    if (this.activeCount < MAX_CONCURRENT_CONTAINERS) {
      this.drainGroup(chatJid);
    } else if (!this.waitingGroups.includes(chatJid)) {
      this.waitingGroups.push(chatJid);
      logger.debug({ chatJid, waiting: this.waitingGroups.length }, 'Group queued (at capacity)');
    }
  }

  private async drainGroup(chatJid: string): Promise<void> {
    const state = this.getOrCreate(chatJid);
    if (state.active) return;

    state.active = true;
    this.activeCount++;
    logger.debug({ chatJid, activeCount: this.activeCount }, 'Starting group drain');

    if (state.groupFolder) {
      const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
      this.cleanIpcInputDir(inputDir);
    }

    try {
      while (state.pendingTasks.length > 0 || state.pendingMessages) {
        if (this.shuttingDown) break;

        while (state.pendingTasks.length > 0) {
          const task = state.pendingTasks.shift()!;
          try {
            await task.fn();
            state.retryCount = 0;
          } catch (err) {
            logger.error({ chatJid, taskId: task.taskId, err }, 'Task execution failed');
            state.retryCount++;
            if (state.retryCount < MAX_RETRIES) {
              const delay = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
              logger.warn({ chatJid, retry: state.retryCount, delayMs: delay }, 'Will retry after delay');
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        }

        if (state.pendingMessages && this.processMessagesFn) {
          state.pendingMessages = false;
          try {
            await this.processMessagesFn(chatJid);
            state.retryCount = 0;
          } catch (err) {
            logger.error({ chatJid, err }, 'Message processing failed');
            state.retryCount++;
            if (state.retryCount < MAX_RETRIES) {
              const delay = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
              logger.warn({ chatJid, retry: state.retryCount, delayMs: delay }, 'Will retry after delay');
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        }
      }
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      this.activeCount--;
      logger.debug({ chatJid, activeCount: this.activeCount }, 'Group drain complete');

      this.drainWaiting();
    }
  }

  private drainWaiting(): void {
    while (this.waitingGroups.length > 0 && this.activeCount < MAX_CONCURRENT_CONTAINERS) {
      const nextJid = this.waitingGroups.shift()!;
      const nextState = this.groups.get(nextJid);
      if (nextState && (nextState.pendingMessages || nextState.pendingTasks.length > 0)) {
        this.drainGroup(nextJid);
      }
    }
  }

  private cleanIpcInputDir(inputDir: string): void {
    try {
      if (!fs.existsSync(inputDir)) return;
      const files = fs.readdirSync(inputDir);
      for (const file of files) {
        try { fs.unlinkSync(path.join(inputDir, file)); } catch {}
      }
    } catch {}
  }

  async shutdown(timeoutMs: number = 10000): Promise<void> {
    this.shuttingDown = true;
    logger.info({ activeCount: this.activeCount }, 'GroupQueue shutting down');

    for (const [chatJid, state] of this.groups) {
      if (state.active) {
        this.closeStdin(chatJid);
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (this.activeCount > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (this.activeCount > 0) {
      logger.warn({ remaining: this.activeCount }, 'Shutdown timeout, some containers still active');
    }
  }
}
