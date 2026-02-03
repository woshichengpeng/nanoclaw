# TODO

## Pending

- [ ] 🟡 Stop hook 强制 commit - 考虑用 Claude Code Stop hook，在回复前检查未 commit 的改动，有则 block
- [x] 🟡 智能吃药提醒 - 已实现，用链式 schedule_task：每次提醒都预约10分钟后的跟进，用户确认后取消

## Completed

- [x] 🟡 自动静默 commit hook - 已实现，使用 Claude SDK PostToolUse hook，对 .md/.txt 文件自动 commit
- [x] 🟡 添加 send_file 工具 - 已实现，支持图片和文档发送

