---
name: upstream-merge
description: Selectively merge useful changes from upstream gavrielc/nanoclaw into our fork. Use when user says "merge upstream", "sync upstream", "check upstream", or wants to pull changes from the original repo. Handles diverged branches where our fork uses Telegram instead of WhatsApp.
---

# Upstream Merge

Selectively cherry-pick useful changes from `gavrielc/nanoclaw` (upstream) into our fork. Our fork has diverged significantly — we use Telegram, they use WhatsApp — so full merge is not possible. Instead, review each commit and decide: merge, manually apply, or skip.

## Context

- Upstream remote: `https://github.com/gavrielc/nanoclaw.git` (name: `upstream`)
- Our `src/index.ts` is a complete Telegram rewrite; upstream's is WhatsApp (Baileys)
- Cursor file: `.upstream-merge-cursor` tracks last reviewed commit hash

## Workflow

### 1. Setup & Discover New Commits

```bash
# Ensure upstream remote exists
git remote add upstream https://github.com/gavrielc/nanoclaw.git 2>/dev/null
git fetch upstream

# Read cursor (last reviewed hash)
CURSOR=$(grep -v '^#' .upstream-merge-cursor | tr -d '[:space:]')

# Show only NEW commits since last review
git log --oneline upstream/main --not $CURSOR
```

If no new commits, stop here.

### 2. Triage Each Commit

For each new commit, inspect files changed and diff:

```bash
git log --oneline -1 <hash>
git diff-tree --no-commit-id --name-only -r <hash>
git show <hash> --stat -p
```

Categorize into:

| Category | Action | Examples |
|----------|--------|---------|
| **New files only** (skills, scripts) | `git cherry-pick --no-commit` | New skill folders, new utilities |
| **Useful refactor** touching shared files | Manual apply | Logger dedup, config changes |
| **WhatsApp-specific** changes to `src/index.ts` | Skip | Baileys reconnect, LID JID translation |
| **Code reformatting** (prettier, lint) | Skip or take config only | Bulk reformats that conflict with our code |

Present the triage table to the user and confirm before proceeding.

### 3. Apply Changes

**Clean cherry-picks** (new files, non-conflicting patches):
```bash
git cherry-pick --no-commit <hash>
```

**Manual applies** (concept is useful but code conflicts): Read the upstream diff, understand the intent, apply equivalent changes to our codebase manually.

**Config-only from larger commits**: Extract just the useful parts (e.g., `.prettierrc` from a prettier+reformat commit).

### 4. Verify

Run ALL of these checks — do not skip any:

```bash
# TypeScript compilation
npm run build

# Rebuild container image
./container/build.sh

# Quick smoke test (optional, if service is running)
# launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
# launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

If `npm run build` fails, fix type errors before continuing. If container build fails, check if changes touched `container/` or `agent-runner/`.

### 5. Update Cursor & Commit

Update `.upstream-merge-cursor` with:
- The tip commit hash of `upstream/main` (even if some were skipped — they've been *reviewed*)
- Date of review
- List of merged commit hashes
- List of skipped commit hashes with reasons

Then commit all changes in a single commit:

```
feat: selective merge from upstream gavrielc/nanoclaw

Cherry-picked: <list with short descriptions>
Skipped: <list with reasons>
```

## Skip Criteria

Always skip commits that:
- Only modify WhatsApp/Baileys logic in `src/index.ts` (LID mapping, reconnect handling, QR auth)
- Only modify `src/whatsapp-auth.ts`
- Are bulk code reformats that would conflict with our Telegram rewrite
- Touch `groups/*/CLAUDE.md` with upstream-specific group memory

## Manual Apply Candidates

Consider manually applying when:
- A refactor touches shared files (`container-runner.ts`, `task-scheduler.ts`, `db.ts`, `config.ts`) but the upstream version of `index.ts` is incompatible
- A new feature adds both new files (cherry-pickable) and integration code in `index.ts` (needs manual Telegram equivalent)
- A bug fix addresses logic in `task-scheduler.ts` or `container-runner.ts` that we also use
