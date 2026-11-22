/**
 * Native `/goal` tracking for tmux CLIs (Claude Code today).
 *
 * A goal turns one message into a self-continuing loop: the CLI's own Stop
 * hook evaluates the condition after every turn and blocks stopping until it
 * holds. So for a goal, a Stop is NOT the end of the reply. Completion is the
 * goal being achieved (plus the usual idle + settled background work), never
 * a turn merely ending. Rule learned from the Hermes Writer broker and
 * verified live against Claude Code 2.1.330:
 *   - provenance: only goal records seen after this message was sent count
 *     (a stale verdict from an earlier goal or scrollback never does);
 *   - only a goal SET in this wait is followed; its later verdicts
 *     (unmet, achieved, cleared, interrupted) count, nothing else does;
 *   - `/goal clear` and an Esc interrupt end the wait but are not achievement.
 */

/** One goal-relevant transcript record, as classified by a profile. */
export type GoalSignal = 'set' | 'unmet' | 'achieved' | 'cleared' | 'interrupted'

/** The goal state of one reply wait. 'none' = this message is not (or no longer) driving a goal. */
export type GoalState = 'none' | 'active' | 'achieved' | 'cleared' | 'interrupted'

export function nextGoalState(state: GoalState, signal: GoalSignal): GoalState {
  if (signal === 'set') return 'active'
  // Every later verdict only means something for a goal this wait set: a goal
  // left armed by an earlier message must not turn an ordinary reply into a goal wait.
  if (state !== 'active') return state
  return signal === 'unmet' ? 'active' : signal
}

/** The goal stopped driving turns (achieved, cleared or interrupted). */
export function goalLeftActive(before: GoalState, after: GoalState): boolean {
  return before === 'active' && after !== 'active'
}
