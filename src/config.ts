import fs from 'fs';
import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'nanoclaw', 'mount-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const DEFAULT_AGENT = (process.env.NANOCLAW_DEFAULT_AGENT || 'claude').toLowerCase();
export const CONTAINER_IMAGE_CLAUDE = process.env.CONTAINER_IMAGE_CLAUDE
  || process.env.CONTAINER_IMAGE
  || 'nanoclaw-agent:latest';
export const CONTAINER_IMAGE_CODEX = process.env.CONTAINER_IMAGE_CODEX || 'nanoclaw-codex:latest';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10); // 30min default for streaming
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min idle before closing container
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10));
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const IPC_POLL_INTERVAL = 1000;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(`^@${escapeRegex(ASSISTANT_NAME)}\\b`, 'i');

// Timezone for scheduled tasks (cron expressions, etc.)
// Default to Asia/Shanghai (Beijing time) if not set
export const TIMEZONE = process.env.TZ || 'Asia/Shanghai';

// Model override: switch model via /model command
const CLAUDE_MODEL_OVERRIDE_PATH = path.join(DATA_DIR, 'claude_model_override.json');
const CODEX_MODEL_OVERRIDE_PATH = path.join(DATA_DIR, 'codex_model_override.json');
const CODEX_EFFORT_OVERRIDE_PATH = path.join(DATA_DIR, 'codex_effort_override.json');

export const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4.6',
  sonnet: 'claude-sonnet-4.5',
  haiku: 'claude-haiku-4.5',
};

export function getModelOverride(agent: 'claude' | 'codex'): string | null {
  const targetPath = agent === 'codex' ? CODEX_MODEL_OVERRIDE_PATH : CLAUDE_MODEL_OVERRIDE_PATH;
  try {
    if (fs.existsSync(targetPath)) {
      const data = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
      return data.model || null;
    }
  } catch { /* ignore */ }
  return null;
}

export function setModelOverride(agent: 'claude' | 'codex', model: string | null): void {
  const targetPath = agent === 'codex' ? CODEX_MODEL_OVERRIDE_PATH : CLAUDE_MODEL_OVERRIDE_PATH;
  if (model) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify({ model }, null, 2));
  } else {
    try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
  }
}

export function getCodexReasoningEffort(): string | null {
  try {
    if (fs.existsSync(CODEX_EFFORT_OVERRIDE_PATH)) {
      const data = JSON.parse(fs.readFileSync(CODEX_EFFORT_OVERRIDE_PATH, 'utf-8'));
      return data.effort || null;
    }
  } catch { /* ignore */ }
  return null;
}

export function setCodexReasoningEffort(effort: string | null): void {
  if (effort) {
    fs.mkdirSync(path.dirname(CODEX_EFFORT_OVERRIDE_PATH), { recursive: true });
    fs.writeFileSync(CODEX_EFFORT_OVERRIDE_PATH, JSON.stringify({ effort }, null, 2));
  } else {
    try { fs.unlinkSync(CODEX_EFFORT_OVERRIDE_PATH); } catch { /* ignore */ }
  }
}
