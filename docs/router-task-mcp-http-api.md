# Router Task MCP — HTTP API

The router runs agent tasks (Claude Code, Codex, Antigravity/agy, OpenCode) for a client. It exposes this as one [MCP](https://modelcontextprotocol.io) endpoint over **Streamable HTTP**. This document is the client-facing reference.

- Operations (enable, configure, restart): [router-task-mcp-operations.md](./router-task-mcp-operations.md)
- Design and rationale: [router-task-mcp-design.md](./router-task-mcp-design.md)

Contract version: `routerContractVersion: "1.1.0"`.

---

## 1. Endpoint

| | |
|---|---|
| URL | `http://127.0.0.1:8767/mcp` (host and port from `taskService.http` in `agents.yaml`) |
| Transport | MCP Streamable HTTP, **stateless** (no `Mcp-Session-Id`), JSON responses |
| Method | `POST` with a JSON-RPC 2.0 body |
| Required headers | `Content-Type: application/json`, `Accept: application/json, text/event-stream` (a missing `Accept` gets `406`) |
| Auth | None by default. If `taskService.http.bearerTokenFile` is set, send `Authorization: Bearer <token>` (missing or wrong: `401`) |
| Reachability | Loopback only. `Host` must be `127.0.0.1:<port>` or `localhost:<port>`. A browser `Origin` must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. Anything else gets `403` |
| Lifetime | Served by the router process. It starts and stops with the router, which runs under launchd |

Any MCP client that supports Streamable HTTP can connect:

```json
{ "mcpServers": { "router-task": { "type": "http", "url": "http://127.0.0.1:8767/mcp" } } }
```

A client that only speaks stdio can use `bin/router-task-mcp` instead. It exposes the same tools and goes through `task.sock`.

### Raw HTTP

Each request is independent, so you can call a tool without an `initialize` handshake:

```sh
curl -s http://127.0.0.1:8767/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"router_health","arguments":{}}}'
```

Standard MCP methods: `initialize`, `tools/list` (input **and** output JSON Schemas for every tool), `tools/call`, `resources/templates/list`, `resources/read`, `ping`.

---

## 2. Response envelope

Every `tools/call` returns the same envelope twice. It appears as `result.structuredContent` and, JSON-encoded, as `result.content[0].text`. `result.isError` is `true` exactly when `ok` is `false`.

```json
{
  "routerContractVersion": "1.1.0",
  "requestId": "6c7a192e-8eb8-48fa-9004-1c49826a06ef",
  "ok": true,
  "replayed": false,
  "data": { "...": "tool-specific, see §4" },
  "error": null
}
```

Failure:

```json
{
  "routerContractVersion": "1.1.0",
  "requestId": "95264c59-7a1b-4110-acc1-84727363f699",
  "ok": false,
  "replayed": false,
  "data": null,
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "No such task.",
    "retryable": false,
    "sideEffects": "none",
    "details": { "taskId": "task_nope" }
  }
}
```

| Field | Meaning |
|---|---|
| `requestId` | Echoes the optional `requestId` argument (a UUID) every tool accepts, or a generated one. Use it for tracing |
| `replayed` | `true` when a mutation was answered from its idempotency record (same `idempotencyKey`, same arguments). Nothing ran twice |
| `error.retryable` | Safe to retry **with the same `idempotencyKey`** |
| `error.sideEffects` | `none`: nothing happened. `accepted`: the intent was durably recorded. `unknown`: the request may have taken effect, so reconcile (`router_task_get`) before acting |

A transport or protocol problem (bad JSON-RPC, unknown tool, wrong header) is an HTTP or JSON-RPC error, not an envelope.

---

## 3. Conventions

### 3.1 Idempotency and concurrency
- Every mutation takes an `idempotencyKey`: 1–128 printable ASCII characters, no whitespace. On any transport error, repeat the **same call with the same key**. Reusing a key with different arguments returns `IDEMPOTENCY_CONFLICT`.
- Control tools take `expectedControlVersion` (from the latest snapshot) and usually `expectedOwner` (`{executionId, generation}` from `snapshot.owner`, or `null` before an owner exists). A stale value returns `VERSION_CONFLICT` / `OWNER_MISMATCH`. Re-read the task and decide again.

### 3.2 Strings and identifiers
- Identifiers are 1–256 UTF-8 bytes with no control characters. Digests are lowercase hex SHA-256 (64 characters).
- Timestamps are ISO 8601 with an offset, e.g. `2026-11-22T22:29:41.113+08:00`.
- Arguments are **strict**: an unknown field returns `INVALID_REQUEST`.

### 3.3 Backend candidate
```json
{ "kind": "claude", "mode": "tmux", "model": "opus", "variant": null }
```

| kind | mode | notes |
|---|---|---|
| `claude` | `tmux` | Claude Code in the router's tmux session for the workdir. Supports `native_goal` (§5.3) |
| `codex` | `tmux` | Codex CLI in tmux |
| `agy` | `tmux` | Antigravity CLI in tmux |
| `opencode` | `http_sse` | The router's OpenCode server |

- `model` is passed **as-is** to the agent CLI. The router does not keep an allowlist (unless an operator configures `backends.<kind>.models`), so the CLI decides what it accepts.
- For tmux backends the model only applies when a session is **spawned**. A workdir with a running session keeps that session's model.
- `variant` must be `null`.
- `router_capabilities` shows which kind/mode pairs are `available` right now.

### 3.4 Workdir
- `projectId: null` with an absolute `workdir`: a **dynamic** workdir. It must be under a configured root (default `~/Projects` and `/tmp`, i.e. `/private/tmp`) and pass the ownership checks.
- `projectId: "<id>"`: a named project from `agents.yaml`.
- A workdir that is also a chat group's workdir is **shared with Feishu chat**. Its agent session is long-lived, so a task there is refused (`backend_unavailable`) while chat is using the session.
- Any other workdir (e.g. `/tmp/job-123`) is **temporary**. Tasks on it share one session while they overlap, and the router tears the session down when the **last** task on that workdir is `CLOSED`.

### 3.5 Task phases
`PREPARED → STARTING → ACTIVE ⇄ WAITING_PERMISSION / WAITING_INPUT → QUIESCENT → FINALIZING → CLOSED`. With fallback enabled, the task can also pass through `FALLBACK_PENDING`, `WAITING_AUTHORIZATION` and `WAITING_RETRY`.

`UNKNOWN` is an attention state. The router cannot prove what the agent did, for example after a router restart during a turn. It **never** means success. Resolve it with `router_task_cancel`, or ask the operator.

### 3.6 Completion
A task's turn is `completed` only when:
- **text input:** the agent **and all its background subtasks** have stopped;
- **`native_goal` input:** the agent's `/goal` reported the goal **achieved**. A cleared, interrupted or never-set goal counts as `failed`.

`businessAcceptance` is always `not_evaluated`. Whether the work is good is the client's call.

---

## 4. Tools

Read-only tools: `router_health`, `router_capabilities`, `router_task_get`, `router_task_lookup`, `router_events_read`, `router_task_result`, `router_turn_text_read`. All other tools are mutations and take `idempotencyKey`. Every tool also accepts an optional `requestId` (UUID).

### 4.1 `router_health`
Arguments: none.
Returns `{status: "ok", routerInstanceId, routerContractVersion, recoveryInProgress}`. It reports on the service only, not on backend availability.

### 4.2 `router_capabilities`
Arguments: none.
Returns `{routerContractVersion, routerInstanceId, backends[], limits}`.

Each entry in `backends[]` has:
- `kind`, `mode`, `available`, `availabilityReason`;
- `features {isolatedSession, samePrimaryTurns, recoverAcceptedTurn, permissionReply, cancel, eventReplay}`;
- `permissionModes`, `maxConcurrentTasks`, `fallbackContractVersion`, `supportedFallbackTriggers[]`;
- `orderedFallback`, `cleanFailureFallback`, `checkpointHandoff`, `sameOwnerResetRecovery`, `nativeGoal`.

`limits`:

| limit | value |
|---|---|
| `requestBytes` | 1 048 576 |
| `promptBytes` | 262 144 |
| `eventBytes` / `eventPageBytes` | 65 536 / 262 144 |
| `textChunkBytes` | 65 536 |
| `startAuthorizationMaxSeconds` | 60 |
| `eventRetentionDays` / `resultRetentionDays` | 7 / 30 |
| `maxConcurrentTasks` | `null` (no cap) |

### 4.3 `router_task_prepare` (mutation)
Creates a `PREPARED` task with a frozen assignment and policy. **Nothing runs, and no session is created.** A task that is never started expires after 600 s.

| Argument | Type | Notes |
|---|---|---|
| `idempotencyKey` | string | |
| `clientId` | identifier | Your client's stable name |
| `clientTaskId` | identifier | Unique per `clientId`. Used for `router_task_lookup` |
| `scopeKey` | identifier | At most one live task per `clientId` + `scopeKey` (otherwise `SCOPE_BUSY`) |
| `correlation` | map, optional | ≤ 8 keys (`[A-Za-z0-9_.-]{1,64}`), values ≤ 256 bytes. Echoed back |
| `projectId` | identifier \| null | §3.4 |
| `workdir` | string ≤ 4096 | Absolute path |
| `backend` | candidate | Must equal `policy.fallback.candidates[0]` |
| `assignment.inputKind` | `text` \| `native_goal` | §5.3 |
| `assignment.prompt` | string | 1 B – 256 KiB. A text prompt that starts with `/goal` is refused (use `native_goal`) |
| `assignment.contractSha256` | sha256 | Digest of *your* acceptance contract. Opaque to the router and echoed for audit |
| `assignment.metadata` | map, optional | ≤ 8 keys, values ≤ 128 bytes |
| `policy` | object | Below |

`policy`:

| Field | Range | Notes |
|---|---|---|
| `inputMode` | `single_turn` \| `same_primary` | Use `single_turn`. `same_primary` (multi-turn) is not supported yet |
| `permissionMode` | `broker` \| `backend_policy` | `broker`: permission prompts come to you as events. `backend_policy`: they are denied automatically |
| `runTimeoutSeconds` | 10 – 43 200 | |
| `idleTimeoutSeconds` | 10 – 3 600 | |
| `permissionTimeoutSeconds` | 30 – 7 200 | |
| `quiescentTimeoutSeconds` | 60 – 86 400 | How long a finished task waits for `router_task_close` |
| `fallback.enabled` | bool | |
| `fallback.candidates` | 1–8 candidates | Ordered. Index 0 is the primary |
| `fallback.triggerOn` | ≤ 64 `{code, stage, fromCandidateIndexes?, toCandidateIndexes?}` | Codes and stages must appear in the candidate's `supportedFallbackTriggers` |
| `fallback.maxSwitches` | 0 – 7 | |
| `fallback.startupRetriesPerCandidate` | 0 – 1 | |
| `fallback.retryDelaySeconds` | 0 – 60 | |
| `fallback.maxRecoverySeconds` | 1 – 43 200 | |
| `fallback.onExhausted` | `"fail"` | |
| `fallback.sameOwnerReset` | `{enabled, maxWaitSeconds 0–43200, maxResumeActions 0–1}` | Use `enabled: false` |

Returns `{task: TaskSnapshot, resources: {snapshotUri, resultUri}}`. Keep `task.taskId`, `task.controlVersion` and `task.fallbackPlanSha256`.

### 4.4 `router_task_get`
`{taskId}` → `{task, resources}`.

### 4.5 `router_task_lookup`
`{clientId, clientTaskId}` → `{task, resources}`. Use it to recover when a prepare reply was lost.

### 4.6 `router_task_start` (mutation)
Starts a `PREPARED` task under a short-lived authorization.

| Argument | Notes |
|---|---|
| `taskId`, `idempotencyKey`, `expectedControlVersion` | |
| `authorization.revision` | Your identifier for this grant. Recorded in events for audit |
| `authorization.expiresAt` | Timestamp at most **60 s** in the future (otherwise `AUTHORIZATION_EXPIRED`) |
| `authorization.promptSha256` | SHA-256 of the exact UTF-8 prompt bytes, **computed by you** |
| `authorization.contractSha256` | Same value as in prepare |
| `authorization.fallbackPlanSha256` | `task.fallbackPlanSha256` from the prepare snapshot |

Any mismatch returns `ASSIGNMENT_MISMATCH` / `INVALID_DIGEST`. Returns `{accepted: true, task}`. **Accepted means durable intent, not that the agent succeeded.** Follow progress with events.

### 4.7 `router_events_read`
| Argument | Notes |
|---|---|
| `taskId` | |
| `afterSeq` | Cursor. Start at `0` |
| `limit` | 1–100 (optional) |
| `waitSeconds` | 0–20 long poll (optional) |

Returns `{taskId, events[], nextAfterSeq, hasMore, lastSeq, minAvailableSeq, taskPhase}`. Persist `nextAfterSeq` **after** processing. Reading never changes the task. A cursor below `minAvailableSeq` returns `EVENT_CURSOR_EXPIRED` (retention is 7 days).

Event shape:

```json
{ "taskId": "task_…", "seq": 6, "at": "2026-11-22T22:29:11.126+08:00", "type": "text.delta",
  "executionId": "exec_…", "turnId": "turn_…", "executionAttemptId": "xatt_…", "candidateIndex": 0, "data": { } }
```

Event types:

| Group | Types |
|---|---|
| Lifecycle | `task.prepared`, `task.starting`, `task.sealed`, `task.finalizing`, `task.closed`, `task.unknown` |
| Execution | `execution_attempt.started`, `execution_attempt.ended`, `owner.established`, `owner.reconciled`, `turn.accepted`, `turn.ended` |
| Output | `text.delta`, `text.reset` (replace that stream's text), `tool.failed`, `backend.diagnostic` |
| Needs you | `permission.requested`, `permission.resolved`, `interaction.required`, `authorization.required`, `authorization.resolved` |
| Fallback / recovery | `fallback.evaluated`, `fallback.planned`, `fallback.blocked`, `fallback.exhausted`, `recovery.scheduled`, `recovery.resumed` |

A normal run produces: `task.prepared → task.starting → execution_attempt.started → owner.established → turn.accepted → text.delta… → turn.ended`, after which the phase is `QUIESCENT`.

`permission.requested` data: `{permissionRequestId, toolCallId, toolName, description, options: [{optionId: "allow_once"}, {optionId: "deny_once"}], expiresAt}`.

### 4.8 `router_task_result`
`{taskId, afterTurnId?, afterExecutionAttemptId?}` → `{taskId, phase, controlVersion, final, executionOutcome, turns[], executionAttempts[], evidence, cleanup, businessAcceptance: "not_evaluated", lastSeq, nextAfterTurnId, hasMore}`.

Each turn has:
- `turnId`, `executionAttemptId`, `candidateIndex`;
- `state`, `outcome` (`completed` / `failed` / `cancelled` / …), `delivery`;
- `startedAt`, `endedAt`;
- `finalText` (inline up to 16 KiB), `finalTextSha256`, `finalTextBytes`, `finalTextTruncated`, `finalTextComplete`;
- `protocol {backendFinished, activeToolCount, stopReason}`;
- `process {exitCode, signal, controlledShutdown}`;
- `evidence {backendSessionId, backendTurnId, transcriptPath}`.

`final` becomes `true` once the task is `CLOSED`.

### 4.9 `router_turn_text_read`
`{taskId, turnId, offsetBytes, maxBytes? (1–65536)}` → `{taskId, turnId, text, offsetBytes, nextOffsetBytes, totalBytes, sha256, eof}`. Use it for final text longer than the 16 KiB inline limit (up to 16 MiB).

### 4.10 `router_permission_reply` (mutation)
`{taskId, idempotencyKey, expectedControlVersion, expectedOwner, turnId, permissionRequestId, optionId: "allow_once"|"deny_once", authorizationRevision}`.

Answers one pending request. Possible errors:
- `PERMISSION_STALE`: it expired or was already answered.
- `INVALID_OPTION`: the option isn't one the request offered.

### 4.11 `router_task_cancel` (mutation)
`{taskId, idempotencyKey, expectedControlVersion, expectedOwner, reason (≤256 B), graceSeconds (1–30)}`.

Interrupts the task's own agent turn (Esc) and finalizes. For a `native_goal` task it also clears the goal. **Accepted is not completion: wait for `CLOSED`.**

### 4.12 `router_task_close` (mutation)
`{taskId, idempotencyKey, expectedControlVersion, expectedOwner, reason}`. Closes a `QUIESCENT` task and releases its owner, without sending any prompt.

`TASK_NOT_QUIESCENT` means the task is still running: wait for it to finish, or use `router_task_cancel` instead. After `CLOSED`, check `cleanup.ownerReleased: true`.

### 4.13 `router_task_seal` (mutation)
`{taskId, idempotencyKey, expectedControlVersion, expectedOwner, reason}`. Forbids any further input or dispatch. It does not interrupt a turn already in flight.

### 4.14 `router_task_authorize` (mutation)
`{taskId, idempotencyKey, expectedControlVersion, expectedOwner, transitionRequestId, decision: "allow"|"deny", authorization}`.

Use it to answer an `authorization.required` event (a fallback switch needs your fresh grant):
- `decision: "allow"`: send `authorization` as in §4.6, plus `transitionSha256` taken from the event.
- `decision: "deny"`: send `authorization: null`.

### 4.15 `router_task_add_turn`
Reserved for multi-turn tasks. It currently returns `UNSUPPORTED_CAPABILITY`.

---

## 5. Flows

### 5.1 Run a task
1. `router_capabilities`: check that the candidate you want is `available`.
2. `router_task_prepare`: keep `taskId`, `controlVersion` and `fallbackPlanSha256`.
3. `router_task_start`: `expiresAt` ≤ 60 s ahead, `promptSha256 = sha256(prompt bytes)`.
4. Loop `router_events_read` with `waitSeconds: 20`, and answer `permission.requested` / `authorization.required` as they arrive.
5. When the phase is `QUIESCENT`: `router_task_result` (and `router_turn_text_read` if the text is truncated).
6. `router_task_close`, then wait for `CLOSED` (with `cleanup.ownerReleased: true`).

### 5.2 Recover after losing a reply
- **Prepare reply lost:** call `router_task_lookup` with `clientId` + `clientTaskId`.
- **Any mutation reply lost:** repeat it with the same `idempotencyKey`. The response comes back with `replayed: true` and the original outcome.
- **`SERVICE_UNAVAILABLE`:** the router is restarting. Read tools can simply be retried. Retry mutations with the same key.
- **Task in `UNKNOWN`:** the router restarted mid-turn and cannot prove what happened. Use `router_task_cancel`; never assume success.

### 5.3 Native `/goal` (Claude)
- Send `assignment.inputKind: "native_goal"` with `prompt: "/goal <single-line condition, ≤ 900 bytes>"`.
- Only candidates with `nativeGoal: true` qualify (today `claude/tmux`). Every candidate in the fallback chain must support it.
- The task stays `ACTIVE` across all of the goal's self-continued turns. It ends `completed` only when Claude reports the goal achieved, and cancelling clears the goal.

---

## 6. Error codes

| Group | Codes |
|---|---|
| Validation / access | `INVALID_REQUEST`, `INVALID_DIGEST`, `REQUEST_TOO_LARGE`, `PROJECT_NOT_ALLOWED`, `WORKDIR_NOT_ALLOWED`, `PEER_NOT_ALLOWED` |
| Identity / concurrency | `TASK_NOT_FOUND`, `TURN_NOT_FOUND`, `CLIENT_TASK_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `OPERATION_IN_PROGRESS`*, `VERSION_CONFLICT`, `SCOPE_BUSY`, `OWNER_MISMATCH`, `OWNER_UNVERIFIED` |
| Lifecycle / policy | `TASK_BUSY`, `TASK_SEALED`, `TASK_NOT_QUIESCENT`, `PERMISSION_STALE`, `INVALID_OPTION`, `UNSUPPORTED_CAPABILITY`, `AUTHORIZATION_EXPIRED`, `ASSIGNMENT_MISMATCH`, `RESULT_NOT_READY`* |
| Observation / retention | `INVALID_CURSOR`, `EVENT_CURSOR_EXPIRED`, `RESULT_EXPIRED` |
| Capacity / availability | `CAPACITY_EXHAUSTED`*, `BACKEND_UNAVAILABLE`*, `SERVICE_UNAVAILABLE`*, `STORAGE_UNAVAILABLE`*, `RECOVERY_IN_PROGRESS`*, `INTERNAL_ERROR` |
| Fallback / grants | `AUTHORIZATION_STALE`, `FALLBACK_POLICY_INVALID`, `FALLBACK_EXHAUSTED`, `FALLBACK_BLOCKED`, `CHECKPOINT_INVALID`, `EFFECTS_UNVERIFIED` |

\* retryable by default. Always go by the `retryable` field in the actual response.

Reasons for asynchronous outcomes appear in `task.terminalReason` and in events, never as tool errors:

| Group | Reasons |
|---|---|
| Timeouts and limits | `RUN_TIMEOUT`, `IDLE_TIMEOUT`, `PERMISSION_TIMEOUT`, `QUIESCENT_TIMEOUT`, `OUTPUT_LIMIT_EXCEEDED`, `EVENT_LIMIT_EXCEEDED` |
| Backend and recovery | `BACKEND_FAILED`, `DELIVERY_UNKNOWN`, `CLEANUP_UNKNOWN`, `RECOVERY_UNRESOLVED`, `WORKDIR_CHANGED` |
| Authorization | `AUTHORIZATION_EXPIRED`, `AUTHORIZATION_DENIED`, `PREPARED_EXPIRED` |
| Fallback | `FALLBACK_EXHAUSTED`, `FALLBACK_BLOCKED` |
| Closed by someone | `CANCELLED`, `CLOSED_BY_CLIENT`, `OPERATOR_RELEASED` |

---

## 7. Resources

| URI template | Content |
|---|---|
| `router://tasks/{taskId}/snapshot` | Current `TaskSnapshot` (same as `router_task_get`) |
| `router://tasks/{taskId}/result` | First page of `router_task_result` |

Read them with `resources/read`. An unknown task returns MCP error `-32002`.

---

## 8. Complete example (`curl`)

```sh
URL=http://127.0.0.1:8767/mcp
call() {  # call <tool> '<json arguments>'
  curl -s "$URL" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" \
  | jq '.result.structuredContent'
}

PROMPT='Write REPORT.md summarising this repository.'
CONTRACT=$(printf 'report must exist' | shasum -a 256 | cut -d' ' -f1)
POLICY='{"inputMode":"single_turn","permissionMode":"backend_policy","runTimeoutSeconds":1800,
  "idleTimeoutSeconds":600,"permissionTimeoutSeconds":300,"quiescentTimeoutSeconds":3600,
  "fallback":{"enabled":false,"candidates":[{"kind":"claude","mode":"tmux","model":"opus","variant":null}],
  "triggerOn":[],"maxSwitches":0,"startupRetriesPerCandidate":0,"retryDelaySeconds":0,
  "maxRecoverySeconds":600,"onExhausted":"fail",
  "sameOwnerReset":{"enabled":false,"maxWaitSeconds":0,"maxResumeActions":0}}}'

# 1. prepare
PREP=$(call router_task_prepare "{\"idempotencyKey\":\"prep-001\",\"clientId\":\"my-client\",
  \"clientTaskId\":\"job-001\",\"scopeKey\":\"repo-x\",\"projectId\":null,\"workdir\":\"/tmp/job-001\",
  \"backend\":{\"kind\":\"claude\",\"mode\":\"tmux\",\"model\":\"opus\",\"variant\":null},
  \"assignment\":{\"inputKind\":\"text\",\"prompt\":\"$PROMPT\",\"contractSha256\":\"$CONTRACT\"},
  \"policy\":$POLICY}")
TASK=$(echo "$PREP" | jq -r .data.task.taskId)
CV=$(echo "$PREP" | jq -r .data.task.controlVersion)
PLAN=$(echo "$PREP" | jq -r .data.task.fallbackPlanSha256)

# 2. start (grant valid for 30 s)
EXP=$(date -v+30S '+%Y-%m-%dT%H:%M:%S.000%z' | sed -E 's/([0-9]{2})([0-9]{2})$/\1:\2/')
PSHA=$(printf '%s' "$PROMPT" | shasum -a 256 | cut -d' ' -f1)
call router_task_start "{\"taskId\":\"$TASK\",\"idempotencyKey\":\"start-001\",\"expectedControlVersion\":$CV,
  \"authorization\":{\"revision\":\"grant-1\",\"expiresAt\":\"$EXP\",\"promptSha256\":\"$PSHA\",
  \"contractSha256\":\"$CONTRACT\",\"fallbackPlanSha256\":\"$PLAN\"}}"

# 3. follow events (long poll)
call router_events_read "{\"taskId\":\"$TASK\",\"afterSeq\":0,\"waitSeconds\":20}" | jq '.data | {taskPhase, nextAfterSeq, types: [.events[].type]}'

# 4. result once QUIESCENT, then close
call router_task_result "{\"taskId\":\"$TASK\"}" | jq '.data.turns[0] | {outcome, finalText}'
T=$(call router_task_get "{\"taskId\":\"$TASK\"}")
call router_task_close "{\"taskId\":\"$TASK\",\"idempotencyKey\":\"close-001\",
  \"expectedControlVersion\":$(echo "$T" | jq .data.task.controlVersion),
  \"expectedOwner\":$(echo "$T" | jq -c '.data.task.owner | {executionId, generation}'),\"reason\":\"done\"}"
```

The workdir `/tmp/job-001` must exist and be owned by the router user. It is a temporary workdir, so its Claude session is torn down once this task is `CLOSED`.
