/**
 * Single choke point for lifecycle writes: read the task, let a pure function
 * produce the next record + events (+ attempt/turn rows), persist everything
 * in one IMMEDIATE transaction, bump controlVersion on phase/control changes,
 * then wake long-pollers after COMMIT.
 */
import { DomainError } from '../errors'
import { assertTransition, InvalidPhaseTransition } from '../lifecycle'
import type { AttemptRecord, TaskEvent, TaskRecord, TurnRecord } from '../model'
import type { NewEvent, TaskStore } from '../store/task-store'
import { formatTimestamp, type Clock } from '../time'

export interface Change<R = void> {
  task: TaskRecord
  events?: NewEvent[]
  attempts?: AttemptRecord[]
  turns?: TurnRecord[]
  /** Set when the change is a lifecycle/control/owner change (increments controlVersion). */
  control?: boolean
  result?: R
}

export class Notifier {
  private waiters = new Map<string, Set<() => void>>()

  wait(taskId: string, ms: number): Promise<void> {
    return new Promise(resolve => {
      const set = this.waiters.get(taskId) ?? new Set()
      this.waiters.set(taskId, set)
      const done = () => { clearTimeout(timer); set.delete(done); if (!set.size) this.waiters.delete(taskId); resolve() }
      const timer = setTimeout(done, ms)
      set.add(done)
    })
  }

  notify(taskId: string): void {
    for (const fn of [...(this.waiters.get(taskId) ?? [])]) fn()
  }

  activeCount(): number {
    let n = 0
    for (const s of this.waiters.values()) n += s.size
    return n
  }
}

export class Committer {
  /** Called after every successful commit (the engine re-arms deadline timers here). */
  onCommitted: ((task: TaskRecord) => void) | null = null

  constructor(private store: TaskStore, private clock: Clock, private notifier: Notifier) {}

  /**
   * `fn` receives the current task (or throws TASK_NOT_FOUND) and returns a Change.
   * Returning null means "nothing to do" (e.g. a stale async continuation).
   */
  commit<R>(taskId: string, fn: (task: TaskRecord) => Change<R> | null): { task: TaskRecord; events: TaskEvent[]; result?: R } | null {
    let out: { task: TaskRecord; events: TaskEvent[]; result?: R } | null = null
    try {
      this.store.tx(() => {
        const current = this.store.getTask(taskId)
        if (!current) throw new DomainError('TASK_NOT_FOUND', 'No such task.', { taskId })
        const change = fn(current)
        if (!change) return
        let next = change.task
        if (next.phase !== current.phase) assertTransition(current.phase, next.phase)
        const now = this.clock.now()
        if (change.control || next.phase !== current.phase) next = { ...next, controlVersion: current.controlVersion + 1 }
        next = { ...next, updatedAtMs: now }
        for (const a of change.attempts ?? []) this.store.putAttempt(a)
        for (const t of change.turns ?? []) this.store.putTurn(t)
        const { task: withSeq, stored } = this.store.appendEvents(next, change.events ?? [], formatTimestamp(now))
        this.store.putTask(withSeq)
        out = { task: withSeq, events: stored, result: change.result }
      })
    } catch (e) {
      if (e instanceof DomainError || e instanceof InvalidPhaseTransition) throw e
      throw new DomainError('STORAGE_UNAVAILABLE', 'The task store could not commit the change.', {}, { sideEffects: 'none' })
    }
    if (out) {
      this.notifier.notify(taskId)
      const committed = (out as { task: TaskRecord }).task
      if (this.onCommitted) queueMicrotask(() => this.onCommitted?.(committed))
    }
    return out
  }
}

/** Helper for building attempt-bound event payloads. */
export function attemptEvent(type: string, a: Pick<AttemptRecord, 'executionAttemptId' | 'candidateIndex' | 'executionId'> | null, turnId: string | null, data: Record<string, unknown> = {}): NewEvent {
  return {
    type,
    executionId: a?.executionId ?? null,
    turnId,
    executionAttemptId: a?.executionAttemptId ?? null,
    candidateIndex: a?.candidateIndex ?? null,
    data,
  }
}

export function taskEvent(type: string, data: Record<string, unknown> = {}): NewEvent {
  return { type, executionId: null, turnId: null, executionAttemptId: null, candidateIndex: null, data }
}
