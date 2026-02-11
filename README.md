<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  Personal Pi-powered AI assistant over Telegram, running securely in containers. Fork of <a href="https://github.com/gavrielc/nanoclaw">gavrielc/nanoclaw</a>.
</p>

## What This Fork Changes

Upstream NanoClaw uses WhatsApp (Baileys). This fork replaces it with **Telegram** (Telegraf) and adds:

- Telegram Bot API with photo/document receiving and file sending
- Brave Search integration
- Typing indicators and session recovery
- Market report scripts and watchlist
- Self-modification workflow (container rebuild + auto-restart)
- Selective upstream merge skill (`/upstream-merge`)

## Quick Start

```bash
git clone https://github.com/woshichengpeng/nanoclaw.git
cd nanoclaw
pi
```

Then run `/setup`.

## What It Supports

- **Telegram I/O** - Message your Pi agent from your phone via Telegram bot
- **Isolated group context** - Each group has its own `CLAUDE.md` memory, isolated filesystem, and container sandbox
- **Main channel** - Your private chat for admin control; every other group is isolated
- **Scheduled tasks** - Recurring cron jobs that run the agent and message you back
- **Per-group model selection** - Switch provider/model with `/agent`
- **Thinking level control** - Adjust reasoning depth with `/thinking`
- **Web access** - Brave Search and web fetch
- **Container isolation** - Agents sandboxed in Apple Container (macOS) or Docker
- **Optional integrations** - Gmail (`/add-gmail`), X/Twitter (`/x-integration`), voice transcription, and more via skills

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments and message me a briefing
```

From the main channel, manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
```

Switch model per group:
```
/agent github-copilot/claude-opus-4.6
/agent github-copilot/gpt-4.1
```

## Architecture

```
Telegram (Telegraf) --> SQLite --> Polling loop --> Container (Pi Coding Agent SDK) --> Response
```

Single Node.js process. Agents execute in isolated Linux containers with mounted directories. IPC via filesystem.

Key files:
- `src/index.ts` - Main app: Telegram connection, routing, IPC
- `src/container-runner.ts` - Spawns agent containers
- `src/task-scheduler.ts` - Runs scheduled tasks
- `src/db.ts` - SQLite operations
- `src/logger.ts` - Shared pino logger
- `groups/*/CLAUDE.md` - Per-group memory

## Syncing with Upstream

This fork selectively merges useful changes from [gavrielc/nanoclaw](https://github.com/gavrielc/nanoclaw). WhatsApp-specific changes are skipped.

Run `/upstream-merge` or see `.upstream-merge-cursor` for the last synced commit.

## Requirements

- macOS or Linux
- Node.js 20+
- [Pi Coding Agent SDK](https://github.com/mariozechner/pi-coding-agent) (installed in the container)
- API keys for your chosen providers (Anthropic/OpenAI/etc.)
- [Apple Container](https://github.com/apple/container) (macOS) or [Docker](https://docker.com/products/docker-desktop) (macOS/Linux)
- Telegram Bot Token (get from [@BotFather](https://t.me/BotFather))

## FAQ

**Why Telegram?**

Because I use Telegram. Upstream uses WhatsApp. That's the point of forking.

**Why Apple Container instead of Docker?**

On macOS, Apple Container is lightweight, fast, and optimized for Apple silicon. Docker is also supported.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. See [docs/SECURITY.md](docs/SECURITY.md).

**How do I debug issues?**

Run `/debug` with the agent.

## License

MIT
