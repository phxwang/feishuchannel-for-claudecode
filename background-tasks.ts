/**
 * Works out, from a Claude Code session transcript (JSONL), which background
 * tasks the session started and hasn't yet heard back from.
 *
 * claude-tmux-worker.ts uses this after a turn's Stop hook fires: if anything
 * is still pending, the CLI will start a fresh turn by itself once it
 * finishes (a `<task-notification>`), so the router must keep forwarding
 * transcript text instead of treating the request as done. The pane footer
 * alone is not enough for this — it only says "N shells" for bash tasks, and
 * found live, a run with one backgrounded smoke shell plus one async review
 * agent showed only "← 2 agents", which also stays on screen after the
 * agents finish. The transcript records both the start and the end of every
 * background task explicitly, so it's used instead.
 *
 * Start records (on the `toolUseResult` of the tool call's result line):
 *   - bash run in, or moved to, the background: `backgroundTaskId`
 *   - async agent: `isAsync: true` + `agentId`
 * End records:
 *   - `<task-notification><task-id>ID</task-id>…` anywhere in a line —
 *     as a user message for bash tasks, but for agents only as a
 *     `queue-operation` / `queued_command` line, so it's matched as raw text
 *     rather than in one particular message field
 *   - a successful TaskStop (`toolUseResult.task_id` + "Successfully
 *     stopped task"), which sends no notification of its own
 */

/** Matches the escaped JSON form (`\n` as two characters) as well as real newlines. */
const NOTIFICATION_TASK_ID_RE = /<task-notification>(?:\s|\\n)*<task-id>([^<]+)<\/task-id>/g
const TASK_STOPPED_PREFIX = 'Successfully stopped task'

type ToolUseResult = Record<string, unknown>

function parseToolUseResult(line: string): ToolUseResult | null {
  // Cheap pre-filter: transcripts run to several MB and most lines carry no
  // tool result at all.
  if (!line.includes('"toolUseResult"')) return null
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return null
    const result = (parsed as Record<string, unknown>).toolUseResult
    return typeof result === 'object' && result !== null ? result as ToolUseResult : null
  } catch {
    // A partially written trailing line or a non-JSON line: nothing to read.
    return null
  }
}

function startedTaskId(result: ToolUseResult): string | null {
  if (typeof result.backgroundTaskId === 'string' && result.backgroundTaskId) return result.backgroundTaskId
  if (result.isAsync === true && typeof result.agentId === 'string' && result.agentId) return result.agentId
  return null
}

function stoppedTaskId(result: ToolUseResult): string | null {
  const stopped = typeof result.message === 'string' && result.message.startsWith(TASK_STOPPED_PREFIX)
  return stopped && typeof result.task_id === 'string' && result.task_id ? result.task_id : null
}

function notifiedTaskIds(line: string): string[] {
  if (!line.includes('<task-notification>')) return []
  return [...line.matchAll(NOTIFICATION_TASK_ID_RE)].map(m => m[1].trim())
}

/**
 * What to do after a Stop, given what's still running:
 *   - `done`: nothing left, the request is finished
 *   - `wait`: the pane footer itself shows shells running; that's a live
 *     signal, so wait (bounded only by the overall reply deadline)
 *   - `wait-capped`: only the transcript says something is pending. It's
 *     usually right, but a task whose end was never recorded (the CLI
 *     crashed or was killed mid-task) would stay "pending" forever, so the
 *     caller stops waiting after a long stretch with no transcript activity
 */
export type BackgroundWait = 'done' | 'wait' | 'wait-capped'

export function backgroundWaitAfterStop(pendingTaskCount: number, runningShells: number): BackgroundWait {
  if (runningShells > 0) return 'wait'
  return pendingTaskCount > 0 ? 'wait-capped' : 'done'
}

/** IDs of background tasks started in `lines` with no end record after them. */
export function pendingBackgroundTaskIds(lines: readonly string[]): Set<string> {
  const started = new Set<string>()
  const ended = new Set<string>()
  for (const line of lines) {
    for (const id of notifiedTaskIds(line)) ended.add(id)
    const result = parseToolUseResult(line)
    if (!result) continue
    const startId = startedTaskId(result)
    if (startId) started.add(startId)
    const stopId = stoppedTaskId(result)
    if (stopId) ended.add(stopId)
  }
  return new Set([...started].filter(id => !ended.has(id)))
}
