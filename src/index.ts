import 'dotenv/config';
import { Telegraf, Input } from 'telegraf';
import pino from 'pino';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  POLL_INTERVAL,
  STORE_DIR,
  DATA_DIR,
  TRIGGER_PATTERN,
  MAIN_GROUP_FOLDER,
  IPC_POLL_INTERVAL,
  TIMEZONE,
  CONTAINER_IMAGE,
  GROUPS_DIR
} from './config.js';
import { RegisteredGroup, Session, NewMessage } from './types.js';
import { initDatabase, storeMessage, storeChatMetadata, getNewMessages, getMessagesSince, getAllTasks, updateChatName, getAllChats } from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot, AvailableGroup } from './container-runner.js';
import { loadJson, saveJson } from './utils.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

const telegrafBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
let lastTimestamp = '';
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

// === Container Rebuild State ===
interface ContainerRebuildState {
  hasBackup: boolean;
  lastBackupTime?: string;
}

let containerRebuildState: ContainerRebuildState = { hasBackup: false };
const CONTAINER_STATE_PATH = path.join(DATA_DIR, 'container_state.json');

function loadContainerState(): void {
  containerRebuildState = loadJson<ContainerRebuildState>(CONTAINER_STATE_PATH, { hasBackup: false });
}

function saveContainerState(): void {
  saveJson(CONTAINER_STATE_PATH, containerRebuildState);
}

// Extract image name without tag from CONTAINER_IMAGE (e.g., "nanoclaw-agent:latest" -> "nanoclaw-agent")
function getContainerImageName(): string {
  return CONTAINER_IMAGE.split(':')[0];
}

function backupCurrentImage(): boolean {
  try {
    const imageName = getContainerImageName();
    execSync(`container image tag ${imageName}:latest ${imageName}:backup`, { stdio: 'pipe' });
    containerRebuildState = { hasBackup: true, lastBackupTime: new Date().toISOString() };
    saveContainerState();
    logger.info({ imageName }, 'Container image backed up to :backup tag');
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to backup container image');
    return false;
  }
}

function buildNewImage(): boolean {
  try {
    logger.info('Building new container image...');
    execSync('./container/build.sh', { cwd: process.cwd(), stdio: 'pipe', timeout: 300000 }); // 5 min timeout
    logger.info('Container image built successfully');
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to build container image');
    return false;
  }
}

function rollbackContainerImage(): boolean {
  if (!containerRebuildState.hasBackup) {
    logger.warn('No backup image available for rollback');
    return false;
  }
  try {
    const imageName = getContainerImageName();
    execSync(`container image tag ${imageName}:backup ${imageName}:latest`, { stdio: 'pipe' });
    logger.info({ imageName }, 'Container image rolled back to :backup');
    return true;
  } catch (err) {
    logger.error({ err }, 'Failed to rollback container image');
    return false;
  }
}

async function handleContainerRebuild(sourceGroup: string): Promise<void> {
  logger.info({ sourceGroup }, 'Container rebuild requested');

  // Find the chat JID for the main group to send notifications
  const mainJid = Object.entries(registeredGroups).find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];

  // 1. Backup current :latest to :backup
  if (!backupCurrentImage()) {
    if (mainJid) {
      await sendMessage(mainJid, '❌ Container rebuild failed: Could not backup current image.');
    }
    return;
  }

  // 2. Build new image
  if (!buildNewImage()) {
    logger.warn('Build failed, rolling back to backup image...');
    rollbackContainerImage();
    if (mainJid) {
      await sendMessage(mainJid, '❌ Container rebuild failed: Build error. Rolled back to previous image.');
    }
    return;
  }

  // 3. Success - notify and restart
  if (mainJid) {
    await sendMessage(mainJid, '✅ Container rebuilt successfully. Restarting service to use new image...');
  }

  // Delay restart to allow notification to be sent
  setTimeout(() => {
    logger.info('Restarting service after container rebuild...');
    process.exit(0); // launchd will restart us
  }, 2000);
}

async function setTyping(chatId: string, isTyping: boolean): Promise<void> {
  if (!isTyping) return; // Telegram doesn't have a "stop typing" action
  try {
    await telegrafBot.telegram.sendChatAction(chatId, 'typing');
  } catch (err) {
    logger.debug({ chatId, err }, 'Failed to update typing status');
  }
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{ last_timestamp?: string; last_agent_timestamp?: Record<string, string> }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  loadContainerState();
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), { last_timestamp: lastTimestamp, last_agent_timestamp: lastAgentTimestamp });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

/**
 * Sync group metadata (placeholder for Telegram - groups are managed manually).
 */
async function syncGroupMetadata(force = false): Promise<void> {
  // Telegram doesn't have automatic group discovery like WhatsApp
  // Groups are registered manually via IPC
  logger.debug({ force }, 'syncGroupMetadata called (no-op for Telegram)');
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter(c => c.jid !== '__group_sync__')
    .map(c => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid)
    }));
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid];
  if (!group) return;

  const content = msg.content.trim();
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Main group responds to all messages; other groups require trigger prefix
  if (!isMainGroup && !TRIGGER_PATTERN.test(content)) return;

  // Get all messages since last agent interaction so the session has full context
  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || '';
  const missedMessages = getMessagesSince(msg.chat_jid, sinceTimestamp, ASSISTANT_NAME);

  const lines = missedMessages.map(m => {
    // Escape XML special characters in content
    const escapeXml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing message');

  // Send typing indicator every 4 seconds while agent is running
  await setTyping(msg.chat_jid, true);
  const typingInterval = setInterval(() => {
    setTyping(msg.chat_jid, true).catch(() => {});
  }, 4000);

  let response: string | null;
  try {
    response = await runAgent(group, prompt, msg.chat_jid);
  } finally {
    clearInterval(typingInterval);
  }

  // Process any IPC messages from this agent run BEFORE deciding to send result
  // This ensures send_message calls take precedence over result
  const ipcMessagesSent = await processGroupIpcMessages(group.folder, isMainGroup);
  const sentToThisChat = ipcMessagesSent.includes(msg.chat_jid);

  // Only send result if no IPC message was already sent for this chat
  if (response && !sentToThisChat) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    // Telegram bot sends as itself, no ASSISTANT_NAME prefix needed
    await sendMessage(msg.chat_jid, response);
  } else {
    // IPC message was sent (or no response), just update timestamp
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
    if (sentToThisChat) {
      logger.debug({ chatJid: msg.chat_jid }, 'Skipping result send - IPC message already sent');
    }
  }
}

async function runAgent(group: RegisteredGroup, prompt: string, chatJid: string): Promise<string | null> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(group.folder, isMain, tasks.map(t => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run
  })));

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(group.folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain
    });

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Container agent error');
      return null;
    }

    return output.result;
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return null;
  }
}

async function sendMessage(chatId: string, text: string): Promise<void> {
  try {
    await telegrafBot.telegram.sendMessage(chatId, text);
    logger.info({ chatId, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send message');
  }
}

/**
 * Convert container path to host path.
 * Container paths: /workspace/project/..., /workspace/group/...
 * Host paths: projectRoot/..., groups/{folder}/...
 */
function containerPathToHostPath(containerPath: string, groupFolder: string): string {
  const projectRoot = process.cwd();

  if (containerPath.startsWith('/workspace/project/')) {
    return path.join(projectRoot, containerPath.slice('/workspace/project/'.length));
  }
  if (containerPath.startsWith('/workspace/group/')) {
    return path.join(GROUPS_DIR, groupFolder, containerPath.slice('/workspace/group/'.length));
  }
  // Fallback: assume it's already a host path or use as-is
  return containerPath;
}

async function sendFile(
  chatId: string,
  filePath: string,
  isImage: boolean,
  caption?: string
): Promise<void> {
  try {
    const inputFile = Input.fromLocalFile(filePath);

    if (isImage) {
      await telegrafBot.telegram.sendPhoto(chatId, inputFile, { caption });
    } else {
      await telegrafBot.telegram.sendDocument(chatId, inputFile, { caption });
    }

    logger.info({ chatId, filePath, isImage }, 'File sent');
  } catch (err) {
    logger.error({ chatId, filePath, err }, 'Failed to send file');
  }
}

/**
 * Process IPC messages for a specific group immediately after agent run.
 * Returns list of chatJids that received messages.
 * This ensures send_message tool calls are processed before result is sent.
 */
async function processGroupIpcMessages(groupFolder: string, isMain: boolean): Promise<string[]> {
  const sentToChats: string[] = [];
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  const messagesDir = path.join(ipcBaseDir, groupFolder, 'messages');

  try {
    if (!fs.existsSync(messagesDir)) {
      return sentToChats;
    }

    const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
    for (const file of messageFiles) {
      const filePath = path.join(messagesDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        // Authorization: verify this group can send to this chatJid
        const targetGroup = registeredGroups[data.chatJid];
        const isAuthorized = isMain || (targetGroup && targetGroup.folder === groupFolder);

        if (data.type === 'message' && data.chatJid && data.text) {
          if (isAuthorized) {
            await sendMessage(data.chatJid, data.text);
            sentToChats.push(data.chatJid);
            logger.info({ chatJid: data.chatJid, groupFolder }, 'IPC message sent (inline)');
          } else {
            logger.warn({ chatJid: data.chatJid, groupFolder }, 'Unauthorized IPC message attempt blocked');
          }
        } else if (data.type === 'file' && data.chatJid && data.filePath) {
          if (isAuthorized) {
            const hostPath = containerPathToHostPath(data.filePath, groupFolder);
            await sendFile(data.chatJid, hostPath, data.isImage, data.caption);
            sentToChats.push(data.chatJid);
            logger.info({ chatJid: data.chatJid, groupFolder, filePath: hostPath }, 'IPC file sent (inline)');
          } else {
            logger.warn({ chatJid: data.chatJid, groupFolder }, 'Unauthorized IPC file attempt blocked');
          }
        }
        fs.unlinkSync(filePath);
      } catch (err) {
        logger.error({ file, groupFolder, err }, 'Error processing IPC message');
        const errorDir = path.join(ipcBaseDir, 'errors');
        fs.mkdirSync(errorDir, { recursive: true });
        fs.renameSync(filePath, path.join(errorDir, `${groupFolder}-${file}`));
      }
    }
  } catch (err) {
    logger.error({ err, groupFolder }, 'Error reading IPC messages directory');
  }

  return sentToChats;
}

function startIpcWatcher(): void {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter(f => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

              // Authorization: verify this group can send to this chatJid
              const targetGroup = registeredGroups[data.chatJid];
              const isAuthorized = isMain || (targetGroup && targetGroup.folder === sourceGroup);

              if (data.type === 'message' && data.chatJid && data.text) {
                if (isAuthorized) {
                  await sendMessage(data.chatJid, data.text);
                  logger.info({ chatJid: data.chatJid, sourceGroup }, 'IPC message sent');
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC message attempt blocked');
                }
              } else if (data.type === 'file' && data.chatJid && data.filePath) {
                if (isAuthorized) {
                  const hostPath = containerPathToHostPath(data.filePath, sourceGroup);
                  await sendFile(data.chatJid, hostPath, data.isImage, data.caption);
                  logger.info({ chatJid: data.chatJid, sourceGroup, filePath: hostPath }, 'IPC file sent');
                } else {
                  logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC file attempt blocked');
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC message');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC messages directory');
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error({ file, sourceGroup, err }, 'Error processing IPC task');
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string,  // Verified identity from IPC directory
  isMain: boolean       // Verified from directory path
): Promise<void> {
  // Import db functions dynamically to avoid circular deps
  const { createTask, updateTask, deleteTask, getTaskById: getTask } = await import('./db.js');
  const { CronExpressionParser } = await import('cron-parser');

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value && data.groupFolder) {
        // Authorization: non-main groups can only schedule for themselves
        const targetGroup = data.groupFolder;
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn({ sourceGroup, targetGroup }, 'Unauthorized schedule_task attempt blocked');
          break;
        }

        // Resolve the correct JID for the target group (don't trust IPC payload)
        const targetJid = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup
        )?.[0];

        if (!targetJid) {
          logger.warn({ targetGroup }, 'Cannot schedule task: target group not registered');
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, { tz: TIMEZONE });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid cron expression');
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid interval');
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn({ scheduleValue: data.schedule_value }, 'Invalid timestamp');
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode = (data.context_mode === 'group' || data.context_mode === 'isolated')
          ? data.context_mode
          : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString()
        });
        logger.info({ taskId, sourceGroup, targetGroup, contextMode }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task pause attempt');
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task resume attempt');
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTask(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: data.taskId, sourceGroup }, 'Unauthorized task cancel attempt');
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
        await syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = getAvailableGroups();
        const { writeGroupsSnapshot: writeGroups } = await import('./container-runner.js');
        writeGroups(sourceGroup, true, availableGroups, new Set(Object.keys(registeredGroups)));
      } else {
        logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig
        });
      } else {
        logger.warn({ data }, 'Invalid register_group request - missing required fields');
      }
      break;

    case 'request_restart':
      // Only main group can request a restart
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized request_restart attempt blocked');
        break;
      }
      logger.info({ sourceGroup }, 'Service restart requested via IPC');
      // Delay restart to allow current request to complete
      setTimeout(() => {
        logger.info('Restarting service...');
        process.exit(0); // launchd will restart us
      }, 2000);
      break;

    case 'rebuild_container':
      // Only main group can rebuild containers
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized rebuild_container attempt blocked');
        break;
      }
      await handleContainerRebuild(sourceGroup);
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

function setupTelegram(): void {
  // Handle incoming messages
  telegrafBot.on('message', async (ctx) => {
    if (!ctx.message || !('text' in ctx.message)) return;

    const chatId = String(ctx.chat.id);
    const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    const content = ctx.message.text;
    const senderId = String(ctx.from?.id || ctx.chat.id);
    const senderName = ctx.from?.first_name || ctx.from?.username || 'User';
    const timestamp = new Date(ctx.message.date * 1000).toISOString();

    // Check if this chat is registered
    const group = registeredGroups[chatId];
    if (!group) {
      logger.debug({ chatId }, 'Message from unregistered Telegram chat');
      return;
    }

    // Store message in database
    storeChatMetadata(chatId, timestamp);
    storeMessage({
      key: { remoteJid: chatId, id: String(ctx.message.message_id), fromMe: false },
      message: { conversation: content },
      messageTimestamp: ctx.message.date,
      pushName: senderName
    }, chatId, false, senderName);

    logger.info({ chatId, isGroup, senderName }, `Telegram message: ${content.substring(0, 50)}...`);
  });

  // Start the bot
  telegrafBot.launch();
  logger.info('Telegram bot started');

  // Graceful shutdown
  process.once('SIGINT', () => {
    logger.info('Shutting down Telegram bot');
    telegrafBot.stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    logger.info('Shutting down Telegram bot');
    telegrafBot.stop('SIGTERM');
  });

  // Start message processing loop
  startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions
  });
  startIpcWatcher();
  startMessageLoop();
}

async function startMessageLoop(): Promise<void> {
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) logger.info({ count: messages.length }, 'New messages');
      for (const msg of messages) {
        try {
          await processMessage(msg);
          // Only advance timestamp after successful processing for at-least-once delivery
          lastTimestamp = msg.timestamp;
          saveState();
        } catch (err) {
          logger.error({ err, msg: msg.id }, 'Error processing message, will retry');
          // Stop processing this batch - failed message will be retried next loop
          break;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

// === Code Rollback Mechanism ===
// If Andy makes code changes but doesn't commit within 30 minutes, auto-rollback
const ROLLBACK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
let lastCleanStateTime = Date.now();

function hasUncommittedChanges(): boolean {
  try {
    const status = execSync('git status --porcelain', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

function rollbackChanges(): void {
  try {
    logger.warn('Rolling back uncommitted code changes...');
    execSync('git checkout .', { cwd: process.cwd(), stdio: 'pipe' });
    execSync('git clean -fd', { cwd: process.cwd(), stdio: 'pipe' });

    // Also rollback container image if we have a backup
    if (containerRebuildState.hasBackup) {
      logger.warn('Rolling back container image to :backup...');
      if (rollbackContainerImage()) {
        containerRebuildState = { hasBackup: false };
        saveContainerState();
      }
    }

    logger.info('Code and container changes rolled back successfully');
  } catch (err) {
    logger.error({ err }, 'Failed to rollback code changes');
  }
}

function checkAndRollbackUncommittedChanges(): void {
  if (hasUncommittedChanges()) {
    logger.warn('Uncommitted code changes detected on startup - rolling back');
    rollbackChanges();
  } else {
    logger.debug('No uncommitted changes detected');
  }
  lastCleanStateTime = Date.now();
}

function startRollbackMonitor(): void {
  setInterval(() => {
    if (hasUncommittedChanges()) {
      const timeSinceClean = Date.now() - lastCleanStateTime;
      if (timeSinceClean > ROLLBACK_TIMEOUT_MS) {
        logger.warn({ timeSinceClean }, 'Uncommitted changes exceeded timeout - rolling back and restarting');
        rollbackChanges();
        process.exit(1); // launchd will restart us
      }
    } else {
      lastCleanStateTime = Date.now();
    }
  }, 60000); // Check every minute
  logger.info('Code rollback monitor started (30 min timeout)');
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Apple Container system already running');
  } catch {
    logger.info('Starting Apple Container system...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
      logger.info('Apple Container system started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Apple Container system');
      console.error('\n╔════════════════════════════════════════════════════════════════╗');
      console.error('║  FATAL: Apple Container system failed to start                 ║');
      console.error('║                                                                ║');
      console.error('║  Agents cannot run without Apple Container. To fix:           ║');
      console.error('║  1. Install from: https://github.com/apple/container/releases ║');
      console.error('║  2. Run: container system start                               ║');
      console.error('║  3. Restart NanoClaw                                          ║');
      console.error('╚════════════════════════════════════════════════════════════════╝\n');
      throw new Error('Apple Container system is required but failed to start');
    }
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  setupTelegram();
  startRollbackMonitor();
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
