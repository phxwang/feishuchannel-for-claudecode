# Plan: Antigravity CLI (`agy`) via tmux as a router backend

Status: **implemented on branch `feat/agy-tmux`, live-tested on inv4** · 2026-11-20

## 1. Decisions

| Topic | Decision |
|---|---|
| Transport | **Interactive `agy` CLI in a detached tmux session per workdir**, the same model as Claude-via-tmux. Messages are delivered as real keystrokes (`tmux paste-buffer` + Enter) |
| Feature target | Parity with Claude-via-tmux (§4) |
| Model / mode | Zero config by default: agy's own default model and agent mode. Optional overrides per directory, or per chat (§5) |
| Test target | `inv4` (`/Users/openclaw/Projects/inv4`, its Feishu test group) |
| Fallback | Same pattern as OpenCode: pre-delivery failures only. `agy` can be the primary and can be a fallback target (§6) |

(`agy acp` also works and is still an alternative, but per review we go with tmux.)

## 2. What I verified live (agy 1.5.12, scratch workspace)

| Probe | Result | Consequence for design |
|---|---|---|
| Launch in tmux, paste a prompt, press Enter | Works | Same delivery path as Claude |
| First launch in a new dir | "Do you trust the contents of this project?" dialog | Pass `--settings '{"trustedWorkspaces":["<workdir>"]}'` at spawn. **Verified:** the dialog is skipped and nothing is persisted to `~/.gemini/antigravity-cli/settings.json` |
| Lifecycle hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`) | All fire. The payload includes `conversationId`, `cwd`, `transcriptPath`, `lastUserInput`, and for `Stop`: `terminationReason`, `fullyIdle`, `error` | `Stop` is the primary completion signal, as with Claude. `SessionStart` gives us the conversation id (there's no `--session-id` flag) |
| Hook env | Hooks inherit the tmux session env (`-e FEISHU_AGY_TAG=…` was visible in the hook) | One global hook can tell router sessions apart from your own agy use |
| Per-session hooks via `--settings` | **Not supported** (`unknown setting "hooks"`) | Hooks must come from a global location. See §3.2 |
| ⚠️ `PreToolUse` hook printing `{}` | agy treats it as **deny** and every tool call fails | The router does **not** register `PreToolUse` |
| Transcript | `~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript_full.jsonl`, one JSON line per step: `USER_INPUT`, `PLANNER_RESPONSE` (`content`, `thinking`, `tool_calls[]`, token usage), tool steps (`status`, `error`) | Text streaming and progress come from this file, the same way as with the Claude transcript |
| `fullyIdle` on Stop | `false` while a background task (e.g. a backgrounded `sleep`) is still running, and `true` on the final Stop | Keep watching after the reply, like Claude's "N shells running" footer |
| Permission prompt | Numbered menu: `> 1. Yes, run command` / `2. Yes, and always allow in this conversation…` / `3. … (Persist to settings.json)` / `4. No, cancel` plus a `↑/↓ Navigate` footer | Reuses the Claude dialog card. Differences: the cursor is `>` not `❯`, and **a digit key selects immediately, with no Enter** |
| `/model` panel | A non-numbered `>`-cursor list (models) + effort slider + `enter Select · esc Go Back` | New "cursor list" dialog kind: press Down N times, then Enter. The cursor position is visible in plain text, so this is more reliable than the tab-bar guess |
| Message sent mid-turn | Queued by agy (`▸ Also say SECOND (alt+m to send immediately)`), then run as the **next** turn. It produces its own `Stop` with `lastUserInput = "Also say SECOND"` | See §4, mid-turn row |
| Busy/idle footer | `esc to cancel` while working, `? for shortcuts` when idle | Readiness check before pasting, and stuck detection |
| Reattach | `agy --conversation <id>` in a new tmux session restored context. It correctly recalled "SECOND" from the earlier session | Survives a router restart and the idle reaper |
| Default agent mode | **`auto`** (edits and safe commands auto-approved, asks before irreversible actions) | The zero-config default asks less often than Claude's default |

## 3. Architecture

### 3.1 Code layout: generalize the tmux worker, don't fork it

`claude-tmux-worker.ts` is 1185 lines, over our 800-line cap, and about 70% of it is CLI-agnostic: tmux plumbing, the collect loop, dialog cards, stuck-pane screenshots and idle reaping. Plan:

```
tmux/
  tmux-core.ts        runTmux, spawn/kill/paste/capture, session naming, idle reaper
  dialog.ts           numbered-menu + tab-bar + NEW cursor-list parsers (cursor ❯ or >)
  turn-collector.ts   collect loop: stop signal, transcript tail, progress, text chunks, dialogs, background watch
  profile.ts          interface CliProfile { bin, spawnArgs(), transcript locate/parse, selectOption keys, idle/busy footer, … }
  profiles/claude.ts  today's Claude behavior, moved here verbatim
  profiles/agy.ts     agy specifics (below)
claude-tmux-worker.ts → thin re-export kept for compatibility, then removed
agy-plugin/           agy plugin: hooks.json + hook.sh (§3.2)
```

`router.ts`: the existing tmux path (`handleClaudeTmuxTask`, status card, dialog cards, `/esc` `/restart` `/select`) becomes `handleTmuxTask(profile, …)`. `primary: 'claude', mode: 'tmux'` → Claude profile. `primary: 'agy'` → agy profile. So every tmux feature, now and in future, applies to both.

**Phase 0** does this refactor alone, with all existing `claude-tmux-worker.test.ts` tests still green, before any agy code. That keeps the risk to Claude tmux contained and reviewable.

### 3.2 Hooks: a small agy plugin, guarded by env

Hooks can't be passed per session, so the repo ships `agy-plugin/` (`plugin.json` + `hooks.json` + `hook.sh`). It's installed once with `agy plugin install` by `bin/install.js`, and can be removed with `agy plugin uninstall`.

- `hook.sh` exits at once with `{}` unless `FEISHU_AGY_SIGNAL_DIR` is set. The router sets that only on the tmux sessions it spawns, so your own interactive agy use is unaffected.
- Registered events: **`SessionStart`** (writes `conversationId` → signal file, which is how we learn the id), **`Stop`** (writes the payload: `terminationReason`, `fullyIdle`, `error`, `lastUserInput`), and **`PostToolUse`** (a progress tick). No `PreToolUse` (see the deny pitfall in §2).
- Signals are files in `$TMPDIR/feishu-agy-tmux/<session>/` (like Claude's `STOP_SIGNAL_DIR`), written atomically.

### 3.3 The agy profile

- **bin:** resolved once with `Bun.which('agy')`, then `~/.local/bin/agy` (launchd PATH lesson).
- **spawn:** `agy [--conversation <id>] [--model M] [--effort E] [--mode P] --settings '{"trustedWorkspaces":["<workdir>"]}'`, with env `FEISHU_AGY_SIGNAL_DIR`. tmux session name is `feishu-agy-<hash(workdir)>`.
- **transcript:** `transcriptPath` from the hook payload, or derived from the conversation id. Parser:
  - `PLANNER_RESPONSE.content` → reply text block.
  - `tool_calls[]` → progress (`CommandLine` / `Path` / `Url` summarized).
  - Tool step `status: ERROR` → shown in the status card.
- **select option:** send the digit only. **cursor list:** `Down`×N, then `Enter`. **esc:** `Escape`.
- **reset commands:** `/clear`, `/new` (to verify which agy honors). After a reset, wait for a fresh `SessionStart` and rebind.

## 4. Parity with Claude-via-tmux

| Claude-via-tmux feature | agy |
|---|---|
| "🤔 思考中…" status card: tool, elapsed time, 1.5s throttle, 15s heartbeat, quiet while a dialog is pending | Shared code. Fed by the agy transcript and `PostToolUse` ticks |
| Reply text streams one block at a time | Each new `PLANNER_RESPONSE.content` is sent as it lands |
| Stop hook = completion, then a quiet window | Same, using the agy plugin's `Stop` signal |
| Keeps watching for background work after the reply | `Stop.fullyIdle === false` → keep collecting until a later Stop with `fullyIdle: true`, or the hard cap |
| Mid-turn message absorbed (`↪️ 已并入…`) | agy **queues** it as the next turn (verified). **Recommended:** keep agy's native queue. The router skips the extra status card, marks it `⏳ 已排队，将在当前回合后处理`, and attributes each reply by `Stop.lastUserInput`. Alternative: send with `alt+m` ("send immediately") to absorb like Claude. To be verified in phase 1, and you choose |
| Permission prompt → card with each option + 🚪 Esc, 30-min timeout then a real Escape | Shared card flow. Parser accepts the `>` cursor, and a selection sends the digit without Enter |
| `/select <n>` | Same (digit only for agy) |
| `/model`-style panels | New cursor-list card: one button per entry → Down×N + Enter. Accurate, because the `>` cursor is visible in plain text |
| Tab-bar cards, stuck-pane screenshots | Shared code. Screenshots work as-is |
| `/esc`, `/restart` | Shared. `/restart` respawns with `--conversation <id>` (keeps context). `/reset` starts fresh |
| Slash commands with instant local output | Detect from the pane or transcript (agy prints in-pane). Verify in phase 1 |
| Session survives router restart (persisted session id) | `conversationId` from `SessionStart` is persisted in `router.db` and passed as `--conversation` on respawn |
| Idle sessions killed after 1h | Same reaper. Context is kept through `--conversation` |
| Attachments downloaded, path handed to the CLI | Same |
| Rate limit → degraded until reset → fallback | `Stop.terminationReason: "ERROR"` + quota/spend-cap `error` text → `routing/degraded.ts`, with the reset time if parseable, otherwise 30 min |
| 8h hard cap | Same |

## 5. Configuration: zero by default

Minimum for inv4:

```yaml
# agents.yaml
projects:
  inv4:
    workdir: /Users/openclaw/Projects/inv4
    allowedAgents: [claude, opencode, agy]
```

```jsonc
// access.json, inv4 group
"agent": { "primary": "agy", "fallback": "opencode" }
```

Reserved optional parameters. Each layer overrides the one above it, and anything unset means agy's default:

```yaml
agents:
  agy:                     # global, optional
    bin: agy
    model: ~               # → --model
    effort: ~              # → --effort (low|medium|high|xhigh|max)
    permissionMode: ~      # → --mode (accept-edits|auto|plan); unset = agy default (auto)
projects:
  inv4:
    agy:                   # per directory, optional
      model: claude-opus-4-6-thinking
      effort: high
```

A per-chat `agent.model` / `agent.effort` overrides the project level, as with tmux Claude's `agent.model`. These are spawn-time flags, so a change takes effect after `/restart`, like Claude tmux. `/model` in chat changes it live through the panel card.

Schema changes:
- `AgentKind` adds `'agy'`.
- The zod enums for primary, fallback and allowedAgents add `agy`.
- New optional `agents.agy` and `projects.<id>.agy`.
- `resolveAgyConfig()` mirrors `resolveOpenCodeConfig`.

## 6. Fallback (same pattern as OpenCode)

- `agent.fallback` accepts `opencode | claude | agy` (but not the same as primary), gated by `fallback.enabled` and `allowedAgents`.
- It triggers only **before delivery**, the same contract as tmux Claude (`sendAndAwaitReply` throws before the paste):
  - agy binary missing;
  - tmux spawn failed;
  - the session never reached the idle footer;
  - agy is degraded (rate-limited).
- Once the paste has happened, failures are reported, never re-run elsewhere.
- `router.ts` currently hard-codes `fallback === 'opencode'` → `handleOpenCodeTask`. That becomes one `dispatchFallback(kind)` table, so claude→agy, agy→opencode, agy→claude and opencode→agy all work.
- The notice reuses today's wording, e.g. `⚠️ Antigravity (tmux) 当前不可用，已切换到 OpenCode 处理本次任务。`

## 7. Safety

- Never `--dangerously-skip-permissions`.
- Workdir must be a canonical `projects.*.workdir`.
- Trust is granted per session only, through `--settings`, never persisted.
- The plugin hook is a no-op outside router-spawned sessions and never registers `PreToolUse`.
- Feishu app credentials are not exported into the tmux session env.

## 8. Tests (TDD with `bun test`, ≥80% on new and moved files)

1. **Phase 0 refactor:** the existing tmux tests pass unchanged, plus profile-contract tests for Claude.
2. **Unit (agy):**
   - Transcript parser (fixtures recorded today).
   - Dialog parsers: `>` numbered menu, cursor list (`/model`), and no false positive on a numbered list in a finished reply (verified case: "1. Apple 2. Banana 3. Orange").
   - Stop payload parsing (`fullyIdle`, ERROR/quota).
   - `hook.sh` env guard.
   - Config resolution layers.
   - Fallback dispatch table.
3. **Integration:** the collector driven by a fake tmux + fake signal/transcript files: normal turn, background work, queued mid-turn message, permission card, `/model` card, restart with `--conversation`, quota → degraded → fallback.
4. **Live on inv4:**
   - Plain question.
   - Command needing approval.
   - Mid-turn message.
   - Backgrounded task.
   - `/model`, `/esc`, `/restart`.
   - Image attachment.
   - Router restart followed by a follow-up question.
   - Forced fallback to OpenCode (bad `bin`).

   A Feishu screenshot goes in the PR.

## 9. Phases

| Phase | Scope |
|---|---|
| 0 | Split `claude-tmux-worker.ts` into `tmux/*` + Claude profile, no behavior change |
| 1 | agy profile, agy plugin + installer, config/schema, routing `primary: agy`, status card, streaming, Stop/background watch, permission card, `/esc` `/restart`. Live on inv4 |
| 2 | Cursor-list dialog (`/model`), mid-turn handling (queue vs `alt+m`), `--conversation` persistence across restart, idle reaper, attachments |
| 3 | Degraded/rate-limit, generalized fallback table, README "Antigravity via tmux" section + design doc update |

## 10. Review decisions (2026-11-20)

1. Mid-turn messages: **keep agy's native queue**.
2. Plugin install by `bin/install.js` into the global agy config: **approved**.
3. inv4 after testing: **restore OpenCode nativeV2**.

## 11. Implementation notes (2026-11-20)

- `tmux/manager.ts` (generic manager), `tmux/dialog.ts` (parsers, incl. the new cursor-list picker), `tmux/profiles/{claude,agy}.ts`, `tmux-route.ts` (Feishu cards/status/commands, moved out of router.ts), `routing/fallback.ts` (pure fallback choice), `agy-plugin/` (hooks). `claude-tmux-worker.ts` is now a compatibility re-export.
- Queue-mode attribution follows transcript `USER_INPUT` boundaries, not only Stop order — an integration test caught text from the next queued turn being credited to the previous message.
- Local slash commands (`/model` + Esc) run no turn and fire no Stop hook; a delivered `/command` that never starts a turn is finished after 3s of idle footer (`slashCommandIdleMs`). Found in the inv4 live test, fixed, re-verified on real agy.
- Live inv4 test: queued messages during boot, tool use, `/model` picker card, `/restart` resume, `/reset` — all OK except the `/model` hang above (fixed). inv4 restored to OpenCode nativeV2 afterwards.
