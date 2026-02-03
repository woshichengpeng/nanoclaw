# TODO

## Pending

- [ ] 🔴 取消 Avis 租车订单 - 有两个订单，通过 Visa 预订的
- [ ] 🟡 Stop hook 强制 commit - 回复前检查未 commit 改动，有则 block → [设计文档](docs/commit-hook-design.md)
- [x] 🟡 智能吃药提醒 - 已实现，用链式 schedule_task：每次提醒都预约10分钟后的跟进，用户确认后取消

## Completed

- [x] 🟡 自动静默 commit hook - 已实现，使用 Claude SDK PostToolUse hook，对 .md/.txt 文件自动 commit
- [x] 🟡 添加 send_file 工具 - 已实现，支持图片和文档发送

