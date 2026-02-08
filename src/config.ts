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

export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'nanoclaw-agent:v3';
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '300000', 10);
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
export const MODEL_OVERRIDE_PATH = path.join(DATA_DIR, 'model_override.json');

export const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4.6',
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-4.5',
};

export function getModelOverride(): string | null {
  try {
    if (fs.existsSync(MODEL_OVERRIDE_PATH)) {
      const data = JSON.parse(fs.readFileSync(MODEL_OVERRIDE_PATH, 'utf-8'));
      return data.model || null;
    }
  } catch { /* ignore */ }
  return null;
}

export function setModelOverride(model: string | null): void {
  if (model) {
    fs.mkdirSync(path.dirname(MODEL_OVERRIDE_PATH), { recursive: true });
    fs.writeFileSync(MODEL_OVERRIDE_PATH, JSON.stringify({ model }, null, 2));
  } else {
    try { fs.unlinkSync(MODEL_OVERRIDE_PATH); } catch { /* ignore */ }
  }
}
