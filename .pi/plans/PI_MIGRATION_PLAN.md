# Plan: 将 NanoClaw 的 Claude/Codex 后端替换为 Pi Agent SDK

## 总体概述

当前 NanoClaw 架构是：**Telegram → SQLite → 轮询 → 容器（Claude Agent SDK / Codex CLI）→ 响应**

目标是将容器内的 Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) 和 Codex SDK (`@openai/codex-sdk`) 替换为 Pi Coding Agent SDK (`@mariozechner/pi-coding-agent`)，同时保留外部架构（Telegram/Feishu 接入、IPC 通信、调度器等）不变。

## 架构变化要点

| 维度 | 现状 | 目标 |
|------|------|------|
| 容器内 Agent | Claude Agent SDK + Codex SDK（两个独立 runner） | Pi Coding Agent SDK（统一一个 runner） |
| 双后端切换 (`/agent claude\|codex`) | 两种独立的 runner、两个 Dockerfile | 通过 Pi 的 ModelRegistry 切换 provider/model（单一 runner） |
| MCP 集成 | Claude SDK 内建 MCP 支持 (`createSdkMcpServer`) | Pi SDK 的 Extension / customTools 系统 |
| 会话管理 | Claude 的 `.claude/` 目录 + Codex Thread ID | Pi 的 `SessionManager`（JSONL 文件） |
| 环境变量 | `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `CLAUDE_CODE_*` 等 | Pi AI 的统一 env vars（`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` 等）|
| 全局安装 | `@anthropic-ai/claude-code` + `@openai/codex` | `@mariozechner/pi-coding-agent` |
| 输出格式 | Claude 的 structured_output / Codex 的 outputSchema | Pi 的 Extension/Tool 系统实现等效输出控制 |

---

## 详细步骤

### 阶段 1：重写容器内 Agent Runner（核心改造）

#### 1.1 重写 `container/agent-runner/package.json`
- 移除 `@anthropic-ai/claude-agent-sdk` 和 `@openai/codex-sdk` 依赖
- 添加 `@mariozechner/pi-coding-agent`、`@mariozechner/pi-ai`、`@mariozechner/pi-agent-core` 依赖
- 保留 `cron-parser`
- 添加 `@sinclair/typebox`（Pi 工具定义需要）

#### 1.2 重写 `container/agent-runner/src/index.ts`（原 Claude runner）
**替换 `query()` 调用为 Pi SDK 的 `createAgentSession()` + `session.prompt()`：**

关键映射：
- `query({ prompt, options: { cwd, resume, ... } })` → `createAgentSession({ cwd, sessionManager, model, tools, ... })` + `session.prompt()`
- `options.allowedTools` → Pi 的 `tools` 参数（`createCodingTools('/workspace/group')`）
- `options.permissionMode: 'bypassPermissions'` → Pi 天然无权限弹窗
- `options.outputFormat` → System prompt 中要求 JSON 格式 + 解析
- `options.mcpServers` → Pi 的 `customTools`
- `options.hooks` → `session.subscribe` 事件处理
- `options.systemPrompt` → `ResourceLoader` 的 `systemPromptOverride`

**streaming 模式处理：**
- `session.subscribe()` 监听事件，在 `agent_end` 时提取最终 assistant 消息
- 保留 `OUTPUT_START_MARKER` / `OUTPUT_END_MARKER` stdout 协议

**会话管理：**
- Pi 的 `SessionManager.create(cwd, sessionDir)` 或 `SessionManager.open(path)`
- 容器内会话存储在自定义目录

#### 1.3 删除 `container/agent-runner/src/codex-runner.ts`

#### 1.4 重写 `container/agent-runner/src/ipc-mcp.ts` → `ipc-tools.ts`
将 MCP 工具转换为 Pi 的 `ToolDefinition[]` 格式（使用 TypeBox schema）

#### 1.5 删除 `container/agent-runner/src/ipc-mcp-stdio.ts`
不再需要 MCP stdio 传输

#### 1.6 输出格式适配
在 system prompt 中追加 JSON 输出要求，从 assistant 消息中解析

#### 1.7 Hooks 等价逻辑
- PreCompact → `session.subscribe` 的 `auto_compaction_start`
- PostToolUse auto-commit → `session.subscribe` 的 `tool_execution_end`

### 阶段 2：修改容器构建

#### 2.1 合并为单一 Dockerfile（删除 `Dockerfile.codex`）
- `npm install -g @anthropic-ai/claude-code` → `npm install -g @mariozechner/pi-coding-agent`
- session 目录 `.claude` → `.pi/agent`
- 统一 entrypoint 指向 `dist/index.js`

#### 2.2 修改 `container/build.sh`
- 移除 codex target
- 只构建单一镜像

#### 2.3 `container/.claude/` → `container/.pi/`

### 阶段 3：修改宿主机代码

#### 3.1 简化 `src/types.ts`
- `AgentType` 改为 provider/model 概念
- `SessionEntry` 简化为 `string`

#### 3.2 修改 `src/config.ts`
- 移除 Codex 特有配置
- 统一 model override
- 单一 container image

#### 3.3 修改 `src/container-runner.ts`
- 环境变量过滤更新为 Pi 兼容
- 会话目录挂载 `.claude` → `.pi/agent`
- 移除 claude/codex 分支

#### 3.4 修改 `src/index.ts`
- `/agent` 命令改为 provider/model 选择
- `/effort` → `/thinking`
- 简化双 agent 逻辑
- 更新 container rebuild 逻辑

#### 3.5 修改 `src/task-scheduler.ts`
- 移除 claude/codex 分支

### 阶段 4：适配记忆系统

#### 4.1 保留 CLAUDE.md（Pi 原生支持作为 fallback）

#### 4.2 全局记忆通过 ResourceLoader 注入

### 阶段 5：更新文档和配置

#### 5.1-5.5 更新 README.md, CLAUDE.md, REQUIREMENTS.md, .env, package.json

### 阶段 6：清理和测试

#### 6.1 删除废弃文件
#### 6.2 更新 skills
#### 6.3 构建测试
#### 6.4 端到端测试

---

## 风险点和注意事项

1. **Structured Output**: Pi SDK 没有 Claude SDK 的 `outputFormat` 等价物，需要通过 system prompt 或 custom tool 实现
2. **MCP 集成**: Pi SDK 不内建 MCP 支持，需要将 MCP 工具转为 customTools
3. **流式输出**: Pi SDK 的事件流模型与 Claude SDK 的 `query()` generator 不同，需要对齐 `OUTPUT_START_MARKER` 机制
4. **会话恢复**: Pi 的会话格式 (JSONL tree) 与 Claude 的不同，现有会话不兼容
5. **容器内 CLI**: Pi 的 `pi` CLI 需全局安装

## 预估工作量

| 阶段 | 工作量 |
|------|--------|
| 阶段 1: 容器 Agent Runner 重写 | **最大**，约 60% |
| 阶段 2: 容器构建修改 | 约 5% |
| 阶段 3: 宿主机代码修改 | 约 20% |
| 阶段 4: 记忆系统适配 | 约 5% |
| 阶段 5: 文档更新 | 约 5% |
| 阶段 6: 清理测试 | 约 5% |
