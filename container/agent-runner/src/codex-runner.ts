/**
 * NanoClaw Codex Runner
 * Runs Codex SDK inside container, receives config via stdin, outputs result to stdout
 * Supports multi-turn conversations via IPC polling
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Codex, Thread } from '@openai/codex-sdk';
import type { AgentMessageItem } from '@openai/codex-sdk';

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
  additionalProperties: false,
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
  required: ['outputType', 'userMessage', 'internalLog'],
} as const;

interface ContainerOutput {
  status: 'success' | 'error';
  result: AgentResponse | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Known model context windows (tokens). Used to set compact thresholds
// since Codex can't fetch the model catalog when using API key auth.
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5.2-codex': 272_000,
  'gpt-5.2': 128_000,
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 1_000_000,
  'gpt-4.1-nano': 1_000_000,
  'o3': 200_000,
  'o4-mini': 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 128_000;

function getContextWindow(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  // Longest prefix match (exact first, then prefix) — matches Codex's own logic
  let best: { slug: string; window: number } | null = null;
  for (const [slug, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(slug)) {
      if (!best || slug.length > best.slug.length) {
        best = { slug, window };
      }
    }
  }
  return best?.window ?? DEFAULT_CONTEXT_WINDOW;
}

// --- IPC infrastructure ---

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

// --- Core utilities ---

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[codex-runner] ${message}`);
}

function safeReadFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function buildPrompt(input: ContainerInput): string {
  const parts: string[] = [];

  if (input.isScheduledTask) {
    parts.push('[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]');
  }

  parts.push(input.prompt);
  return parts.filter(Boolean).join('\n\n');
}

function escapeTomlString(s: string): string {
  // Use TOML multi-line basic string (""") for content with newlines
  if (s.includes('\n')) {
    // Escape backslashes and triple-quotes inside the value
    const escaped = s.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"');
    return `"""\n${escaped}"""`;
  }
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function writeCodexConfig(): void {
  const configDir = '/home/node/.codex';
  fs.mkdirSync(configDir, { recursive: true });

  const modelOverride = process.env.CODEX_MODEL?.trim();
  const effortOverride = process.env.CODEX_MODEL_REASONING_EFFORT?.trim();

  const lines: string[] = [
    'web_search = "disabled"',
  ];

  if (modelOverride) {
    const safeModel = modelOverride.replace(/"/g, '\\"');
    lines.push(`model = "${safeModel}"`);
  }

  // Set context window and compact limit based on model
  const contextWindow = getContextWindow(modelOverride);
  const compactLimit = Math.floor(contextWindow * 0.8);
  lines.push(`model_context_window = ${contextWindow}`);
  lines.push(`model_auto_compact_token_limit = ${compactLimit}`);

  if (effortOverride) {
    const safeEffort = effortOverride.replace(/"/g, '\\"');
    lines.push(`model_reasoning_effort = "${safeEffort}"`);
  }

  // Load global CLAUDE.md as user-level instructions
  const globalPaths = [
    '/workspace/global/CLAUDE.md',
    '/workspace/project/groups/CLAUDE.md'
  ];
  for (const candidate of globalPaths) {
    const content = safeReadFile(candidate);
    if (content) {
      lines.push(`instructions = ${escapeTomlString(content.trim())}`);
      break;
    }
  }

  // Let Codex auto-discover group CLAUDE.md as project-level instructions
  lines.push('project_doc_fallback_filenames = ["CLAUDE.md"]');

  lines.push(
    '',
    '[mcp_servers.nanoclaw]',
    'command = "node"',
    'args = ["/app/dist/ipc-mcp-stdio.js"]',
    'env_vars = ["NANOCLAW_CHAT_JID", "NANOCLAW_GROUP_FOLDER", "NANOCLAW_IS_MAIN", "NANOCLAW_IS_SCHEDULED_TASK"]',
  );

  if (process.env.BRAVE_API_KEY) {
    lines.push('', '[mcp_servers.brave-search]');
    lines.push('command = "npx"');
    lines.push('args = ["-y", "@brave/brave-search-mcp-server"]');
    lines.push('env_vars = ["BRAVE_API_KEY"]');
  }

  fs.writeFileSync(path.join(configDir, 'config.toml'), lines.join('\n') + '\n');
}

// --- SDK client ---

function createCodexClient(): Codex {
  return new Codex({
    apiKey: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY,
    env: process.env as Record<string, string>,
  });
}

// --- Turn execution ---

async function runCodexTurn(
  thread: Thread,
  prompt: string,
): Promise<{
  newSessionId?: string;
  error?: string;
  closedDuringTurn: boolean;
}> {
  let newSessionId: string | undefined;
  let error: string | undefined;
  let closedDuringTurn = false;

  // AbortController to cancel the turn when close sentinel is detected
  const abortController = new AbortController();

  // Start IPC polling during turn
  const pollHandle = setInterval(() => {
    if (shouldClose()) {
      closedDuringTurn = true;
      abortController.abort();
      clearInterval(pollHandle);
    }
  }, IPC_POLL_MS);

  try {
    const streamedResult = await thread.runStreamed(prompt, {
      outputSchema: AGENT_RESPONSE_SCHEMA,
      signal: abortController.signal,
    });

    for await (const event of streamedResult.events) {
      switch (event.type) {
        case 'thread.started':
          newSessionId = event.thread_id;
          log(`Thread started: ${newSessionId}`);
          break;

        case 'item.completed': {
          if (event.item.type === 'agent_message') {
            const text = (event.item as AgentMessageItem).text;
            // Try to parse as structured AgentResponse
            let result: AgentResponse | null = null;
            try {
              const parsed = JSON.parse(text);
              if (parsed.outputType === 'message' || parsed.outputType === 'log') {
                result = parsed as AgentResponse;
                if (result.outputType === 'message' && !result.userMessage) {
                  result = { outputType: 'log', internalLog: result.internalLog };
                }
              }
            } catch {
              // Not JSON — treat as plain message
              result = { outputType: 'message', userMessage: text };
            }
            if (result) {
              writeOutput({ status: 'success', result, newSessionId });
            }
          }
          break;
        }

        case 'turn.completed':
          log(`Turn completed`);
          break;

        case 'turn.failed':
          error = event.error.message;
          log(`Turn failed: ${error}`);
          break;

        case 'error':
          error = event.message;
          log(`Thread error: ${error}`);
          break;
      }
    }
  } catch (err) {
    // Abort errors are expected when close sentinel is detected
    if (!closedDuringTurn) {
      error = err instanceof Error ? err.message : String(err);
      log(`runCodexTurn error: ${error}`);
    }
  } finally {
    clearInterval(pollHandle);
  }

  return { newSessionId, error, closedDuringTurn };
}

// --- Memory file auto-commit ---

function autoCommitMemoryFiles(groupFolder: string): void {
  if (!fs.existsSync('/workspace/project/.git')) return;

  let status = '';
  try {
    status = execSync('git status --porcelain', {
      cwd: '/workspace/project',
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch {
    return;
  }

  const files = status
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.slice(3))
    .map(file => {
      const arrow = file.indexOf(' -> ');
      return arrow >= 0 ? file.slice(arrow + 4) : file;
    })
    .filter(file => {
      const ext = path.extname(file).toLowerCase();
      if (ext !== '.md' && ext !== '.txt') return false;
      if (file.startsWith('groups/')) return true;
      return file.startsWith(`groups/${groupFolder}/`);
    });

  if (files.length === 0) return;

  try {
    const quotedFiles = files.map(f => `"${f}"`).join(' ');
    execSync(`git add ${quotedFiles}`, {
      cwd: '/workspace/project',
      stdio: 'pipe'
    });

    execSync('git commit -m "Auto-save: memory files" --author="Andy <andy@nanoclaw.local>" --no-verify', {
      cwd: '/workspace/project',
      stdio: 'pipe'
    });

    log(`Auto-committed memory files: ${files.join(', ')}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (!errMsg.includes('nothing to commit')) {
      log(`Auto-commit skipped or failed: ${errMsg}`);
    }
  }
}

// --- Main entry point ---

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

  process.env.NANOCLAW_CHAT_JID = input.chatJid;
  process.env.NANOCLAW_GROUP_FOLDER = input.groupFolder;
  process.env.NANOCLAW_IS_MAIN = input.isMain ? 'true' : 'false';
  process.env.NANOCLAW_IS_SCHEDULED_TASK = input.isScheduledTask ? 'true' : 'false';
  if (!process.env.CODEX_API_KEY && process.env.OPENAI_API_KEY) {
    process.env.CODEX_API_KEY = process.env.OPENAI_API_KEY;
  }

  try {
    writeCodexConfig();
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to prepare Codex config: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const codex = createCodexClient();
  const thread = input.sessionId
    ? codex.resumeThread(input.sessionId, {
        workingDirectory: '/workspace/group',
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      })
    : codex.startThread({
        workingDirectory: '/workspace/group',
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      });

  // Drain any IPC messages that arrived before we started
  let prompt = buildPrompt(input);
  const earlyPrompts = drainIpcInput();
  if (earlyPrompts.length > 0) {
    prompt += '\n' + earlyPrompts.join('\n');
  }

  try {
    log('Starting Codex agent...');

    // First turn
    let turnResult = await runCodexTurn(thread, prompt);

    if (turnResult.error && !turnResult.closedDuringTurn) {
      // If the first turn errored with no output at all, emit error
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: turnResult.newSessionId,
        error: turnResult.error,
      });
      process.exit(1);
    }

    // Auto-commit memory files after each turn
    if (input.isMain) {
      autoCommitMemoryFiles(input.groupFolder);
    }

    // Multi-turn loop: wait for follow-up messages until _close
    while (!turnResult.closedDuringTurn) {
      // Emit session-update marker so host can track the session
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: turnResult.newSessionId,
      });

      log('Waiting for next IPC message...');
      const nextPrompt = await waitForIpcMessage();

      if (nextPrompt === null) {
        log('Close sentinel detected, exiting');
        break;
      }

      log('Received follow-up message, running next turn...');
      turnResult = await runCodexTurn(thread, nextPrompt);

      // Emit error to host if follow-up turn failed
      if (turnResult.error) {
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: turnResult.newSessionId,
          error: turnResult.error,
        });
      }

      if (input.isMain) {
        autoCommitMemoryFiles(input.groupFolder);
      }
    }

    log('Codex agent session ended');

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
