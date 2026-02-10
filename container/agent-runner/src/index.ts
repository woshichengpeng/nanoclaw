/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Supports streaming mode: stays alive accepting follow-up messages via IPC.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { query, HookCallback, PreCompactHookInput, PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
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

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

// ── Streaming infrastructure ────────────────────────────────────────

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: ''  // SDK fills this in
    };
    this.queue.push(msg);
    if (this.waiting) {
      this.waiting();
      this.waiting = null;
    }
  }

  end(): void {
    this.done = true;
    if (this.waiting) {
      this.waiting();
      this.waiting = null;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        await new Promise<void>(resolve => { this.waiting = resolve; });
      }
    }
  }
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
    .sort(); // Process in order
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

// ── Session helpers ─────────────────────────────────────────────────

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  // sessions-index.json is in the same directory as the transcript
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

// ── Hooks ───────────────────────────────────────────────────────────

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
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

    return {};
  };
}

/**
 * Auto-commit memory files (.md, .txt) after Edit/Write operations.
 * Only runs for main channel which has access to /workspace/project.
 */
function createAutoCommitHook(groupFolder: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const postToolUse = input as PostToolUseHookInput;
    const toolName = postToolUse.tool_name;

    // Only handle Edit and Write tools
    if (toolName !== 'Edit' && toolName !== 'Write') {
      return {};
    }

    const toolInput = postToolUse.tool_input as { file_path?: string };
    const filePath = toolInput?.file_path;

    if (!filePath) {
      return {};
    }

    // Check if it's a memory file we should auto-commit
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.md' && ext !== '.txt') {
      return {};
    }

    // Only auto-commit files in specific directories
    const isGroupMemory = filePath.startsWith('/workspace/group/');
    const isProjectMemory = filePath.startsWith('/workspace/project/groups/');

    if (!isGroupMemory && !isProjectMemory) {
      return {};
    }

    // Check if we have access to the project (main channel only)
    if (!fs.existsSync('/workspace/project/.git')) {
      return {};
    }

    try {
      // Map container path to git path
      let gitPath: string;
      if (isGroupMemory) {
        // /workspace/group/foo.md -> groups/{groupFolder}/foo.md
        gitPath = filePath.replace('/workspace/group/', `groups/${groupFolder}/`);
      } else {
        // /workspace/project/... -> ...
        gitPath = filePath.replace('/workspace/project/', '');
      }

      const fileName = path.basename(filePath);

      // Stage and commit
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
      // Commit might fail if there are no changes (file content unchanged)
      // This is expected and not an error
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!errMsg.includes('nothing to commit')) {
        log(`Auto-commit skipped or failed: ${errMsg}`);
      }
    }

    return {};
  };
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

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
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

// ── Query runner ────────────────────────────────────────────────────

async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
  resumeAt?: string
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  let closedDuringQuery = false;

  // Poll IPC input during query — push follow-up messages into the stream
  const pollHandle = setInterval(() => {
    if (shouldClose()) {
      closedDuringQuery = true;
      stream.end();
      clearInterval(pollHandle);
      return;
    }
    const prompts = drainIpcInput();
    for (const p of prompts) {
      stream.push(p);
    }
  }, IPC_POLL_MS);

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;

  try {
    for await (const message of query({
      prompt: stream,
      options: {
        cwd: '/workspace/group',
        resume: sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: globalClaudeMd
          ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
          : undefined,
        allowedTools: [
          'Bash',
          'Read', 'Write', 'Edit', 'Glob', 'Grep',
          'WebFetch',
          'Task', 'TaskOutput', 'TaskStop',
          'TeamCreate', 'TeamDelete', 'SendMessage',
          'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
          'mcp__nanoclaw__*',
          'mcp__brave-search__*'
        ],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: ['/app/dist/ipc-mcp-stdio.js'],
            env: {
              NANOCLAW_CHAT_JID: containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
              NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
              NANOCLAW_IS_SCHEDULED_TASK: containerInput.isScheduledTask ? '1' : '0',
            },
          },
          ...(process.env.BRAVE_API_KEY ? {
            'brave-search': {
              command: 'npx',
              args: ['-y', '@brave/brave-search-mcp-server'],
              env: { BRAVE_API_KEY: process.env.BRAVE_API_KEY }
            }
          } : {})
        },
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook()] }],
          ...(containerInput.isMain ? {
            PostToolUse: [{ matcher: 'Edit|Write', hooks: [createAutoCommitHook(containerInput.groupFolder)] }]
          } : {})
        },
        outputFormat: {
          type: 'json_schema',
          schema: AGENT_RESPONSE_SCHEMA,
        }
      }
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if (message.type === 'assistant') {
        lastAssistantUuid = message.uuid;
      }

      if (message.type === 'result') {
        let result: AgentResponse | null = null;
        if (message.subtype === 'success' && message.structured_output) {
          result = message.structured_output as AgentResponse;
          if (result.outputType === 'message' && !result.userMessage) {
            result = { outputType: 'log', internalLog: result.internalLog };
          }
        } else if (message.subtype === 'success' || message.subtype === 'error_max_structured_output_retries') {
          const textResult = 'result' in message ? (message as { result?: string }).result : null;
          if (textResult) {
            result = { outputType: 'message', userMessage: textResult };
          }
        }
        if (result) {
          writeOutput({ status: 'success', result, newSessionId });
        }
      }
    }
  } finally {
    clearInterval(pollHandle);
  }

  return { newSessionId, lastAssistantUuid, closedDuringQuery };
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

  // Check if session file exists before trying to resume
  let sessionToResume = input.sessionId;
  if (sessionToResume) {
    const sessionFile = path.join(
      process.env.HOME || '/home/node',
      '.claude/projects/-workspace-group',
      `${sessionToResume}.jsonl`
    );
    if (!fs.existsSync(sessionFile)) {
      log(`Session file not found, starting fresh: ${sessionToResume}`);
      sessionToResume = undefined;
    }
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

    // First query
    let queryResult = await runQuery(prompt, sessionToResume, input);

    // Streaming loop: wait for follow-up messages until _close
    while (!queryResult.closedDuringQuery) {
      // Emit session-update marker so host can track the session
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: queryResult.newSessionId
      });

      log('Waiting for next IPC message...');
      const nextPrompt = await waitForIpcMessage();

      if (nextPrompt === null) {
        // _close sentinel found
        log('Close sentinel detected, exiting');
        break;
      }

      log(`Received follow-up message, resuming query...`);
      queryResult = await runQuery(
        nextPrompt,
        queryResult.newSessionId,
        input,
        queryResult.lastAssistantUuid
      );
    }

    log('Agent session ended');

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
