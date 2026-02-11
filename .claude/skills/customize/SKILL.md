---
name: customize
description: Add new capabilities or modify NanoClaw behavior. Use when the user wants to add channels (Telegram/Feishu/Slack/etc.), change triggers, add tools/integrations, adjust routing, or otherwise customize the system. This is an interactive skill that asks questions to understand what the user wants.
---

# NanoClaw Customization (Pi SDK)

This skill helps users add capabilities or modify behavior. Use **AskUserQuestion** to gather requirements before making changes.

## Workflow

1. **Understand the request** – Ask clarifying questions.
2. **Plan the changes** – Identify files to modify and expected behavior.
3. **Implement** – Make code changes directly.
4. **Test guidance** – Tell the user how to verify.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: routing, command handling, channel wiring, IPC |
| `src/config.ts` | Trigger pattern, defaults, model overrides, timeouts |
| `src/telegram.ts` | Telegram input/output + media handling |
| `src/feishu.ts` | Feishu/Lark input/output + media handling |
| `src/container-runner.ts` | Spawns Pi SDK container, mounts, env injection |
| `container/agent-runner/src/index.ts` | Pi SDK session setup, skill loader, tool wiring |
| `container/agent-runner/src/ipc-tools.ts` | IPC tools (`send_message`, `schedule_task`, `register_group`, etc.) |
| `src/task-scheduler.ts` | Scheduled task loop + execution |
| `src/db.ts` | SQLite storage for chats/messages/tasks |
| `src/mount-security.ts` | External mount allowlist validation |
| `data/registered_groups.json` | Registered groups and their folders/triggers |
| `groups/*/CLAUDE.md` | Per-group memory/persona |
| `groups/global/CLAUDE.md` | Global read-only memory for non-main groups |

## Common Customization Patterns

### Adding a New Input Channel (Telegram, Feishu, Slack, Email, etc.)

Questions to ask:
- Which channel (Telegram, Feishu/Lark, Slack, Discord, email, SMS)?
- Do we need a new JID prefix (e.g., `tg:`, `fs:`, `sl:`)?
- Same trigger word or a different trigger per channel?
- Should it share existing group folders or use separate ones?

Implementation pattern:
1. Create a channel module (e.g., `src/slack.ts`) modeled after `src/telegram.ts`.
2. Wire it in `src/index.ts`:
   - Extend the `Channel` type and `getChannelFromJid()`.
   - Add `setup<Channel>()` initialization.
   - Update `sendMessage`, `sendFile`, and `setTyping` to route by prefix.
3. Ensure messages are stored with `storeMessageDirect()` and metadata with `storeChatMetadata()`.
4. Update `data/registered_groups.json` for the new channel JIDs.
5. Add env vars to `.env` if required (tokens, secrets) and use them in the channel module.

### Adding Tools/Integrations (Pi SDK)

Questions to ask:
- What service or capability? (calendar, database, CRM, etc.)
- Should it run **inside** the container or on the host?
- Should the tool be available to all groups or only main?

Implementation options:
1. **Custom Pi tool**: add to `container/agent-runner/src/ipc-tools.ts` and handle the IPC message in `src/index.ts` (or a new host handler).
2. **Skill-only integration**: add a skill to `.claude/skills/<skill>/SKILL.md` or `container/skills/` if it’s container-only.
3. **Code-level integration**: implement directly in the host process (`src/index.ts`, `src/db.ts`) and expose via IPC tools.

### Changing Assistant Behavior

Questions to ask:
- Which aspect? (name, trigger, persona, response style)
- Apply to all groups or a specific one?

Implementation:
- Trigger/name → `src/config.ts` + update CLAUDE.md references
- Global persona → `groups/global/CLAUDE.md`
- Per-group persona → `groups/<folder>/CLAUDE.md`

### Adding New Commands

Questions to ask:
- What should the command do?
- Available in all groups or main only?
- Does it need a new Pi tool or IPC action?

Implementation:
1. Add parsing logic in `handleCommand()` in `src/index.ts`.
2. Ensure commands run before trigger checks.
3. Add any new IPC tool if you need container-side calls.

### Adjusting Scheduled Tasks

Questions to ask:
- Does the task need group context or isolated mode?
- Is it one-time, interval, or cron?

Implementation:
- Tool definitions → `container/agent-runner/src/ipc-tools.ts`
- Host handling → `src/index.ts` (IPC) + `src/task-scheduler.ts`

### Mounting External Directories

Questions to ask:
- Which directories should be mounted?
- Read-write or read-only?
- Should non-main groups be restricted to read-only?

Implementation:
1. Update the allowlist at `~/.config/nanoclaw/mount-allowlist.json`.
2. Add mounts per group in `data/registered_groups.json` under `containerConfig.additionalMounts`.
3. Mount validation is enforced by `src/mount-security.ts`.

## After Changes

**Host code changes only**:
```bash
npm run build
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

**If you changed container/agent-runner or container/skills**:
```bash
./container/build.sh
npm run build
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Example Interaction

User: "Add a Feishu channel in addition to Telegram"

1. Ask: "Should Feishu share the same group folders as Telegram, or use separate ones?"
2. Ask: "Should Feishu use the same trigger word?"
3. Add `src/feishu.ts` (if missing) and wire it in `src/index.ts`.
4. Update `data/registered_groups.json` with `fs:<chat_id>` entries.
5. Provide authentication/setup steps and verify with a test message.
