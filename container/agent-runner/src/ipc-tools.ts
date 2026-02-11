/**
 * IPC-based tools for NanoClaw
 * Writes messages and tasks to files for the host process to pick up
 */

import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { Type, type Static } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

export interface IpcToolContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function okResult(text: string, details?: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text }],
    details
  };
}

export function createIpcTools(ctx: IpcToolContext): ToolDefinition[] {
  const { chatJid, groupFolder, isMain, isScheduledTask } = ctx;

  const sendMessageParams = Type.Object({
    text: Type.String({ description: 'The message text to send' })
  });

  const sendFileParams = Type.Object({
    file_path: Type.String({ description: 'Absolute path to the file inside the container' }),
    caption: Type.Optional(Type.String({ description: 'Optional caption/message to accompany the file' })),
    force_document: Type.Optional(Type.Boolean({ description: 'Force sending as document even if it is an image (default: false)' }))
  });

  const scheduleType = Type.Union([
    Type.Literal('cron'),
    Type.Literal('interval'),
    Type.Literal('once')
  ], { description: 'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time' });

  const contextMode = Type.Union([
    Type.Literal('group'),
    Type.Literal('isolated')
  ], { description: 'group=runs with chat history and memory, isolated=fresh session (include context in prompt)' });

  const scheduleTaskParams = Type.Object({
    prompt: Type.String({ description: 'What the agent should do when the task runs. For isolated mode, include all necessary context here.' }),
    schedule_type: scheduleType,
    schedule_value: Type.String({ description: 'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix)' }),
    context_mode: Type.Optional(contextMode),
    ...(isMain ? {
      target_group_jid: Type.Optional(Type.String({
        description: 'JID of the group to schedule the task for. The group must be registered — look up JIDs in /workspace/project/data/registered_groups.json (the keys are JIDs). If the group is not registered, let the user know and ask if they want to activate it. Defaults to the current group.'
      }))
    } : {})
  });

  const taskIdParams = Type.Object({
    task_id: Type.String({ description: 'The task ID to update' })
  });

  const registerGroupParams = Type.Object({
    jid: Type.String({ description: 'The chat JID with prefix (e.g., "tg:123456789" or "fs:oc_xxx")' }),
    name: Type.String({ description: 'Display name for the group' }),
    folder: Type.String({ description: 'Folder name for group files (lowercase, hyphens, e.g., "family-chat")' }),
    trigger: Type.String({ description: 'Trigger word (e.g., "@Andy")' })
  });

  return [
    {
      name: 'send_message',
      label: 'send_message',
      description: 'Send a message to the user or group. The message is delivered immediately while you are still running. You can call this multiple times to send multiple messages.',
      parameters: sendMessageParams,
      execute: async (_toolCallId, args: Static<typeof sendMessageParams>) => {
        const data = {
          type: 'message',
          chatJid,
          text: args.text,
          groupFolder,
          broadcast: !!isScheduledTask,
          timestamp: new Date().toISOString()
        };

        const filename = writeIpcFile(MESSAGES_DIR, data);

        return okResult(`Message sent (${filename}).`, { filename });
      }
    },
    {
      name: 'send_file',
      label: 'send_file',
      description: `Send a file to the current chat. Supports images, documents, and other files.

File path must be accessible within the container (e.g., /workspace/group/... or /workspace/project/...).
For images (jpg, jpeg, png, gif, webp), the file is sent as a photo. Otherwise, it's sent as a document.

Size limits: 10 MB for photos, 50 MB for other files.`,
      parameters: sendFileParams,
      execute: async (_toolCallId, args: Static<typeof sendFileParams>) => {
        if (!fs.existsSync(args.file_path)) {
          throw new Error(`File not found: ${args.file_path}`);
        }

        const stats = fs.statSync(args.file_path);
        const sizeMB = stats.size / (1024 * 1024);
        const ext = path.extname(args.file_path).toLowerCase();
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const isImage = imageExtensions.includes(ext) && !args.force_document;

        const maxSize = isImage ? 10 : 50;
        if (sizeMB > maxSize) {
          throw new Error(`File too large (${sizeMB.toFixed(1)} MB). Max: ${maxSize} MB for ${isImage ? 'photos' : 'documents'}.`);
        }

        const data = {
          type: 'file',
          chatJid,
          filePath: args.file_path,
          caption: args.caption,
          isImage,
          groupFolder,
          broadcast: !!isScheduledTask,
          timestamp: new Date().toISOString()
        };

        const filename = writeIpcFile(MESSAGES_DIR, data);

        return okResult(`File queued for delivery (${filename}): ${path.basename(args.file_path)}${isImage ? ' (as photo)' : ' (as document)'}`, { filename });
      }
    },
    {
      name: 'schedule_task',
      label: 'schedule_task',
      description: `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
• "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
• "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" → group (needs conversation context)
- "Check the weather every morning" → isolated (self-contained task)
- "Follow up on my request" → group (needs to know what was requested)
- "Generate a daily report" → isolated (just needs instructions in prompt)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
      parameters: scheduleTaskParams,
      execute: async (_toolCallId, args: Static<typeof scheduleTaskParams>) => {
        if (args.schedule_type === 'cron') {
          try {
            CronExpressionParser.parse(args.schedule_value);
          } catch (err) {
            throw new Error(`Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`);
          }
        } else if (args.schedule_type === 'interval') {
          const ms = parseInt(args.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            throw new Error(`Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`);
          }
        } else if (args.schedule_type === 'once') {
          const date = new Date(args.schedule_value);
          if (isNaN(date.getTime())) {
            throw new Error(`Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00" (no Z suffix).`);
          }
        }

        const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

        const data = {
          type: 'schedule_task',
          prompt: args.prompt,
          schedule_type: args.schedule_type,
          schedule_value: args.schedule_value,
          context_mode: args.context_mode || 'group',
          targetJid,
          createdBy: groupFolder,
          timestamp: new Date().toISOString()
        };

        const filename = writeIpcFile(TASKS_DIR, data);

        return okResult(`Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}`, { filename });
      }
    },
    {
      name: 'list_tasks',
      label: 'list_tasks',
      description: 'List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group\'s tasks.',
      parameters: Type.Object({}),
      execute: async () => {
        const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
        if (!fs.existsSync(tasksFile)) {
          return okResult('No scheduled tasks found.');
        }

        const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
        const tasks = isMain
          ? allTasks
          : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

        if (tasks.length === 0) {
          return okResult('No scheduled tasks found.');
        }

        const formatted = tasks.map((t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
          `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`
        ).join('\n');

        return okResult(`Scheduled tasks:\n${formatted}`);
      }
    },
    {
      name: 'pause_task',
      label: 'pause_task',
      description: 'Pause a scheduled task. It will not run until resumed.',
      parameters: taskIdParams,
      execute: async (_toolCallId, args: Static<typeof taskIdParams>) => {
        const data = {
          type: 'pause_task',
          taskId: args.task_id,
          groupFolder,
          isMain,
          timestamp: new Date().toISOString()
        };

        writeIpcFile(TASKS_DIR, data);

        return okResult(`Task ${args.task_id} pause requested.`);
      }
    },
    {
      name: 'resume_task',
      label: 'resume_task',
      description: 'Resume a paused task.',
      parameters: taskIdParams,
      execute: async (_toolCallId, args: Static<typeof taskIdParams>) => {
        const data = {
          type: 'resume_task',
          taskId: args.task_id,
          groupFolder,
          isMain,
          timestamp: new Date().toISOString()
        };

        writeIpcFile(TASKS_DIR, data);

        return okResult(`Task ${args.task_id} resume requested.`);
      }
    },
    {
      name: 'cancel_task',
      label: 'cancel_task',
      description: 'Cancel and delete a scheduled task.',
      parameters: taskIdParams,
      execute: async (_toolCallId, args: Static<typeof taskIdParams>) => {
        const data = {
          type: 'cancel_task',
          taskId: args.task_id,
          groupFolder,
          isMain,
          timestamp: new Date().toISOString()
        };

        writeIpcFile(TASKS_DIR, data);

        return okResult(`Task ${args.task_id} cancellation requested.`);
      }
    },
    {
      name: 'register_group',
      label: 'register_group',
      description: `Register a new Telegram or Feishu chat so the agent can respond to messages there. Main group only.

JID format:
- Telegram: "tg:<chat_id>" (e.g., "tg:123456789")
- Feishu: "fs:<chat_id>"

The folder name should be lowercase with hyphens (e.g., "family-chat"). The "main" folder is reserved for the Telegram admin channel.`,
      parameters: registerGroupParams,
      execute: async (_toolCallId, args: Static<typeof registerGroupParams>) => {
        if (!isMain) {
          throw new Error('Only the main group can register new groups.');
        }

        const data = {
          type: 'register_group',
          jid: args.jid,
          name: args.name,
          folder: args.folder,
          trigger: args.trigger,
          timestamp: new Date().toISOString()
        };

        writeIpcFile(TASKS_DIR, data);

        return okResult(`Group "${args.name}" registered. It will start receiving messages immediately.`);
      }
    },
    {
      name: 'request_restart',
      label: 'request_restart',
      description: `Request the NanoClaw service to restart. Use this after making code changes that need to take effect.

Main channel only. The service will restart gracefully after a short delay.

**Important:** Make sure you have committed your code changes before requesting a restart, otherwise they will be rolled back!`,
      parameters: Type.Object({}),
      execute: async () => {
        if (!isMain) {
          throw new Error('Only the main channel can request service restarts.');
        }

        const data = {
          type: 'request_restart',
          groupFolder,
          timestamp: new Date().toISOString()
        };

        writeIpcFile(TASKS_DIR, data);

        return okResult('Service restart requested. The service will restart in a few seconds. Your current session will end.');
      }
    },
    {
      name: 'rebuild_container',
      label: 'rebuild_container',
      description: `Rebuild the agent container image. Main channel only.

Use this after making changes to container code (Dockerfile, agent-runner, etc.).

**Workflow:**
1. Make changes to container code (but DON'T commit yet)
2. Call this tool to rebuild and restart
3. Test that the new container works
4. If working: commit the changes (this finalizes the new image)
5. If broken: wait for 30-min git rollback (container will also rollback automatically)`,
      parameters: Type.Object({}),
      execute: async () => {
        if (!isMain) {
          throw new Error('Only the main channel can rebuild containers.');
        }

        const data = {
          type: 'rebuild_container',
          groupFolder,
          timestamp: new Date().toISOString()
        };

        writeIpcFile(TASKS_DIR, data);

        return okResult('Container rebuild requested. Will backup current image and build new one.');
      }
    }
  ];
}
