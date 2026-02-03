# Stop Hook 强制 Commit 设计

## 问题

改完文件后经常忘记 commit，导致 30 分钟后被自动 rollback。

## 目标

在 Claude 回复用户之前，自动检查是否有未 commit 的改动。如果有，block 回复并提醒先 commit。

## 方案对比

| 方案 | 触发时机 | 优点 | 缺点 |
|------|---------|------|------|
| A: Prompt 强调 | 无 | 简单 | 依赖 AI 自觉，容易忘 |
| B: PostToolUse hook | 每次 Edit/Write | 及时 | 太频繁，每行都触发 |
| C: Stop hook | 回复前 | 只检查一次 | 简单有效 |
| D: Flag + Stop | 回复前 | 更精确 | 复杂度高 |

**推荐方案 C**

## 实现细节

### 1. Hook 配置

在 `/workspace/project/.claude/settings.local.json` 添加：

```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "/workspace/project/scripts/check-uncommitted.sh"
      }]
    }]
  }
}
```

### 2. 检查脚本

`/workspace/project/scripts/check-uncommitted.sh`:

```bash
#!/bin/bash
# 检查是否有未 commit 的改动

cd /workspace/project

# 检查是否有修改的文件 (不包括 untracked)
if ! git diff --quiet HEAD 2>/dev/null; then
  # 输出 JSON 格式的 block 响应
  cat <<EOF
{
  "decision": "block",
  "reason": "⚠️ 有未 commit 的改动！请先运行 git add && git commit 再回复用户。"
}
EOF
  exit 0
fi

# 检查是否有已 staged 但未 commit 的文件
if ! git diff --cached --quiet 2>/dev/null; then
  cat <<EOF
{
  "decision": "block",
  "reason": "⚠️ 有 staged 但未 commit 的改动！请先 git commit 再回复用户。"
}
EOF
  exit 0
fi

# 没有问题，允许继续
echo '{"decision": "allow"}'
```

### 3. 边缘情况

- **只改了 untracked 文件**: 不 block (新文件可能是临时的)
- **改了但故意不 commit**: 需要手动 `git checkout` 放弃改动
- **不在 git repo 里的文件**: 不影响 (如 /tmp)

### 4. 排除列表

某些文件改动不需要 commit：
- `/workspace/group/conversations/` - 对话记录
- `/tmp/` - 临时文件
- `*.log` - 日志文件

可以在脚本里加 `--exclude` 逻辑。

## 待确认

1. Stop hook 的输出格式是否正确？需要测试
2. 是否需要区分 main channel 和其他 group？
3. 如果 block 了，Claude 会收到什么提示？

## 参考

- Claude Code Hooks 文档: https://code.claude.com/docs/en/hooks-guide
- GitButler 的实现: https://docs.gitbutler.com/features/ai-integration/claude-code-hooks
