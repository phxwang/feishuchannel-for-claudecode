# Codex CLI via tmux: profile findings

Status: **profile, fixture and tests implemented** (`tmux/profiles/codex.ts`). Not yet wired into `router.ts` or the task backend. · codex-cli 0.169.1 · 2026-11-22

Codex runs like Claude Code and Antigravity: the interactive TUI in one detached tmux session per workdir (`feishu-codex-<sha1(workdir)[0:10]>`), driven by the shared `TmuxCliManager`. `codex exec` is not used.

## How it was verified (no billable calls)

The real TUI (`/opt/homebrew/bin/codex`, 0.169.1) ran in tmux with:

- an **isolated `CODEX_HOME`** in a scratch dir. Its own `config.toml` points `model_provider` at a local mock, and `requires_openai_auth = false`. The user's `~/.codex` (config, credentials, sessions) was neither read by Codex nor written. Its `config.toml` mtime and `sessions/` were unchanged afterwards.
- a **local mock of the Responses API** (`tmux/test-fixtures/mock-responses-api.ts`) that returns canned SSE streams: an echo, an escalated `exec_command` call (to trigger an approval), a slow reply, and an HTTP 400 (a failed turn).
- `OPENAI_API_KEY=` emptied in the session env.

No prompt reached a real model. The same setup then ran the real profile end to end through `TmuxCliManager`: reply, approval dialog answered, failed turn reported, Esc interrupt, `/model` + Esc, idle-kill + resume. Everything passed.

## Findings

| # | Topic | Finding | Verified? |
|---|---|---|---|
| 1 | Spawn | `codex [resume <id>] -s <sandbox> -a <approval> [-m M] [-c model_reasoning_effort="E"] -c notify=[…] -c projects={"<workdir>"={trust_level="trusted"}}` | ✅ |
| 1a | Folder trust | Without the `projects` override, a new dir shows "Trust this folder?". The inline-table override skips it for this session only, and nothing is persisted. The dotted form `-c projects."<path>".trust_level=…` does **not** work | ✅ |
| 1b | Sandbox / approval | `-s read-only\|workspace-write\|danger-full-access`, `-a on-request\|never` (`untrusted` is rejected by 0.169). The profile allows only `read-only`/`workspace-write` and `on-request`/`never`, and **always passes both explicitly**, so a user `config.toml` can't widen a router session. `--dangerously-bypass-approvals-and-sandbox`, `--approve-for-me` and `--dangerously-bypass-hook-trust` are never passed | ✅ flags exist (help); mock session used them |
| 1c | Session id up front | None (`--session-id` doesn't exist). The id is the rollout's thread id | ✅ |
| 1d | Resume | `codex resume <id> [flags]` reopens the thread, shows its history, and **appends to the same rollout file** | ✅ → `resumable: true` |
| 2 | Ready marker | Idle footer `? for shortcuts`. It **stays visible during a turn**, so the profile also requires the working line `esc to interrupt` to be absent | ✅ |
| 3 | Transcript | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local start time>-<thread id>.jsonl`. **Created on the first submitted message**, not at startup | ✅ |
| 3a | Records | `session_meta` (first line: `id`, `cwd`, `originator: "codex-tui"`, `source: "cli"`), `event_msg/task_started`, `response_item/message` (role `user` / `assistant` with `phase: commentary\|final_answer`, `output_text`), `response_item/function_call` (`exec_command`, `arguments` = JSON with `cmd`), `response_item/custom_tool_call`, `function_call_output`, `event_msg/item_completed` (a duplicate of each item: UserMessage, AgentMessage, CommandExecution, FileChange…), `event_msg/task_complete` (`error: {message}` on failure), `event_msg/turn_aborted` (`reason: "interrupted"`) | ✅ (TUI via mock, plus 2846 real local rollouts surveyed) |
| 4 | `notify` | `-c notify=["/bin/sh","<script>"]` runs the program with one JSON argument `{"type":"agent-turn-complete","thread-id","turn-id","cwd","client":"codex-tui","input-messages":[all inputs so far],"last-assistant-message"}`. The program inherits the tmux session env. **No trust prompt needed** | ✅ |
| 4a | ⚠️ notify pitfalls | (1) Codex also notifies for its internal **title-generator thread** (a different thread-id, no rollout), sometimes **before** the main notify. (2) **No notify at all** for a failed turn (`task_complete` with `error`) or an interrupted one (`turn_aborted`) | ✅ → notify is not used as the stop signal |
| 4b | Hooks | 0.169 has Claude-style hooks (`Stop` input has `session_id`, `turn_id`, `transcript_path`, `last_assistant_message`). Hooks given via `-c hooks={…}` show "Hooks need review" and run only after a trust decision that is persisted to `config.toml` (`hooks.state.*.trusted_hash`), or with `--dangerously-bypass-hook-trust` | ✅ → not used |
| 5 | Approval dialog | `Would you like to run the following command?` / `Reason: …` / `$ <cmd>` / `› 1. Yes, proceed (y)` / `2. Yes, and don't ask again for commands that start with … (p)` / `3. No, and tell Codex what to do differently (esc)` / `Press enter to confirm or esc to cancel`. **A bare digit acts immediately**, with no Enter | ✅ |
| 5a | `/model` | A numbered `›` picker with a `↓` scroll marker and an `enter select · esc back` footer. No rollout record, no notify | ✅ |
| 6 | Mid-turn input | Typed while working, it shows "Messages to be submitted after next tool call" and is **steered into the running turn**: one `task_started`, one `task_complete`, both user messages in the same turn | ✅ → `midTurn: 'absorb'` |

## Design

**Turn completion.** The rollout's `task_complete` / `turn_aborted` record ends the turn. A new optional profile hook, `isTurnEnd(line)`, counts it in the manager like the stop signal firing. `stopSignalPath` is `null`, and profiles that define `isTurnEnd` opt out of the quiet-period fallback. `afterStop` reads the last turn end from the rollout tail: a failed turn reports `error` (surfaced via `onStopError`), while an interrupted turn ends quietly. `conversationId` is the rollout's thread id.

**Session/transcript identity.** This is exact in the normal case:

1. `codex-plugin/notify.sh` (active only when `FEISHU_CODEX_SIGNAL_DIR` is set, which the router does only on the sessions it spawns, and only those sessions get `-c notify=`) writes `notify-<thread-id>.json` + `last.json` atomically into the per-workdir signal dir `$TMPDIR/feishu-codex-tmux/<session name>/` (0700, cleared on each spawn).
2. `discoverSessionId` takes the newest notified thread id **whose rollout exists and is an interactive top-level session in this workdir** (`originator: codex-tui`, `source` not a sub-agent object, `cwd` equal after realpath). This drops the title-generator thread and sub-agents.
3. Before the first notify, or when the first turn failed (which notifies nothing), the fallback is the **single** interactive rollout for this workdir created since this profile spawned the session. With two or more candidates, it returns nothing and doesn't guess. `findLatestTranscript` always returns `null`.
4. The id is persisted by the manager and used for `codex resume <id>` after an idle kill or a router restart. `transcriptPath(id)` searches day dirs newest first, because a resumed thread's file stays in its original day dir.

**Dialogs.** `parseDialogOptions` with cursor `›`, tolerating the `↑/↓` marker, `enter … · esc …` and `Press enter to confirm…` footers. For approval prompts the card question is replaced with `Would you like to run the following command?\n$ <cmd>`. `optionKeys` sends the digit alone.

**Slash commands.** `slashCommandIdleMs: 3000`, as with agy: a `/command` that starts no turn ends once the pane has been idle for 3 s.

## Assumed, not verified

- The model picker (`/model`) acts on a digit the same way the approval prompt does. Only Esc was tested on it.
- Other startup screens on a real `~/.codex` (model-migration notices, update prompts, login expiry) were not seen with the isolated home. If one appears, `isReady` stays false, startup times out after 30 s, and the paste would land in that screen.
- Background terminals (`write_stdin` / long-running `exec_command` sessions) that outlive a turn are not tracked. A turn end is always `wait: 'done'`.
- `danger-full-access` is refused by the profile. The user's `config.toml` can still change other settings for router sessions (for example `approvals_reviewer`, or MCP servers).
- The `-c projects={…}` override hides the user's other per-project trust entries for that session. That's harmless for a single-workdir session.
- Real model output (long multi-tool turns, compaction, `request_user_input` questions) is untested. It would need a billable smoke test.

## Known gaps

- **First-turn attribution** relies on the fallback in step 3 until the first notify. If another interactive Codex starts in the **same workdir** during the router session's first turn, the fallback sees two rollouts and returns nothing, so the first turn's text is only recovered once its notify arrives. Correctness then depends on notify, which doesn't fire for a failed first turn.
- With no id at all, the manager's 20 s no-turn idle timeout ends the wait with a hint that mentions the agy plugin (that text is in `tmux/manager.ts`).

## Re-verifying

```bash
H=$(mktemp -d)/home; W=$(mktemp -d); mkdir -p $H
cat > $H/config.toml <<EOF
model = "mock-model"
model_provider = "mock"
[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:18765/v1"
wire_api = "responses"
requires_openai_auth = false
EOF
bun tmux/test-fixtures/mock-responses-api.ts 18765 /tmp/mock-requests.jsonl &
tmux new-session -d -s cxprobe -c $W -e CODEX_HOME=$H -e OPENAI_API_KEY= \
  codex -s workspace-write -a on-request \
  -c 'notify=["/bin/sh","'$PWD'/codex-plugin/notify.sh"]' -c 'projects={"'$W'"={trust_level="trusted"}}'
```

Or point `createCodexProfile({ bin: ['/usr/bin/env', 'CODEX_HOME=' + H, 'OPENAI_API_KEY=', 'codex'], codexHome: H })` at it and drive it with `TmuxCliManager`.

## Files

- `tmux/profiles/codex.ts`: `createCodexProfile({ bin?, codexHome?, signalRoot?, notifyScript? })`, spawn argv, readiness, dialogs, identity
- `tmux/profiles/codex-rollout.ts`: rollout parsing and lookup
- `codex-plugin/notify.sh`: notify bridge (no-op without `FEISHU_CODEX_SIGNAL_DIR`)
- `tmux/test-fixtures/fake-codex-tui.ts`: TUI double for the manager tests
- `tmux/test-fixtures/mock-responses-api.ts`: Responses API mock for manual live checks
- `tmux/profiles/codex.test.ts`, `tmux/codex-manager.test.ts`
