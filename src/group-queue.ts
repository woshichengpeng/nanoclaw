import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<void>) | null = null;
  private onMessagePipedFn: ((groupJid: string) => void) | null = null;
  private onContainerDoneFn: ((groupJid: string, hadUnconsumedInput: boolean) => void) | null = null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<void>): void {
    this.processMessagesFn = fn;
  }

  setOnMessagePipedFn(fn: (groupJid: string) => void): void {
    this.onMessagePipedFn = fn;
  }

  setOnContainerDoneFn(fn: (groupJid: string, hadUnconsumedInput: boolean) => void): void {
    this.onContainerDoneFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages');
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing of the same task
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn });
  }

  registerProcess(groupJid: string, proc: ChildProcess, containerName: string, groupFolder?: string): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return false;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ prompt: text }));
      // Remove close sentinel FIRST — before placing the new message atomically
      const closeSentinel = path.join(inputDir, '_close');
      try { fs.unlinkSync(closeSentinel); } catch {}
      fs.renameSync(tempPath, filepath);
      logger.debug({ groupJid, filename }, 'Piped message to active container');
      if (this.onMessagePipedFn) this.onMessagePipedFn(groupJid);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        await this.processMessagesFn(groupJid);
        state.retryCount = 0;
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      const folder = state.groupFolder;
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;

      // Safety net: if IPC input files remain unconsumed, mark messages as pending
      let hadUnconsumed = false;
      if (folder) {
        hadUnconsumed = this.checkUnconsumedInput(groupJid, folder);
      }

      // Notify host after cleanup — cursor advancement decisions happen here
      if (this.onContainerDoneFn) {
        this.onContainerDoneFn(groupJid, hadUnconsumed);
      }

      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      const folder = state.groupFolder;
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;

      // Safety net: if IPC input files remain unconsumed, mark messages as pending
      let hadUnconsumed = false;
      if (folder) {
        hadUnconsumed = this.checkUnconsumedInput(groupJid, folder);
      }

      // Notify host — clears any stale lastContainerResult from previous message runs
      if (this.onContainerDoneFn) {
        this.onContainerDoneFn(groupJid, hadUnconsumed);
      }

      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  /**
   * Check if IPC input files remain unconsumed after a container exits.
   * If so, clean them up and mark messages as pending for reprocessing.
   */
  private checkUnconsumedInput(groupJid: string, groupFolder: string): boolean {
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      let allFiles: string[];
      try {
        allFiles = fs.readdirSync(inputDir);
      } catch {
        return false; // Directory doesn't exist
      }

      const jsonFiles = allFiles.filter(f => f.endsWith('.json'));
      const tmpFiles = allFiles.filter(f => f.endsWith('.tmp'));

      // Always clean up close sentinel
      const closeSentinel = path.join(inputDir, '_close');
      try { fs.unlinkSync(closeSentinel); } catch {}

      // Clean up any orphaned .tmp files
      for (const f of tmpFiles) {
        try { fs.unlinkSync(path.join(inputDir, f)); } catch {}
      }

      if (jsonFiles.length > 0) {
        logger.warn(
          { groupJid, groupFolder, count: jsonFiles.length },
          'Unconsumed IPC input files found after container exit, re-enqueuing',
        );
        // Clean up stale input files — these are duplicates of DB content;
        // the reprocessed prompt will re-read from the DB using lastAgentTimestamp
        for (const f of jsonFiles) {
          try { fs.unlinkSync(path.join(inputDir, f)); } catch {}
        }

        // Mark messages as pending so drainGroup will reprocess
        const state = this.getGroup(groupJid);
        state.pendingMessages = true;
        return true;
      }
    } catch (err) {
      logger.debug({ groupJid, err }, 'Error checking unconsumed IPC input');
    }
    return false;
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task);
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain');
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task);
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain');
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number = 10000): Promise<void> {
    this.shuttingDown = true;

    // Don't kill containers — they'll finish on their own via idle timeout
    // or container timeout. This prevents restart cycles from killing working agents.
    const activeContainers: string[] = [];
    for (const [_jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
