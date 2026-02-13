import 'dotenv/config';
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
  IDLE_TIMEOUT,
  TIMEZONE,
  DEFAULT_MODEL,
  CONTAINER_IMAGE,
  GROUPS_DIR,
  MODEL_ALIASES,
  getModelOverride,
  getThinkingLevelOverride,
  setModelOverride,
  setThinkingLevelOverride
} from './config.js';
import { RegisteredGroup, Session, NewMessage } from './types.js';
import { initDatabase, storeMessageDirect, storeChatMetadata, getMessagesSince, getMessagesSinceRowId, getMaxRowIdBefore, getAllTasks, getAllChats, migrateAddChannelPrefix } from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { AgentResponse, ContainerOutput, runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot, AvailableGroup } from './container-runner.js';
import { GroupQueue } from './group-queue.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';
import { setupTelegram, telegramSendMessage, telegramSendFile, telegramSetTyping } from './telegram.js';
let lastTimestamp = '';
let lastTimestampByChat: Record<string, string> = {};
let lastRowIdByChat: Record<string, number> = {};
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

// GroupQueue for managing concurrent long-lived containers
const queue = new GroupQueue();

// Active idle-timer reset functions, keyed by chatJid
const activeIdleTimerResetters = new Map<string, () => void>();

// Tracks whether the last container run succeeded, keyed by chatJid.
// Used by onContainerDone to decide cursor advancement after checkUnconsumedInput.
const lastContainerResult = new Map<string, boolean>();

// === Container Rebuild State ===
interface ImageBackupState {
  hasBackup: boolean;
  lastBackupTime?: string;
}

interface ContainerRebuildState {
  agent: ImageBackupState;
}

function defaultContainerState(): ContainerRebuildState {
  return {
    agent: { hasBackup: false }
  };
}

let containerRebuildState: ContainerRebuildState = defaultContainerState();
const CONTAINER_STATE_PATH = path.join(DATA_DIR, 'container_state.json');

function loadContainerState(): void {
  const loaded = loadJson<unknown>(CONTAINER_STATE_PATH, defaultContainerState());
  if (loaded && typeof loaded === 'object' && 'agent' in loaded) {
    containerRebuildState = loaded as ContainerRebuildState;
    return;
  }

  if (loaded && typeof loaded === 'object' && ('claude' in loaded || 'codex' in loaded)) {
    const legacy = loaded as { claude?: ImageBackupState; codex?: ImageBackupState };
    containerRebuildState = {
      agent: {
        hasBackup: !!legacy?.claude?.hasBackup || !!legacy?.codex?.hasBackup,
        lastBackupTime: legacy?.claude?.lastBackupTime || legacy?.codex?.lastBackupTime
      }
    };
    return;
  }

  const legacy = loaded as { hasBackup?: boolean; lastBackupTime?: string };
  containerRebuildState = {
    agent: {
      hasBackup: !!legacy?.hasBackup,
      lastBackupTime: legacy?.lastBackupTime
    }
  };
}

function saveContainerState(): void {
  saveJson(CONTAINER_STATE_PATH, containerRebuildState);
}

// Extract image name without tag (e.g., "nanoclaw-agent:latest" -> "nanoclaw-agent")
function getContainerImageName(image: string): string {
  return image.split(':')[0];
}

// Extract tag (e.g., "nanoclaw-agent:latest" -> "latest")
function getContainerImageTag(image: string): string {
  const parts = image.split(':');
  return parts[1] || 'latest';
}

function imageExists(image: string): boolean {
  try {
    execSync(`container image inspect ${image}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function backupImage(image: string, key: keyof ContainerRebuildState): boolean {
  if (!imageExists(image)) {
    containerRebuildState[key] = { hasBackup: false };
    saveContainerState();
    logger.warn({ image }, 'Container image not found, skipping backup');
    return true;
  }

  try {
    const imageName = getContainerImageName(image);
    const tag = getContainerImageTag(image);
    execSync(`container image tag ${imageName}:${tag} ${imageName}:backup`, { stdio: 'pipe' });
    containerRebuildState[key] = { hasBackup: true, lastBackupTime: new Date().toISOString() };
    saveContainerState();
    logger.info({ imageName }, 'Container image backed up to :backup tag');
    return true;
  } catch (err) {
    logger.error({ err, image }, 'Failed to backup container image');
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

function rollbackContainerImage(image: string, key: keyof ContainerRebuildState): boolean {
  if (!containerRebuildState[key]?.hasBackup) {
    logger.warn({ image }, 'No backup image available for rollback');
    return false;
  }
  try {
    const imageName = getContainerImageName(image);
    const tag = getContainerImageTag(image);
    execSync(`container image tag ${imageName}:backup ${imageName}:${tag}`, { stdio: 'pipe' });
    logger.info({ imageName, tag }, 'Container image rolled back to :backup');
    return true;
  } catch (err) {
    logger.error({ err, image }, 'Failed to rollback container image');
    return false;
  }
}

async function handleContainerRebuild(sourceGroup: string): Promise<void> {
  logger.info({ sourceGroup }, 'Container rebuild requested');

  // Find the chat JID for the main group to send notifications
  const mainJid = Object.entries(registeredGroups).find(([, g]) => g.folder === MAIN_GROUP_FOLDER)?.[0];

  // 1. Backup current image to :backup
  const backupOk = backupImage(CONTAINER_IMAGE, 'agent');
  if (!backupOk) {
    if (mainJid) {
      await sendMessage(mainJid, '❌ Container rebuild failed: Could not backup current image.');
    }
    return;
  }

  // 2. Build new image
  if (!buildNewImage()) {
    logger.warn('Build failed, rolling back to backup image...');
    rollbackContainerImage(CONTAINER_IMAGE, 'agent');
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
  if (!isTyping) return;
  try {
    if (chatId.startsWith('fs:')) {
      // Feishu doesn't have a native typing indicator
      return;
    }
    const tgId = chatId.startsWith('tg:') ? chatId.slice(3) : chatId;
    await telegramSetTyping(tgId);
  } catch (err) {
    logger.debug({ chatId, err }, 'Failed to update typing status');
  }
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json');
  const state = loadJson<{
    last_timestamp?: string;
    last_timestamp_by_chat?: Record<string, string>;
    last_row_id_by_chat?: Record<string, number>;
    last_agent_timestamp?: Record<string, string>;
  }>(statePath, {});
  lastTimestamp = state.last_timestamp || '';
  lastTimestampByChat = state.last_timestamp_by_chat || {};
  lastRowIdByChat = state.last_row_id_by_chat || {};
  lastAgentTimestamp = state.last_agent_timestamp || {};
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {});
  for (const [key, entry] of Object.entries(sessions)) {
    if (entry && typeof entry === 'object') {
      const legacy = entry as { claude?: string; codex?: string };
      const resolved = legacy.claude || legacy.codex;
      if (resolved) {
        sessions[key] = resolved;
      } else {
        delete sessions[key];
      }
    }
  }
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
  for (const group of Object.values(registeredGroups)) {
    group.agent = normalizeModelSpec(group.agent);
  }
  loadContainerState();
  logger.info({ groupCount: Object.keys(registeredGroups).length }, 'State loaded');
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
    last_timestamp_by_chat: lastTimestampByChat,
    last_row_id_by_chat: lastRowIdByChat,
    last_agent_timestamp: lastAgentTimestamp
  });
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
}

type Channel = 'telegram' | 'feishu';

function normalizeModelSpec(model?: string): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'claude' || trimmed === 'codex') return undefined; // legacy values
  return trimmed;
}

function getGroupModel(group: RegisteredGroup): string | undefined {
  return normalizeModelSpec(group.agent) || getModelOverride() || DEFAULT_MODEL || undefined;
}

function getCurrentModel(group: RegisteredGroup): string {
  return getGroupModel(group) || '(default)';
}

function getSession(sessionKey: string): string | undefined {
  return sessions[sessionKey];
}

function setSession(sessionKey: string, sessionId: string): void {
  sessions[sessionKey] = sessionId;
}

function getChannelFromJid(jid: string): Channel | null {
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('fs:')) return 'feishu';
  return null;
}

function normalizeChatJid(jid: string): { jid: string; channel: Channel | null } {
  const trimmed = jid.trim();
  const channel = getChannelFromJid(trimmed);
  if (channel) return { jid: trimmed, channel };
  return { jid: `tg:${trimmed}`, channel: 'telegram' };
}
function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = { ...group, agent: normalizeModelSpec(group.agent) };
  saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info({ jid, name: group.name, folder: group.folder }, 'Group registered');
}

function resolveTaskChatJid(requesterJid: string | undefined, targetGroup: string): string | undefined {
  if (requesterJid) {
    const requesterGroup = registeredGroups[requesterJid];
    if (requesterGroup && requesterGroup.folder === targetGroup) {
      return requesterJid;
    }
  }

  const candidates = Object.entries(registeredGroups)
    .filter(([, group]) => group.folder === targetGroup)
    .map(([jid]) => jid)
    .sort();

  return candidates[0];
}

/**
 * Sync group metadata (placeholder for Telegram - groups are managed manually).
 */
async function syncGroupMetadata(force = false): Promise<void> {
  // Telegram doesn't provide automatic group discovery
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

/**
 * Format messages since a timestamp into XML for the agent prompt.
 */
function formatMessages(chatJid: string, sinceTimestamp: string): { prompt: string; count: number } {
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  const lines = missedMessages.map(m => {
    const escapeXml = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const mediaAttr = m.media_path ? ` media="/workspace/group/media/${path.basename(m.media_path)}"` : '';
    const replyAttr = m.reply_to_content ? ` reply_to="${escapeXml(m.reply_to_content)}"` : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"${mediaAttr}${replyAttr}>${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;
  return { prompt, count: missedMessages.length };
}

function resolveModelInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const alias = MODEL_ALIASES[trimmed.toLowerCase()];
  const resolved = alias || trimmed;
  const normalized = resolved.includes(':') ? resolved.replace(':', '/') : resolved;
  if (!normalized.includes('/')) {
    return null;
  }
  return normalized;
}

/**
 * Handle slash commands from a message. Returns true if the message was a command.
 */
async function handleCommand(msg: NewMessage, group: RegisteredGroup): Promise<boolean> {
  const content = msg.content.trim();

  // Handle /newsession command
  if (content === '/newsession' || content.endsWith('/newsession')) {
    delete sessions[msg.chat_jid];
    saveState();
    logger.info({ group: group.name, chatJid: msg.chat_jid }, 'Session cleared by /newsession command');
    await sendMessage(msg.chat_jid, '✅ Session cleared. Next message will start a fresh conversation.');
    return true;
  }

  // Handle /help command
  if (content === '/help' || content.endsWith('/help')) {
    const currentModel = getCurrentModel(group);
    const modelOverride = getModelOverride() || '(none)';
    const thinkingLevel = getThinkingLevelOverride() || '(default)';
    const aliases = Object.entries(MODEL_ALIASES).map(([k, v]) => `  ${k} → ${v}`).join('\n');

    await sendMessage(msg.chat_jid, [
      '📋 Available commands:',
      '',
      '/help - Show this help',
      '/agent - Show current model for this group',
      '/agent <provider/model> - Switch model for this group',
      '/model - Show global model override',
      '/model <provider/model|alias> - Set global model override',
      '/model default - Reset global model override',
      '/thinking - Show current thinking level',
      '/thinking <off|minimal|low|medium|high|xhigh> - Set thinking level',
      '/thinking default - Reset thinking level',
      '/newsession - Clear session, start fresh',
      '',
      `Current model: ${currentModel}`,
      `Global override: ${modelOverride}`,
      `Thinking level: ${thinkingLevel}`,
      ...(aliases ? ['', 'Aliases:', aliases] : []),
    ].join('\n'));
    return true;
  }

  // Handle /agent command
  const agentMatch = content.match(/^\/agent(?:\s+(.+))?$/i);
  if (agentMatch) {
    const agentArg = agentMatch[1]?.trim();
    if (!agentArg) {
      const current = getCurrentModel(group);
      await sendMessage(msg.chat_jid, `Current model: ${current}`);
      return true;
    }

    const resolved = resolveModelInput(agentArg);
    if (!resolved) {
      await sendMessage(msg.chat_jid, 'Usage: /agent <provider/model>');
      return true;
    }

    for (const regGroup of Object.values(registeredGroups)) {
      if (regGroup.folder === group.folder) {
        regGroup.agent = resolved;
      }
    }
    saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

    await sendMessage(msg.chat_jid, `✅ Model set for this group: ${resolved}`);
    return true;
  }

  // Handle /model command
  const modelMatch = content.match(/^\/model(?:\s+(.+))?$/i);
  if (modelMatch) {
    const modelArg = modelMatch[1]?.trim();
    if (!modelArg) {
      const currentOverride = getModelOverride() || '(none)';
      const currentModel = getCurrentModel(group);
      const lines = [
        `Global model override: ${currentOverride}`,
        `Current model for this group: ${currentModel}`,
        '',
        'Usage: /model <provider/model|alias>',
        'Reset: /model default',
      ];
      const aliases = Object.entries(MODEL_ALIASES).map(([k, v]) => `  ${k} → ${v}`).join('\n');
      if (aliases) {
        lines.splice(3, 0, 'Aliases:', aliases, '');
      }
      await sendMessage(msg.chat_jid, lines.join('\n'));
      return true;
    }

    if (modelArg.toLowerCase() === 'default' || modelArg.toLowerCase() === 'reset') {
      setModelOverride(null);
      logger.info({ chatJid: msg.chat_jid }, 'Model override cleared');
      await sendMessage(msg.chat_jid, '✅ Global model override reset to default.');
      return true;
    }

    const resolved = resolveModelInput(modelArg);
    if (!resolved) {
      await sendMessage(msg.chat_jid, 'Usage: /model <provider/model|alias>');
      return true;
    }

    setModelOverride(resolved);
    logger.info({ chatJid: msg.chat_jid, model: resolved }, 'Model override set');
    await sendMessage(msg.chat_jid, `✅ Global model override set: ${resolved}`);
    return true;
  }

  // Handle /thinking command
  const thinkingMatch = content.match(/^\/thinking(?:\s+(.+))?$/i);
  if (thinkingMatch) {
    const levelArg = thinkingMatch[1]?.trim().toLowerCase();
    const validLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

    if (!levelArg) {
      const currentLevel = getThinkingLevelOverride() || '(default)';
      await sendMessage(
        msg.chat_jid,
        `Current thinking level: ${currentLevel}\n\nUsage: /thinking <off|minimal|low|medium|high|xhigh>\nReset: /thinking default`
      );
      return true;
    }

    if (levelArg === 'default' || levelArg === 'reset') {
      setThinkingLevelOverride(null);
      logger.info({ chatJid: msg.chat_jid }, 'Thinking level override cleared');
      await sendMessage(msg.chat_jid, '✅ Thinking level reset to default.');
      return true;
    }

    if (!validLevels.has(levelArg)) {
      await sendMessage(msg.chat_jid, 'Usage: /thinking <off|minimal|low|medium|high|xhigh>');
      return true;
    }

    setThinkingLevelOverride(levelArg);
    logger.info({ chatJid: msg.chat_jid, level: levelArg }, 'Thinking level override set');
    await sendMessage(msg.chat_jid, `✅ Thinking level set to: ${levelArg}`);
    return true;
  }

  return false;
}

/**
 * Process all pending messages for a group (called by GroupQueue).
 * This is the core function that formats messages, runs the agent with streaming,
 * and handles the streaming output.
 */
async function processGroupMessages(chatJid: string): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group) return;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const { prompt, count } = formatMessages(chatJid, sinceTimestamp);

  if (count === 0) return;

  // Check trigger for non-main groups
  if (!isMainGroup && group.requiresTrigger !== false) {
    const recentMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    const hasTrigger = recentMessages.some(m => TRIGGER_PATTERN.test(m.content.trim()));
    if (!hasTrigger) return;
  }

  logger.info({ group: group.name, chatJid, messageCount: count }, 'Processing group messages');

  // Send typing indicator
  await setTyping(chatJid, true);
  const typingInterval = setInterval(() => {
    setTyping(chatJid, true).catch(() => {});
  }, 4000);

  // Set up idle timer to close container after inactivity
  // Only starts AFTER first output is received — during the initial query,
  // the container timeout (CONTAINER_TIMEOUT) is the safety net instead.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let outputSentToUser = false;
  let agentProducedOutput = false;
  let firstOutputReceived = false;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.info({ group: group.name, chatJid, idleTimeout: IDLE_TIMEOUT }, 'Idle timeout reached, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };
  const startIdleTimerIfNeeded = () => {
    if (!firstOutputReceived) {
      firstOutputReceived = true;
      logger.debug({ group: group.name }, 'First output received, starting idle timer');
    }
    resetIdleTimer();
  };

  // Register so piped messages can reset the idle timer
  activeIdleTimerResetters.set(chatJid, startIdleTimerIfNeeded);

  try {
    const result = await runAgent(group, prompt, chatJid, async (streamedOutput) => {
      // Log every streamed output for debugging
      logger.debug({
        group: group.name,
        status: streamedOutput.status,
        hasResult: !!streamedOutput.result,
        outputType: streamedOutput.result?.outputType,
        hasUserMessage: !!streamedOutput.result?.userMessage,
        userMessageLen: streamedOutput.result?.userMessage?.length,
        hasLog: !!streamedOutput.result?.internalLog,
        newSessionId: streamedOutput.newSessionId ? '(set)' : '(none)',
        error: streamedOutput.error,
      }, 'Streamed output received');

      // Process IPC messages inline during streaming
      const inlineIpcSent = await processGroupIpcMessages(group.folder, isMainGroup);
      if (inlineIpcSent.length > 0) {
        agentProducedOutput = true;
        if (inlineIpcSent.includes(chatJid)) outputSentToUser = true;
        startIdleTimerIfNeeded();
      }

      // Send streamed results to user
      if (streamedOutput.result?.outputType === 'message' && streamedOutput.result?.userMessage) {
        await sendMessage(chatJid, streamedOutput.result.userMessage);
        outputSentToUser = true;
      }

      if (streamedOutput.result?.internalLog) {
        agentProducedOutput = true;
        logger.info(
          { group: group.name, outputType: streamedOutput.result.outputType },
          `Agent: ${streamedOutput.result.internalLog}`,
        );
      }

      // Reset idle timer on output
      if (streamedOutput.result) {
        agentProducedOutput = true;
        startIdleTimerIfNeeded();
      }
    }, startIdleTimerIfNeeded);

    if (idleTimer) clearTimeout(idleTimer);

    // Process any remaining IPC messages
    const finalIpcSent = await processGroupIpcMessages(group.folder, isMainGroup);
    if (finalIpcSent.length > 0) {
      agentProducedOutput = true;
      if (finalIpcSent.includes(chatJid)) outputSentToUser = true;
    }

    // Detect silent failure: container succeeded but produced no output at all.
    // This typically happens when the session is too large and the model
    // aborts internally (e.g. GitHub Copilot silently aborting at context limits).
    // Auto-clear the session so the next message starts fresh.
    if (result === 'success' && !agentProducedOutput) {
      if (sessions[chatJid]) {
        logger.warn({ group: group.name, chatJid }, 'Container returned success but no output was produced — session may be too large, auto-clearing');
        delete sessions[chatJid];
        saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
        await sendMessage(chatJid, '⚠️ No response was received. Session has been auto-cleared — please resend your message.');
      }
    }

    // Store result for onContainerDone callback to decide cursor advancement.
    // If we already sent output to the user, treat as success even on error —
    // rolling back the cursor would cause infinite message replay (duplicates).
    if (result === 'error' && outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, treating as success to prevent cursor rollback');
    }
    lastContainerResult.set(chatJid, result !== 'error' || outputSentToUser);
  } finally {
    activeIdleTimerResetters.delete(chatJid);
    clearInterval(typingInterval);
    if (idleTimer) clearTimeout(idleTimer);
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onActivity?: () => void,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const model = getGroupModel(group);
  const thinkingLevel = getThinkingLevelOverride() || undefined;
  const sessionKey = chatJid;
  const sessionId = getSession(sessionKey);

  // Update tasks snapshot for container to read
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

  // Update available groups snapshot
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(group.folder, isMain, availableGroups, new Set(Object.keys(registeredGroups)));

  // Wrap onOutput to track session IDs and detect token overflow
  const wrappedOnOutput = onOutput ? async (output: ContainerOutput) => {
    if (output.newSessionId) {
      setSession(sessionKey, output.newSessionId);
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }
    await onOutput(output);
  } : undefined;

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain,
      model,
      thinkingLevel
    },
    // onProcess: register with GroupQueue
    (proc, containerName) => {
      queue.registerProcess(chatJid, proc, containerName, group.folder);
    },
    wrappedOnOutput,
    onActivity);

    // For non-streaming runs, session ID comes in final output
    if (output.newSessionId) {
      setSession(sessionKey, output.newSessionId);
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      const errorStr = output.error || '';
      if (/prompt_tokens_exceeded|context_window|token.*limit|max.*context/i.test(errorStr)) {
        logger.warn({ group: group.name, model, error: errorStr }, 'Token overflow detected, clearing session');
        delete sessions[sessionKey];
        saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
      }
      logger.error({ group: group.name, error: output.error }, 'Container agent error');
      return 'error';
    }

    // For non-streaming runs, send the result directly
    if (!onOutput && output.result) {
      if (output.result.outputType === 'message' && output.result.userMessage) {
        await sendMessage(chatJid, output.result.userMessage);
      }
      if (output.result.internalLog) {
        logger.info(
          { group: group.name, outputType: output.result.outputType },
          `Agent: ${output.result.internalLog}`,
        );
      }
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

/**
 * Get all registered JIDs for a given group folder.
 * Used to broadcast messages to all platforms (e.g., both Telegram and Feishu) for the same group.
 */
function getJidsForGroup(groupFolder: string): string[] {
  return Object.entries(registeredGroups)
    .filter(([, group]) => group.folder === groupFolder)
    .map(([jid]) => jid);
}

async function sendMessage(chatId: string, text: string): Promise<void> {
  try {
    if (chatId.startsWith('fs:')) {
      const { feishuSendMessage } = await import('./feishu.js');
      await feishuSendMessage(chatId.slice(3), text);
    } else {
      await telegramSendMessage(chatId.startsWith('tg:') ? chatId.slice(3) : chatId, text);
    }
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
    if (chatId.startsWith('fs:')) {
      const { feishuSendFile } = await import('./feishu.js');
      await feishuSendFile(chatId.slice(3), filePath, isImage, caption);
    } else {
      await telegramSendFile(chatId.startsWith('tg:') ? chatId.slice(3) : chatId, filePath, isImage, caption);
    }

    logger.info({ chatId, filePath, isImage }, 'File sent');
  } catch (err) {
    logger.error({ chatId, filePath, err }, 'Failed to send file');
  }
}

/**
 * Process IPC messages for a specific group. Idempotent (read → send → delete).
 * Returns list of chatJids that received messages.
 *
 * Called inline during agent streaming callbacks AND after container completion
 * for low-latency delivery. Also polled by the IPC watcher as a safety net.
 *
 * ⚠️ When adding new code paths that run containers, call this function
 * in both the streaming callback and after completion. See task-scheduler.ts
 * for the pattern, and commit 3dc6d5a for what happens when you forget.
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
            // If broadcast flag is set (scheduled tasks), send to all JIDs for this group
            const targetJids = data.broadcast ? getJidsForGroup(groupFolder) : [data.chatJid];
            for (const jid of targetJids) {
              await sendMessage(jid, data.text);
              sentToChats.push(jid);
            }
            logger.info({ chatJid: data.chatJid, groupFolder, broadcast: !!data.broadcast, targets: targetJids.length }, 'IPC message sent (inline)');
          } else {
            logger.warn({ chatJid: data.chatJid, groupFolder }, 'Unauthorized IPC message attempt blocked');
          }
        } else if (data.type === 'file' && data.chatJid && data.filePath) {
          if (isAuthorized) {
            const hostPath = containerPathToHostPath(data.filePath, groupFolder);
            // If broadcast flag is set (scheduled tasks), send to all JIDs for this group
            const targetJids = data.broadcast ? getJidsForGroup(groupFolder) : [data.chatJid];
            for (const jid of targetJids) {
              await sendFile(jid, hostPath, data.isImage, data.caption);
              sentToChats.push(jid);
            }
            logger.info({ chatJid: data.chatJid, groupFolder, filePath: hostPath, broadcast: !!data.broadcast, targets: targetJids.length }, 'IPC file sent (inline)');
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
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // IPC message files are handled inline during agent runs for low-latency delivery.
      // Do NOT process them here — missing inline calls should fail loudly, not be silently masked.

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
    targetJid?: string;
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

  // Normalize task ID: agents sometimes strip the 'task-' prefix
  const taskId = data.taskId && !data.taskId.startsWith('task-') ? `task-${data.taskId}` : data.taskId;

  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value && (data.targetJid || data.groupFolder)) {
        // Support both new targetJid and legacy groupFolder
        let targetGroup: string;
        let targetJid: string | undefined;

        if (data.targetJid) {
          // New style: resolve group from JID
          const targetGroupEntry = registeredGroups[data.targetJid];
          if (!targetGroupEntry) {
            logger.warn({ targetJid: data.targetJid }, 'Cannot schedule task: target group not registered');
            break;
          }
          targetGroup = targetGroupEntry.folder;
          targetJid = data.targetJid;
        } else {
          // Legacy style: groupFolder
          targetGroup = data.groupFolder!;
          targetJid = resolveTaskChatJid(data.chatJid, targetGroup);
          if (!targetJid) {
            logger.warn({ targetGroup }, 'Cannot schedule task: target group not registered');
            break;
          }
        }

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn({ sourceGroup, targetGroup }, 'Unauthorized schedule_task attempt blocked');
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

        const newTaskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode = (data.context_mode === 'group' || data.context_mode === 'isolated')
          ? data.context_mode
          : 'isolated';
        createTask({
          id: newTaskId,
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
        logger.info({ taskId: newTaskId, sourceGroup, targetGroup, contextMode }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
      if (taskId) {
        const task = getTask(taskId);
        if (!task) {
          logger.warn({ taskId, rawTaskId: data.taskId, sourceGroup }, 'Task not found for pause');
        } else if (isMain || task.group_folder === sourceGroup) {
          updateTask(task.id, { status: 'paused' });
          logger.info({ taskId: task.id, sourceGroup }, 'Task paused via IPC');
        } else {
          logger.warn({ taskId: task.id, sourceGroup }, 'Unauthorized task pause attempt');
        }
      }
      break;

    case 'resume_task':
      if (taskId) {
        const task = getTask(taskId);
        if (!task) {
          logger.warn({ taskId, rawTaskId: data.taskId, sourceGroup }, 'Task not found for resume');
        } else if (isMain || task.group_folder === sourceGroup) {
          updateTask(task.id, { status: 'active' });
          logger.info({ taskId: task.id, sourceGroup }, 'Task resumed via IPC');
        } else {
          logger.warn({ taskId: task.id, sourceGroup }, 'Unauthorized task resume attempt');
        }
      }
      break;

    case 'cancel_task':
      if (taskId) {
        const task = getTask(taskId);
        if (!task) {
          logger.warn({ taskId, rawTaskId: data.taskId, sourceGroup }, 'Task not found for cancel');
        } else if (isMain || task.group_folder === sourceGroup) {
          deleteTask(task.id);
          logger.info({ taskId: task.id, sourceGroup }, 'Task cancelled via IPC');
        } else {
          logger.warn({ taskId: task.id, sourceGroup }, 'Unauthorized task cancel attempt');
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
        const { jid: normalizedJid, channel } = normalizeChatJid(data.jid);
        if (!channel) {
          logger.warn({ jid: data.jid }, 'Invalid jid format for register_group');
          break;
        }

        if (channel === 'feishu' && data.folder === MAIN_GROUP_FOLDER) {
          logger.warn({ jid: normalizedJid, folder: data.folder }, 'Feishu group cannot be registered as main');
          break;
        }

        const crossChannelConflict = Object.entries(registeredGroups).find(
          ([existingJid, group]) =>
            group.folder === data.folder &&
            getChannelFromJid(existingJid) &&
            getChannelFromJid(existingJid) !== channel
        );
        if (crossChannelConflict) {
          logger.warn({ folder: data.folder, existingJid: crossChannelConflict[0], newJid: normalizedJid }, 'Cross-channel folder reuse blocked');
          break;
        }

        registerGroup(normalizedJid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          channel,
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

async function startMessageLoop(): Promise<void> {
  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      for (const jid of jids) {
        let sinceRowId = lastRowIdByChat[jid];
        if (sinceRowId === undefined) {
          const sinceTimestamp = lastTimestampByChat[jid] || lastTimestamp || '';
          sinceRowId = sinceTimestamp
            ? getMaxRowIdBefore(jid, sinceTimestamp, ASSISTANT_NAME)
            : 0;
          lastRowIdByChat[jid] = sinceRowId;
          saveState();
        }

        const messages = getMessagesSinceRowId(jid, sinceRowId, ASSISTANT_NAME);
        if (messages.length === 0) continue;

        logger.info({ chatJid: jid, count: messages.length }, 'New messages');

        // Handle commands immediately (don't go through queue)
        let hasNonCommandMessages = false;
        for (const msg of messages) {
          const group = registeredGroups[msg.chat_jid];
          if (!group) continue;

          const isCommand = await handleCommand(msg, group);

          // Advance cursor for all messages (commands and non-commands)
          if (typeof msg.row_id === 'number') {
            lastRowIdByChat[jid] = msg.row_id;
          }
          lastTimestampByChat[jid] = msg.timestamp;
          if (!lastTimestamp || msg.timestamp > lastTimestamp) {
            lastTimestamp = msg.timestamp;
          }
          saveState();

          if (!isCommand) {
            hasNonCommandMessages = true;
          }
        }

        if (!hasNonCommandMessages) continue;

        // Try to pipe formatted messages to active container first
        const sinceTimestamp = lastAgentTimestamp[jid] || '';
        const { prompt, count } = formatMessages(jid, sinceTimestamp);
        if (count > 0 && queue.sendMessage(jid, prompt)) {
          logger.debug({ chatJid: jid, count }, 'Messages piped to active container');
        } else if (count > 0) {
          // No active container — enqueue for processing
          queue.enqueueMessageCheck(jid);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Recover pending messages on startup — enqueue any groups that have
 * unprocessed messages since the last agent timestamp.
 */
function recoverPendingMessages(): void {
  for (const chatJid of Object.keys(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info({ chatJid, count: pending.length }, 'Recovering pending messages');
      queue.enqueueMessageCheck(chatJid);
    }
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

    // Also rollback container images if we have backups
    const hasBackup = containerRebuildState.agent?.hasBackup;
    if (hasBackup) {
      logger.warn('Rolling back container image to :backup...');
      rollbackContainerImage(CONTAINER_IMAGE, 'agent');
      containerRebuildState = defaultContainerState();
      saveContainerState();
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

  // Kill and clean up orphaned NanoClaw containers from previous runs
  try {
    const listJson = execSync('container ls -a --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers = JSON.parse(listJson) as Array<{ configuration: { id: string }; status: string }>;
    const nanoclawContainers = containers.filter(
      (c) => c.configuration.id.startsWith('nanoclaw-'),
    );
    const running = nanoclawContainers
      .filter((c) => c.status === 'running')
      .map((c) => c.configuration.id);
    if (running.length > 0) {
      execSync(`container stop ${running.join(' ')}`, { stdio: 'pipe' });
      logger.info({ count: running.length }, 'Stopped orphaned containers');
    }
    const allNames = nanoclawContainers.map((c) => c.configuration.id);
    if (allNames.length > 0) {
      execSync(`container rm ${allNames.join(' ')}`, { stdio: 'pipe' });
      logger.info({ count: allNames.length }, 'Cleaned up stopped containers');
    }
  } catch {
    // No containers or cleanup not supported
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  migrateAddChannelPrefix();
  logger.info('Database initialized');
  loadState();

  // Initialize Telegram channel
  setupTelegram({
    storeMessageDirect,
    storeChatMetadata,
    getGroupFolder: (chatJid: string) => registeredGroups[chatJid]?.folder,
  });

  // Optionally enable Feishu/Lark channel
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
    const { setupFeishu } = await import('./feishu.js');
    setupFeishu({
      storeMessageDirect,
      storeChatMetadata,
      getGroupFolder: (chatJid: string) => registeredGroups[chatJid]?.folder,
    });
    logger.info('Feishu/Lark channel enabled');
  }

  // Wire GroupQueue
  queue.setProcessMessagesFn(processGroupMessages);
  queue.setOnMessagePipedFn((groupJid) => {
    const resetFn = activeIdleTimerResetters.get(groupJid);
    if (resetFn) resetFn();
  });
  queue.setOnContainerDoneFn((groupJid, hadUnconsumedInput) => {
    const succeeded = lastContainerResult.get(groupJid);
    lastContainerResult.delete(groupJid);
    // undefined = early return (no messages / no trigger) — don't touch cursor
    if (succeeded === undefined) return;
    if (succeeded && !hadUnconsumedInput) {
      lastAgentTimestamp[groupJid] = new Date().toISOString();
      saveState();
    }
  });

  // Start core message processing (not channel-specific)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => {
      queue.registerProcess(groupJid, proc, containerName, groupFolder);
    },
    sendMessage,
    processIpcMessages: processGroupIpcMessages,
    assistantName: ASSISTANT_NAME,
    registerIdleResetter: (groupJid, resetFn) => activeIdleTimerResetters.set(groupJid, resetFn),
    unregisterIdleResetter: (groupJid) => activeIdleTimerResetters.delete(groupJid),
  });
  startIpcWatcher();

  // Recover messages that arrived while we were down
  recoverPendingMessages();

  startMessageLoop();

  startRollbackMonitor();

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down...');
    queue.shutdown(10000).then(() => process.exit(0));
  });
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
