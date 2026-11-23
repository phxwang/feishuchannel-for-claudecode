# Router Task MCP — Operations

How to enable, use, observe, disable and roll back the router task service and its MCP server. Design: [router-task-mcp-design.md](./router-task-mcp-design.md).

## 1. Components

| Piece | Where | Notes |
|---|---|---|
| Task service | inside `router.ts` (launchd `com.openclaw.feishuchannel-router`) | Started only when `agents.yaml` has `taskService.enabled: true`, or in drain mode (§4) |
| Private state | `~/.claude/channels/feishu/task-service/` (0700) | `task-service.db` (SQLite WAL), `task.sock` (0600), `runs/<executionAttemptId>/` (0700) |
| MCP server (HTTP, default) | `mcp/http.ts`, inside the router | Streamable HTTP at `http://127.0.0.1:8767/mcp`, started and stopped with the task service. Loopback only, Host/Origin allowlist, optional bearer token. Stateless. |
| MCP server (stdio, optional) | `bin/router-task-mcp` → `mcp/task-mcp.ts` | Same tools over task.sock for clients that only speak stdio. Never starts the router. |
| Operator CLI | `bun task-service/admin.ts` | `inspect` / `release`. Not reachable through MCP. |
| JSON Schemas | `schemas/router-task/` | Regenerate with `bun run schemas`. A test fails if they are stale. |

## 2. Enable

1. Add a `taskService` block to `~/.claude/channels/feishu/agents.yaml`. The example below lists every backend and the main options:

   ```yaml
   taskService:
     enabled: true
     # maxConcurrentTasks: 8          # optional; default: no cap
     dynamicWorkdirs:
       roots: [/Users/openclaw/Projects, /tmp]
       allowedAgents: [opencode, claude, codex, agy]
       requireGitWorktree: false
     backends:
       opencode: { models: ["deepseek/deepseek-flash"] }   # endpoint/password from agents.opencode
       claude:   { models: ["opus", "sonnet"] }
       codex:    { models: ["gpt-5.5-codex"], sandbox: workspace-write }
       agy:      { models: ["<agy model id>"] }
     http:                             # router-task MCP over Streamable HTTP (default: on)
       enabled: true
       host: 127.0.0.1                 # loopback only: 127.0.0.1 | localhost | ::1
       port: 8767
       # bearerTokenFile: /path/to/token   # optional; clients then send Authorization: Bearer <token>
   ```

   `models` is optional for every backend. When it is left out, the candidate's model string is passed straight through to the agent CLI, which decides what it accepts. An empty block such as `claude: {}` enables the backend with no restriction. When `models` is listed, it acts as an allowlist. `model: "default"` always passes: it means the backend's own configured default (no model flag).

   Rules enforced at load time (the task service refuses to start if they are violated; the chat router keeps running):
   - A root may not be `/`, `$HOME`, or contain `$HOME`, the Feishu state directory or `~/.claude`.
   - `taskService.projects.<id>` must exist under top-level `projects`.
   - `codex.sandbox` only accepts `read-only` and `workspace-write`.

2. Restart the router:

   ```sh
   launchctl kickstart -k gui/$(id -u)/com.openclaw.feishuchannel-router
   grep task-service ~/.claude/channels/feishu/router-debug.log | tail
   ```

   Expect `task-service: listening on …/task-service/task.sock` and `task-service: MCP (streamable HTTP) listening on http://127.0.0.1:8767/mcp`. If the port is taken, the HTTP endpoint logs `MCP HTTP endpoint NOT started`, and the task service and the stdio launcher keep working.

3. Register the MCP server in the client. Use the HTTP endpoint, which the router serves:

   ```json
   { "mcpServers": { "router-task": { "type": "http", "url": "http://127.0.0.1:8767/mcp" } } }
   ```

   Add `"headers": { "Authorization": "Bearer <token>" }` when `http.bearerTokenFile` is set. A client that only speaks stdio can still use the launcher:

   ```json
   { "mcpServers": { "router-task": { "command": "/Users/openclaw/Projects/feishuchannel/bin/router-task-mcp" } } }
   ```

   The launcher's `--service-socket` flag is optional. It defaults to `$FEISHU_STATE_DIR/task-service/task.sock`.

## 3. Using it (client flow)

1. `router_capabilities`: check that the backends and modes you need are `available` and support your `permissionMode`.
2. `router_task_prepare` with a stable `clientTaskId`, a `scopeKey`, `projectId: null` (dynamic directory) or a named project, the `workdir`, the `backend` tuple, the `assignment`, and the full `policy`. Nothing runs yet.
3. `router_task_start` with `authorization = {revision, expiresAt (≤60 s ahead), promptSha256, contractSha256, fallbackPlanSha256}`. Every digest appears in the prepare snapshot except `promptSha256`, which is the SHA-256 of the exact prompt bytes and which the client computes itself.
4. Loop on `router_events_read` (`waitSeconds` up to 20). Store your cursor only after you have processed the events.
5. Handling events:
   - `permission.requested`: answer with `router_permission_reply` (`allow_once` / `deny_once`).
   - `authorization.required`: re-check your own gates, then `router_task_authorize` with `transitionSha256` from the request.
6. At `QUIESCENT`: read `router_task_result` / `router_turn_text_read`, then call `router_task_close`. Watch for `CLOSED` with `cleanup.ownerReleased: true`.
7. To stop early: `router_task_cancel`, then wait for `CLOSED`.

Retries: on a transport error, repeat the **same** call with the **same** `idempotencyKey`. Do not invent a new key.

UNKNOWN is an attention state. It never means success and never permits a second task in the same scope.

## 4. Disable and drain

- Set `taskService.enabled: false` and restart the router.
- If no task is left that is not CLOSED, the socket is not created, and the MCP server returns `SERVICE_UNAVAILABLE`.
- Otherwise the service starts in **drain mode**:
  - `router_task_prepare` and `router_task_start` are refused.
  - Queries, seal, cancel, close, permission and authorization replies, and recovery keep working.
  - The log lists the task ids that are still live.
  - Close or cancel them, and the next restart with no live tasks removes the socket.

## 5. Rollback

1. Disable as in §4.
2. Revert the branch.
3. Optionally delete `~/.claude/channels/feishu/task-service/`. That removes all task state and does not touch `router.db`, chat routing, or `access.json`.

## 6. Stuck UNKNOWN tasks

1. Inspect the task:

   ```sh
   bun task-service/admin.ts inspect <taskId>
   ```

2. Check the backend by hand, using the owner facts from `inspect`:

   | Backend | What to check |
   |---|---|
   | OpenCode | Session status in `opencode serve` |
   | Claude / agy / Codex | The workdir's tmux session (`tmux ls`, `tmux capture-pane -p -t <session>`): confirm no turn is still running |

3. Only once you have confirmed that nothing the task owns is still running:

   ```sh
   bun task-service/admin.ts release <taskId> --verified-by "checked pid 1234 gone at 14:05"
   ```

   This records `owner.reconciled` with `source: "operator"` and your note, then closes the task.

## 7. Logs and redaction

- Service logs go to the router debug log (`router-debug.log`, `dbg`) with the prefix `task-service:`.
- The MCP server logs to stderr only. Its stdout is JSON-RPC.
- Event payloads never carry tool arguments or tool output. Tool and permission descriptions and backend diagnostics pass through `safeSummary`, which redacts bearer tokens, API keys, passwords and credentials in URLs.
- Prompts are stored only in `task_prompts` (needed to dispatch fallback attempts). They are never returned by any read and are purged after 30 days.
- Per-attempt run files (`runs/<id>/prompt.txt`, `stdout.jsonl`) are mode 0600 inside 0700 directories.

## 8. Retention

An hourly job does the following:

- deletes events of tasks CLOSED more than 7 days ago
- deletes result bodies (final texts, prompts) of tasks CLOSED more than 30 days ago, after which reads return `RESULT_EXPIRED`
- never prunes task, operation or attempt tombstones, or anything belonging to an active or UNKNOWN task

## 9. Capability inventory (phase 1)

All backends run through the router's existing execution objects. A task on a workdir uses that workdir's session (the same one chat uses), and a new workdir gets a new session.

| kind/mode | permission modes | fallback triggers (before delivery) | notes |
|---|---|---|---|
| `opencode/http_sse` | broker, backend_policy | backend_unavailable, startup_failed, rate_limited, provider_unavailable | The router's `OpenCodeAdapter`. One session per workdir (`task:workdir:<dir>` binding). A busy session is refused. |
| `claude/tmux` | broker (menus), backend_policy (auto-deny) | backend_unavailable, startup_failed, authentication_invalid (+ authentication_invalid at clean_failure) | The router's `tmuxClaude`, shared with chat. A busy session is refused. Preflight runs `claude auth status --json`; a first-request `verification_required` / `authentication_failed` API error is the clean-failure auth case. |
| `agy/tmux` | broker (menus), backend_policy (auto-deny) | backend_unavailable, startup_failed | The router's `tmuxAgy`, shared with chat. The quota cooldown is respected. |
| `codex/tmux` | broker (menus), backend_policy (auto-deny) | backend_unavailable, startup_failed | The Codex profile on the shared tmux manager |
| `fake/exec` | broker, backend_policy | all | Tests only (`backends.fake.enabled`) |

A tmux turn in flight lives only in router memory. If the router restarts mid-turn, the task becomes UNKNOWN; use `router_task_cancel` or `admin.ts release`. Input is never resent.

Not advertised in phase 1: clean-failure fallback (except Claude's auth failure), checkpoint handoff, same-owner reset resume, native `/goal` on backends other than `claude/tmux`, multi-turn (`router_task_add_turn` returns `UNSUPPORTED_CAPABILITY`).
