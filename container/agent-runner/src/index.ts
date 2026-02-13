/**
 * NanoClaw Agent Runner (Pi SDK)
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Supports streaming mode: stays alive accepting follow-up messages via IPC.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent
} from '@mariozechner/pi-coding-agent';
import type { Message, TextContent } from '@mariozechner/pi-ai';
import { createIpcTools } from './ipc-tools.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  model?: string;
  thinkingLevel?: string;
}

interface AgentResponse {
  outputType: 'message' | 'log';
  userMessage?: string;
  internalLog?: string;
}

const AGENT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    outputType: {
      type: 'string',
      enum: ['message', 'log'],
      description: '"message": the userMessage field contains a message to send to the user or group. "log": the output will not be sent to the user or group.',
    },
    userMessage: {
      type: 'string',
      description: 'A message to send to the user or group. Include when outputType is "message".',
    },
    internalLog: {
      type: 'string',
      description: 'Information that will be logged internally but not sent to the user or group.',
    },
  },
  required: ['outputType'],
} as const;

interface ContainerOutput {
  status: 'success' | 'error';
  result: AgentResponse | null;
  newSessionId?: string;
  error?: string;
}

// ── IPC Input Polling ───────────────────────────────────────────────

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

function shouldClose(): boolean {
  return fs.existsSync(IPC_INPUT_CLOSE_SENTINEL);
}

function drainIpcInput(): string[] {
  if (!fs.existsSync(IPC_INPUT_DIR)) return [];
  const files = fs.readdirSync(IPC_INPUT_DIR)
    .filter(f => f.endsWith('.json'))
    .sort();
  const prompts: string[] = [];
  for (const file of files) {
    const filePath = path.join(IPC_INPUT_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.prompt) prompts.push(data.prompt);
      fs.unlinkSync(filePath);
    } catch (err) {
      log(`Failed to read IPC input ${file}: ${err}`);
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
  return prompts;
}

async function waitForIpcMessage(): Promise<string | null> {
  while (true) {
    if (shouldClose()) return null;
    const prompts = drainIpcInput();
    if (prompts.length > 0) return prompts.join('\n');
    await new Promise(resolve => setTimeout(resolve, IPC_POLL_MS));
  }
}

// ── I/O helpers ─────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// ── Transcript helpers ──────────────────────────────────────────────

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function extractMessageText(message: Message): string {
  if (!message || typeof message !== 'object' || !('role' in message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part) {
          return (part as TextContent).text || '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

function extractTranscriptMessages(messages: Message[]): ParsedMessage[] {
  const parsed: ParsedMessage[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || !('role' in message)) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = extractMessageText(message).trim();
    if (!text) continue;
    parsed.push({ role: message.role, content: text });
  }
  return parsed;
}

function buildConversationSummary(messages: ParsedMessage[]): string | null {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return null;
  const summary = firstUser.content.replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  return summary.slice(0, 80);
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function archiveConversation(sessionManager: SessionManager): void {
  try {
    const context = sessionManager.buildSessionContext();
    const messages = extractTranscriptMessages(context.messages as Message[]);
    if (messages.length === 0) {
      log('No messages to archive');
      return;
    }

    const summary = buildConversationSummary(messages);
    const name = summary ? sanitizeFilename(summary) : generateFallbackName();

    const conversationsDir = '/workspace/group/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const markdown = formatTranscriptMarkdown(messages, summary);
    fs.writeFileSync(filePath, markdown);

    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Memory Auto-commit ──────────────────────────────────────────────

function autoCommitMemoryFile(filePath: string, groupFolder: string): void {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.md' && ext !== '.txt') {
    return;
  }

  const isGroupMemory = filePath.startsWith('/workspace/group/');
  const isProjectMemory = filePath.startsWith('/workspace/project/');

  if (!isGroupMemory && !isProjectMemory) {
    return;
  }

  if (!fs.existsSync('/workspace/project/.git')) {
    return;
  }

  try {
    let gitPath: string;
    if (isGroupMemory) {
      gitPath = filePath.replace('/workspace/group/', `groups/${groupFolder}/`);
    } else {
      gitPath = filePath.replace('/workspace/project/', '');
    }

    const fileName = path.basename(filePath);

    execSync(`git add "${gitPath}"`, {
      cwd: '/workspace/project',
      stdio: 'pipe'
    });

    execSync(`git commit -m "Auto-save: ${fileName}" --author="Andy <andy@nanoclaw.local>" --no-verify`, {
      cwd: '/workspace/project',
      stdio: 'pipe'
    });

    log(`Auto-committed memory file: ${gitPath}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!errMsg.includes('nothing to commit')) {
      log(`Auto-commit skipped or failed: ${errMsg}`);
    }
  }
}

// ── Output Parsing ──────────────────────────────────────────────────

function parseAgentResponse(text: string): AgentResponse | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as AgentResponse;
      if (parsed.outputType === 'message' || parsed.outputType === 'log') {
        if (parsed.outputType === 'message' && !parsed.userMessage) {
          return { outputType: 'log', internalLog: parsed.internalLog };
        }
        return parsed;
      }
    } catch {
      // try next candidate
    }
  }

  // Fallback: try to fix malformed JSON (e.g. unescaped quotes in string values).
  // Models sometimes produce JSON like:
  //   {"outputType":"message","userMessage":"text with "quotes" inside"}
  // where the inner quotes break JSON.parse. We escape them and retry.
  for (const candidate of candidates) {
    const fixed = fixMalformedAgentJson(candidate);
    if (fixed) return fixed;
  }

  return { outputType: 'message', userMessage: trimmed };
}

/**
 * Attempt to fix and parse malformed JSON where string values contain unescaped
 * double quotes. Strategy: find the value of userMessage/internalLog by locating
 * the field key, then extract the raw content between known boundaries, escape
 * the inner quotes, and parse the repaired JSON.
 */
function fixMalformedAgentJson(text: string): AgentResponse | null {
  // Must have an outputType to be our expected schema
  const outputTypeMatch = text.match(/"outputType"\s*:\s*"(message|log)"/);
  if (!outputTypeMatch) return null;
  const outputType = outputTypeMatch[1] as 'message' | 'log';

  const userMessage = extractFieldFromMalformedJson(text, 'userMessage');
  const internalLog = extractFieldFromMalformedJson(text, 'internalLog');

  if (outputType === 'message' && userMessage) {
    log('Recovered userMessage from malformed JSON (unescaped quotes in model output)');
    return { outputType, userMessage, internalLog: internalLog || undefined };
  }
  if (outputType === 'message') {
    // message with no userMessage → demote to log (matches main parser behavior)
    return { outputType: 'log', internalLog: internalLog || undefined };
  }
  // outputType === 'log'
  return { outputType, internalLog: internalLog || undefined };
}

/**
 * Extract a string field from malformed JSON. Locates the field key pattern
 * ("fieldName":"), then finds the value's end by searching backwards from
 * known boundary patterns (next field key or closing brace).
 */
function extractFieldFromMalformedJson(json: string, fieldName: string): string | null {
  // Find "fieldName" : " with flexible whitespace
  const keyPattern = new RegExp(`"${fieldName}"\\s*:\\s*"`);
  const keyMatch = keyPattern.exec(json);
  if (!keyMatch) return null;
  const valueStart = keyMatch.index + keyMatch[0].length;

  // Determine where this field's value ends.
  // We look for the LAST occurrence of `"` that is followed by either:
  //   ,"<knownField>" (another field in the object)
  //   }              (end of object — possibly with whitespace)
  // We search from the end of the string backwards.
  const knownFields = ['outputType', 'userMessage', 'internalLog'];
  const endMarkers: number[] = [];

  for (const field of knownFields) {
    if (field === fieldName) continue;
    // Look for , "fieldName" after our value start (with optional whitespace)
    // Note: if the value itself contains this pattern, we may truncate early.
    // This is an inherent limitation of parsing malformed JSON, but acceptable
    // since this is already a fallback path for invalid model output.
    const delimPattern = new RegExp(`,\\s*"${field}"`);
    const delimMatch = delimPattern.exec(json.slice(valueStart));
    if (delimMatch) {
      const pos = valueStart + delimMatch.index;
      // Pattern: ...value text here","nextField"...
      // The closing quote of our value is just before the comma
      if (pos > valueStart && json[pos - 1] === '"') {
        endMarkers.push(pos - 1); // position of the closing quote
      }
    }
  }

  // Also check for "} at end of object
  const lastBrace = json.lastIndexOf('}');
  if (lastBrace > valueStart) {
    // Walk back from } to find the closing "
    let i = lastBrace - 1;
    while (i > valueStart && (json[i] === ' ' || json[i] === '\n' || json[i] === '\r' || json[i] === '\t')) i--;
    if (json[i] === '"') {
      endMarkers.push(i);
    }
  }

  if (endMarkers.length === 0) return null;

  // Take the earliest end marker (smallest position) — this field ends before the next field starts
  const valueEnd = Math.min(...endMarkers);
  if (valueEnd <= valueStart) return null;

  const rawValue = json.slice(valueStart, valueEnd);

  // Unescape JSON escape sequences in a single pass to avoid double-processing.
  // E.g., \\n in the raw value is a literal backslash-n pair (escaped backslash + n),
  // not a newline. A sequential replace would incorrectly convert \\\\ → \\ then \\n → newline.
  return rawValue.replace(/\\([\\"ntr])/g, (_match, ch) => {
    switch (ch) {
      case '\\': return '\\';
      case '"': return '"';
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      default: return ch;
    }
  });
}

// ── Session setup ───────────────────────────────────────────────────

const OUTPUT_FORMAT_PROMPT = `You MUST respond with a single JSON object matching this schema:\n${JSON.stringify(AGENT_RESPONSE_SCHEMA, null, 2)}\n\nReturn ONLY valid JSON. Do not wrap in markdown. Do not include any extra text.`;

function parseModelSpec(spec?: string): { provider: string; modelId: string } | null {
  if (!spec) return null;
  const trimmed = spec.trim();
  if (!trimmed) return null;
  const parts = trimmed.includes('/') ? trimmed.split('/') : trimmed.split(':');
  if (parts.length < 2) return null;
  const provider = parts[0];
  const modelId = parts.slice(1).join('/');
  if (!provider || !modelId) return null;
  return { provider, modelId };
}

function normalizeThinkingLevel(level?: string): 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (!level) return undefined;
  const trimmed = level.trim().toLowerCase();
  if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(trimmed)) {
    return trimmed as 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  }
  return undefined;
}

async function createSession(input: ContainerInput): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
  const cwd = '/workspace/group';
  const sessionDir = '/workspace/sessions';
  const agentDir = process.env.PI_CODING_AGENT_DIR || '/home/node/.pi/agent';

  let sessionManager: SessionManager;
  if (input.sessionId && fs.existsSync(input.sessionId)) {
    sessionManager = SessionManager.open(input.sessionId, sessionDir);
  } else {
    if (input.sessionId) {
      log(`Session file not found, starting fresh: ${input.sessionId}`);
    }
    sessionManager = SessionManager.create(cwd, sessionDir);
  }

  const authPath = agentDir ? path.join(agentDir, 'auth.json') : undefined;
  const modelsPath = agentDir ? path.join(agentDir, 'models.json') : undefined;
  const authStorage = new AuthStorage(authPath);
  const modelRegistry = new ModelRegistry(authStorage, modelsPath);

  let model = undefined;
  const parsedModel = parseModelSpec(input.model);
  if (parsedModel) {
    model = modelRegistry.find(parsedModel.provider, parsedModel.modelId);
    if (!model) {
      log(`Requested model not found: ${parsedModel.provider}/${parsedModel.modelId}`);
    }
  }

  const appendPrompts: string[] = [OUTPUT_FORMAT_PROMPT];
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  if (!input.isMain && fs.existsSync(globalClaudeMdPath)) {
    appendPrompts.unshift(fs.readFileSync(globalClaudeMdPath, 'utf-8'));
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: [
      '/app/skills',
      '/workspace/project/.claude/skills',
      '/workspace/project/.pi/skills',
      '/workspace/group/.claude/skills',
      '/workspace/group/.pi/skills'
    ],
    appendSystemPromptOverride: (base) => [...base, ...appendPrompts.filter(Boolean)],
  });
  await resourceLoader.reload();

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager,
    resourceLoader,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: normalizeThinkingLevel(input.thinkingLevel),
    tools: createCodingTools(cwd),
    customTools: createIpcTools({
      chatJid: input.chatJid,
      groupFolder: input.groupFolder,
      isMain: input.isMain,
      isScheduledTask: input.isScheduledTask
    })
  });

  if (modelFallbackMessage) {
    log(modelFallbackMessage);
  }

  return { session, sessionManager };
}

function subscribeSessionHooks(session: AgentSession, sessionManager: SessionManager, input: ContainerInput): () => void {
  const pendingToolPaths = new Map<string, string>();

  return session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'auto_compaction_start') {
      archiveConversation(sessionManager);
      return;
    }

    if (event.type === 'tool_execution_start') {
      if (event.toolName === 'edit' || event.toolName === 'write') {
        const args = event.args as { path?: string };
        const rawPath = args?.path;
        if (rawPath && typeof rawPath === 'string') {
          const resolved = path.isAbsolute(rawPath)
            ? rawPath
            : path.resolve('/workspace/group', rawPath);
          pendingToolPaths.set(event.toolCallId, resolved);
        }
      }
      return;
    }

    if (event.type === 'tool_execution_end') {
      const filePath = pendingToolPaths.get(event.toolCallId);
      if (!filePath) return;
      pendingToolPaths.delete(event.toolCallId);
      if (event.isError) return;
      if (input.isMain) {
        autoCommitMemoryFile(filePath, input.groupFolder);
      }
    }
  });
}

// ── Query runner ────────────────────────────────────────────────────

// If no SDK events arrive within this window, assume the API call is hung.
const API_STALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const MAX_STALL_RETRIES = 2;

async function runQuery(
  session: AgentSession,
  sessionManager: SessionManager,
  prompt: string
): Promise<{ newSessionId?: string; closedDuringQuery: boolean }> {
  let closedDuringQuery = false;
  let lastAssistant: Message | undefined;
  let stallDetected = false;
  let stallRetries = 0;

  // Inactivity watchdog: abort if no SDK events for API_STALL_TIMEOUT_MS
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallDetected = true;
      stallRetries++;
      log(`No SDK activity for ${API_STALL_TIMEOUT_MS / 1000}s, aborting (stall ${stallRetries}/${MAX_STALL_RETRIES})`);
      session.abort().catch(() => undefined);
    }, API_STALL_TIMEOUT_MS);
  };
  resetStallTimer();

  let turnCount = 0;
  let eventCount = 0;
  let lastEventType = '';
  let lastEventTime = Date.now();

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // Any event = API is alive, reset watchdog
    resetStallTimer();
    eventCount++;
    const now = Date.now();
    const gap = now - lastEventTime;
    lastEventTime = now;

    // Log every event type with timing (debug level)
    if (event.type !== lastEventType || gap > 5000) {
      log(`[event #${eventCount}] ${event.type} (${gap}ms since last)`);
      lastEventType = event.type;
    }

    if (event.type === 'turn_start') {
      turnCount++;
      log(`[turn ${turnCount}] started`);
    }

    if (event.type === 'turn_end') {
      lastAssistant = event.message as Message;
      const msg = event.message as any;
      const stopReason = msg?.stopReason || 'unknown';
      const errorMessage = msg?.errorMessage || '';
      const contentSummary = Array.isArray(msg?.content)
        ? msg.content.map((c: any) => {
            if (c.type === 'text') return `text(${(c.text || '').length} chars)`;
            if (c.type === 'toolCall') return `toolCall(${c.name}, args=${JSON.stringify(c.arguments || {}).length} chars)`;
            return c.type;
          }).join(', ')
        : 'non-array';
      log(`[turn ${turnCount}] ended: stopReason=${stopReason}, error=${errorMessage || 'none'}, content=[${contentSummary}]`);
    }

    if (event.type === 'message_start') {
      log(`[message_start] role=${(event as any).message?.role || 'unknown'}`);
    }

    if (event.type === 'message_end') {
      const msg = event.message as any;
      const stopReason = msg?.stopReason || 'unknown';
      const errorMessage = msg?.errorMessage || '';
      log(`[message_end] role=${msg?.role || 'unknown'}, stopReason=${stopReason}, error=${errorMessage || 'none'}`);
    }

    if (event.type === 'tool_execution_start') {
      const te = event as any;
      log(`[tool_start] ${te.toolName} (id=${te.toolCallId})`);
    }

    if (event.type === 'tool_execution_end') {
      const te = event as any;
      const isError = te.isError || false;
      log(`[tool_end] ${te.toolName} (id=${te.toolCallId}, error=${isError})`);
    }

    // Log auto-compaction and retry events
    if (event.type === 'auto_compaction_start') {
      log(`[auto_compaction_start] reason=${(event as any).reason}`);
    }
    if (event.type === 'auto_compaction_end') {
      log(`[auto_compaction_end] aborted=${(event as any).aborted}, willRetry=${(event as any).willRetry}, error=${(event as any).errorMessage || 'none'}`);
    }
    if (event.type === 'auto_retry_start') {
      log(`[auto_retry_start] attempt=${(event as any).attempt}/${(event as any).maxAttempts}, delay=${(event as any).delayMs}ms, error=${(event as any).errorMessage}`);
    }
    if (event.type === 'auto_retry_end') {
      log(`[auto_retry_end] success=${(event as any).success}, attempt=${(event as any).attempt}, finalError=${(event as any).finalError || 'none'}`);
    }
  });

  const pollHandle = setInterval(() => {
    if (shouldClose()) {
      closedDuringQuery = true;
      session.abort().catch(() => undefined);
      clearInterval(pollHandle);
    }
  }, IPC_POLL_MS);

  try {
    // Retry loop for API stalls
    while (true) {
      stallDetected = false;
      log(`Calling session.prompt() (${prompt.length} chars)...`);
      const promptStart = Date.now();
      await session.prompt(prompt);
      const promptDuration = Date.now() - promptStart;

      log(`session.prompt() returned after ${promptDuration}ms (stallDetected=${stallDetected}, events=${eventCount}, turns=${turnCount})`);

      if (stallDetected && stallRetries < MAX_STALL_RETRIES) {
        log(`API stall detected, retrying (${stallRetries}/${MAX_STALL_RETRIES})...`);
        resetStallTimer();
        continue;
      }
      break;
    }

    const text = lastAssistant ? extractMessageText(lastAssistant) : '';
    log(`Final assistant text: ${text.length} chars, first 200: ${text.slice(0, 200)}`);

    // Log the last assistant message details for debugging aborts
    if (lastAssistant) {
      const msg = lastAssistant as any;
      log(`Final assistant stopReason=${msg.stopReason || 'unknown'}, errorMessage=${msg.errorMessage || 'none'}`);
      if (msg.stopReason === 'aborted') {
        log(`WARNING: Last assistant message was aborted! Content types: ${
          Array.isArray(msg.content) 
            ? msg.content.map((c: any) => `${c.type}${c.type === 'toolCall' ? `(${c.name})` : ''}`).join(', ')
            : 'unknown'
        }`);
      }
    } else {
      log(`WARNING: No lastAssistant message captured after prompt()`);
    }

    const result = parseAgentResponse(text);
    if (result) {
      log(`Parsed response: outputType=${result.outputType}, hasUserMessage=${!!result.userMessage}, hasLog=${!!result.internalLog}`);
      writeOutput({
        status: 'success',
        result,
        newSessionId: sessionManager.getSessionFile()
      });
    } else {
      log(`WARNING: parseAgentResponse returned null for text of ${text.length} chars`);
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    clearInterval(pollHandle);
    unsubscribe();
  }

  return { newSessionId: sessionManager.getSessionFile(), closedDuringQuery };
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    log(`Received input for group: ${input.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Add context for scheduled tasks
  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${input.prompt}`;
  }

  // Drain any IPC messages that arrived before we started
  const earlyPrompts = drainIpcInput();
  if (earlyPrompts.length > 0) {
    prompt += '\n' + earlyPrompts.join('\n');
  }

  try {
    log('Starting agent...');

    const { session, sessionManager } = await createSession(input);
    const unsubscribe = subscribeSessionHooks(session, sessionManager, input);

    try {
      let queryResult = await runQuery(session, sessionManager, prompt);

      while (!queryResult.closedDuringQuery) {
        writeOutput({
          status: 'success',
          result: null,
          newSessionId: queryResult.newSessionId
        });

        log('Waiting for next IPC message...');
        const nextPrompt = await waitForIpcMessage();

        if (nextPrompt === null) {
          log('Close sentinel detected, exiting');
          break;
        }

        log('Received follow-up message, resuming query...');
        queryResult = await runQuery(session, sessionManager, nextPrompt);
      }

      log('Agent session ended');
    } finally {
      unsubscribe();
      session.dispose();
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
