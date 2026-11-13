# OpenCode native v2 insertion and delivery (feature-gated)

Status: implementation for isolated acceptance testing, **not deployed and not production-certified**. Legacy remains the default. Reference design: https://feishu.cn/docx/HRDDd2QGnomWolxn1KdcvMJ7n24 (v2.1).

## Enable only in an isolated test route

The optional `agents.opencode` flags all default to false:

```yaml
agents:
  opencode:
    type: opencode
    baseUrl: http://localhost:4096
    requestTimeoutSeconds: 10
    taskTimeoutSeconds: 3600
    taskHardCapSeconds: 28800
    maxConcurrency: 4
    nativeV2: false
    progressCards: false
    streamText: false
```

`nativeV2` selects a separate native API session/coordinator, not a new field on legacy `prompt_async`. Native bindings use the existing conversation key plus `:native-v2`; legacy bindings, session selection and permission handling are untouched. Do not toggle this flag during an active execution. `progressCards` and `streamText` only affect native mode. With streaming off, authoritative final text is still delivered.

Native mode currently deliberately refuses `route.agent.model` overrides rather than silently mutating an active session's model. It creates a fresh v2 session using the backend's default model/agent. It does **not** migrate legacy history or model configuration. Existing attachment prompts continue using the router's existing text/path context; v2 tool-produced data-URI attachments are collected from authoritative message projections. Arbitrary URL/file references are not fetched automatically.

## User semantics

- Ordinary messages default to `delivery: steer`: while busy they join the current execution group, observer, text owner and progress card. Admission is acknowledged as “submitted, awaiting executor reception”, not “processed”. The next safe step boundary may be after a long-running tool; no instant preemption is promised.
- `/queue <task>` explicitly admits a separate group with `delivery: queue`. It is not declared consumed until the native durable `session.next.prompted` event arrives.
- `/stop` uses native `/interrupt`, not abort-and-resubmit. Pending input is not deleted. The coordinator becomes suspended to prevent a later prompt from accidentally waking that pending work; inspect/rebind the session explicitly before resuming.
- Native API failures never fall back to legacy or automatically repeat the prompt. A lost admission acknowledgement is `outcome_unknown`; the same deterministic ID remains associated with the source message and is observed, not resubmitted.
- Input IDs use `msg_` plus a session/source-message SHA-256 prefix (26 hex characters), accepted by the installed service. Within one process exact duplicate events return the same result. A conflicting duplicate is rejected. No crash-recovery/exactly-once guarantee is made.

## Ownership and completion

The coordinator key contains endpoint, realpath directory and session. Only one source conversation may own its active/queued groups. Reusing a persisted native session first requires bounded idle proof and a finite history baseline; an active session or one with preexisting unconsumed admissions is not silently adopted/woken after router restart.

Durable `session.next.prompted` marks input consumption, and the subsequent `session.next.step.started` associates assistant IDs with that execution group. No v2 `parentID` is invented. Unknown external input suspends the coordinator and suppresses that work's output. A new message arriving after proven idle creates a fresh group rather than losing its reply under a stale “absorbed” flag. Queue inputs maintain their own group and manifest.

A single native SSE reader only parses/enqueues bounded durable events; it never awaits Feishu or ownership HTTP. Durable sequence gaps and SSE disconnects are repaired through exclusive `history?after=<seq>&limit=200` pages. A live-but-silent stream is calibrated every 5 seconds too. Polling is serialized (no overlapping reader/poller or duplicate ownership mutation). Native `/wait` calls are short, abortable idle probes, not multi-minute transport requests. Completion additionally requires all inputs consumed and an owned completed assistant projection, with `tool-calls` not considered final.

Native progress consumes **durable completed text parts**, not speculative token deltas. This provides mid-task explanations without mixing v2 and legacy live-event schemas. Final reconciliation retrieves the paginated ordered native message projection. It filters by owned assistant IDs and ignores reasoning/synthetic/ignored text. The successful legacy task-timeout implementation is unchanged.

## Delivery and display guarantees

- Text snapshots coalesce at 750 ms with one serial sender and per-message/part confirmed-delivery cursors. A streamed “checking…” cannot suppress a different final assistant's conclusion.
- Appending requires prefix consistency. Non-prefix revisions use an explicit final “updated version”; ambiguous send acknowledgements use a labeled resend, never an exactly-once claim. No blind automatic send retry is enabled until Feishu idempotence/rate-limit semantics are proven.
- Unicode surrogate pairs and whitespace are preserved under the existing 4096 UTF-16-unit chunk budget. Actual Feishu limit verification remains a rollout prerequisite.
- Snapshot backlog is bounded (256 parts/512 KiB), then streaming degrades to authoritative reconciliation. Final text delivery has a 30-second budget and every native SDK HTTP operation (including token acquisition and uploads) a 5-second transport timeout. Over-budget/error output is explicitly reported as delivery failure, not “replied”; automated long-answer document/file fallback is not implemented in this increment.
- Cards are optional, independent of execution and text sends: 1.5-second latest-state coalescing, 15-second heartbeat, one serial patch chain, suppression after three consecutive ordinary patch failures, and idempotent terminal patch after any earlier patch. Parallel same-name tools use message/part/call identity; terminal tools never become running again. Permissions are a set with source-message ownership; permission replies bypass output queues.
- Public tool summaries use the tool name only, not raw command/input. Known secret forms are redacted before truncation/escaping. Regex redaction is not a general-purpose data-loss-prevention boundary.
- Attachment sending retains existing best-effort behavior; terminal wording says “attachment attempted”, not confirmed delivery. Aggregate multi-chat limits, jitter/Retry-After-aware retries, and native long-answer file delivery require further acceptance work.
- Closing removes the group and freezes its output. Late ordinary events cannot revive its card. Timeout/interrupt can flush owned completed text marked incomplete; timeout explicitly says remote execution may still be running rather than falsely claiming remote stop. Native timeouts use the actual configured idle/hard limits.

## Resource limits

Per coordinator: 32 pending groups, 4096 retained input identities, 1024 queued SSE records, 1 MiB SSE framing buffer, 4 MiB per JSON response, up to 5 history pages per calibration and 20 message pages per final projection. Baseline history scan is capped at 100 pages. The router caps native coordinators at 256. Limits fail explicitly rather than silently guessing turn ownership. A full input ledger requires a new/rebound session; it is not evicted in a way that could reexecute duplicate input.

## Evidence and tests (2026-11-13, Beijing time)

Read-only `/global/health` on the installed service reported version 1.18.15. Its `/doc` exposes both legacy and native API families. In isolated `/tmp/feishuchannel-steer-probe-20261113` sessions only:

- Native session creation, steer/queue admission with `resume:false`, deterministic IDs, durable history pagination, and projection shapes succeeded.
- Admission did not itself create a visible user projection. An executing native probe subsequently produced `session.next.prompted`, confirming actual consumption is distinct.
- Exact same-ID/same-payload replay returned the original admission sequence; different payload/delivery returned HTTP 409. This differs from current upstream `dev` prose; implementation never relies on first-wins payload mutation.
- A controlled model/tool probe did not reach `step.started` or a tool within 85 seconds. Only that isolated session was interrupted. Therefore **real busy-tool insertion/queue timing remains unverified**, not disproven and not certified.
- No business session injection, deployment, service restart, live router configuration edit or live Feishu message/card acceptance test was performed.

Mock HTTP/durable-boundary regressions cover busy A + B/C steer, explicit queue, idle/admission races, duplicate/ambiguous acknowledgements, cross-chat/foreign input isolation, source-owned permissions, configured timeouts, serial terminal card races, same-name parallel tools, prefix/revision/Unicode delivery and final completion after partial streaming.

Run:

```sh
bun install --ignore-scripts --frozen-lockfile
bun test
bun run check:opencode
bun build router.ts --target=bun --outfile=/tmp/feishuchannel-router-check.js
git diff --check
```

There is no Python test suite in this Bun/TypeScript project; `pytest` is not applicable. Keep every live feature flag **off** until the real multi-minute tool, native B/C insertion + queue order, authorization, forced SSE loss, and Feishu-visible final delivery/card acceptance scenarios pass in an explicitly isolated test route.
