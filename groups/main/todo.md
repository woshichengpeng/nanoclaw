# TODO

## Pending

- [ ] 🔴 取消 Avis 租车订单 - 有两个订单，通过 Visa 预订的
- [ ] 🟡 Stop hook 强制 commit - 回复前检查未 commit 改动，有则 block → [设计文档](docs/commit-hook-design.md)
- [x] 🟡 智能吃药提醒 - 已实现，改进版：定时任务只管发提醒+创建跟进，取消逻辑由用户回复触发（见 CLAUDE.md）

## Completed

- [x] 🟡 自动静默 commit hook - 已实现，使用 Claude SDK PostToolUse hook，对 .md/.txt 文件自动 commit
- [x] 🟡 添加 send_file 工具 - 已实现，支持图片和文档发送

