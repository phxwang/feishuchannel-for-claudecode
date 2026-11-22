# Router Task MCP — Design

Status: implemented on this branch. The backend sections (§11.4–11.6) were revised so that every backend reuses the router's own execution objects.
Branch: `feat/router-task-mcp`. Date: 2026-11-22.

Source requirements:

- *Router MCP v1 — Hermes Writer Integration Specification*, v1.1.0 (Feishu doc `F8XgdPxVdoUAPQxpJC7c9Cq5nab`). It is called "the spec" below, with section numbers written as §N.
- Product direction from the project owner, 2026-11-22:
  1. This is a **general-purpose task MCP**. It is not tied to "Writer" or to Hermes, and Hermes is just one possible client.
  2. **No Hermes client** is built in this project.
  3. **Wrap the current router as an MCP and reuse existing infrastructure** as much as possible.

Where this document and the spec disagree, this document wins. Every deviation is listed in §17. "MUST" and "MUST NOT" keep the meaning they have in the spec: they are acceptance requirements.

---

## 1. Summary

The router (`router.ts`) already runs as a single long-lived process under launchd (`com.openclaw.feishuchannel-router`, `KeepAlive=true`). It already owns:

- the backend adapters
- a SQLite database (`routing/storage.ts`)
- the agents.yaml config and its project allowlist (`routing/config.ts`)
- a single-instance lock (`router-lock.ts`)

This design adds two components.

1. **A task service inside the router process.** It is a durable execution ledger and controller, a small set of new modules under `task-service/`. The router starts it when `agents.yaml` enables it, and it listens on a new private Unix socket. It runs machine tasks, which are kept separate from Feishu chat routing.
2. **A thin stdio MCP facade** (`mcp/task-mcp.ts`, launched by `bin/router-task-mcp`). An MCP client starts it as a stdio server. It translates MCP `tools/call` and `resources/read` into requests on the task-service socket, and holds no state of its own.

```
MCP client (any) ──stdio/JSON-RPC──▶ mcp/task-mcp.ts (facade, stateless)
                                          │ NDJSON request/response
                                          ▼
                     ~/.claude/channels/feishu/task-service/task.sock
                                          │
                ┌─────────────── router.ts process ───────────────┐
                │ task-service/ (ledger, controller, recovery)     │
                │   ├─ store (task-service.db, SQLite WAL)         │
                │   ├─ backends/opencode → OpenCodeAdapter (reuse) │
                │   ├─ backends/claude   → `claude -p` stream-json │
                │   ├─ backends/codex    → `codex exec --json`     │
                │   ├─ backends/agy      → TmuxCliManager (reuse)  │
                │   └─ backends/fake (tests, fault injection)      │
                │ existing chat routing (unchanged)                │
                └──────────────────────────────────────────────────┘
```

The server name is **`router-task`**, and the domain contract version is `routerContractVersion = "1.1.0"`.

---

## 2. Goals and non-goals

### 2.1 Goals for phase 1

- Any local MCP client can start one task in an allowlisted project, or in a new directory under an allowed root that no config file mentions (§6), then observe it, read its result, answer its permissions, and close or cancel it. This keeps working when the client disconnects, retries, or the router restarts.
- All of the spec's safety properties hold:
  - durable idempotency
  - checks on the expected version and expected owner before any change
  - an explicit UNKNOWN state
  - no prompt is ever sent twice
  - cleanup releases only what the task owns
  - a fallback controller that only follows the frozen policy and is owned by the router
- Reuse:
  - `OpenCodeAdapter` (HTTP + SSE)
  - `SSEBuffer` and `normalize.ts`
  - `safeSummary`
  - `bun:sqlite` and the `openDb` conventions
  - `routing/config.ts` (zod, agents.yaml, canonicalizing project workdirs)
  - `router-lock.ts`
  - the router's process lifetime and launchd supervision
  - the existing pattern of newline-delimited JSON over a Unix socket
  - the MCP SDK already in `package.json` (`@modelcontextprotocol/sdk` 1.28.0, which supports protocol `2025-11-25`)
- Backends, all in phase 1 (owner decision, 2026-11-22):
  - a fake backend with fault injection
  - OpenCode in `http_sse` mode, through the existing `OpenCodeAdapter`
  - Claude Code in `print` mode: one `claude -p --output-format stream-json` process per attempt (§11.4)
  - Codex in `exec` mode: one `codex exec --json` process per attempt (§11.5)
  - Antigravity (`agy`) in `tmux` mode: the existing `TmuxCliManager` with a task-dedicated tmux session per attempt (§11.6)
- Fallback:
  - demonstrated between fake candidates, covering every switch that must be refused
  - with four real backends, real switches before delivery between different backends become possible. A real smoke test of two backends is still a separately authorized milestone (spec §12.8).

### 2.2 Non-goals for phase 1

- A Hermes client or Python example (owner decision). Integration docs show a generic MCP client configuration only.
- A public REST/OpenAPI interface, a bespoke SSE stream, remote transport, or authentication beyond the local UID.
- Claude Code in **tmux** mode for tasks. Print mode gives exact process ownership and structured turn evidence, which an interactive terminal UI cannot match. Chat keeps using Claude in tmux and socket modes as it does today.
- Codex through `app-server` (experimental). This is the future route to brokered permissions for Codex (§11.5).
- ACP.
- Multi-turn tasks on the same backend session (`router_task_add_turn` returns `UNSUPPORTED_CAPABILITY`), native `/goal` on any backend other than Claude tmux (§11.7), checkpoint handoff, post-delivery clean-failure fallback, and same-owner quota-reset resume. The schemas and controller must still model all of these and refuse them correctly (§12).
- Any change to Feishu chat routing, the `router.sock` worker protocol, chat fallback, or tmux idle reaping.

---

## 3. Terminology (general-purpose naming)

| Term | Meaning |
|---|---|
| client | Any MCP client process. `clientId` is a caller-chosen correlation string, **not** authentication. |
| task | One durable unit of work identified by a router-generated `taskId`. It holds one frozen assignment, and its execution attempts run one after another, never in parallel. |
| assignment | The frozen input: `inputKind`, `prompt`, `contractSha256`, `metadata`. |
| execution attempt | One backend session on one candidate. Fallback creates a new attempt within the same task. |
| turn | One model input submitted to an attempt. Phase 1 allows one turn per attempt. |
| owner | The exact live execution an attempt holds: a backend session plus the in-flight turn, fenced by `generation`. |
| grant | A short-lived authorization assertion from the client, bound to digests (§9.5, §12.5). |
| scopeKey | A client-defined exclusivity key. While a task is not CLOSED, it is the only task holding its `(clientId, scopeKey)`. |
| correlation | Optional opaque client tags, echoed back unchanged. The spec's Hermes fields `cohortId` and `attemptId` belong here. |

"Writer", "Broker" and "cohort" do not appear in code identifiers.

---

## 4. Reuse map

| Need | Existing piece | How it is used |
|---|---|---|
| Long-lived host process | `router.ts` under launchd `KeepAlive` | The task service starts inside it. No new daemon. |
| Single service instance | `router-lock.ts` (`router.lock` dir) | The router lock already guarantees one instance. The task DB also records `routerInstanceId` (§10.1). |
| Config + allowlist | `routing/config.ts`, `agents.yaml` `projects`, workdir canonicalization under `FEISHU_PROJECTS_ROOT` | New optional `taskService` block in the same zod schema. Task `projectId` refers to `projects.<id>`. |
| SQLite | `bun:sqlite`, WAL, `openDb` style | A separate file, `task-service/task-service.db`, keeps migrations and rollback independent of `router.db`. |
| OpenCode backend | `adapters/opencode/opencode-adapter.ts` (prompt_async, messageID-based turn identity, status + message polling, permission reply, abort) | Small additive refactor to expose `submit` and `observe` with a caller-provided message ID (§11.2). The chat path keeps calling `send()`, which composes them. |
| SSE parsing + normalization | `adapters/opencode/sse.ts`, `normalize.ts` | Reused as-is. Text parts are normalized through the existing `text.snapshot` shape (`messageId`, `partId`) to produce non-duplicating deltas. |
| Redaction | `adapters/opencode/presentation.ts` `safeSummary` | Used for tool and permission descriptions and error details in events. |
| UTF-8-safe splitting | `presentation.ts` `splitUnicode` (UTF-16 based) | A byte-based sibling, `splitUtf8Bytes`, is added next to it. Text events and paging need byte limits. |
| NDJSON-over-Unix-socket framing | `router.ts` worker socket / `worker-link.ts` | The same framing style on a **new** socket. `router.sock` is not touched. |
| Fallback trigger vocabulary | `routing/types.ts` `FallbackTrigger`, the OpenCode adapter's HTTP status → reason mapping (429 → `rate_limited`, 503 → capacity, …) | Reused as classification input. The decision logic is new and task-scoped (§12). `chooseFallback` stays chat-only. |
| Pure state machine pattern | `routing/task-machine.ts` (transition table + immutable `transition`) | Same pattern for the new phase machine. The chat task machine itself is not reused because it has different states. |
| MCP SDK | `@modelcontextprotocol/sdk` 1.28.0, already a dependency (used by `server.ts`) | The facade uses the SDK's `Server` + `StdioServerTransport`. Tests use the SDK's `Client`. |
| zod → JSON Schema | `zod` (dependency) + `zod-to-json-schema` (pulled in by the SDK) | One zod source per schema. Published JSON Schemas are generated from it (§7.2). |
| Fakes | `tmux/test-fixtures/fake-*.ts` pattern | `task-service/backends/fake.ts` with a scripted fault plan. `fake-claude.ts` and `fake-agy.ts` are reused for the agy and process-backend tests. |
| agy hosting | `tmux/manager.ts` `TmuxCliManager`, `tmux/profiles/agy.ts`, `agy-plugin/hook.sh` (Stop-hook signal files), `tmux/dialog.ts` (numbered permission menus), `tmux/agy-errors.ts` | The agy task backend uses a second `TmuxCliManager` instance. A profile wrapper gives it per-attempt session names and signal directories (§11.6). |
| CLI binary resolution | `tmux/profile.ts` `resolveBin` | Used for `claude`, `codex` and `agy` under launchd's reduced PATH. |
| Rate-limit reset parsing | `rate-limit-reset.ts` | Used only to emit diagnostics in phase 1. Same-owner reset resume is still not advertised. |

No new dependency: operation fingerprints and policy digests use a small in-house RFC 8785 JCS (`task-service/jcs.ts`). The domain contains no floating-point fields, so JCS reduces to sorted-key `JSON.stringify` over safe integers, strings, booleans, null, arrays and plain objects; anything else is rejected.

---

## 5. Process model and lifetime

### 5.1 Startup

`router.ts` gets a single wiring block after `openDb` and the adapter construction:

```ts
const taskService = infraConfig?.taskService?.enabled
  ? await startTaskService({ config: infraConfig, stateDir: STATE_DIR, openCodeAdapter, dbg })
  : null
```

`startTaskService` performs these steps:

1. It creates `STATE_DIR/task-service/` with mode 0700. If the directory exists, it must be a real directory (`lstat`), owned by the current UID, with mode 0700. Otherwise startup fails closed: the task service does not start, and the error is logged and reported through health. The chat router keeps running.
   - `STATE_DIR` itself is currently 0755, which is why the socket and DB live in their own 0700 subdirectory.
2. It opens `task-service.db`, runs migrations, and takes the service-instance row (§10.1).
3. It runs recovery (§10.4) with admission closed: queries are served, new conflicting mutations get `RECOVERY_IN_PROGRESS`.
4. It listens on `task-service/task.sock` and sets mode 0600. A stale socket is removed only after confirming it is a socket (`lstat().isSocket()`), never by following a symlink.

### 5.2 Survival rules

- **A facade or client exiting never touches execution.** The facade is a separate process. The service treats an IPC disconnect as the end of a transport and nothing more. A pending long poll is dropped, and no task changes state.
- **The router's idle shutdown must not kill live tasks.** `scheduleIdleShutdown()` currently exits 10 s after the last worker disconnects. It gains one guard: `if (taskService?.hasLiveWork()) return`. Live work means any task not CLOSED, including UNKNOWN, or any connected facade. Under launchd the router would respawn anyway, but an unplanned exit turns every active task into UNKNOWN, so it must not happen by design.
- **The facade never spawns a service.** Unlike `server.ts`, which auto-spawns the router, the facade reports a retryable `SERVICE_UNAVAILABLE` if the socket is missing or refuses connections (spec §1.2). launchd keeps the router up.
- **Router shutdown (SIGTERM).** The service stops admission, stops watchdog timers, and closes the socket. It does **not** cancel tasks, and the next start reconciles them (§10.4):
  - Running OpenCode turns continue inside `opencode serve`.
  - Claude and Codex child processes keep running: they are spawned detached, in their own process group, with stdout and stderr redirected to files.
  - agy runs inside tmux, which is a separate daemon.

### 5.3 Isolation from chat

- Machine tasks never use `conversation_bindings`, `tmux_sessions`, `DegradedTracker`, chat fallback, `/reset`-style commands, or tmux idle reaping.
- Every attempt creates its own OpenCode session (`POST /session?directory=…`). The service never looks up a chat session by workdir.
- There is **no task concurrency cap by default** (owner decision). The router hosts several backends, and a single OpenCode-style limit would not fit them.
  - An optional `taskService.maxConcurrentTasks` and per-backend `taskService.backends.<kind>.maxConcurrentTasks` exist for operators who want one.
  - Task load is counted separately from chat's `agents.opencode.maxConcurrency`.
  - When a configured cap is full, or a backend reports that it is out of capacity, the request is rejected with `CAPACITY_EXHAUSTED` and is never queued behind chat work.
- Even when a chat group and a task share a workdir and the same `opencode serve`, their sessions are distinct. Closing a task never calls the server-level shutdown, and never aborts sessions that the task did not create.

---

## 6. Configuration

The new optional block in `agents.yaml` is validated by the existing loader. Startup fails closed on an invalid file, which is current behavior.

```yaml
taskService:
  enabled: false                 # default; the MCP is inert until set to true
  # maxConcurrentTasks: 8        # optional; unset = no cap (default)
  projects:                      # optional: named projects with their own roots
    feishuchannel:               # must also exist under top-level `projects:`
      workdirRoots:              # default: [projects.<id>.workdir]
        - /Users/openclaw/Projects/feishuchannel
        - /Users/openclaw/Projects/feishuchannel-worktrees
  dynamicWorkdirs:               # directories that appear in no config file
    enabled: true
    roots:                       # default: AGENTS_ALLOWED_ROOTS (FEISHU_PROJECTS_ROOT, i.e. ~/Projects)
      - /Users/openclaw/Projects
      - /tmp                     # temp dirs: add any root here; canonicalized (/tmp -> /private/tmp on macOS)
    allowedAgents: [opencode, claude, codex, agy]
    requireGitWorktree: false    # true: workdir must contain a .git dir/file
    denyPaths: []                # extra canonical subtrees that are refused
  http:                          # router-task MCP over Streamable HTTP (§7.4a)
    enabled: true
    host: 127.0.0.1
    port: 8767
  backends:                      # task-side settings; chat settings under `agents:` are untouched
                                 # `models` is optional everywhere: omitted = pass the model through to the CLI
    opencode:                    # endpoint/password still come from agents.opencode
      models: ["deepseek/deepseek-flash"]   # explicit allowlist; no implicit default model
    claude:
      bin: null                  # default: resolveBin('claude', [~/.local/bin/claude])
      models: ["opus", "sonnet", "fable"]
      permissionPromptTool: true # broker permissions via the relay MCP (§11.4)
      strictMcpConfig: false     # true: pass --strict-mcp-config (only the relay MCP is loaded)
    codex:
      bin: null                  # default: resolveBin('codex', [/opt/homebrew/bin/codex])
      models: ["gpt-5.5-codex"]
      sandbox: workspace-write   # read-only | workspace-write; danger-full-access is refused
    agy:
      bin: null                  # default: agents.agy.bin, then resolveBin('agy', …)
      models: ["<agy model id>"]
      effort: null               # optional, same values as agents.agy.effort
      permissionMode: null       # accept-edits | auto | plan; null = agy default
    fake:
      enabled: false             # tests enable it in their own temporary state dir
```

The model names above are placeholders. The operator lists the exact model identifiers each CLI accepts.

Rules:

- **Dynamic directories.** Clients can ask for a task in a directory that appears in neither `access.json` nor `agents.yaml`, for example a worktree created a moment earlier. Such a directory is accepted when all of the following hold:
  - it canonicalizes under one of `dynamicWorkdirs.roots`
  - it is not on the deny list (§9.3)
  - it satisfies `requireGitWorktree` when that is set

  The allowlist is still enforced on the server, as a set of roots rather than a list of exact directories. Clients still cannot pass paths outside those roots.

  No config edit, router restart, Feishu group or `access.json` entry is needed. Creating a task registers nothing in chat routing, and once the task is CLOSED the router keeps no state about the directory beyond the task's own record.
- `taskService.projects` keys must exist in `projects`. The backend `kind` of each candidate must be in that project's `allowedAgents`, with `fake` allowed only when `backends.fake.enabled`.
- `workdirRoots` must be absolute, canonicalize under `AGENTS_ALLOWED_ROOTS`, and are stored canonicalized. This uses the same code path as `validateRouterConfig`.
- `dynamicWorkdirs.roots` follow the same rules as `workdirRoots`: they must be absolute and are canonicalized at load time.
  - A root may be outside `$HOME`, for example `/tmp`, `/private/tmp`, or `os.tmpdir()`.
  - `/`, `$HOME`, and any root that contains `$HOME`, `STATE_DIR` or `~/.claude` are rejected when the config loads.
- **Ownership check for every dynamic workdir.** This matters for shared, world-writable roots such as `/tmp`. The workdir and every path component between the root and the workdir must:
  - be owned by the router's UID
  - not be writable by group or others (`mode & 0o022 == 0`)

  The root itself is exempt, since `/private/tmp` is world-writable with the sticky bit. This stops another local user from planting a directory or a symlink under `/tmp` for a task to run in. A failure returns `WORKDIR_NOT_ALLOWED` with `details.reason: "ownership"`.
- `taskService.backends.<kind>` must be present for a kind to be usable by tasks. It also needs `agents.<kind>` where the backend has chat-side connection settings (only `agents.opencode` today).
- `codex.sandbox: danger-full-access` and any bypass-approvals flag are rejected when the config loads. Claude's `--permission-mode bypassPermissions` cannot be configured for tasks.
- The service reads its config at router start. Changing it requires a router restart (`launchctl kickstart -k gui/$UID/com.openclaw.feishuchannel-router`). This avoids the allowlist changing while a task is in flight.
- Backend endpoints, passwords (`passwordEnv`) and binaries stay in `agents.<kind>`. Tool arguments can never carry URLs, commands, environment variables, paths to executables, or credentials (spec §2.3).

---

## 7. MCP facade

### 7.1 Protocol profile

- Transport: stdio, via the SDK's `StdioServerTransport`. stdout carries only JSON-RPC, and every diagnostic goes to stderr. A test asserts that every byte on stdout belongs to a protocol message (acceptance case 1).
- Protocol: SDK version negotiation, with `2025-11-25` as the latest. The negotiated version is recorded in tests.
- `serverInfo`: `{name: "router-task", version: <package.json version>}`.
- Capabilities: `tools` (static list, no `listChanged`) and `resources` (templates only, no subscribe). No prompts, sampling, elicitation, roots, or experimental `tasks` support. Tools declare `execution.taskSupport: "forbidden"` where the SDK supports it, or omit it, which defaults to forbidden.
- MCP `notifications/cancelled` aborts only the pending IPC request inside the facade. It never maps to a task cancel.
- No progress or logging notifications in phase 1. They are optional and not needed for correctness.

### 7.2 Implementation approach

The facade uses the SDK's low-level `Server` with explicit `tools/list` and `tools/call` handlers, not `McpServer.registerTool`. The reasons:

- `registerTool` validates input before the handler runs. Its error shape cannot be turned into the spec's domain `INVALID_REQUEST` envelope.
- The spec requires an output schema with discriminated success and error alternatives, which the high-level helper cannot express cleanly.

Concretely:

- Each tool is defined once in `mcp/tool-defs.ts` as a zod argument schema with `.strict()`, a zod schema for the success `data`, annotations, and a description.
- `inputSchema` and `outputSchema` are generated with `zod-to-json-schema` when the facade starts. The same generator writes `schemas/*.json` through `bun run schemas` for the deliverable, and a test checks that the committed files match the generated ones.
- `outputSchema` is `oneOf` the success envelope (`ok: true`, typed `data`) and the error envelope (`ok: false`, `data: null`). This covers every tool.
- `tools/call` validates the arguments with zod and builds an `INVALID_REQUEST` envelope on failure, including unknown fields and out-of-range values. An unknown tool name gets the standard MCP protocol error.
- Every result contains `structuredContent` set to the envelope, exactly one `text` content block holding `JSON.stringify(envelope)`, and `isError` set to `!envelope.ok`.
- **To verify during implementation:** whether SDK 1.28's client-side validation of `structuredContent` handles a `oneOf` output schema together with `isError: true`. If it does not, fall back to a single object schema with nullable `data` and `error` plus an `ok` discriminator, and record that in §17.

### 7.3 Facade ↔ service IPC

- Newline-delimited JSON on `task.sock`. Requests are `{"id": n, "method": "<tool or resource op>", "params": {...}, "requestId": "<uuid>"}`. Responses are `{"id": n, "envelope": {...}}` for tools and `{"id": n, "resource": {...}}` or `{"id": n, "resourceError": {...}}` for resources.
- The facade adds nothing beyond `requestId` generation, which it uses only when the client omits one, and timeouts.
- All validation, idempotency and state live in the service. The service validates again, so the facade is never trusted.
- Timeouts: 10 s per request, and 25 s for `router_events_read` with `waitSeconds > 0`, since the service caps long polls at 20 s.
- During router restarts: read-only tools retry the connection for up to 10 s, which covers the launchd throttle window, before returning `SERVICE_UNAVAILABLE`. Mutations never retry inside the facade.
- The facade never exposes admin methods (§10.4).
- An IPC timeout or disconnect yields `SERVICE_UNAVAILABLE` with `retryable: true` and `sideEffects: "unknown"` for mutations, or `"none"` for queries. The client must then reconcile using the same idempotency key (spec §3).
- The connection is opened lazily per facade process and reconnected on demand.
- Peer check: Bun does not expose `SO_PEERCRED` / `getpeereid`. Isolation comes from the 0700 directory plus the 0600 socket owned by the router UID. This matches the spec's v1 trust model, where any process running as the same UID is trusted, and the limitation is recorded in §17.

### 7.4 Launcher and client config

`bin/router-task-mcp` (shell):

```sh
#!/bin/sh
exec bun "$(dirname "$0")/../mcp/task-mcp.ts" --stdio "$@"
```

Example configuration for any MCP client:

```json
{
  "mcpServers": {
    "router-task": {
      "command": "/Users/openclaw/Projects/feishuchannel/bin/router-task-mcp",
      "args": ["--service-socket", "/Users/openclaw/.claude/channels/feishu/task-service/task.sock"]
    }
  }
}
```

`--service-socket` is optional and defaults to `$FEISHU_STATE_DIR/task-service/task.sock`. The facade refuses a socket path whose parent directory fails the 0700/owner check.

### 7.4a Streamable HTTP (default transport)

Owner direction (2026-11-22): the MCP is served over Streamable HTTP and starts together with the router. `mcp/http.ts` runs inside the router process next to task.sock and calls the `TaskService` in-process through the same facade (`createFacade` with an in-process requester). The tools, envelopes and timeouts are identical to the stdio facade.
- **Transport:** stateless (a fresh facade and transport per POST) with JSON responses. All state lives in the task service.
- **Security:**
  - binds loopback only (`127.0.0.1` / `localhost` / `::1`; any other address is refused);
  - DNS-rebinding protection: the `Host` must be the bound `host:port`, and a browser `Origin` must match it;
  - optional bearer token (`taskService.http.bearerTokenFile`, compared in constant time);
  - admin operations are never exposed.
- **Config:** `taskService.http {enabled (default true), host, port (default 8767), bearerTokenFile}`.
- **Failure:** fails soft. A taken port or an unreadable token is logged, and the task service and the stdio launcher keep working.
- **Trust model:** this widens the stdio model from "same UID, via a 0700 dir and 0600 socket" to "any local process that can reach loopback". Set a bearer token on a multi-user machine.

### 7.5 Tool annotations

- Query tools (`router_health`, `router_capabilities`, `router_task_get`, `router_task_lookup`, `router_events_read`, `router_task_result`, `router_turn_text_read`): `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- Mutation tools (`router_task_prepare`, `_start`, `_authorize`, `_seal`, `_close`, `_cancel`, `_add_turn`, `router_permission_reply`): `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: true`.

---

## 8. Domain model

Bounds, formats and the meaning of each field follow spec §4. Only the decisions specific to this design are listed here.

### 8.1 Identifiers

- `taskId = "task_" + ULID`, `executionAttemptId = "xatt_" + ULID`, `executionId = "exec_" + ULID`, `turnId = "turn_" + ULID`, `operationId = "op_" + ULID`, `transitionRequestId = "xreq_" + ULID`.
  - Identifiers are opaque. A ULID gives time ordering for debugging only, and nothing relies on it.
- `routerInstanceId` is generated once per DB and stored in `meta`.
- Validation of client-supplied strings (1–256 UTF-8 bytes, no control characters), idempotency keys (1–128 printable non-space ASCII), and SHA-256 hex is done by shared zod refinements in `task-service/schema/primitives.ts`.

### 8.2 General-purpose prepare shape

This follows spec §5.3, with the Hermes-specific fields generalized (see §17):

```json
{
  "idempotencyKey": "job-42-prepare",
  "clientId": "nightly-ci",
  "clientTaskId": "job-42",
  "scopeKey": "repo:feishuchannel:pr:123",
  "correlation": {"cohortId": "c-123", "attemptId": "a-1"},
  "projectId": "feishuchannel",
  "workdir": "/Users/openclaw/Projects/feishuchannel-worktrees/pr-123",
  "backend": {"kind": "opencode", "mode": "http_sse", "model": "deepseek/deepseek-flash", "variant": null},
  "assignment": {
    "inputKind": "text",
    "prompt": "…",
    "contractSha256": "<64 hex>",
    "metadata": {"workflow": "pr_repair", "stage": "repair"}
  },
  "policy": {
    "inputMode": "single_turn",
    "fallback": { "enabled": false, "candidates": [ {"kind":"opencode","mode":"http_sse","model":"deepseek/deepseek-flash","variant":null} ],
                  "triggerOn": [], "maxSwitches": 0, "startupRetriesPerCandidate": 0, "retryDelaySeconds": 0,
                  "maxRecoverySeconds": 60, "onExhausted": "fail",
                  "sameOwnerReset": {"enabled": false, "maxWaitSeconds": 0, "maxResumeActions": 0} },
    "permissionMode": "broker",
    "runTimeoutSeconds": 7200, "idleTimeoutSeconds": 600,
    "permissionTimeoutSeconds": 1800, "quiescentTimeoutSeconds": 3600
  }
}
```

- `projectId` is **nullable**.
  - A string means a named project from `taskService.projects`: the workdir must fall under that project's `workdirRoots`, and the project's `allowedAgents` apply.
  - `null` means a dynamic directory: the workdir must fall under `dynamicWorkdirs.roots`, and `dynamicWorkdirs.allowedAgents` apply.
  - If `projectId` is `null` but the workdir also falls under a named project's roots, the named project's rules apply. The snapshot then reports `projectId: "<that project>"` with `workdirSource: "project"`. A client cannot avoid a project's stricter `allowedAgents` by leaving `projectId` empty.
  - Otherwise the snapshot reports `projectId: null` with `workdirSource: "dynamic"`.
- `correlation` is optional: at most 8 keys, each key 1–64 bytes matching `[A-Za-z0-9_.-]`, each value 1–256 bytes. It is part of the frozen task content, so a different `correlation` under the same `clientTaskId` is a `CLIENT_TASK_CONFLICT`. It is echoed in snapshots.
- `assignment.metadata` is optional: at most 8 string keys under the same rules, values at most 128 bytes, and `{}` is valid. The spec limited this to `workflow` and `stage`; this design generalizes it.
- `contractSha256` stays required. A client with no external contract can pass the SHA-256 of an empty string or of its own task description. Either way it is a correlation value and is never checked against any file.
- `permissionMode` is `"broker" | "backend_policy"`:
  - `broker`: every permission prompt the backend raises is sent to the client as `permission.requested` and answered through `router_permission_reply`. Only backends advertising `permissionReply: true` accept it: OpenCode, Claude print (through the relay), agy tmux and the fake.
  - `backend_policy`: the backend runs non-interactively under a sandbox or permission policy configured **on the server**. No permission events are emitted, and anything the policy does not allow is refused by the backend itself. Every backend accepts it.
    - The policy applied is recorded in the snapshot (`permissionPolicy`, e.g. `{"kind": "codex", "sandbox": "workspace-write", "approval": "never"}`).
    - Clients cannot change it through tool arguments.
  - Codex `exec` supports only `backend_policy` (§11.5).
  - For a fallback chain, the mode applies to every candidate: `broker` requires `permissionReply` on all of them, otherwise prepare fails with `UNSUPPORTED_CAPABILITY`.
- `backend.model` must be in `taskService.backends.<kind>.models`. There is no implicit default model.
- `variant` must be `null` in phase 1 for every real backend. The CLI flags and the OpenCode prompt_async path have no verified variant field. A non-null value returns `UNSUPPORTED_CAPABILITY`.
  - agy reasoning effort comes from the server-side `taskService.backends.agy.effort`, not from `variant`.

### 8.3 Phases and transitions

Phases follow spec §4.3: PREPARED, STARTING, ACTIVE, WAITING_PERMISSION, WAITING_INPUT, QUIESCENT, FALLBACK_PENDING, WAITING_AUTHORIZATION, WAITING_RETRY, FINALIZING, CLOSED, UNKNOWN.

`task-service/lifecycle.ts` is a pure transition table in the style of `routing/task-machine.ts`:

| From | To |
|---|---|
| PREPARED | STARTING, FINALIZING (cancel / expiry), CLOSED (not_started, expiry with nothing to clean) |
| STARTING | ACTIVE, FALLBACK_PENDING, FINALIZING, UNKNOWN |
| ACTIVE | WAITING_PERMISSION, WAITING_INPUT, QUIESCENT, FALLBACK_PENDING, FINALIZING, UNKNOWN |
| WAITING_PERMISSION | ACTIVE, FINALIZING, UNKNOWN |
| WAITING_INPUT | FINALIZING, UNKNOWN |
| QUIESCENT | FINALIZING |
| FALLBACK_PENDING | WAITING_AUTHORIZATION, WAITING_RETRY, STARTING, FINALIZING, UNKNOWN |
| WAITING_AUTHORIZATION | STARTING, FINALIZING, UNKNOWN |
| WAITING_RETRY | STARTING, WAITING_AUTHORIZATION, FINALIZING, UNKNOWN |
| FINALIZING | CLOSED, UNKNOWN |
| UNKNOWN | FINALIZING (only via proven reconciliation or a verified-owner cancel), ACTIVE / QUIESCENT (only via `owner.reconciled`) |
| CLOSED | — |

Every transition increments `controlVersion` and appends its event in the same SQLite transaction. Text output never increments `controlVersion`.

### 8.4 Snapshot, turn, result

Shapes are exactly those of spec §4.4, §5.7 and §5.8, with `cohortId` and `attemptId` replaced by `correlation`. The fallback-related snapshot fields from spec §4.4 are present from phase 1: `fallbackPlanSha256`, `selectedCandidateIndex`, `actualBackend`, `currentExecutionAttemptId`, `executionAttemptCount`, `fallbackState`, `pendingAuthorization`. Timestamps are RFC 3339 in `+08:00`, produced by one helper.

For OpenCode, the owner fields are `backendSessionId = <OpenCode session id>`, `pid = null` and `processStartIdentity = null`. The shared `opencode serve` process is not the owner, and its PID is never stored as one.

---

## 9. Tool behaviour

Every tool behaves as in spec §5. This section records the implementation decisions.

### 9.1 Mutation pipeline (shared)

`task-service/operations.ts` applies the same steps to every mutation:

1. Validate the arguments (zod, strict). An `INVALID_REQUEST` here records nothing.
2. Compute `fingerprint = sha256(JCS(args without requestId and idempotencyKey))`.
3. Look up `operations(client_id, tool, target, idempotency_key)`. For a task control, `target = taskId` and `clientId` comes from the stored task. For prepare, `target = "create"` and `clientId` comes from the arguments.
   - completed, same fingerprint → replay the stored envelope with `replayed: true` and the current `requestId`
   - same key, different fingerprint → `IDEMPOTENCY_CONFLICT`
   - pending → `OPERATION_IN_PROGRESS` with `retryAfterMs`
4. Only then check `phase`, `sealed`, `expectedControlVersion` and `expectedOwner`.
5. In one `BEGIN IMMEDIATE` transaction:
   - insert the operation as pending
   - apply the state change
   - append events
   - store the response envelope
   - mark the operation completed

   The acknowledgement goes out after `COMMIT`.
6. Backend side effects (create session, prompt, abort, permission reply) run after commit in the controller. They are driven from durable intent rows, never from the request handler.

Domain errors that are decided after the lookup (for example `VERSION_CONFLICT`) are also stored under the key. Retrying the same key therefore returns the same decision, as spec §4.2 requires for "resolve a prior operation before validating".

### 9.2 `router_health`, `router_capabilities`

- `health`: `status: "ok"` when the DB can be read and written and the socket answers. It also reports `recoveryInProgress`. It says nothing about backend health.
- `capabilities`: limits come from constants that mirror spec §5.2, plus the actual `maxConcurrentTasks`, which is `null` when no cap is configured (the default). Each backend entry also carries its own `maxConcurrentTasks` (nullable) and the `permissionModes` it accepts. Per-backend entries:

| kind / mode | available | features | fallback capabilities |
|---|---|---|---|
| `opencode` / `http_sse` | `OpenCodeAdapter.health()` (cached 10 s) | isolatedSession ✔, samePrimaryTurns ✘, recoverAcceptedTurn ✔ (message ID), permissionReply ✔, cancel ✔, eventReplay ✔ | orderedFallback ✔, supportedFallbackTriggers: `backend_unavailable`, `startup_failed`, `rate_limited`, `provider_unavailable`, `model_unavailable`, all only at `before_delivery`; cleanFailureFallback ✘, checkpointHandoff ✘, sameOwnerResetRecovery ✘, nativeGoal ✘ |
| `claude` / `print` | binary resolves and `claude --version` succeeds (cached 60 s) | isolatedSession ✔ (`--session-id`), samePrimaryTurns ✘, recoverAcceptedTurn ✔ (detached process + output file), permissionReply ✔ (relay), cancel ✔, eventReplay ✔ | orderedFallback ✔, supportedFallbackTriggers: `backend_unavailable`, `startup_failed`, all only at `before_delivery`; others ✘ |
| `codex` / `exec` | binary resolves and `codex --version` succeeds (cached 60 s) | isolatedSession ✔ (new thread per process), samePrimaryTurns ✘, recoverAcceptedTurn ✔ (detached process + output file), permissionReply ✘ (`backend_policy` only), cancel ✔, eventReplay ✔ | orderedFallback ✔, supportedFallbackTriggers: `backend_unavailable`, `startup_failed`, all only at `before_delivery`; others ✘ |
| `agy` / `tmux` | binary resolves, `tmux` is available, the agy hooks plugin is installed | isolatedSession ✔ (task-dedicated tmux session), samePrimaryTurns ✘, recoverAcceptedTurn ✔ (tmux session + persisted conversation id + Stop signal), permissionReply ✔ (numbered dialog), cancel ✔, eventReplay ✔ | orderedFallback ✔, supportedFallbackTriggers: `backend_unavailable`, `startup_failed`, all only at `before_delivery`; others ✘ |
| `fake` / `exec` (only when enabled) | scripted | all phase-1 features, scripted | everything the controller models, including `clean_failure` and `checkpoint_handoff`, so the blocked and grant flows can be tested |

`rate_limited` and `quota_exhausted` are deliberately not advertised for the three CLI backends in phase 1. Their rate-limit evidence is terminal text, and the spec does not accept text alone as positive evidence until a backend-specific, tested diagnostic exists.

Known but unimplemented combinations, such as `claude/tmux` and `codex/app_server`, are listed with `available: false` and `availabilityReason: "not_implemented"`, so clients can see they exist but cannot use them. Prepare rejects them with `UNSUPPORTED_CAPABILITY`.

### 9.3 `router_task_prepare`

Prepare does no backend I/O. It performs these steps:

- Resolves the workdir (`task-service/access.ts`, shared by named and dynamic directories):
  1. The input must be an absolute path with no NUL or control characters.
  2. `realpath()` is applied and the result must be an existing directory (`stat().isDirectory()`). The service **never creates directories**: a client that needs a new worktree creates it before prepare. A missing directory returns `WORKDIR_NOT_ALLOWED` with `details.reason: "not_found"`.
  3. The canonical path is matched against roots by path segment (`root + "/"` prefix or equality), never by a raw string prefix. Named project roots are checked first (§8.2), then `dynamicWorkdirs.roots`.
  4. A **deny list** is always applied, even inside an allowed root:
     - `STATE_DIR` and everything under it
     - `~/.claude`
     - `$HOME` itself
     - each root itself, so a whole root such as `~/Projects` cannot be claimed as one workdir
     - every `denyPaths` entry
  5. For a dynamic workdir, the ownership and mode check from §6 is applied to each path component below the matched root.
  6. If `requireGitWorktree` is set, the directory must contain `.git` (a directory, or a file pointing to a worktree gitdir).
  7. Each candidate backend `kind` must be in the applicable `allowedAgents`. Otherwise prepare returns `PROJECT_NOT_ALLOWED`.
  8. The service records `{canonicalPath, dev, ino, workdirSource}`. Because the path was resolved with `realpath`, a symlink in the input resolves to its target, and that target must itself pass every check above. Before each dispatch, `realpath` + `dev`/`ino` are checked again, so replacing the directory or swapping in a symlink after prepare is detected (`WORKDIR_NOT_ALLOWED`, task finalized as not_started or UNKNOWN as appropriate).
- No backend needs per-directory setup, so a dynamic directory works unchanged:
  - OpenCode takes the directory through `?directory=`.
  - Claude and Codex processes are spawned with `cwd` set to the canonical workdir. Codex also gets `-C <workdir>`, plus `--skip-git-repo-check` when the directory is not a git repository (e.g. under `/tmp`).
  - agy is started by tmux with `-c <workdir>`.
- Validates the policy (§12.1).
- Computes `promptSha256` over the exact prompt bytes and `fallbackPlanSha256 = sha256(JCS(policy.fallback))`.
- Checks scope: the unique index on `(client_id, scope_key)` covers every non-CLOSED task and returns `SCOPE_BUSY`.
- Checks `clientTaskId`: a unique index on `(client_id, client_task_id)`. Identical frozen content replays the existing task, and different content returns `CLIENT_TASK_CONFLICT`.
- Arms the 10-minute PREPARED expiry as a persisted deadline.
- Returns `{task, resources: {snapshotUri, resultUri}}`.

### 9.4 `router_task_get`, `router_task_lookup`

These are plain reads. `lookup` is the recovery path when a prepare reply was lost.

### 9.5 `router_task_start`

Start requires PREPARED, unsealed, and the expected `controlVersion`. It then checks the grant:

- `expiresAt` must be in the future and at most 60 s after acceptance.
- All three digests must match.

Capacity is checked at acceptance. When it is full, the call returns `CAPACITY_EXHAUSTED` with `sideEffects: "none"`, and the task stays PREPARED.

In the same transaction, the service:

- creates the first execution attempt (`candidateIndex = 0`), `executionId`, `turnId` and the **backend turn identity**. For OpenCode, that identity is the prompt message ID, generated with the adapter's existing ascending ID generator.
- stores the grant
- moves the task to STARTING with owner state `starting`

The controller then performs these steps:

1. It checks the start time limit (`runTimeoutSeconds` begins at the first durable start intent) and the workdir identity (`dev`/`ino` unchanged).
2. It runs preflight (`health`), with failures classified per §12.2.
3. It creates the session (`POST /session?directory=`). It persists `backendSessionId` and emits `owner.established` (owner state `live`, generation unchanged).
4. It re-checks that the grant has not expired and that the task is not sealed or cancelled, then persists `delivery_attempt = in_flight` **before** the HTTP call. Then it calls `submit`.
   - 204: `delivery = accepted`, emits `turn.accepted`, and the phase moves to ACTIVE.
   - HTTP error response: `not_sent`, classified per §12.2.
   - Network error, timeout, or crash: `delivery = unknown`. The service then observes using the persisted message ID. If the message appears, delivery is `accepted`. If it cannot be proved, the task goes to UNKNOWN. **The prompt is never posted again.**

The steps above use OpenCode as the example. §11.7 lists the equivalent session, turn identity and delivery proof for Claude, Codex and agy. The rule is the same for every backend: the backend turn identity is persisted before submission, and a submission whose outcome is ambiguous is never repeated.

If the grant expires before step 4, the empty session is released (§9.10), and the task finishes `not_started` (or, if fallback applies, enters the controller).

### 9.6 `router_events_read`

- `task_events` has `PRIMARY KEY (task_id, seq)` and `seq` is assigned inside the state transaction. The read is `SELECT … WHERE seq > ? ORDER BY seq LIMIT ?`, followed by trimming to 256 KiB of serialized size.
- Long poll: if the page is empty and the task is not CLOSED, the request waits on an in-memory per-task notifier. It is signalled only after `COMMIT`, and the wait is at most `waitSeconds`.
  - At most one concurrent long poll per `(taskId, clientId)`. A second one gets `CAPACITY_EXHAUSTED` with `retryAfterMs`.
  - A process-wide cap of 64 long polls applies.
- Cursor errors: `INVALID_CURSOR` and `EVENT_CURSOR_EXPIRED`, as in the spec, with `details`.
- Text from Claude (`stream_event` / `assistant` text blocks), Codex (`item.completed` agent messages) and agy (transcript text parsed by the existing profile `parseText`) is normalized into the same `text.delta` and `text.reset` events per stream.
- Text: the OpenCode `message.part.updated` text part is a full snapshot. The OpenCode attempt runner diffs each snapshot against the last stored text for its `partId` and emits only the appended suffix as `text.delta {streamId: partId, text}`. If a snapshot is not a prefix extension (a rewrite), it emits `text.reset {streamId}` followed by the full text. This extra event type is recorded in §17. Deltas are split at UTF-8 boundaries so each event stays at or below 64 KiB.
- Tool events carry `toolCallId`, `name` and `status`. Arguments and outputs are not stored. Descriptions pass through `safeSummary`.

### 9.7 `router_task_result`, `router_turn_text_read`

- The final text of a turn is built when the turn ends. For OpenCode it comes from `finalizeFromMessages`: the text parts of the last assistant message whose `parentID` is the turn's prompt ID.
- It is stored in `turn_texts(turn_id, text BLOB, sha256, total_bytes)`, with a 16 MiB cap. Reaching the cap triggers safe cancellation with `OUTPUT_LIMIT_EXCEEDED`, and the available prefix is kept together with its true digest and length.
- `finalText` inline is the first 16 KiB, cut at a code-point boundary, and `finalTextTruncated` is set accordingly.
- `turn_text_read` slices the BLOB by byte offsets and rejects offsets that are not on a code-point boundary with `INVALID_CURSOR`.
- `process.exitCode` and `process.signal`:
  - always `null` for OpenCode, and for agy (an interactive session has no per-turn exit)
  - the real raw values for the Claude and Codex child processes, never invented
- `businessAcceptance` is always `"not_evaluated"`.
- Final text by backend: OpenCode uses `finalizeFromMessages`. Claude uses the `result` event's `result` field. Codex uses the last `agent_message` item, cross-checked with `--output-last-message`. agy uses the reply that the existing manager's `collectReply` assembles for this turn.

### 9.8 `router_permission_reply`

- `permission.requested` is persisted with `permissionRequestId = <OpenCode request id>`. The task service creates no new ID, because OpenCode's ID is already unique per request.
- It also stores `toolCallId`, `toolName`, a redacted description, `expiresAt = now + permissionTimeoutSeconds`, and options `[allow_once, deny_once]`. The phase moves to WAITING_PERMISSION, which pauses the idle timer.
- The reply is checked against the exact task, turn and owner, the expected `controlVersion`, and pending-and-unexpired status. Unsupported options and `always` are rejected with `INVALID_OPTION`.
- The decision is recorded first. Then the controller calls `respondPermission(requestId, allow → "once" | deny → "reject")`.
  - On HTTP 2xx, `permission.resolved` records the backend-confirmed decision.
  - If the ACK is lost or ambiguous, the permission stays `unresolved_unknown`, and the turn's permission poll (`GET /permission`) decides. If the request disappears and the turn moves on, it is resolved. If that cannot be proved before the time limit, the task goes to UNKNOWN. **The service never sends a second allow.**
- Expiry: the service sends a scoped `reject`, then cancels and cleans up (§9.10).
- Other backends (details in §11.4 and §11.6):
  - **Claude**: the relay MCP's `tool_use_id`-scoped request becomes `permissionRequestId`. The reply answers the relay's pending call.
  - **agy**: a recognized numbered permission dialog becomes a request, with ID `perm_<ULID>` bound to the dialog's text digest. `allow_once` and `deny_once` map to the dialog's matching options, and a dialog without a clear one-shot allow/deny pair is reported as `interaction.required`.
  - **Codex**: never emits permission requests (`backend_policy` only).

### 9.9 `router_task_seal`

Seal is a single transaction. It sets `sealed = 1`, invalidates pending grants and transition requests, and cancels retry and reset timers (rows marked void, in-memory timers cleared after commit). It sends no backend input and does not interrupt a turn that was already accepted.

### 9.10 `router_task_close`, `router_task_cancel` and owner release

Both persist intent, then seal, then move to FINALIZING, before any backend action. Release for OpenCode is **session-scoped only**:

1. If a turn may be running, the service calls `POST /session/{id}/abort?directory=…`. With cancel, it waits up to `graceSeconds`.
2. It checks that the owner has settled: `/session/status` does not list the session as busy, and no tool part of this turn is `running` or `pending`.
3. It marks the owner `released`, sets `cleanup.ownerReleased = true` and `backgroundWorkSettled = true`, then CLOSED.
4. The OpenCode session itself is **kept**, not deleted, so `backendSessionId` remains useful as audit evidence. Optional deletion can come later behind config.

If verification fails or the backend cannot be reached, the task goes to UNKNOWN and keeps its scope. The service never kills `opencode serve`, never touches sessions it did not create, and never deletes worktrees.

Release for the other backends:

- **Claude and Codex (child processes):**
  1. Send SIGINT to the attempt's process group, then wait for exit up to `graceSeconds`.
  2. If it is still running, send SIGKILL to the same process group.
  3. Release is verified when the PID is gone, or reused by a process with a different start time, and no process in that process group remains.

  The service only signals a process whose PID **and** `processStartIdentity` (start time from `ps -o lstart=`) match the stored owner. It never scans by workdir or name.
- **agy (tmux):** send Escape, then kill the task's own tmux session (`rtask-<attemptId>`) through the manager's `killSession`. Release is verified when `tmux has-session` fails for that exact name. Chat tmux sessions are never involved, because their names come from a different function.

- Close requires QUIESCENT, otherwise `TASK_NOT_QUIESCENT`, and sends no model prompt.
- Cancel racing with a natural finish: if `finalizeFromMessages` already proved `completed`, that outcome is kept. If no backend execution ever started, the outcome is `not_started`.

### 9.11 `router_task_add_turn`

This tool is listed with its full schema and always returns `UNSUPPORTED_CAPABILITY`, after the same argument validation and idempotency recording as other mutations.

### 9.12 `router_task_authorize`

Implemented as in spec §12.5; see §12.5 below.

---

## 10. Storage and recovery

### 10.1 Database

`STATE_DIR/task-service/task-service.db` uses SQLite WAL, `foreign_keys = ON` and `busy_timeout = 5000`. Migrations are ordered SQL scripts in `task-service/store/migrations.ts`, tracked in `meta(schema_version)`, and apply forward only.

| Table | Key / constraints | Purpose |
|---|---|---|
| `meta` | key | `schema_version`, `router_instance_id`, `service_lock` (pid + start identity, informational; the router lock is authoritative) |
| `tasks` | `task_id` PK; UNIQUE(`client_id`,`client_task_id`); partial UNIQUE(`client_id`,`scope_key`) WHERE `phase != 'CLOSED'` | snapshot columns + frozen JSON (assignment without the prompt, policy, correlation), `control_version`, `sealed`, `last_seq`, deadlines |
| `task_prompts` | `task_id` PK | exact prompt BLOB (needed to dispatch fallback attempts). Never returned by any read. Purged with result retention. |
| `operations` | PK(`client_id`,`tool`,`target`,`idempotency_key`) | fingerprint, state (pending/completed), stored envelope, timestamps. A tombstone is kept indefinitely. |
| `execution_attempts` | `execution_attempt_id` PK; UNIQUE(`task_id`,`ordinal`) | candidate index + tuple, trigger code, evidence digest, delivery, effectStatus, owner facts, outcome, blocked reason, timestamps |
| `turns` | `turn_id` PK | attempt id, backend turn id (OpenCode prompt message id), state, delivery, outcome, protocol facts, times |
| `turn_texts` | `turn_id` PK | final text BLOB + sha256 + bytes |
| `task_events` | PK(`task_id`,`seq`) | type, at, attempt/execution/turn ids, JSON data (≤ 64 KiB) |
| `permissions` | `permission_request_id` PK | task/turn/owner binding, options, state, expiresAt, decision, backend confirmation |
| `grants` | `grant_id` PK | kind (start / transition), digests, transitionSha256, expiresAt, state (valid / consumed / void) |
| `transition_requests` | `transition_request_id` PK | §12.5 binding fields, nonce, expiresAt, state |
| `timers` | `timer_id` PK | kind (prepared_expiry / run_deadline / idle / permission / quiescent / retry_wake / recovery_budget), wall deadline, remaining ms, state |

Every lifecycle change goes through one `withTransaction(fn)` helper that writes state, events and operation rows together. Event publication to long-pollers happens only after commit.

If storage fails, writes fail closed with `STORAGE_UNAVAILABLE`. Backend effects are never started before their intent row is committed.

### 10.2 Repository interfaces

Repository interfaces wrap SQLite so the controller can be unit-tested against an in-memory DB:

- `TaskRepo`
- `OperationRepo`
- `EventLog`
- `AttemptRepo`
- `TurnRepo`
- `PermissionRepo`
- `GrantRepo`
- `TimerRepo`

### 10.3 Budgets

- `runTimeoutSeconds` is an **aggregate** deadline. It starts at the first durable start intent, spans every attempt, retry wait and authorization wait, and is never reset by a switch.
- `maxRecoverySeconds` is a cumulative budget across FALLBACK_PENDING, WAITING_AUTHORIZATION and WAITING_RETRY.
- `idleTimeoutSeconds` is measured on meaningful activity only: new text, tool state change, or a permission event. It is paused while WAITING_PERMISSION.
  - For OpenCode tasks, the task controller owns this timer, and the adapter's own `taskTimeoutSeconds` and `taskHardCapSeconds` watchdog is disabled for task-driven observation (§11.2). This avoids two competing time limits.
- `permissionTimeoutSeconds` and `quiescentTimeoutSeconds` are per spec.
- While the router is alive, budgets are measured with `performance.now()`. The service persists both the wall-clock deadline and the remaining milliseconds at every transition and every 30 s. On restart it uses `min(wallDeadline − now, lastRemaining)`. If the clock is found to have moved backwards (`now < lastPersistedAt`), the task is sealed and reconciled. It is never given extra time.

### 10.4 Recovery on router start

Admission stays closed until these steps complete:

1. **PREPARED**: left unstarted. Any start grant that was not consumed is voided. Expiry deadlines are recomputed from the persisted values.
2. **STARTING / ACTIVE / WAITING_PERMISSION / WAITING_INPUT / FINALIZING**: each goes to UNKNOWN first, with a `task.unknown` event. The service then reconciles each one through its backend:
   - **OpenCode**: `GET /session/{id}` must exist, and `GET /session/{id}/message` must contain the persisted prompt message ID.
     - If the message is present and the session is busy, the owner is reconciled. The service emits `owner.reconciled`, increments `generation` and `controlVersion`, returns to ACTIVE or WAITING_PERMISSION, and re-attaches `observe()` to the same message ID.
     - If the message is present and its turn is complete, the owner is reconciled and the turn finalized, and the task becomes QUIESCENT.
     - If the message is absent and `delivery_attempt` was never set to `in_flight`, the prompt is provably not sent. The task continues as in §9.5 step 4 under a **fresh** grant: the old grant is void, which leads to `authorization.required`.
     - If the message is absent but `delivery_attempt` was `in_flight`, the task stays UNKNOWN. Not seeing the message does not prove it was never delivered.
     - If the session is missing (404/410) or the server cannot be reached, the task stays UNKNOWN and is retried with backoff (reusing `reconnect-backoff.ts`). It is never relaunched.
   - **Claude and Codex (process backends)**: the attempt row stores `pid`, `processStartIdentity`, `pgid` and the output-file path.
     - If the PID is alive and its start identity matches, the owner is reconciled. `observe()` re-attaches by tailing the output file from the last persisted byte offset.
     - If the process has exited, the service reads the output file to the end, and the turn is finalized from the terminal event it contains (`result` for Claude, `turn.completed` / `turn.failed` for Codex). The exit status itself is lost once the router is no longer the parent, so it is recorded as `null` rather than guessed.
     - If the output file proves the prompt was consumed but has no terminal event, and the process is gone, the outcome is `failed` with `protocol.backendFinished: false`. That is correct only when release is verified; otherwise the task stays UNKNOWN.
     - A PID that exists with a **different** start identity is treated as gone. The service never signals it.
   - **agy (tmux)**: the task's tmux session name, conversation ID and signal directory are persisted.
     - If the session exists, the owner is reconciled, and the manager re-attaches through its existing persistence hook (the same mechanism chat uses after a router restart). The Stop signal decides whether the turn already ended.
     - If the session is gone, the turn is located in the agy transcript by conversation ID. A turn with a complete reply is finalized. Otherwise the task stays UNKNOWN.
   - FINALIZING whose release can be verified completes to CLOSED.
3. **FALLBACK_PENDING / WAITING_AUTHORIZATION / WAITING_RETRY**: restored only after every previous owner is proven settled. All grants and pending transition requests are voided, so a fresh `authorization.required` is issued before any new input.
4. An UNKNOWN task keeps its scope reservation and stays visible with `needsAttention: true` in the snapshot. Only reconciliation or a cancel against a verified owner can resolve it. There is no force-release tool in MCP (spec §7).
   - For a permanently stuck UNKNOWN, an operator uses `bun task-service/admin.ts`:
     - `inspect <taskId>` prints the owner facts.
     - `release <taskId> --verified-by "<note>"` is run after the operator has checked by hand that no owned work is left. It records `owner.reconciled` with `source: "operator"` and the note, then finalizes to CLOSED with `cleanup.detail: "operator-verified"`.
   - The CLI talks to the same service over `task.sock`, through an admin method that the MCP facade does not expose.

### 10.5 Retention

An hourly job, using the same `setInterval` pattern as the router's `processed_events` pruning:

- For tasks CLOSED more than 7 days ago, deletes `task_events`.
- For tasks CLOSED more than 30 days ago, deletes `turn_texts` and `task_prompts`, and marks the result as expired.
- Never prunes `tasks`, `operations` or `execution_attempts` summaries (tombstones), or any row of an active or UNKNOWN task.

Reading an expired result returns `RESULT_EXPIRED`.

---

## 11. Backend abstraction

### 11.1 `TaskBackend` interface (new, task-scoped)

The chat-oriented `AgentAdapter` hides turn identity and owns its own timeouts, so the task service uses a narrower interface:

```ts
interface TaskBackend {
  readonly kind: 'opencode' | 'claude' | 'codex' | 'agy' | 'fake'
  readonly mode: 'http_sse' | 'print' | 'exec' | 'tmux'
  capabilities(): BackendCapabilities
  preflight(c: Candidate, dir: WorkdirIdentity, signal: AbortSignal): Promise<PreflightResult>   // never sends input
  createSession(c: Candidate, dir: WorkdirIdentity, signal: AbortSignal): Promise<{ backendSessionId: string } | NotSentFailure>
  newTurnId(): string                                                     // caller-generated backend turn id, persisted before submit
  submit(s: SessionRef, turnId: string, input: TurnInput, signal: AbortSignal): Promise<SubmitResult>  // 'accepted' | NotSentFailure | 'unknown'
  observe(s: SessionRef, turnId: string, signal: AbortSignal): AsyncIterable<BackendEvent>       // re-attachable, no internal deadlines
  locateTurn(s: SessionRef, turnId: string, signal: AbortSignal): Promise<'absent' | 'running' | 'ended' | 'session_missing'>
  replyPermission(s: SessionRef, requestId: string, d: 'allow_once' | 'deny_once', signal: AbortSignal): Promise<'confirmed' | 'unknown'>
  interrupt(s: SessionRef, turnId: string, signal: AbortSignal): Promise<'requested' | 'unknown'>
  verifyReleased(s: SessionRef, turnId: string, signal: AbortSignal): Promise<{ released: boolean | null; detail: string }>
}
```

`BackendEvent` covers the following, with every event carrying its turn identity:

- `text.snapshot {partId, text}`
- `tool {toolCallId, name, status}`
- `permission.requested`
- `permission.cleared`
- `interaction.required`
- `turn.ended {outcome, finalText, protocol}`
- `failure {classification, evidence}`

### 11.2 OpenCode implementation (reusing `OpenCodeAdapter`)

`task-service/backends/opencode.ts` wraps the existing adapter instance that `router.ts` already builds. The changes to `opencode-adapter.ts` are additive:

1. **Caller-provided prompt ID.** `AgentTask` gains an optional `messageId`, and `send()` uses it when present, otherwise `nextPromptId()`. `nextPromptId` is exported.
2. **Split submit and observe.** The `prompt_async` POST (with its 429/503/404 classification) is extracted into `submitPrompt(sessionId, directory, messageId, text, model, signal)`. The poll loop (SSE + `/permission` + `/session/status` + `finalizeFromMessages`) is extracted into `observeTurn(sessionId, directory, messageId, signal, {watchdog?: false})`.
   - `send()` becomes `submit + observe` with the watchdog on, so chat behaviour is unchanged.
   - The task path calls them separately with `watchdog: false`.
3. **Model selection.** `submitPrompt` accepts an optional `{providerID, modelID}` and includes it in the prompt_async body. The prompt_async request schema already has a `model` field, which must be verified against the live `/doc` during implementation. `parseNativeModel` in `router.ts` is moved to `adapters/opencode/model.ts` and shared.
4. **Text part identity.** `normalize.ts` keeps producing `text.delta` for chat. `observeTurn` additionally emits `text.snapshot {messageId, partId, text}`, which already exists in the `AgentEvent` union, for task consumers.
5. **Turn location.** `locateTurn` uses `GET /session/{id}/message` and looks for the persisted message ID and its child assistant messages. It reuses `selectTurnMessages`.

The existing `adapters/opencode/*.test.ts` regression suite and `server.test.ts` must stay green (acceptance case 17). A new contract test drives the split methods against the existing mock OpenCode server from `opencode-adapter.test.ts`.

The native v2 coordinator (`v2-coordinator.ts`) is **not** used in phase 1, because the spec asks for the existing HTTP/SSE adapter. It is a candidate for a later `opencode/native_v2` mode.

### 11.3 Fake backend

`task-service/backends/fake.ts` is driven by a per-candidate script: an ordered list of steps such as `preflight: ok | fail(code)`, `createSession: ok | fail(code) | hang`, `submit: accepted | notSent(code) | ackLost | crashAfterSend`, `emit(...)`, `permission(...)`, `end(outcome)`, `interruptResult`, `releaseResult`, `effects: none | partial | unknown`.

- The fake records every `submit` call, so tests can assert that no prompt is ever delivered twice.
- It advertises every fallback capability, so the controller's `clean_failure` and `checkpoint_handoff` grant and blocked paths can be exercised. The fake checkpoint is a deterministic digest, not real handoff.
- It can be enabled only through `taskService.backends.fake.enabled`, which tests set in a temporary `FEISHU_STATE_DIR`.

### 11.4 Claude Code, Antigravity and Codex: the router's own tmux sessions

Owner direction (2026-11-22): every backend reuses the router's existing execution logic, and the MCP is one more interface on top of it. A separate process model per CLI (for example `claude -p` or `codex exec`) is not used.

`task-service/backends/tmux-shared.ts` (`SharedTmuxBackend`) drives the **router's own `TmuxCliManager` instances**: `tmuxClaude`, `tmuxAgy`, and a Codex manager built from `tmux/profiles/codex.ts`. It calls them through the same `sendAndAwaitReply(workdir, text, options)` that the Feishu path (`tmux-route.ts`) uses. Only the presentation differs: the callbacks feed the task ledger instead of Feishu cards.

- **Sessions.** Sessions are keyed by workdir, exactly as for chat. A task on a workdir that already has a session reuses it. A task on a different workdir (for example a temporary one) gets its own session, which the manager creates on first use. Per-attempt release never kills a session; it only ends the task's own turn. Session lifetime follows §11.7.
- **Spawn options.** These come from the router's own resolution: the Claude model, and `resolveAgySpawnOptions` for agy. They apply only when a session is first spawned, the same as for chat.
- **Busy sessions.** A busy session is refused before delivery with `not_sent backend_unavailable`, so a task never folds into, or queues behind, someone else's turn. That makes the refusal eligible for the ordered fallback.
- **Delivery.** By the manager's contract, a throw from `sendAndAwaitReply` means the input never reached the CLI, so it becomes `not_sent startup_failed`. Any callback (text, progress, dialog), or the resolved reply, proves delivery.
- **Events.** Streamed text chunks become `text` appends. Progress lines become `tool` started events, all completed at turn end. The resolved reply becomes `turn.ended completed` with the reply as final text, but only when the agent and all its background subtasks have stopped (wait end `stop`, `local_command` or `quiet`). A CLI-reported stop error, or the manager giving up on background work it never saw end (`background_idle`), becomes `failed`.
- **Router state.** The router's own unavailability state is respected: the agy quota cooldown in `DegradedTracker` is checked before dispatch, and a stop error is fed back to it. This is the same as chat.
- **Dialogs.** The manager's `onDialog` callback is used.
  - **broker:** a numbered menu with exactly one one-shot allow and one deny becomes `permission.requested`. The client's reply selects that option. Any other menu becomes `interaction.required`, which `router_task_cancel` resolves with Escape.
  - **backend_policy:** the deny option is chosen automatically, with no prompt to anyone.
- **Interrupt.** Escape on the workdir's session, which is what `/esc` does in chat.
- **Restart.** A turn in flight exists only in router memory, so `recoverAcceptedTurn` is false. After a router restart, such a task becomes UNKNOWN (`locate` returns `unreachable`). It is resolved by `router_task_cancel` or by the operator `release`, and the input is never resent.

### 11.5 OpenCode: the router's adapter and session binding

`OpenCodeTaskBackend` wraps the router's `OpenCodeAdapter` (§11.2). It also takes a `sessionFor(directory)` that calls the router's own `getOrCreateOpenCodeSession`, with the same SQLite binding store and in-flight creation lock that chat uses, keyed `task:workdir:<dir>`. Tasks on the same workdir therefore share one OpenCode session, and a busy session is refused before delivery. Release aborts the task's own turn only if it is still running, and never deletes the session.

### 11.7 Task completion and temporary-workdir lifetime

Owner decisions (2026-11-22):

- **Completion.** A `/goal` task is complete once the goal is achieved. Any other task is complete once the whole agent and all its subtasks have stopped. A `/goal` must be submitted as `native_goal`. A text prompt that is itself a `/goal` command is refused at prepare with `INVALID_REQUEST`, because a text task would end at the goal's first Stop.
- **Native goal (Claude tmux).** The rule follows the Hermes Writer broker's (`inv-code-writer-broker2`) and was verified live against Claude Code 2.1.330. The broker reads pane markers. The router reads the structured `goal_status` transcript attachment instead (`tmux/profiles/claude-goal.ts`):
  - `met:false, sentinel:true` is goal set.
  - `met:false` is the verdict after a turn: unmet, and the CLI continues by itself.
  - `met:true` is achieved.
  - `met:true, sentinel:true` is `/goal clear`, which is **not** achieved.
  - `[Request interrupted by user]` is Esc. Esc leaves the goal armed.

  Only records after the send count, and a verdict only applies to a goal that is active in that wait (`tmux/goal.ts`). In `TmuxCliManager` the effects are:
  - While the goal is active, a Stop does not end the wait. The wait is capped by `backgroundIdleCapMs`, like unconfirmed background work.
  - The verdict, which lands after that turn's Stop, counts as the turn end.
  - Background tasks must still be settled.
  - `Goal set:` is not taken for a finished local command.
  - The end reason carries the goal state (`onWaitEnded(reason, { goal })`).

  The task is `completed` only for a real stop with goal `achieved`. A cleared, interrupted or never-set goal is `failed`. Cancel presses Esc and then types `/goal clear` while the task's wait still owns the session. Releasing a goal run that ended any other way without the goal achieved or cleared (timeout, dropped dialog, denied tool, Esc) also presses Esc and then `/goal clear`, unless another caller is already using the session. Either way a shared session is not left with an armed goal. Only a goal **set** in the wait is followed, so a goal left armed earlier never turns an ordinary message into a goal wait. Chat gets the same following of a `/goal` to its verdict.
- **Mapped workdirs** are the access.json group workdirs, `defaultWorkdir`, and the agents.yaml project workdirs, compared by canonical path and read fresh each time. Their sessions are long-lived and shared with chat. Tasks never tear them down.
- **Temporary workdirs** are every other workdir, such as a `/tmp` dir allowed by the dynamic roots. Their agents exist only for the tasks using them. Concurrent and later tasks on the same workdir reuse the session while it is alive. When the **last** open task on the workdir reaches CLOSED (not after each attempt, so a fallback candidate can still reuse it), `startTaskService({ onWorkdirReleased })` notifies the router. `task-service/workdir-teardown.ts` then kills each CLI's tmux session for that workdir and forgets its conversation id, skipping any session that is busy again. For OpenCode it only releases the router's `task:workdir:<dir>` binding. The OpenCode session itself is kept (owner: "just release session").
- Tasks left UNKNOWN are not CLOSED, so their sessions stay until the operator resolves them. Sessions orphaned by a crash are reaped by the router's existing idle sweep.

### 11.6 Per-backend summary

| | OpenCode `http_sse` | Claude / agy / Codex `tmux` |
|---|---|---|
| Execution object | router's `OpenCodeAdapter` | router's `TmuxCliManager` (per CLI) |
| Session | one per workdir (`task:workdir:<dir>` binding) | one per workdir, shared with Feishu chat |
| Turn identity | prompt `messageID` | `tmux:<executionAttemptId>` (in memory) |
| Delivery proof | prompt_async 204, or the message found by ID | any manager callback, or the resolved reply |
| Turn end proof | status idle + completed assistant messages | `sendAndAwaitReply` resolved (Stop hook + transcript, as in chat) |
| Permissions | broker / backend_policy | broker (numbered menus) / backend_policy (auto-deny) |
| Release | abort if busy; session kept | turn ended (Escape if needed); session kept |
| Restart recovery | message lookup by ID | not recoverable: UNKNOWN, then cancel or operator release |


## 12. Fallback and recovery controller

### 12.1 Policy validation (`task-service/fallback/policy.ts`)

Policy validation is pure and enforces every rule in spec §12.1:

- Candidates: 1–8 entries, no duplicates, and `[0]` deep-equals `backend`.
- `enabled: false` forces only the primary candidate, an empty `triggerOn`, and zero values for every limit and reset field.
- Bounds on `maxSwitches`, `startupRetriesPerCandidate`, `retryDelaySeconds`, `maxRecoverySeconds` and the `sameOwnerReset` fields.
- `triggerOn` is a set of exact `{code, stage}` pairs with optional `fromCandidateIndexes` and `toCandidateIndexes`, unique and in range. Wildcards are not allowed.
- Code/stage combinations must be in the allowed matrix (§12.2).
- `run_timeout` is rejected.
- Every candidate must be implemented. If any `{code, stage}` pair is enabled, every candidate it could apply to must advertise that trigger and stage. Otherwise prepare fails with `FALLBACK_POLICY_INVALID` or `UNSUPPORTED_CAPABILITY`.
- `native_goal` requires `nativeGoal` on every candidate. Only the Claude tmux backend advertises it (its profile reads goal verdicts, §11.7), so any other candidate in the chain rejects the task.
- `fallbackPlanSha256 = sha256(JCS(policy.fallback))`.

The chat-level `fallback:` block in agents.yaml has **no effect** on tasks. A task with fallback disabled never switches, even when chat fallback is enabled globally (spec §12.8).

### 12.2 Classification (`task-service/fallback/classify.ts`)

Classification is pure. It maps a backend failure to `{code, stage, evidence}` only when there is positive structured evidence:

| Code | OpenCode positive evidence (phase 1) | Allowed stage |
|---|---|---|
| `backend_unavailable` | health check fails (connection refused or HTTP error) before session creation; agents.yaml has no `opencode` block | before_delivery |
| `startup_failed` | `POST /session` returns HTTP error (no session created), or prompt_async returns an HTTP error other than 429/503/model errors, both with `not_sent` proven | before_delivery |
| `rate_limited` | prompt_async HTTP 429 | before_delivery |
| `provider_unavailable` | prompt_async HTTP 503 | before_delivery |
| `model_unavailable` | prompt_async 4xx whose body names an unknown model (to be confirmed against live OpenCode; until then, not advertised) | before_delivery |
| `authentication_invalid`, `quota_exhausted`, `context_exhausted`, `execution_failed`, `idle_timeout`, `capability_unavailable` | not produced by OpenCode in phase 1 (post-delivery evidence requires clean_failure, which is not supported) | — |

Positive evidence from the CLI backends (phase 1):

| Code | Claude `print` | Codex `exec` | agy `tmux` |
|---|---|---|---|
| `backend_unavailable` | binary missing or `--version` fails | binary missing or `--version` fails | binary or `tmux` missing, or the agy hooks plugin is not installed |
| `startup_failed` | process exits non-zero before `system/init`, with no init in the output file | process exits non-zero before `thread.started` | session never reaches `isReady` before the startup timeout, verified killed, and no USER_INPUT step |

Auth and quota failures from these CLIs show up only as text: a `result` error string, an `error` event message, or a pane or Stop-hook error. They are recorded as diagnostics, `rate-limit-reset.ts` and `agy-errors.ts` are reused for the reset time, and they are **not** triggers in phase 1. Each can be promoted once a backend-specific classifier with tests exists.

A network error or timeout after the prompt POST began, or a process or tmux delivery whose outcome is ambiguous, is always `DELIVERY_UNKNOWN` and is never a trigger. The never-trigger list from spec §12.2 is hard-coded and cannot be overridden by `triggerOn`.

### 12.3 Controller (`task-service/fallback/controller.ts`)

The controller is a pure decision function plus a small effectful runner. The pure part is:

```
decide(task, attempts, failure, now) ->
  | { kind: 'terminate', reason, outcome }          // no eligible rule, exhausted, never-trigger, budget gone
  | { kind: 'retry_same', delayMs }                 // startupRetriesPerCandidate, after empty owner released
  | { kind: 'switch', toIndex, needsGrant, delayMs }
  | { kind: 'blocked', reason }                     // eligible code but unmet stage evidence, e.g. effects unknown
  | { kind: 'unknown' }                             // delivery/ownership/cleanup uncertain
```

The runner carries out spec §12.4 steps 1–7, persisting state before every effect:

1. It emits `fallback.evaluated`.
2. It moves to FALLBACK_PENDING and settles the previous owner through `interrupt` and `verifyReleased`.
3. It emits `fallback.planned`, naming the next `executionAttemptId` and the input digest.
4. It moves to WAITING_AUTHORIZATION or WAITING_RETRY, with a persisted timer.
5. At dispatch it rechecks, atomically: seal and cancel, release of the previous owner, the policy digest, capacity, deadlines, `dev`/`ino`, and the binding.
6. It moves to STARTING and continues as in §9.5.
7. When attempts are exhausted it emits `fallback.exhausted` and moves to FINALIZING, then CLOSED or UNKNOWN.

Rules:

- A candidate skipped because preflight failed still counts against the switch and traversal budget.
- The ledger is bounded at 16 attempts.
- `selectedCandidateIndex` and `actualBackend` track the latest attempt.
- `generation` increases on every owner change.

### 12.4 Grant reuse

- **before_delivery**: the start grant can be reused for the next candidate only if it is unexpired at dispatch and its `fallbackPlanSha256` matches. In practice the 60 s TTL means a slow chain asks for a fresh grant through `authorization.required`.
- **clean_failure and checkpoint_handoff**: these always need a fresh grant, and are fake-only in phase 1.

### 12.5 `router_task_authorize`

This is implemented as spec §12.5 describes:

- A transition request carries a router-generated nonce. Its `transitionSha256` covers every binding field except `expiresAt`.
- Its lifetime is the minimum of 300 s, the remaining recovery budget, and the remaining run budget.
- `allow` validates every digest and atomically consumes the grant.
- `deny` seals the task and finalizes it, keeping the real prior outcome.
- A stale or expired request yields `AUTHORIZATION_STALE` with `sideEffects: "none"`.

If the client never answers, the request expires. The controller then either issues a new request while the budget lasts, or finalizes the task with reason `AUTHORIZATION_EXPIRED`.

### 12.6 Same-owner reset

The policy schema accepts the `sameOwnerReset` block. Every phase-1 backend advertises `sameOwnerResetRecovery: false`, so an enabled `sameOwnerReset` is rejected at prepare. The controller states and tests exist only for the fake, which covers the auto-resume case versus a single explicit Retry.

---

## 13. Errors

These are the domain codes exactly as in spec §8, defined in `task-service/errors.ts` as a `const` enum together with each code's default `retryable` value.

Only the service builds envelopes:

- `sideEffects` is `none` for any error raised before commit.
- It is `accepted` for replayed or accepted operations.
- The facade uses `unknown` for IPC and transport failures on mutations.

Error messages are short English sentences. `details` holds only typed, non-secret fields. Stack traces go to the router debug log through `dbg`, never into envelopes.

---

## 14. Code layout

Following the repo convention of many small files (200–400 lines, 800 at most), organized by feature:

```
task-service/
  index.ts                  startTaskService(): wiring, socket, lifecycle hooks for router.ts
  config.ts                 zod for agents.yaml `taskService` (imported by routing/config.ts)
  access.ts                 state dir/socket checks, workdir canonicalization + dev/ino identity
  schema/primitives.ts      ids, digests, bounded strings, timestamps
  schema/tools.ts           per-tool args + success data (zod, strict)
  schema/envelope.ts        envelope + error zod; JSON-Schema generation entry
  errors.ts                 domain codes, DomainError
  jcs.ts                    fingerprint/digest helpers (wraps `canonicalize`)
  lifecycle.ts              pure phase transition table
  operations.ts             idempotent mutation pipeline (§9.1)
  store/db.ts               open + pragmas + withTransaction
  store/migrations.ts
  store/{tasks,operations,attempts,turns,events,permissions,grants,timers}.ts
  controller/task-runner.ts start/dispatch/observe loop per attempt
  controller/release.ts     interrupt + verifyReleased
  controller/budgets.ts     deadlines, monotonic/persisted budgets
  controller/recovery.ts    §10.4
  controller/notifier.ts    post-commit long-poll wakeups
  fallback/policy.ts        §12.1
  fallback/classify.ts      §12.2
  fallback/controller.ts    §12.3 pure decide()
  fallback/transition.ts    transition requests + grants (§12.5)
  backends/backend.ts       TaskBackend interface
  backends/opencode.ts      wraps OpenCodeAdapter
  backends/process-runner.ts detached spawn, run dir, pid/start identity, pgid signals, output-file tailing
  backends/claude.ts        claude -p stream-json mapping
  backends/claude-permission-mcp.ts  stdio relay MCP for --permission-prompt-tool
  backends/codex.ts         codex exec --json mapping
  backends/agy.ts           task-owned TmuxCliManager instance + agy profile wrapper
  backends/contract.test.ts shared suite run against every backend's fake
  backends/fake.ts
  admin.ts                  operator CLI (outside MCP): inspect / release a verified-stuck UNKNOWN task
  ipc/protocol.ts           NDJSON framing + method table
  ipc/server.ts             socket server on task.sock
  handlers/*.ts             one file per tool + resources
  retention.ts
mcp/
  task-mcp.ts               stdio entry (arg parsing, SDK Server)
  tool-defs.ts              names, annotations, descriptions, schemas → JSON Schema
  ipc-client.ts             lazy socket client with timeouts
  resources.ts              templates + read mapping
bin/router-task-mcp
schemas/                    generated JSON Schemas (tools, envelope, events, resources)
docs/router-task-mcp-design.md   (this file)
docs/router-task-mcp-operations.md  enable/disable/rollback, logs, capability inventory
```

Changes to existing files are limited to:

- `router.ts`: the startup wiring and the idle-shutdown guard, about 15 lines.
- `routing/config.ts` and `routing/types.ts`: the optional `taskService` key.
- `adapters/opencode/opencode-adapter.ts`: the additive split described in §11.2.
- `adapters/opencode/model.ts`: new home of the extracted `parseNativeModel`.
- `tmux/manager.ts`: optional `sessionKey` separated from the cwd (§11.6), defaulting to the workdir.
- `tmux/profiles/agy.ts`: options for session name, signal directory and resumability (§11.6), defaulting to today's values.
- `tmux/test-fixtures/fake-claude.ts`: a stream-json print mode. New fixture `tmux/test-fixtures/fake-codex.ts`.
- `package.json`: the `canonicalize` dependency and a `schemas` script.

---

## 15. Testing

These are `bun:test` suites placed next to the code, following the existing convention. Every test of the service and facade uses a temporary `FEISHU_STATE_DIR`, an in-memory or temporary SQLite DB, and the fake backend or the existing mock OpenCode HTTP server.

| Spec acceptance case | Test location | Approach |
|---|---|---|
| 1 MCP init, tools/list, schemas, text = structuredContent, resource templates, clean stdout | `mcp/task-mcp.test.ts` | Spawn `bin/router-task-mcp` against a test service. Connect with the SDK `Client` + `StdioClientTransport`. Validate every result against its published `outputSchema` with ajv (an SDK dependency). Capture raw stdout and assert every line parses as JSON-RPC. Record the negotiated protocol version. |
| 2 prepare has no backend effects; expired/invalid grant cannot run | `handlers/prepare.test.ts`, `start.test.ts` | fake backend call log |
| 3 idempotency, CLIENT_TASK_CONFLICT, SCOPE_BUSY, requestId excluded | `operations.test.ts` | table-driven |
| 4 request cancel / facade exit / reconnect do not touch execution | `mcp/lifecycle.test.ts` | kill facade mid-run, reconnect, read events from the same cursor |
| 5 crash injection around intent/send/ACK/response | `controller/crash.test.ts` | the fake's `crashAfterSend` and `ackLost` + reopening the service on the same DB file |
| 6 recovery reattaches exact session, bumps generation, no relaunch from UNKNOWN | `controller/recovery.test.ts` | fake + mock OpenCode |
| 7 chat vs task isolation on the same workdir | `isolation.test.ts` | mock OpenCode records which session receives each call. Chat path runs through `OpenCodeAdapter.send`. |
| 8 cursors, pagination, empty long polls, expiry, output quota, abandoned readers | `handlers/events.test.ts` | |
| 9 silence / idle / old text / refusal / exit 0 are not success | `backends/opencode.test.ts` | mock server scenarios reusing `selectTurnMessages` fixtures |
| 10 permission scoping, stale/unknown options, ambiguous ACK | `handlers/permission.test.ts` | |
| 11 add_turn rejects; seal/start races | `handlers/seal.test.ts` | |
| 12 cancel vs completion; old owner cannot cancel | `handlers/cancel.test.ts` | |
| 13 close sends no prompt, never kills shared serve or deletes worktree | `handlers/close.test.ts` | mock server asserts no `/session/*/prompt_async` after close and no global calls |
| 14 storage/backend/IPC failure | `store/failure.test.ts` | read-only DB file, closed socket |
| 15 deadlines survive restart, old grants and tombstones cannot revive | `controller/budgets.test.ts` | |
| 16 UTF-8 paging, digests, schema bounds, symlinks, unknown fields | `handlers/text.test.ts`, `access.test.ts` | |
| Dynamic workdirs | `access.test.ts` | Covers:<br>• accepted: a new directory under a root<br>• rejected: outside every root, `../` escapes, a symlink pointing outside, the root itself, `STATE_DIR`/`~/.claude`, a missing directory, a disallowed backend kind, missing `.git` when `requireGitWorktree` is set<br>• `projectId: null` inside a named project's roots gets that project's rules<br>• a directory replaced between prepare and dispatch is detected |
| 17 existing regression suites pass | `bun test` (full) | |
| 18 real backend smoke | `scripts/task-mcp-smoke.ts --backend opencode|claude|codex|agy` (manual, separately authorized) | prepare → start → events → result/text → close, then reconnect without redelivery, run once per backend. Record the CLI, server and SDK versions. |
| Backend contract | `backends/contract.test.ts` | The same cases run against every backend through its fake: delivery proof, turn-end proof, no duplicate submission, interrupt, verified release, restart reattach. Also, broker permissions for those that support it, and `backend_policy` emitting no permission events. |
| Process ownership | `backends/process-runner.test.ts` | A child survives the parent being killed. Output is re-read from the stored offset. A PID reused by another process is never signalled. Only the process group is signalled. |
| Chat/task tmux isolation | `backends/agy.test.ts` | Task sessions use `rtask-*` names. The chat idle sweep never touches them. The chat agy session for the same workdir is unaffected. |
| §12.8 fallback list | `fallback/*.test.ts` | pure `decide()` tables + runner tests with two or three fake candidates, covering every prohibited switch |

The coverage target is at least 80% on `task-service/` and `mcp/`. TDD order follows §16.

---

## 16. Implementation sequence

Each step is a reviewable commit on `feat/router-task-mcp`:

1. Schemas, primitives, errors, JCS, lifecycle table (pure), with tests.
2. Store: migrations, repositories, `withTransaction`, operations pipeline, event log, long-poll notifier.
3. Fake backend + task runner + release + budgets. Handlers for prepare, start, get, lookup, events, result, text, seal, close and cancel against the fake.
4. Fallback: policy, classify, decide, runner, transition requests, `router_task_authorize`. All §12.8 cases against fake candidates.
5. IPC server + `startTaskService` + router wiring + idle-shutdown guard (still disabled by default).
6. MCP facade, tool definitions, JSON Schema generation, resources, launcher, stdio tests.
7. OpenCode adapter split (§11.2) + `backends/opencode.ts` + regression run.
8. Process runner + Claude print backend + permission relay MCP (§11.4).
9. Codex exec backend (§11.5).
10. agy tmux backend: manager `sessionKey`, profile options, task manager instance (§11.6), plus a regression run of the tmux suites.
11. Recovery and crash suites for all backends, retention, `admin.ts`.
12. Operations doc (enable, disable, rollback, logs, redaction, capability inventory) and the manual smoke script.

---

## 17. Deviations from the spec

| Spec | This design | Reason |
|---|---|---|
| Server name `router-writer` | `router-task` | General-purpose task MCP (owner direction) |
| Prepare fields `cohortId`, `attemptId` (required) | Optional `correlation` map. Hermes may put `cohortId` and `attemptId` there. | General-purpose. Not every client has cohorts. |
| `assignment.metadata` limited to `workflow`/`stage` | Up to 8 bounded string keys | General-purpose |
| `projectId` + canonical workdir must match a server-side allowlist | `projectId` is nullable. A dynamic workdir is accepted under configured `dynamicWorkdirs.roots`, with a deny list and a recheck of `dev`/`ino` at every dispatch. The allowlist is a set of roots rather than exact directories. | Clients create directories (e.g. worktrees) at runtime that are not in any config (owner direction) |
| Hermes Python client example (deliverable) | Dropped. A generic MCP config example plus a TypeScript smoke script using the SDK `Client`. | Owner direction |
| Socket at `~/.claude/channels/feishu/task-service.sock` | `~/.claude/channels/feishu/task-service/task.sock` | The spec requires a 0700 parent directory. The existing state dir is 0755 and is shared with chat state, so a dedicated subdirectory is used. |
| Validate peer UID where supported | Not done. Relies on directory and socket permissions. | Bun exposes no peer-credential API. The trust model (same UID) is unchanged. |
| Text events only `text.delta` | Adds `text.reset {streamId}` before resending a rewritten part | OpenCode sends full part snapshots, and a rewrite cannot be expressed as an append-only delta |
| OpenCode `variant` | Must be `null` in phase 1 | No verified variant field on the prompt_async path |
| Output schema "discriminated alternatives" | `oneOf` success/error. Fallback to a single object with an `ok` discriminator if SDK validation rejects `oneOf`. | SDK compatibility, to be verified in step 6 |
| — (not specified) | OpenCode sessions are kept after close, not deleted | Keeps `backendSessionId` useful as evidence. Deletion can become a config option later. |
| Phase 1: OpenCode only. Claude tmux/print, AGY and Codex are later capabilities. | Phase 1 also implements Claude `print`, Codex `exec` and agy `tmux`. Each stays `available: false` until its contract suite and smoke test pass. | Owner direction: tasks must be able to use Claude, Codex and agy |
| `permissionMode` must be `broker` | `broker \| backend_policy`. `backend_policy` runs under a non-interactive sandbox or permission policy set on the server, recorded in the snapshot. | `codex exec` cannot route approvals. A general-purpose client may want unattended runs under a fixed server policy. |
| Capabilities advertise the actual `maxConcurrentTasks` | `null` (uncapped) by default, with optional global and per-backend caps | Owner direction: no concurrency restriction across multiple agents |
| No force-release tool | Still none in MCP. An operator-only `task-service/admin.ts release <taskId> --verified-by <note>` exists outside MCP, records `owner.reconciled` with an operator source, and keeps the full audit trail. | Owner decision for permanently stuck UNKNOWN tasks |
| Backend modes `http_sse, tmux, print, acp, exec` | Same set. `app_server` would be added for Codex later. | — |

---

## 18. Decisions and remaining verification

Owner decisions (2026-11-22):

1. **Stuck UNKNOWN**: an operator-only `task-service/admin.ts` CLI outside MCP (§14, §17).
2. **Dynamic roots**: `~/Projects` by default, plus any configured root, including temp directories such as `/tmp`. Every component below a root must pass the ownership check (§6). `requireGitWorktree` defaults to `false`.
3. **Concurrency**: no cap by default. Optional global and per-backend caps exist. Task load is counted separately from chat's OpenCode limit (§5.3).
4. **OpenCode sessions** are kept after close. On a temporary workdir only the router's binding is released (§11.7).
5. **Facade during router restarts**: read-only tools retry inside the facade for up to 10 s while the socket is missing. Mutations return `SERVICE_UNAVAILABLE` (`sideEffects: "unknown"` if a request may have been sent), and the client retries with the same idempotency key.
6. **Backends for tasks**: OpenCode, Claude, Codex and agy, all allowed for dynamic directories by default.
7. **Completion and temporary workdirs**: completion means goal achieved (`/goal`) or agent plus all subtasks stopped. Temporary-workdir agents are torn down when the last task on that workdir closes (§11.7).

To verify during implementation (no owner input needed):

- OpenCode: how an unknown model on prompt_async is reported, which decides `model_unavailable`, and the `model` field in the prompt_async body.
- Claude 2.1.330:
  - how `--permission-prompts host` interacts with `--permission-prompt-tool`
  - the relay tool's response shape
  - that stdin prompt delivery happens before `system/init`
- Codex 0.169.1:
  - that `-` reads the prompt from stdin
  - the `approval_policy="never"` config key
  - the `exec --json` event names (`thread.started`, `turn.started`, `item.*`, `turn.completed`, `turn.failed`)
- agy 1.5.13: that a task-scoped `FEISHU_AGY_SIGNAL_DIR` works with an installed plugin, and that its USER_INPUT step can be attributed to one prompt.
- SDK 1.28.0: that a `oneOf` output schema is accepted together with `isError: true`.

---

## 19. Enable, disable, rollback (summary)

- **Enable**: add `taskService.enabled: true` (plus `projects` and `backends`) to `agents.yaml`, then run `launchctl kickstart -k gui/$UID/com.openclaw.feishuchannel-router`. Register `bin/router-task-mcp` in the MCP client.
- **Disable**: set `enabled: false` and restart.
  - With no live tasks, the socket is not created and the MCP facade reports `SERVICE_UNAVAILABLE`.
  - If any task in the DB is not CLOSED (including UNKNOWN), the service still starts, but in **drain mode**: prepare and start are rejected with `SERVICE_UNAVAILABLE`, while queries, seal, cancel, close, permission replies, authorization replies and recovery keep working, so those tasks can finish. Startup logs the blocking task IDs. The socket goes away on the first restart after every task is CLOSED.
- **Rollback**: revert the branch. `task-service/task-service.db` is independent of `router.db`, so deleting the `task-service/` directory removes all task state without affecting chat routing.
- Full procedures live in `docs/router-task-mcp-operations.md` (deliverable of step 12).

---

## 20. Implementation notes (as built)

These record where the implementation made a concrete choice that the sections above leave open, or where it simplified them.

- **Storage layout.** Each row stores its record as a JSON document (`doc`), alongside only the columns that need SQL constraints:
  - `tasks`: unique `(client_id, client_task_id)` and a partial unique index on the active scope
  - `operations`: the idempotency primary key
  - `attempts`: unique `(task_id, ordinal)`
  - `events`: primary key `(task_id, seq)`

  Permissions, grants, pending transition requests and deadlines live inside the task document instead of separate tables. Every change still commits in one `BEGIN IMMEDIATE` transaction (`core/commit.ts`).
- **One outer transaction per mutation.** `core/operations.ts` wraps the operation row and the handler's own commits (which become SQLite savepoints) in one transaction. A non-retryable domain rejection is recorded under the key, so a retry replays the same decision. Retryable rejections are not recorded.
- **Budgets.** Deadlines are persisted wall-clock values (prepared expiry, aggregate run deadline, idle, permission, quiescent, retry wake, transition-request expiry, cumulative recovery budget), and one timer per task fires for the earliest of them (`core/timers.ts`). A restart recomputes from the persisted values and never renews them. If the wall clock is seen to go backwards by more than 5 s relative to the last write, the task fails closed (sealed and finalized). The separate monotonic-remaining bookkeeping described in §10.3 was not needed for this.
- **Pre-decision.** When a turn ends failed, or an attempt fails before delivery, the engine first runs the pure `decide()` as if the owner were already settled:
  - If no switch or retry is possible, a delivered attempt goes to QUIESCENT, so the client can inspect the result and close. An undelivered one goes to FINALIZING and then CLOSED.
  - Only when a switch or retry is possible does the task enter FALLBACK_PENDING, release the previous owner, and decide for real.
- **Startup grant reuse.** A `before_delivery` switch reuses the start grant only if it is still valid and unexpired, with a 2 s margin, when dispatch happens. Otherwise the engine raises `authorization.required`. A grant is marked consumed only when input is actually handed to a backend; a not-sent failure puts it back.
- **Recovery for not-sent attempts.** After a restart, an attempt whose input was provably never handed off is closed as `not_started`, and a fresh attempt on the same candidate is planned behind `authorization.required` (trigger `recovery_restart`), so old grants never authorize input after a restart.
- **Socket path length.** Unix socket paths are limited to 104 bytes on macOS. The service refuses paths longer than 103 bytes with a clear error. The default `~/.claude/channels/feishu/task-service/task.sock` is far below that.
- **Review hardening.**
  - Malformed IPC frames are dropped, and request handlers can never reject unhandled.
  - The router logs any stray `unhandledRejection` instead of exiting.
  - Deadline, observer and permission-reply failures are caught and retried.
  - A partially failed startup tears itself down.
  - Idle shutdown is re-checked when a task closes, but only if it was deferred for live tasks. An idle connected MCP client does not pin the router.
  - State-dependent rejections are not recorded under an idempotency key: `VERSION_CONFLICT`, `OWNER_MISMATCH`, `TASK_NOT_QUIESCENT`, `TASK_BUSY`, `PERMISSION_STALE`, `AUTHORIZATION_STALE`, `SCOPE_BUSY` and `OWNER_UNVERIFIED`. The key stays usable after the task moves on.
  - Tmux turn outcomes use the manager's new optional `onWaitEnded` reason. Only a real stop counts as `completed`; a chat `/restart`, a timeout or idle give-up ends the turn as `failed`.
  - After a router restart, cancelling a tmux task checks the exact session: if the session is gone, the task is released. Otherwise Escape is sent and the CLI's ready prompt is required.
  - OpenCode tasks on one workdir take an in-process lock, and a missing shared session evicts its binding.
- **Known limits.**
  - A chat message sent to a workdir while an MCP task's turn runs is handled by the CLI's own mid-turn rule ("absorb" for Claude/Codex, "queue" for agy), exactly as two chat messages would be. `router_task_cancel` presses Escape on that shared session.
  - Admin methods share `task.sock`. Any same-UID process can already read `task-service.db` directly, so a separate socket would not add a boundary under the v1 same-UID trust model.
