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
  TIMEZONE,
  DEFAULT_AGENT,
  CONTAINER_IMAGE_CLAUDE,
  CONTAINER_IMAGE_CODEX,
  GROUPS_DIR,
  MODEL_ALIASES,
  getCodexReasoningEffort,
  getModelOverride,
  setCodexReasoningEffort,
  setModelOverride
} from './config.js';
import { RegisteredGroup, Session, NewMessage, AgentType } from './types.js';
import { initDatabase, storeMessageDirect, storeChatMetadata, getMessagesSince, getMessagesSinceRowId, getMaxRowIdBefore, getAllTasks, getAllChats, migrateAddChannelPrefix } from './db.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { AgentResponse, runContainerAgent, writeTasksSnapshot, writeGroupsSnapshot, AvailableGroup } from './container-runner.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';
import { setupTelegram, telegramSendMessage, telegramSendFile, telegramSetTyping } from './telegram.js';
let lastTimestamp = '';
let lastTimestampByChat: Record<string, string> = {};
let lastRowIdByChat: Record<string, number> = {};
let sessions: Session = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};

// === Container Rebuild State ===
interface ImageBackupState {
  hasBackup: boolean;
  lastBackupTime?: string;
}

interface ContainerRebuildState {
  claude: ImageBackupState;
  codex: ImageBackupState;
}

function defaultContainerState(): ContainerRebuildState {
  return {
    claude: { hasBackup: false },
    codex: { hasBackup: false }
  };
}

let containerRebuildState: ContainerRebuildState = defaultContainerState();
const CONTAINER_STATE_PATH = path.join(DATA_DIR, 'container_state.json');

function loadContainerState(): void {
  const loaded = loadJson<unknown>(CONTAINER_STATE_PATH, defaultContainerState());
  if (loaded && typeof loaded === 'object' && 'claude' in loaded && 'codex' in loaded) {
    containerRebuildState = loaded as ContainerRebuildState;
    return;
  }

  const legacy = loaded as { hasBackup?: boolean; lastBackupTime?: string };
  containerRebuildState = {
    claude: {
      hasBackup: !!legacy?.hasBackup,
      lastBackupTime: legacy?.lastBackupTime
    },
    codex: { hasBackup: false }
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

  // 1. Backup current images to :backup
  const backupClaude = backupImage(CONTAINER_IMAGE_CLAUDE, 'claude');
  const backupCodex = backupImage(CONTAINER_IMAGE_CODEX, 'codex');
  if (!backupClaude || !backupCodex) {
    if (mainJid) {
      await sendMessage(mainJid, '❌ Container rebuild failed: Could not backup current images.');
    }
    return;
  }

  // 2. Build new image
  if (!buildNewImage()) {
    logger.warn('Build failed, rolling back to backup images...');
    rollbackContainerImage(CONTAINER_IMAGE_CLAUDE, 'claude');
    rollbackContainerImage(CONTAINER_IMAGE_CODEX, 'codex');
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
  registeredGroups = loadJson(path.join(DATA_DIR, 'registered_groups.json'), {});
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

function normalizeAgent(agent?: string): AgentType {
  if (agent === 'claude' || agent === 'codex') return agent;
  return DEFAULT_AGENT === 'codex' ? 'codex' : 'claude';
}

function getGroupAgent(group: RegisteredGroup): AgentType {
  return normalizeAgent(group.agent);
}

function getEnvDefaultModel(agent: AgentType): string | undefined {
  if (agent === 'claude') return process.env.ANTHROPIC_MODEL;
  return process.env.CODEX_MODEL;
}

function getCurrentModel(agent: AgentType): string {
  return getModelOverride(agent) || getEnvDefaultModel(agent) || '(default)';
}

function getSessionForAgent(sessionKey: string, agent: AgentType): string | undefined {
  const entry = sessions[sessionKey];
  if (!entry) return undefined;
  if (typeof entry === 'string') {
    return agent === 'claude' ? entry : undefined;
  }
  return entry[agent];
}

function setSessionForAgent(sessionKey: string, agent: AgentType, sessionId: string): void {
  const entry = sessions[sessionKey];
  if (typeof entry === 'string') {
    sessions[sessionKey] = agent === 'claude'
      ? { claude: sessionId }
      : { claude: entry, codex: sessionId };
  } else {
    sessions[sessionKey] = { ...(entry || {}), [agent]: sessionId };
  }
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
  registeredGroups[jid] = { ...group, agent: normalizeAgent(group.agent) };
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

  // Handle /newsession command - start a fresh session
  if (content === '/newsession' || content.endsWith('/newsession')) {
    delete sessions[msg.chat_jid];
    saveState();
    logger.info({ group: group.name, chatJid: msg.chat_jid }, 'Session cleared by /newsession command');
    await sendMessage(msg.chat_jid, '✅ Session cleared. Next message will start a fresh conversation.');
    return;
  }

  // Handle /help command - show available commands
  if (content === '/help' || content.endsWith('/help')) {
    const currentAgent = getGroupAgent(group);
    const currentModel = getCurrentModel(currentAgent);
    const currentEffort = currentAgent === 'codex'
      ? (getCodexReasoningEffort() || '(default)')
      : null;
    await sendMessage(msg.chat_jid, [
      '📋 Available commands:',
      '',
      '/help - Show this help',
      '/agent - Show current agent',
      '/agent <claude|codex> - Switch agent for this group',
      '/model - Show current model',
      '/model <name> - Switch model for current agent (or full ID)',
      '/model default - Reset to default model',
      '/effort - Show current reasoning effort (codex only)',
      '/effort <level> - Set reasoning effort (none|minimal|low|medium|high|xhigh)',
      '/effort default - Reset reasoning effort (codex only)',
      '/newsession - Clear session, start fresh',
      '',
      `Current agent: ${currentAgent}`,
      `Current model: ${currentModel}`,
      ...(currentEffort ? [`Current effort: ${currentEffort}`] : []),
    ].join('\n'));
    return;
  }

  // Handle /agent command - switch agent for this group
  const agentMatch = content.match(/^\/agent(?:\s+(.+))?$/i);
  if (agentMatch) {
    const agentArg = agentMatch[1]?.trim().toLowerCase();
    if (!agentArg) {
      const current = getGroupAgent(group);
      await sendMessage(msg.chat_jid, `Current agent: ${current}`);
      return;
    }
    if (agentArg !== 'claude' && agentArg !== 'codex') {
      await sendMessage(msg.chat_jid, 'Usage: /agent <claude|codex>');
      return;
    }

    for (const regGroup of Object.values(registeredGroups)) {
      if (regGroup.folder === group.folder) {
        regGroup.agent = agentArg as AgentType;
      }
    }
    saveJson(path.join(DATA_DIR, 'registered_groups.json'), registeredGroups);

    await sendMessage(msg.chat_jid, `✅ Agent set to: ${agentArg}`);
    if (agentArg === 'codex' && !process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY) {
      await sendMessage(msg.chat_jid, '⚠️ Codex requires CODEX_API_KEY or OPENAI_API_KEY in .env.');
    }
    return;
  }

  // Handle /model command - switch model for current agent
  const modelMatch = content.match(/^\/model(?:\s+(.+))?$/i);
  if (modelMatch) {
    const modelArg = modelMatch[1]?.trim();
    if (!modelArg) {
      const currentAgent = getGroupAgent(group);
      const current = getCurrentModel(currentAgent);
      const otherAgent: AgentType = currentAgent === 'claude' ? 'codex' : 'claude';
      const otherModel = getCurrentModel(otherAgent);
      const lines = [
        `Current agent: ${currentAgent}`,
        `Current model: ${current}`,
        `Other agent model: ${otherModel}`,
        '',
        'Usage: /model <name|full-model-id>',
        'Reset: /model default',
      ];
      if (currentAgent === 'claude') {
        const aliases = Object.entries(MODEL_ALIASES).map(([k, v]) => `  ${k} → ${v}`).join('\n');
        lines.splice(3, 0, 'Aliases:', aliases, '');
      }
      await sendMessage(msg.chat_jid, lines.join('\n'));
      return;
    }
    if (modelArg.toLowerCase() === 'default' || modelArg.toLowerCase() === 'reset') {
      const currentAgent = getGroupAgent(group);
      setModelOverride(currentAgent, null);
      const defaultModel = getEnvDefaultModel(currentAgent) || '(env default)';
      logger.info({ chatJid: msg.chat_jid, agent: currentAgent }, 'Model override cleared');
      await sendMessage(msg.chat_jid, `✅ Model reset for ${currentAgent}: ${defaultModel}`);
      return;
    }
    const currentAgent = getGroupAgent(group);
    const resolved = currentAgent === 'claude'
      ? (MODEL_ALIASES[modelArg.toLowerCase()] || modelArg)
      : modelArg;

    if (currentAgent === 'claude') {
      // Validate model by making a minimal API call before saving
      await sendMessage(msg.chat_jid, `🔄 Testing model: ${resolved}...`);
      const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
      const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
      try {
        const resp = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: resolved,
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          logger.warn({ model: resolved, status: resp.status, body }, 'Model validation failed');
          await sendMessage(msg.chat_jid, `❌ Model unavailable: ${resolved}\nHTTP ${resp.status}: ${body.slice(0, 200)}`);
          return;
        }
      } catch (err) {
        logger.warn({ model: resolved, err }, 'Model validation request failed');
        await sendMessage(msg.chat_jid, `❌ Cannot reach model: ${resolved}\n${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }

    setModelOverride(currentAgent, resolved);
    logger.info({ chatJid: msg.chat_jid, agent: currentAgent, model: resolved }, 'Model override set');
    await sendMessage(msg.chat_jid, `✅ Model switched for ${currentAgent}: ${resolved}`);
    return;
  }

  // Handle /effort command - switch Codex reasoning effort
  const effortMatch = content.match(/^\/effort(?:\s+(.+))?$/i);
  if (effortMatch) {
    const currentAgent = getGroupAgent(group);
    if (currentAgent !== 'codex') {
      await sendMessage(msg.chat_jid, '⚠️ /effort only applies to Codex. Switch with /agent codex first.');
      return;
    }

    const effortArg = effortMatch[1]?.trim().toLowerCase();
    const validEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

    if (!effortArg) {
      const currentEffort = getCodexReasoningEffort() || '(default)';
      await sendMessage(
        msg.chat_jid,
        `Current effort: ${currentEffort}\n\nUsage: /effort <none|minimal|low|medium|high|xhigh>\nReset: /effort default`
      );
      return;
    }

    if (effortArg === 'default' || effortArg === 'reset') {
      setCodexReasoningEffort(null);
      logger.info({ chatJid: msg.chat_jid }, 'Codex reasoning effort cleared');
      await sendMessage(msg.chat_jid, '✅ Codex reasoning effort reset to default.');
      return;
    }

    if (!validEfforts.has(effortArg)) {
      await sendMessage(msg.chat_jid, 'Usage: /effort <none|minimal|low|medium|high|xhigh>');
      return;
    }

    setCodexReasoningEffort(effortArg);
    logger.info({ chatJid: msg.chat_jid, effort: effortArg }, 'Codex reasoning effort set');
    await sendMessage(msg.chat_jid, `✅ Codex reasoning effort set to: ${effortArg}`);
    return;
  }

  // Main group responds to all messages; for non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false && !TRIGGER_PATTERN.test(content)) return;

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
    const mediaAttr = m.media_path ? ` media="/workspace/group/media/${path.basename(m.media_path)}"` : '';

    // If this is a reply, include the original message content (already extracted from Telegram)
    const replyAttr = m.reply_to_content ? ` reply_to="${escapeXml(m.reply_to_content)}"` : '';

    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"${mediaAttr}${replyAttr}>${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  if (!prompt) return;

  logger.info({ group: group.name, messageCount: missedMessages.length }, 'Processing message');

  // Send typing indicator every 4 seconds while agent is running
  await setTyping(msg.chat_jid, true);
  const typingInterval = setInterval(() => {
    setTyping(msg.chat_jid, true).catch(() => {});
  }, 4000);

  let response: AgentResponse | 'error';
  try {
    response = await runAgent(group, prompt, msg.chat_jid);
  } finally {
    clearInterval(typingInterval);
  }

  if (response === 'error') {
    // Container or agent error — don't advance cursor, will retry
    return;
  }

  // Process any IPC messages from this agent run BEFORE deciding to send result
  // This ensures send_message calls take precedence over result
  const ipcMessagesSent = await processGroupIpcMessages(group.folder, isMainGroup);
  const sentToThisChat = ipcMessagesSent.includes(msg.chat_jid);

  // Update timestamp — agent processed successfully (whether it responded or stayed silent)
  lastAgentTimestamp[msg.chat_jid] = msg.timestamp;

  if (response.outputType === 'message' && response.userMessage && !sentToThisChat) {
    await sendMessage(msg.chat_jid, response.userMessage);
  } else if (sentToThisChat) {
    logger.debug({ chatJid: msg.chat_jid }, 'Skipping result send - IPC message already sent');
  }

  if (response.internalLog) {
    logger.info(
      { group: group.name, outputType: response.outputType },
      `Agent: ${response.internalLog}`,
    );
  }
}

async function runAgent(group: RegisteredGroup, prompt: string, chatJid: string): Promise<AgentResponse | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const agent = getGroupAgent(group);
  // Use chat_jid as session key so each platform gets its own session context
  const sessionKey = chatJid;
  const sessionId = getSessionForAgent(sessionKey, agent);

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
      isMain,
      agent
    });

    if (output.newSessionId) {
      setSessionForAgent(sessionKey, agent, output.newSessionId);
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
    }

    if (output.status === 'error') {
      // Check for token overflow errors - clear session so next message starts fresh
      const errorStr = output.error || '';
      if (/prompt_tokens_exceeded|context_window|token.*limit|max.*context/i.test(errorStr)) {
        logger.warn({ group: group.name, agent, error: errorStr }, 'Token overflow detected, clearing session');
        const entry = sessions[sessionKey];
        if (entry && typeof entry !== 'string') {
          delete entry[agent];
        } else if (typeof entry === 'string' && agent === 'claude') {
          delete sessions[sessionKey];
        }
        saveJson(path.join(DATA_DIR, 'sessions.json'), sessions);
      }
      logger.error({ group: group.name, error: output.error }, 'Container agent error');
      return 'error';
    }

    return output.result ?? { outputType: 'log' };
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

      // IPC message files are handled inline after agent runs to preserve send_message precedence.
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
        if (messages.length > 0) {
          logger.info({ chatJid: jid, count: messages.length }, 'New messages');
        }

        for (const msg of messages) {
          try {
            await processMessage(msg);
            // Only advance cursor after successful processing for at-least-once delivery
            if (typeof msg.row_id === 'number') {
              lastRowIdByChat[jid] = msg.row_id;
            }
            lastTimestampByChat[jid] = msg.timestamp;
            if (!lastTimestamp || msg.timestamp > lastTimestamp) {
              lastTimestamp = msg.timestamp;
            }
            saveState();
          } catch (err) {
            logger.error({ err, msg: msg.id }, 'Error processing message, will retry');
            // Stop processing this chat - failed message will be retried next loop
            break;
          }
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

    // Also rollback container images if we have backups
    const hasClaudeBackup = containerRebuildState.claude?.hasBackup;
    const hasCodexBackup = containerRebuildState.codex?.hasBackup;
    if (hasClaudeBackup || hasCodexBackup) {
      logger.warn('Rolling back container images to :backup...');
      if (hasClaudeBackup) {
        rollbackContainerImage(CONTAINER_IMAGE_CLAUDE, 'claude');
      }
      if (hasCodexBackup) {
        rollbackContainerImage(CONTAINER_IMAGE_CODEX, 'codex');
      }
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

  // Start core message processing (not channel-specific)
  startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    processIpcMessages: processGroupIpcMessages
  });
  startIpcWatcher();
  startMessageLoop();

  startRollbackMonitor();
}

main().catch(err => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
