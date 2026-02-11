---
name: x-integration
description: X (Twitter) automation for NanoClaw. Provides x_post/x_like/x_reply/x_retweet/x_quote tools that route through host-side browser automation. Use for setup, testing, or troubleshooting X functionality.
---

# X (Twitter) Integration

Automate X (Twitter) actions using the **host macOS Chrome profile** and **Playwright**. The container exposes custom tools that write IPC tasks; the host executes browser automation and returns results. **Only the main group is allowed to run these tools.**

> **Applies to:** NanoClaw + Pi Coding Agent SDK (customTools + IPC)

## Tool Catalog

| Action | Tool | Purpose |
|--------|------|---------|
| Post | `x_post` | Publish a new tweet |
| Like | `x_like` | Like a tweet |
| Reply | `x_reply` | Reply to a tweet |
| Retweet | `x_retweet` | Retweet without comment |
| Quote | `x_quote` | Quote tweet with a comment |

## Architecture (IPC + customTools)

```
Container (Pi Agent)
└── createXTools() → writes IPC task to /workspace/ipc/tasks
    └── waits for /workspace/ipc/x_results/<requestId>.json
Host (macOS)
└── src/index.ts → processTaskIpc() → handleXIpc()
    └── runs .claude/skills/x-integration/scripts/*.ts via tsx
        └── writes result to data/ipc/<group>/x_results
```

Alignment notes:
- X tools must follow the **ToolDefinition + TypeBox params + AgentToolResult** pattern used in `container/agent-runner/src/ipc-tools.ts`.
- IPC file layout mirrors existing tasks/messages flow.

## Prerequisites (Host)

1. Install host dependencies for scripts:
   ```bash
   npm ls playwright tsx dotenv-cli || npm install playwright tsx dotenv-cli
   ```
2. Optional: set a custom Chrome path in `.env` (if not default):
   ```bash
   CHROME_PATH=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome
   ```

## One-Time Authentication

```bash
npx dotenv -e .env -- npx tsx .claude/skills/x-integration/scripts/setup.ts
```

Verify:
```bash
cat data/x-auth.json
```

## Integration Steps (Code)

### 1) Host: wire IPC handler

**File:** `src/index.ts`

Add import near other local imports:
```ts
import { handleXIpc } from '../.claude/skills/x-integration/host.js';
```

In `processTaskIpc`, short-circuit **before** the switch:
```ts
const handled = await handleXIpc(data, sourceGroup, isMain, DATA_DIR);
if (handled) return;
```

### 2) Container: register custom tools

**Goal:** merge X tools with existing `createIpcTools` in `customTools`.

**File:** `container/agent-runner/src/index.ts`

```ts
import { createXTools } from './skills/x-integration/agent.js';

customTools: [
  ...createIpcTools({
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isMain: input.isMain,
    isScheduledTask: input.isScheduledTask
  }),
  ...createXTools({ groupFolder: input.groupFolder, isMain: input.isMain })
]
```

> **Important:** `createXTools` must return `ToolDefinition[]` (TypeBox params + AgentToolResult). The `.claude/skills/x-integration/agent.ts` version that uses `@anthropic-ai/claude-agent-sdk` **will not compile** inside the Pi container.

### 3) Ensure the tool file is compiled inside the container

**Recommended path:**
```
container/agent-runner/src/skills/x-integration/agent.ts
```

**Alternative (keep source in .claude):**
- Change `container/build.sh` build context to the project root
- Update `container/Dockerfile` `COPY` paths
- Add a `COPY .claude/skills/x-integration/agent.ts ./src/skills/x-integration/` line before `npm run build`

## Build + Restart

```bash
./container/build.sh
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Usage (Chat Examples)

```
@PostBot post a tweet: Hello world!
@PostBot like https://x.com/user/status/123
@PostBot reply to https://x.com/user/status/123 with: Great post!
@PostBot retweet https://x.com/user/status/123
@PostBot quote https://x.com/user/status/123 with comment: Interesting
```

## Script Testing (Host)

```bash
# Post
echo '{"content":"Test tweet - please ignore"}' | npx dotenv -e .env -- npx tsx .claude/skills/x-integration/scripts/post.ts

# Like
echo '{"tweetUrl":"https://x.com/user/status/123"}' | npx dotenv -e .env -- npx tsx .claude/skills/x-integration/scripts/like.ts
```

## Troubleshooting

**Auth expired**
```bash
npx dotenv -e .env -- npx tsx .claude/skills/x-integration/scripts/setup.ts
```

**Chrome profile locked**
```bash
rm -f data/x-browser-profile/SingletonLock
rm -f data/x-browser-profile/SingletonSocket
rm -f data/x-browser-profile/SingletonCookie
```

**Logs**
```bash
grep -i "x_post\|x_like\|x_reply\|handleXIpc" logs/nanoclaw.log | tail -20
```

**Script timeout (default 120s)**
- Adjust the timeout in `.claude/skills/x-integration/host.ts` if needed.

## Security Notes

- `data/x-browser-profile/` stores X cookies (gitignored)
- `data/x-auth.json` is the auth marker (gitignored)
- Main-group enforcement happens in **both** the tool implementation and host IPC handler
