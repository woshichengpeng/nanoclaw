---
name: debug
description: Debug Pi agent container issues in NanoClaw. Use when agents fail, containers crash, auth breaks, or IPC/session storage is acting up.
---

# NanoClaw (Pi SDK) Debugging Guide

Use this guide when container runs fail, agents exit unexpectedly, or sessions/IPCs don’t behave as expected. Commands assume you are in the repository root.

## Architecture Overview

```
Host (macOS)                                           Container (Linux VM)
──────────────────────────────────────────────────────────────────────────────
src/container-runner.ts                               container/agent-runner
  │                                                     │
  │ spawns Apple Container                              │ runs Pi Coding Agent SDK
  │ sets mounts + env file                              │ handles streaming + IPC
  │                                                     │
  ├── project root (main only) ─────────────────────▶ /workspace/project
  ├── groups/{folder} ─────────────────────────────▶ /workspace/group
  ├── groups/global (non-main, RO) ─────────────────▶ /workspace/global
  ├── data/sessions/{group}/{jid}/pi-sessions ─────▶ /workspace/sessions
  ├── ~/.pi/agent or $PI_CODING_AGENT_DIR ─────────▶ /home/node/.pi/agent
  ├── data/ipc/{group} ───────────────────────────▶ /workspace/ipc
  ├── data/env (filtered env) ─────────────────────▶ /workspace/env-dir (RO)
  └── allowlisted extra mounts ────────────────────▶ /workspace/extra/<path>
```

**Runtime facts**
- Container user: `node` (HOME=`/home/node`).
- Pi agent config lives at `/home/node/.pi/agent` (mounted from host).
- Session files live at `/workspace/sessions` (mounted from host).
- IPC is per-group under `data/ipc/{group}` for isolation.

## Log Locations

| Log | Location | Notes |
| --- | --- | --- |
| Main app logs | `logs/nanoclaw.log` | Router, Telegram/Feishu, container spawn |
| Main app errors | `logs/nanoclaw.error.log` | Host-side errors |
| Container run logs | `groups/{folder}/logs/container-*.log` | Per-run stderr/stdout + mounts |
| Sessions index | `data/sessions.json` | Maps chat JID → session file path |

## Debug Logging

Enable verbose logging:

```bash
LOG_LEVEL=debug npm run dev
# or LOG_LEVEL=trace for even more detail
```

Debug/trace shows:
- Full container args and mounts
- Streaming output markers
- Container stderr in real time

## Environment Variables & Auth

Apple Container drops `-e` vars when used with `-i`. NanoClaw writes a filtered `.env` to `data/env/env`, which is mounted into `/workspace/env-dir/env` and sourced by the container entrypoint.

**Whitelisted env vars** (copied from `.env`):
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT`
- `GOOGLE_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, `COHERE_API_KEY`
- `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION`
- `PI_CODING_AGENT_DIR`, `PI_DEFAULT_MODEL`, `BRAVE_API_KEY`

**Pi agent config directory**
- Host: `~/.pi/agent` (or `PI_CODING_AGENT_DIR`)
- Container: `/home/node/.pi/agent`
- Files: `auth.json`, `models.json` (used by the Pi SDK)

Check inside container:

```bash
container run --rm --entrypoint /bin/bash \
  -v ~/.pi/agent:/home/node/.pi/agent \
  nanoclaw-agent:latest -c 'ls -la /home/node/.pi/agent'
```

## Session Storage (Pi SDK)

Sessions are stored per **group + chatJid**, isolated from each other:

```
data/sessions/{groupFolder}/{sanitizedJid}/pi-sessions
└── session-*.json  (Pi session files)
```

Inside container:
- `SessionManager` reads/writes `/workspace/sessions`.
- The session “ID” stored in `data/sessions.json` is the **container path** to the session file (e.g., `/workspace/sessions/session-xxxx.json`).

If new sessions keep appearing:
1. Check that `/workspace/sessions` is mounted.
2. Verify the session file path exists inside the container.
3. Check `data/sessions.json` and compare paths.

## IPC: Host ↔ Container

**Container → Host (agent tools):**
- `/workspace/ipc/messages/*.json` → send_message / send_file
- `/workspace/ipc/tasks/*.json` → schedule_task / pause / resume / cancel / register_group

**Host → Container (streaming input):**
- `/workspace/ipc/input/*.json` → prompt chunks for active container
- `/workspace/ipc/input/_close` → close sentinel (ends the session)

**Host snapshots (read-only for agent):**
- `/workspace/ipc/current_tasks.json`
- `/workspace/ipc/available_groups.json`

Per-group IPC directories live on the host under:

```
data/ipc/{group}/messages
                /tasks
                /input
```

## Common Issues & Fixes

### 1) Container exited with code 1
Check `groups/{folder}/logs/container-*.log` for stderr tail.

Common causes:
- Missing API keys in `.env` → check `data/env/env` is created.
- Pi auth/config missing → check `/home/node/.pi/agent/auth.json`.
- Apple Container not running → ensure `container system status` succeeds.

### 2) No auth / model found
If you see “model not found” or “auth missing”:
- Ensure `.env` contains the provider API keys.
- Ensure `~/.pi/agent/auth.json` and `models.json` exist.
- If you override `PI_CODING_AGENT_DIR`, verify it’s mounted and contains the files.

### 3) Sessions not resuming
If every message creates a new session:
- Verify `data/sessions.json` has a path like `/workspace/sessions/session-*.json`.
- Verify `data/sessions/{group}/{jid}/pi-sessions/` exists and contains files.
- Check mount: `data/sessions/.../pi-sessions` → `/workspace/sessions`.

### 4) IPC not delivering messages
- Check `data/ipc/{group}/messages` for pending files.
- Confirm `processGroupIpcMessages` is running (see `logs/nanoclaw.log`).
- For streaming, check `data/ipc/{group}/input` for prompt files and `_close` sentinel.

### 5) Additional mounts not visible
Additional mounts are validated against the allowlist in:

```
~/.config/nanoclaw/mount-allowlist.json
```

Rejected mounts show warnings in logs.

## Manual Container Test

Run the container directly with a test prompt:

```bash
# Ensure env file exists
mkdir -p data/env
cp .env data/env/env

# Test run
printf '{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"tg:test","isMain":false}' | \
  container run -i --rm \
  --mount "type=bind,source=$(pwd)/data/env,target=/workspace/env-dir,readonly" \
  -v $(pwd)/groups/test:/workspace/group \
  -v $(pwd)/data/ipc/test:/workspace/ipc \
  -v $(pwd)/data/sessions/test/tg_test/pi-sessions:/workspace/sessions \
  -v ~/.pi/agent:/home/node/.pi/agent \
  nanoclaw-agent:latest
```

## CLI Checks (Inside Container)

The Pi CLI is installed in the container:

```bash
container run --rm --entrypoint /bin/bash nanoclaw-agent:latest -c 'pi --help'
```

Use it to verify auth/config, or inspect the mounted `~/.pi/agent` directory.

## Rebuild / Verify Container Image

```bash
# Rebuild agent container
./container/build.sh

# Check image
container images | grep nanoclaw-agent
```
