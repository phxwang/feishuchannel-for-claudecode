# Feishu Channel 多 Agent Router 设计

> 日期：2026-08-17
> 目标：在现有 Feishu Channel Router 内统一接入 Claude Code 与 OpenCode，通过同一个飞书 Bot、同一条 WebSocket 和同一套安全策略选择后端，并支持 OpenCode 作为 Claude Code 的受控 fallback。

## 一、结论

建议把现有 Router 从“Claude Code worker 转发器”升级为“Feishu Gateway + Agent Router”。

- 飞书接入只保留一份：一个 Bot、一个 WebSocket、一个事件去重层、一个卡片回调入口。

- Claude Code 与 OpenCode 都实现统一 Agent Adapter，飞书事件处理代码不直接依赖后端协议。

- 配置以聊天为主键选择后端，可按群、私聊、主题和项目覆盖。

- fallback 是任务级故障转移，不是双写；Claude Code 已开始输出或执行工具后不得自动切换。

- 默认保持兼容：未配置 agent 的现有群和私聊仍走 Claude Code。

- OpenCode 由 Router 的 Adapter 连接；Claude Code 继续沿用 Unix Socket worker 注册机制。

- 会话绑定记录实际执行后端，确保 stop、审批、diff、回复都回到正确实例。

## 二、现状与改造范围

已核对 `/Users/openclaw/Projects/feishuchannel` 当前实现：

- `router.ts` 独占飞书 WebSocket。

- `access.json` 用 `groups.<chatId>.workdir` 和 `defaultWorkdir` 决定工作目录。

- Claude Code 的 `server.ts` 作为 worker，通过 Unix Socket 注册 cwd。

- 当前路由链为 `chat_id → workdir → Claude worker`。

- 入站解析、附件描述、引用消息、ack reaction、allowlist 已集中在 Router。

- 权限/确认卡片仍按 workdir 转发；定位失败时存在广播行为。

- 当前没有后端抽象、任务状态存储、后端健康模型和故障转移语义。

因此不应再启动一个独立 Bridge 抢占同一 Bot 的 WebSocket。OpenCode 应作为 Adapter 合入 Router，或作为 Router 管理的本地子服务。

## 三、目标架构

```plaintext
Feishu Bot
    │ 单一 WebSocket / Open API
    ▼
Feishu Gateway
    ├─ 验签、去重、消息解析、附件
    ├─ allowlist / mention / rate limit
    └─ 统一消息、卡片和回调
    ▼
Routing Core
    ├─ Config Resolver
    ├─ Conversation Binding Store
    ├─ Task State Machine
    ├─ Session Queue
    └─ Fallback Controller
       │
       ├───────────────┐
       ▼               ▼
Claude Adapter      OpenCode Adapter
Unix Socket worker  SDK / HTTP / SSE
       │               │
Claude Code         opencode serve
```

职责边界：

- Gateway 只负责飞书协议、身份、安全入口和展示。

- Routing Core 决定 project、primary、fallback、session 和 task。

- Adapter 统一后端能力，不向上泄露 Claude MCP notification 或 OpenCode SSE 原始结构。

- Adapter 不自行决定 fallback；只能由 Fallback Controller 根据任务状态决定。

- 持久化绑定是路由真相来源，禁止根据“当前在线 worker”猜测会话后端。

## 四、统一 Agent Adapter

```vhdl
type AgentKind = "claude" | "opencode"

interface AgentAdapter {
  readonly kind: AgentKind
  health(target: AgentTarget): Promise<HealthStatus>
  createSession(ctx: ConversationContext): Promise<AgentSession>
  resumeSession(sessionId: string): Promise<AgentSession>
  send(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent>
  abort(sessionId: string, taskId: string): Promise<void>
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>
  getFinalMessage(sessionId: string, taskId: string): Promise<FinalMessage>
  getDiff(sessionId: string, taskId?: string): Promise<FileDiff[]>
}
```

统一事件至少包括：`task.started`、`text.delta`、`text.completed`、`tool.started`、`tool.completed`、`tool.failed`、`permission.requested`、`session.idle`、`task.failed`、`task.aborted`。

Claude Adapter：

- 保留 Unix Socket worker 注册。

- 注册消息新增 `adapter: claude`、`workerId`、`capabilities`、`protocolVersion`。

- Router 每次投递生成 `taskId`；worker 所有回复、权限和完成事件必须带回 taskId。

- 删除无法定位时广播审批回调的逻辑，改为 `permissionId → taskId → adapter instance` 精确路由。

OpenCode Adapter：

- 连接独立守护、仅监听 localhost 的 `opencode serve`。

- 用官方 SDK/HTTP 创建和恢复 session，用 SSE 订阅事件。

- Router 启动时检查版本和 health；断流重连，结束时读取最终 messages 校验完整输出。

- Adapter 内归一化 OpenCode 原始事件。

- 凭证从环境变量或 Keychain 注入，不写入普通配置文件。

## 五、配置设计

建议拆分：

- `access.json`：继续保存用户、群、mention、pairing 等入口安全配置。

- `router.yaml`：新增后端、项目、路由和 fallback。

- `.env`/Keychain：保存 secrets。

```plaintext
version: 1

defaults:
  project: inv
  agent:
    primary: claude
    fallback: null
  routingKey: thread
  stickyBackend: true

agents:
  claude:
    type: claude-channel
    socket: ~/.claude/channels/feishu/router.sock
    health:
      workerTtlSeconds: 15

  opencode:
    type: opencode
    baseUrl: http://127.0.0.1:4096
    passwordEnv: OPENCODE_SERVER_PASSWORD
    requestTimeoutSeconds: 30
    taskTimeoutSeconds: 3600
    maxConcurrency: 4

projects:
  inv:
    workdir: /Users/openclaw/Projects/inv
    allowedAgents: [claude, opencode]

  feishuchannel:
    workdir: /Users/openclaw/Projects/feishuchannel
    allowedAgents: [claude, opencode]

routes:
  dms:
    default:
      project: inv
      agent:
        primary: claude
        fallback: opencode
        policy: pre_execution_only

  groups:
    oc_group_for_inv:
      project: inv
      requireMention: true
      agent:
        primary: claude
        fallback: opencode
        policy: pre_execution_only

    oc_group_for_opencode:
      project: feishuchannel
      agent:
        primary: opencode
        fallback: null

fallback:
  enabled: true
  triggerOn:
    - backend_unavailable
    - startup_timeout
    - rate_limited
    - capacity_exhausted
  neverTriggerOn:
    - permission_denied
    - user_abort
    - invalid_request
    - tool_failure
    - partial_execution
  maxAttempts: 1
  cooldownSeconds: 300
  notifyUser: true
```

解析优先级：主题临时绑定 → 群/私聊显式 route → defaults → 旧 `access.json` 兼容映射。旧配置推导出的 agent 默认为 Claude。

启动时做 schema 和安全校验：workdir 必须为绝对路径且 canonicalize 后在允许根目录；route 引用必须存在；project 必须允许 primary/fallback；两者不能相同；secret 禁止直接写进 YAML。配置错误必须 fail-closed，不能回落到任意目录或 Agent。

## 六、路由与会话绑定

conversation key：

- 私聊：`p2p:<userOpenId>:<projectId>`

- 群主题：`group:<chatId>:thread:<rootMessageId>:<projectId>`

- 无主题群：`group:<chatId>:<projectId>`

```vhdl
interface ConversationBinding {
  conversationKey: string
  projectId: string
  configuredPrimary: AgentKind
  configuredFallback?: AgentKind
  activeAgent: AgentKind
  agentSessionId: string
  routeVersion: string
  createdAt: string
  updatedAt: string
}
```

`stickyBackend: true`：

- session 创建后，后续消息继续使用 activeAgent。

- 修改配置不迁移已有 session；`/agent reset` 或管理员迁移后才重新选择。

- fallback 成功后 activeAgent 切为 OpenCode，保证后续上下文连续。

- Claude 和 OpenCode session 不做“无损迁移”。切换时新建 session，只注入裁剪后的用户消息和失败说明，不搬运隐藏推理或未授权工具输出。

建议命令：

- `/agent status`：显示 project、configured primary/fallback、active backend 和健康状态。

- `/agent use claude|opencode`：在 route 允许范围内新建指定后端 session。

- `/agent reset`：清除绑定并按当前配置重新选择。

- `/agent stop`：中断当前 task。

- `/agent fallback on|off`：仅管理员或获授权用户可改临时策略。

## 七、Fallback 的严格语义

允许自动 fallback：

- primary worker 在任务提交前不在线或已超过 TTL。

- 后端健康检查失败，尚未提交 prompt。

- 提交明确返回 rate limit、capacity exhausted 或启动超时，且 Adapter 能证明任务未被接受。

- 在任何可见文本、工具调用、文件变更或 permission request 出现前失败。

禁止自动 fallback：

- primary 已执行工具或产生文件/外部副作用。

- 已向用户输出部分答案。

- 正在等待审批。

- 用户拒绝权限、主动 stop、请求非法。

- 单个工具失败但 Agent session 仍存活。

- 无法证明 primary 是否接收任务。

原因：primary 可能已产生副作用时，fallback 重跑可能重复写文件、重复发消息、重复提交或造成上下文分叉。

```plaintext
RECEIVED
  → PRIMARY_SELECTED
  → PRIMARY_PREFLIGHT
      → SUBMITTED
          → RUNNING
          → WAITING_PERMISSION
          → COMPLETED | FAILED | ABORTED
      ↘ FALLBACK_ELIGIBLE
          → FALLBACK_PREFLIGHT
          → SUBMITTED → RUNNING → COMPLETED | FAILED
```

只有 `PRIMARY_PREFLIGHT` 或“已确认未接收”的 `SUBMITTED` 能进入 fallback。最多一次，禁止 Claude → OpenCode → Claude 循环。

用户提示必须明确：

- “Claude Code 当前不可用，已切换到 OpenCode 处理本次任务。”

- “Claude Code 在执行中断开。为避免重复操作，未自动重跑；可停止或新建 OpenCode 会话。”

## 八、消息、卡片与审批

- 入站后立即 reaction/处理中状态。

- `text.delta` 进入统一节流器，300–800 ms 合并更新。

- 工具默认折叠，错误和关键变更展开。

- 完成时强制读取 final message 校验。

- 卡片显示实际后端，例如 `Backend: Claude Code` 或 `Fallback: OpenCode`。

审批回调必须包含并校验：`actionVersion`、`taskId`、`permissionId`、`adapterKind`、`agentInstanceId`、`conversationKey`、`expiresAt`、防重放 nonce。Router 查任务存储后精确回给对应 Adapter，禁止广播。

Gateway Policy 先于 Agent 原生审批：检查项目边界、敏感路径、命令风险和操作者身份；可直接拒绝的不发卡片；用户决定再映射到 Adapter。审计只记摘要，不记密钥、完整环境变量或隐藏推理。

## 九、持久化与并发

MVP 使用 SQLite，至少包含：

- `conversation_bindings`

- `tasks`

- `agent_sessions`

- `processed_events`

- `permissions`

- `card_states`

- `backend_health`

约束：

- Feishu event\_id/message\_id 唯一，保证入站幂等。

- 同一 conversation 串行，不同 conversation 并行。

- agent 和 project 分别配置并发上限。

- 所有事件必须关联唯一 taskId。

- Router 重启后先查询后端状态，再恢复订阅或标记 UNKNOWN，绝不盲目重放。

- 卡片 revision 单调递增，旧事件不能覆盖新状态。

## 十、生命周期与部署

当前 Router 会在所有 Claude worker 断开 10 秒后退出。接入 OpenCode 后必须改为常驻 Gateway：

- Router 由 launchd/systemd 独立守护。

- Claude worker 按项目启动、动态注册。

- OpenCode Server 独立守护，Router 不与其同生共死。

- Router 只监听本机 Unix Socket；OpenCode 只监听 127.0.0.1。

- 增加本地 `/healthz` 或管理 Socket，输出 Bot WebSocket、Adapter、worker、队列和 DB 状态。

- SIGUSR1 增加 Adapter 健康、实例和当前任务数。

推荐渐进拆分：

```plaintext
src/
  gateway/
  routing/
    config.ts
    resolver.ts
    bindings.ts
    task-machine.ts
    fallback.ts
    queue.ts
  adapters/
    agent-adapter.ts
    claude/
    opencode/
  storage/
  security/
```

## 十一、兼容与迁移

- 没有 `router.yaml` 时行为与当前版本一致。

- 现有 `access.json` 不废弃，group.workdir/defaultWorkdir 自动映射为 Claude route。

- Claude worker 协议增加版本；旧 worker 仍可 Claude-only，但不开启 fallback 和精确恢复。

- 首次启用新版 Router 时备份状态并提供配置 dry-run。

实施步骤：

1. 抽取 config resolver、route decision、task state machine 纯函数。

2. Claude Socket 协议增加 workerId、taskId、capabilities、version。

3. 引入 SQLite 和精确 callback routing，先保持 Claude-only。

4. 实现 OpenCode Adapter 与契约测试。

5. 开启 route 级 `primary: opencode`，先不启用 fallback。

6. 对测试群开启 `claude → opencode` 的 pre-execution fallback。

7. 稳定后迁移常用群，并保留全局 kill switch。

## 十二、测试与验收

单元测试：配置继承/fail-closed、route 解析、sticky binding、fallback eligibility、partial execution 禁止重跑、callback 防重放、workdir/symlink 边界。

契约测试：Claude 注册/投递/回复/权限/abort；OpenCode health/session/prompt/SSE/idle/abort/permission/diff，并固定版本与事件 fixtures。

集成测试：

- 同一 Bot 下一个群走 Claude，另一个群走 OpenCode。

- Claude 离线时只在执行前切到 OpenCode。

- Claude 已执行工具后断线，不自动重跑。

- Router 重启后恢复 binding 和 OpenCode SSE。

- 两聊天并行、同一聊天串行。

- 重复 Feishu event 不产生第二任务。

- 审批按钮不能跨任务、跨用户重放。

MVP 验收：

- 单 Bot/单 WebSocket 同时服务两种 Agent。

- 新会话按 route 配置选择后端。

- `/agent status` 准确显示配置后端和实际后端。

- fallback 仅在无副作用阶段、最多一次，并通知用户。

- stop、permission、final response、diff 都回到 active backend。

- 旧 access.json 行为兼容。

- 全量 `bun test` 通过，并有真实 OpenCode 契约测试。

## 十三、最终建议

采用“单 Feishu Gateway + 多 Agent Adapter + 持久化任务状态”。首版支持按群/私聊选择 Claude 或 OpenCode、按 project 限制 Agent、Claude primary + OpenCode fallback、`pre_execution_only`、sticky binding，以及管理员查看/重置/显式切换后端。

不要把 OpenCode Bridge 做成第二个独立 Bot 进程，也不要在任务开始执行后静默 fallback。这样能最大化复用现有 Feishu Channel 的接入、安全、卡片和 worker 能力，同时把 Claude/OpenCode 差异封装在 Adapter 层，为以后接 Codex 等后端保留清晰扩展点。
