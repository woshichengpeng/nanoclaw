/**
 * NanoClaw Codex Runner
 * Runs Codex CLI inside container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';

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

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const SCHEMA_PATH = '/tmp/agent_response_schema.json';
const OUTPUT_PATH = '/tmp/agent_output.json';

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

  const globalPaths = [
    '/workspace/global/CLAUDE.md',
    '/workspace/project/groups/CLAUDE.md'
  ];

  let globalClaudeMd: string | null = null;
  for (const candidate of globalPaths) {
    const content = safeReadFile(candidate);
    if (content) {
      globalClaudeMd = content;
      break;
    }
  }

  const groupClaudeMd = safeReadFile('/workspace/group/CLAUDE.md');

  if (globalClaudeMd) {
    parts.push(`[GLOBAL CLAUDE.md]\n${globalClaudeMd.trim()}\n[/GLOBAL CLAUDE.md]`);
  }

  if (groupClaudeMd) {
    parts.push(`[GROUP CLAUDE.md]\n${groupClaudeMd.trim()}\n[/GROUP CLAUDE.md]`);
  }

  if (input.isScheduledTask) {
    parts.push('[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]');
  }

  parts.push(input.prompt);
  return parts.filter(Boolean).join('\n\n');
}

function writeCodexSchema(): void {
  fs.writeFileSync(SCHEMA_PATH, JSON.stringify(AGENT_RESPONSE_SCHEMA, null, 2));
}

function writeCodexConfig(): void {
  const configDir = '/home/node/.codex';
  fs.mkdirSync(configDir, { recursive: true });

  const lines: string[] = [
    '[mcp_servers.nanoclaw]',
    'command = "node"',
    'args = ["/app/dist/ipc-mcp-stdio.js"]',
    'env_vars = ["NANOCLAW_CHAT_JID", "NANOCLAW_GROUP_FOLDER", "NANOCLAW_IS_MAIN", "NANOCLAW_IS_SCHEDULED_TASK"]',
  ];

  if (process.env.BRAVE_API_KEY) {
    lines.push('', '[mcp_servers.brave-search]');
    lines.push('command = "npx"');
    lines.push('args = ["-y", "@brave/brave-search-mcp-server"]');
    lines.push('env_vars = ["BRAVE_API_KEY"]');
  }

  fs.writeFileSync(path.join(configDir, 'config.toml'), lines.join('\n') + '\n');
}

function parseAgentMessage(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  if (record.type !== 'agent_message') return undefined;
  if (typeof record.text === 'string') return record.text;
  const content = record.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textParts = (content as Array<Record<string, unknown>>)
      .map(part => typeof part.text === 'string' ? part.text : '')
      .filter(Boolean);
    if (textParts.length > 0) return textParts.join('');
  }
  if (content && typeof content === 'object') {
    const contentRecord = content as Record<string, unknown>;
    if (typeof contentRecord.text === 'string') return contentRecord.text;
  }
  return undefined;
}

async function runCodex(prompt: string, sessionId?: string): Promise<{
  output: AgentResponse | null;
  newSessionId?: string;
  error?: string;
  lastAgentMessage?: string;
}> {
  const args: string[] = [];
  if (sessionId) {
    args.push('exec', 'resume', sessionId);
  } else {
    args.push('exec');
  }

  args.push(
    '--json',
    '--output-schema', SCHEMA_PATH,
    '-o', OUTPUT_PATH,
    '--full-auto',
    '--sandbox', 'danger-full-access',
    '--skip-git-repo-check',
    prompt
  );

  let stdoutBuffer = '';
  let stderrBuffer = '';
  let newSessionId: string | undefined;
  let lastAgentMessage: string | undefined;

  const child = spawn('codex', args, {
    cwd: '/workspace/group',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (data) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
          newSessionId = event.thread_id;
        }
        if (event.type === 'item.completed') {
          const item = (event as { item?: unknown }).item;
          const message = parseAgentMessage(item);
          if (message) lastAgentMessage = message;
        }
      } catch {
        // Ignore malformed JSON lines
      }
    }
  });

  child.stderr.on('data', (data) => {
    const chunk = data.toString();
    stderrBuffer += chunk;
    if (stderrBuffer.length > 4000) {
      stderrBuffer = stderrBuffer.slice(-4000);
    }
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });

  if (stdoutBuffer.trim()) {
    try {
      const event = JSON.parse(stdoutBuffer.trim()) as Record<string, unknown>;
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        newSessionId = event.thread_id;
      }
      if (event.type === 'item.completed') {
        const item = (event as { item?: unknown }).item;
        const message = parseAgentMessage(item);
        if (message) lastAgentMessage = message;
      }
    } catch {
      // Ignore trailing partial JSON
    }
  }

  if (exitCode !== 0) {
    return {
      output: null,
      newSessionId,
      error: `Codex exited with code ${exitCode}: ${stderrBuffer.trim()}`,
      lastAgentMessage
    };
  }

  let output: AgentResponse | null = null;
  try {
    if (fs.existsSync(OUTPUT_PATH)) {
      output = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8')) as AgentResponse;
    }
  } catch {
    output = null;
  }

  if (output && output.outputType === 'message' && !output.userMessage) {
    output = { outputType: 'log', internalLog: output.internalLog };
  }
  if (output && output.outputType !== 'message' && output.outputType !== 'log') {
    output = null;
  }

  return { output, newSessionId, lastAgentMessage };
}

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
    writeCodexSchema();
    writeCodexConfig();
    try { fs.unlinkSync(OUTPUT_PATH); } catch { /* ignore */ }
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to prepare Codex config: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const prompt = buildPrompt(input);

  try {
    const { output, newSessionId, error, lastAgentMessage } = await runCodex(prompt, input.sessionId);

    let result: AgentResponse | null = output;
    if (!result && lastAgentMessage) {
      result = { outputType: 'message', userMessage: lastAgentMessage };
    }

    if (input.isMain) {
      autoCommitMemoryFiles(input.groupFolder);
    }

    if (error) {
      writeOutput({
        status: 'error',
        result: null,
        newSessionId,
        error
      });
      process.exit(1);
    }

    writeOutput({
      status: 'success',
      result: result ?? { outputType: 'log' },
      newSessionId
    });
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: err instanceof Error ? err.message : String(err)
    });
    process.exit(1);
  }
}

main();
