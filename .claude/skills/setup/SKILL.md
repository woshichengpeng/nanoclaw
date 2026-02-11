---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, configure Pi SDK auth, authenticate Telegram/Feishu, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup (Pi SDK + Telegram/Feishu)

Run all commands automatically. Only pause when user action is required (bot creation, token entry, or confirming chats).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text. This integrates with the built-in question/answer system for a better experience.

## 1. Install Dependencies

```bash
npm install
```

## 2. Install Container Runtime

NanoClaw uses **Apple Container** by default on macOS. Docker is supported via the `/convert-to-docker` skill.

First, detect the platform and check what's available:

```bash
echo "Platform: $(uname -s)"
which container && echo "Apple Container: installed" || echo "Apple Container: not installed"
which docker && docker info >/dev/null 2>&1 && echo "Docker: installed and running" || echo "Docker: not installed or not running"
```

### If NOT on macOS (Linux, etc.)

Apple Container is macOS-only. Use Docker instead.

Tell the user:
> You're on Linux, so we'll use Docker for container isolation. Let me set that up now.

**Use the `/convert-to-docker` skill** to convert the codebase to Docker, then continue to Section 3.

### If on macOS

**If Apple Container is already installed:** Continue to Section 3.

**If Apple Container is NOT installed:** Ask the user:
> NanoClaw needs a container runtime for isolated agent execution. You have two options:
>
> 1. **Apple Container** (default) - macOS-native, lightweight, designed for Apple silicon
> 2. **Docker** - Cross-platform, widely used, works on macOS and Linux
>
> Which would you prefer?

#### Option A: Apple Container

Tell the user:
> Apple Container is required for running agents in isolated environments.
>
> 1. Download the latest `.pkg` from https://github.com/apple/container/releases
> 2. Double-click to install
> 3. Run `container system start` to start the service
>
> Let me know when you've completed these steps.

Wait for user confirmation, then verify:

```bash
container system start
container --version
```

**Note:** NanoClaw auto-starts the Apple Container system when it launches, so you don't need to start it manually after reboots.

#### Option B: Docker

Tell the user:
> You've chosen Docker. Let me set that up now.

**Use the `/convert-to-docker` skill** to convert the codebase to Docker, then continue to Section 3.

## 3. Configure Pi SDK Authentication

NanoClaw runs the **Pi Coding Agent SDK** inside containers. Credentials are resolved in this order:
1. `~/.pi/agent/auth.json` (from Pi `/login` or manual edit)
2. Environment variables from `.env` (API keys)

The host `~/.pi/agent/` directory is mounted into containers at `/home/node/.pi/agent`.

Ask the user:
> Do you want to authenticate with **Pi subscriptions** (Claude Pro/Max, Copilot, etc.) or **API keys**?

### Option 1: Pi Subscription Login

Tell the user:
> Run `/login` in your Pi CLI and follow the prompts. Tokens are stored at `~/.pi/agent/auth.json`.
>
> If you're already in a Pi session, just type `/login` now and pick a provider.

Verify:

```bash
ls -l ~/.pi/agent/auth.json
```

### Option 2: API Keys in `.env`

Ask which providers they want (Anthropic, OpenAI, OpenRouter, etc.). Add keys to `.env`:

```bash
cat > .env << 'EOF'
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
MISTRAL_API_KEY=
GROQ_API_KEY=
XAI_API_KEY=
COHERE_API_KEY=
GOOGLE_API_KEY=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_VERSION=
# Optional defaults
PI_DEFAULT_MODEL=
EOF
```

Tell the user to fill in the keys they plan to use.

Verify:

```bash
grep -E "^(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|MISTRAL_API_KEY|GROQ_API_KEY|XAI_API_KEY|COHERE_API_KEY|GOOGLE_API_KEY|AZURE_OPENAI_API_KEY|AZURE_OPENAI_ENDPOINT|AZURE_OPENAI_API_VERSION|PI_DEFAULT_MODEL)=" .env
```

## 4. Configure Telegram Bot

**USER ACTION REQUIRED**

Tell the user:
> Create a Telegram bot with [@BotFather](https://t.me/BotFather) and copy the bot token.
>
> Then either:
> - Start a personal chat with the bot (press **Start**), or
> - Add the bot to a group where you want to use NanoClaw.

If they provide the token, add it to `.env`:

```bash
if grep -q '^TELEGRAM_BOT_TOKEN=' .env; then
  perl -pi -e 's/^TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=<token>/' .env
else
  echo 'TELEGRAM_BOT_TOKEN=<token>' >> .env
fi
```

**Group privacy note:** If you want the bot to see *all* group messages (e.g., for the main channel or `requiresTrigger: false` groups), disable privacy in BotFather: `/setprivacy` → **Disable**.

## 5. (Optional) Configure Feishu/Lark Bot

Feishu is optional. If the user wants it, set up a Feishu (Lark) app with a bot and event subscription.

Tell the user:
> Create a Feishu/Lark app, enable **Bot**, and add the `im.message.receive_v1` event.
> Copy the App ID and App Secret, then add the bot to the chat.
>
> Use `FEISHU_DOMAIN=feishu` for the China (Feishu) domain. Otherwise omit it for Lark.

Add to `.env`:

```bash
if grep -q '^FEISHU_APP_ID=' .env; then
  perl -pi -e 's/^FEISHU_APP_ID=.*/FEISHU_APP_ID=<app_id>/' .env
else
  echo 'FEISHU_APP_ID=<app_id>' >> .env
fi

if grep -q '^FEISHU_APP_SECRET=' .env; then
  perl -pi -e 's/^FEISHU_APP_SECRET=.*/FEISHU_APP_SECRET=<app_secret>/' .env
else
  echo 'FEISHU_APP_SECRET=<app_secret>' >> .env
fi

if ! grep -q '^FEISHU_DOMAIN=' .env; then
  echo 'FEISHU_DOMAIN=feishu' >> .env  # only if using Feishu China
fi
```

## 6. Build Container Image

Build the NanoClaw agent container:

```bash
./container/build.sh
```

Verify the build succeeded by running a simple test (auto-detects runtime):

```bash
if which docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
else
  echo '{}' | container run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
fi
```

## 7. Configure Assistant Name (Optional)

Ask the user:
> What trigger word do you want to use? (default: `Andy`)
>
> Messages starting with `@TriggerWord` will be sent to the agent.

If they choose something other than `Andy`, update:
1. `.env` - set `ASSISTANT_NAME=NewName`
2. `groups/global/CLAUDE.md` - Change "# Andy" and "You are Andy" to the new name
3. `groups/main/CLAUDE.md` - Same changes at the top
4. `data/registered_groups.json` - Use `@NewName` as the trigger when registering groups

Store their choice - you'll use it when creating the registered_groups.json and when telling them how to test.

## 8. Understand the Security Model

Before registering your main channel, you need to understand an important security concept.

**Use the AskUserQuestion tool** to present this:

> **Important: Your "main" channel is your admin control portal.**
>
> The main channel has elevated privileges:
> - Can see messages from ALL other registered groups
> - Can manage and delete tasks across all groups
> - Can write to global memory that all groups can read
> - Has read-write access to the entire NanoClaw project
>
> **Recommendation:** Use your personal Telegram chat with the bot ("Saved Messages") or a solo Telegram group.
>
> **Question:** Which setup will you use for your main channel?
>
> Options:
> 1. Personal Telegram chat (Saved Messages) - Recommended
> 2. Solo Telegram group (just me)
> 3. Group with other people (I understand the security implications)

If they choose option 3, ask a follow-up:

> You've chosen a group with other people. This means everyone in that group will have admin privileges over NanoClaw.
>
> Are you sure you want to proceed? The other members will be able to:
> - Read messages from your other registered chats
> - Schedule and manage tasks
> - Access any directories you've mounted
>
> Options:
> 1. Yes, I understand and want to proceed
> 2. No, let me use a personal chat or solo group instead

## 9. Register Main Channel (Telegram)

**Note:** The main channel must be **Telegram**. Feishu/Lark can be added as secondary groups, not as the main admin channel.

Ask the user:
> Do you want to use your **personal Telegram chat** (Saved Messages) or a **Telegram group** as your main control channel?

For personal chat:
> Open the bot chat and send any message (or `/start`). Tell me when done.

For group:
> Add the bot to the group and send any message. Tell me when done.
> If you want the bot to read all messages (no `@Trigger` required), disable privacy in BotFather: `/setprivacy` → **Disable**.

After user confirms, start the app briefly to capture the message:

```bash
timeout 15 npm run dev || true
```

Then find the Telegram chat ID from the database:

```bash
sqlite3 store/messages.db "SELECT chat_jid, sender_name, content, timestamp FROM messages WHERE chat_jid LIKE 'tg:%' ORDER BY timestamp DESC LIMIT 10"
```

Create/update `data/registered_groups.json` using the `tg:` chat ID and the assistant name:

```json
{
  "tg:CHAT_ID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP"
  }
}
```

Ensure the groups folder exists:

```bash
mkdir -p groups/main/logs
```

## 10. (Optional) Register Feishu/Lark Chats

If they want Feishu/Lark:

1. Add the Feishu bot to a chat and send a message.
2. Run:
   ```bash
   timeout 15 npm run dev || true
   sqlite3 store/messages.db "SELECT chat_jid, sender_name, content, timestamp FROM messages WHERE chat_jid LIKE 'fs:%' ORDER BY timestamp DESC LIMIT 10"
   ```
3. Add the `fs:` chat ID to `data/registered_groups.json` with a **non-`main`** folder:
   ```json
   {
     "fs:CHAT_ID_HERE": {
       "name": "feishu-team",
       "folder": "feishu-team",
       "trigger": "@ASSISTANT_NAME",
       "added_at": "CURRENT_ISO_TIMESTAMP",
       "channel": "feishu"
     }
   }
   ```
4. Create the folder:
   ```bash
   mkdir -p groups/feishu-team/logs
   ```

## 11. Configure External Directory Access (Mount Allowlist)

Ask the user:
> Do you want the agent to be able to access any directories **outside** the NanoClaw project?
>
> Examples: Git repositories, project folders, documents you want the agent to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

If **no**, create an empty allowlist to make this explicit:

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
echo "Mount allowlist created - no external directories allowed"
```

Skip to the next step.

If **yes**, ask follow-up questions:

### 11a. Collect Directory Paths

Ask the user:
> Which directories do you want to allow access to?
>
> You can specify:
> - A parent folder like `~/projects` (allows access to anything inside)
> - Specific paths like `~/repos/my-app`
>
> List them one per line, or give me a comma-separated list.

For each directory they provide, ask:
> Should `[directory]` be **read-write** (agents can modify files) or **read-only**?
>
> Read-write is needed for: code changes, creating files, git commits
> Read-only is safer for: reference docs, config examples, templates

### 11b. Configure Non-Main Group Access

Ask the user:
> Should **non-main groups** (other chats you add later) be restricted to **read-only** access even if read-write is allowed for the directory?
>
> Recommended: **Yes** - this prevents other groups from modifying files even if you grant them access to a directory.

### 11c. Create the Allowlist

Create the allowlist file based on their answers:

```bash
mkdir -p ~/.config/nanoclaw
```

Then write the JSON file. Example for a user who wants `~/projects` (read-write) and `~/docs` (read-only) with non-main read-only:

```bash
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    },
    {
      "path": "~/docs",
      "allowReadWrite": false,
      "description": "Reference documents"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
```

Verify the file:

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

Tell the user:
> Mount allowlist configured. The following directories are now accessible:
> - `~/projects` (read-write)
> - `~/docs` (read-only)
>
> **Security notes:**
> - Sensitive paths (`.ssh`, `.gnupg`, `.aws`, credentials) are always blocked
> - This config file is stored outside the project, so agents cannot modify it
> - Changes require restarting the NanoClaw service
>
> To grant a group access to a directory, add it to their config in `data/registered_groups.json`:
> ```json
> "containerConfig": {
>   "additionalMounts": [
>     { "hostPath": "~/projects/my-app", "containerPath": "my-app", "readonly": false }
>   ]
> }
> ```

## 12. Configure launchd Service (macOS)

Generate the plist file from the template with correct paths:

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME
ASSISTANT_NAME_VALUE=$(grep '^ASSISTANT_NAME=' .env | cut -d= -f2)
ASSISTANT_NAME_VALUE=${ASSISTANT_NAME_VALUE:-Andy}

sed -e "s|{{NODE_PATH}}|${NODE_PATH}|g" \
    -e "s|{{PROJECT_ROOT}}|${PROJECT_PATH}|g" \
    -e "s|{{HOME}}|${HOME_PATH}|g" \
    -e "s|<string>Andy</string>|<string>${ASSISTANT_NAME_VALUE}</string>|" \
    launchd/com.nanoclaw.plist > ~/Library/LaunchAgents/com.nanoclaw.plist

echo "Created launchd plist with:" 
echo "  Node: ${NODE_PATH}" 
echo "  Project: ${PROJECT_PATH}"
```

Build and start the service:

```bash
npm run build
mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Verify it's running:

```bash
launchctl list | grep nanoclaw
```

## 13. Test

Tell the user (using the assistant name they configured):
> Send `@ASSISTANT_NAME hello` in your registered chat.

Check the logs:

```bash
tail -f logs/nanoclaw.log
```

The user should receive a response in Telegram (or Feishu if configured).

## Troubleshooting

**Service not starting**: Check `logs/nanoclaw.error.log`

**Container agent fails with "Agent process exited with code 1"**:
- Ensure the container runtime is running:
  - Apple Container: `container system start`
  - Docker: `docker info` (start Docker Desktop on macOS, or `sudo systemctl start docker` on Linux)
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

**No response to Telegram messages**:
- Verify `TELEGRAM_BOT_TOKEN` in `.env`
- Ensure the bot is added to the chat and the chat is registered in `data/registered_groups.json`
- If using a group without `@Trigger`, disable privacy in BotFather
- Check `logs/nanoclaw.log` for errors

**No response to Feishu messages**:
- Verify `FEISHU_APP_ID` and `FEISHU_APP_SECRET` in `.env`
- Ensure event subscription includes `im.message.receive_v1`
- Confirm the bot is added to the chat
- Check `logs/nanoclaw.log` for "Feishu WebSocket client started"

**Invalid Telegram bot token**:
- Update `TELEGRAM_BOT_TOKEN` in `.env`
- Restart the service: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

**Unload service**:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```
