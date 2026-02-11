import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { proto } from '@whiskeysockets/baileys';
import { NewMessage, ScheduledTask, TaskRunLog } from './types.js';
import { STORE_DIR, DATA_DIR } from './config.js';
import { loadJson, saveJson } from './utils.js';
import { logger } from './logger.js';

let db: Database.Database;

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);
  `);

  // Add sender_name column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN sender_name TEXT`);
  } catch { /* column already exists */ }

  // Add media_path column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN media_path TEXT`);
  } catch { /* column already exists */ }

  // Add reply_to_id column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id TEXT`);
  } catch { /* column already exists */ }

  // Add reply_to_content column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN reply_to_content TEXT`);
  } catch { /* column already exists */ }

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`);
  } catch { /* column already exists */ }
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(chatJid: string, timestamp: string, name?: string): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(`
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(`
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `).run(chatJid, chatJid, timestamp);
  }
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db.prepare(`
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `).all() as ChatInfo[];
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: proto.IWebMessageInfo, chatJid: string, isFromMe: boolean, pushName?: string, mediaPath?: string, replyToContent?: string): void {
  if (!msg.key) return;

  const content =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    '';

  const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();
  const sender = msg.key.participant || msg.key.remoteJid || '';
  const senderName = pushName || sender.split('@')[0];
  const msgId = msg.key.id || '';

  db.prepare(`INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_path, reply_to_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(msgId, chatJid, sender, senderName, content, timestamp, isFromMe ? 1 : 0, mediaPath || null, replyToContent || null);
}

/**
 * Store a message directly without the legacy WhatsApp/Baileys proto dependency.
 * Used by Telegram, Feishu, and other non-Baileys channels.
 */
export function storeMessageDirect(params: {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  mediaPath?: string;
  replyToContent?: string;
}): void {
  db.prepare(`INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, media_path, reply_to_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(params.id, params.chatJid, params.sender, params.senderName, params.content, params.timestamp, params.isFromMe ? 1 : 0, params.mediaPath || null, params.replyToContent || null);
}

export function getMessagesSince(chatJid: string, sinceTimestamp: string, botPrefix: string): NewMessage[] {
  // Filter out bot's own messages by checking content prefix
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, media_path, reply_to_content
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

export function getMessagesSinceRowId(chatJid: string, sinceRowId: number, botPrefix: string): NewMessage[] {
  const sql = `
    SELECT rowid as row_id, id, chat_jid, sender, sender_name, content, timestamp, media_path, reply_to_content
    FROM messages
    WHERE chat_jid = ? AND rowid > ? AND content NOT LIKE ?
    ORDER BY rowid
  `;
  return db.prepare(sql).all(chatJid, sinceRowId, `${botPrefix}:%`) as NewMessage[];
}

export function getMaxRowIdBefore(chatJid: string, timestamp: string, botPrefix: string): number {
  const sql = `
    SELECT MAX(rowid) as max_rowid
    FROM messages
    WHERE chat_jid = ? AND timestamp <= ? AND content NOT LIKE ?
  `;
  const row = db.prepare(sql).get(chatJid, timestamp, `${botPrefix}:%`) as { max_rowid?: number } | undefined;
  return row?.max_rowid ?? 0;
}

export function createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void {
  db.prepare(`
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined;
}

export function getAllTasks(): ScheduledTask[] {
  return db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[];
}

export function updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt); }
  if (updates.schedule_type !== undefined) { fields.push('schedule_type = ?'); values.push(updates.schedule_type); }
  if (updates.schedule_value !== undefined) { fields.push('schedule_value = ?'); values.push(updates.schedule_value); }
  if (updates.next_run !== undefined) { fields.push('next_run = ?'); values.push(updates.next_run); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `).all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(log.task_id, log.run_at, log.duration_ms, log.status, log.result, log.error);
}

/**
 * One-time migration: add 'tg:' prefix to all existing chat IDs.
 * This enables multi-channel support (Telegram + Feishu).
 * Idempotent — skips if already migrated (marker file).
 */
export function migrateAddChannelPrefix(): void {
  const markerPath = path.join(DATA_DIR, '.migrated-channel-prefix');
  if (fs.existsSync(markerPath)) return;

  logger.info('Running one-time channel prefix migration...');

  // 1. Migrate DB tables (disable FK checks during migration)
  db.exec(`
    PRAGMA foreign_keys = OFF;

    UPDATE chats SET jid = 'tg:' || jid
    WHERE jid NOT LIKE 'tg:%' AND jid NOT LIKE 'fs:%' AND jid != '__group_sync__';

    UPDATE messages SET chat_jid = 'tg:' || chat_jid
    WHERE chat_jid NOT LIKE 'tg:%' AND chat_jid NOT LIKE 'fs:%';

    UPDATE scheduled_tasks SET chat_jid = 'tg:' || chat_jid
    WHERE chat_jid NOT LIKE 'tg:%' AND chat_jid NOT LIKE 'fs:%';

    PRAGMA foreign_keys = ON;
  `);

  // 2. Migrate registered_groups.json
  const groupsPath = path.join(DATA_DIR, 'registered_groups.json');
  if (fs.existsSync(groupsPath)) {
    const groups = loadJson<Record<string, unknown>>(groupsPath, {});
    const migrated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(groups)) {
      const newKey = (key.startsWith('tg:') || key.startsWith('fs:')) ? key : `tg:${key}`;
      migrated[newKey] = value;
    }
    saveJson(groupsPath, migrated);
    logger.info({ count: Object.keys(migrated).length }, 'Migrated registered_groups.json');
  }

  // 3. Migrate sessions.json
  const sessionsPath = path.join(DATA_DIR, 'sessions.json');
  if (fs.existsSync(sessionsPath)) {
    const sessions = loadJson<Record<string, unknown>>(sessionsPath, {});
    const migrated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sessions)) {
      const newKey = (key.startsWith('tg:') || key.startsWith('fs:')) ? key : `tg:${key}`;
      migrated[newKey] = value;
    }
    saveJson(sessionsPath, migrated);
    logger.info({ count: Object.keys(migrated).length }, 'Migrated sessions.json');
  }

  // 4. Migrate router_state.json (last_agent_timestamp keys)
  const statePath = path.join(DATA_DIR, 'router_state.json');
  if (fs.existsSync(statePath)) {
    const state = loadJson<{ last_timestamp?: string; last_agent_timestamp?: Record<string, string> }>(statePath, {});
    if (state.last_agent_timestamp) {
      const migrated: Record<string, string> = {};
      for (const [key, value] of Object.entries(state.last_agent_timestamp)) {
        const newKey = (key.startsWith('tg:') || key.startsWith('fs:')) ? key : `tg:${key}`;
        migrated[newKey] = value;
      }
      state.last_agent_timestamp = migrated;
      saveJson(statePath, state);
      logger.info('Migrated router_state.json');
    }
  }

  // Write marker
  fs.writeFileSync(markerPath, new Date().toISOString());
  logger.info('Channel prefix migration complete');
}
