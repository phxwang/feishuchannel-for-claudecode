/** Read-only tools (design doc §9.4, §9.6, §9.7). Reads never start, consume or cancel anything. */
import { DomainError } from '../errors'
import { LIMITS } from '../schema/tools'
import type { TaskStore } from '../store/task-store'
import type { Notifier } from './commit'
import { attemptSummary, pageAfter, resourceUris, toSnapshot, turnSummary } from './snapshot'

const MAX_LONG_POLLS = 64

export class Queries {
  private polls = new Map<string, number>()

  constructor(private store: TaskStore, private notifier: Notifier) {}

  private task(taskId: string) {
    const t = this.store.getTask(taskId)
    if (!t) throw new DomainError('TASK_NOT_FOUND', 'No such task.', { taskId })
    return t
  }

  get(taskId: string) {
    const t = this.task(taskId)
    const turn = t.currentTurnId ? this.store.getTurn(t.currentTurnId) : undefined
    return { task: toSnapshot(t, turn), resources: resourceUris(taskId) }
  }

  lookup(clientId: string, clientTaskId: string) {
    const t = this.store.getTaskByClient(clientId, clientTaskId)
    if (!t) throw new DomainError('TASK_NOT_FOUND', 'No task with this clientId/clientTaskId.', { clientId, clientTaskId })
    return this.get(t.taskId)
  }

  async events(a: { taskId: string; afterSeq: number; limit?: number; waitSeconds?: number }) {
    let t = this.task(a.taskId)
    const limit = a.limit ?? 100
    const wait = a.waitSeconds ?? 0
    if (a.afterSeq > t.lastSeq) throw new DomainError('INVALID_CURSOR', 'afterSeq is beyond the last committed event.', { lastSeq: t.lastSeq })
    const minSeq = this.store.minEventSeq(a.taskId) ?? t.lastSeq + 1
    if (t.lastSeq > 0 && a.afterSeq < minSeq - 1) {
      throw new DomainError('EVENT_CURSOR_EXPIRED', 'Events after this cursor are no longer retained.', {
        minAvailableSeq: minSeq, lastSeq: t.lastSeq, ...(() => { const r = resourceUris(a.taskId); return { taskResourceUri: r.snapshotUri, resultResourceUri: r.resultUri } })(),
      })
    }
    let events = this.store.readEvents(a.taskId, a.afterSeq, limit, LIMITS.eventPageBytes)
    if (!events.length && wait > 0 && t.phase !== 'CLOSED') {
      const key = a.taskId
      const n = this.polls.get(key) ?? 0
      const total = [...this.polls.values()].reduce((x, y) => x + y, 0)
      if (n >= 1 || total >= MAX_LONG_POLLS) {
        throw new DomainError('CAPACITY_EXHAUSTED', 'Another long poll is already waiting on this task.', { retryAfterMs: 1000 }, { sideEffects: 'none' })
      }
      this.polls.set(key, n + 1)
      try { await this.notifier.wait(a.taskId, wait * 1000) } finally {
        const left = (this.polls.get(key) ?? 1) - 1
        if (left <= 0) this.polls.delete(key); else this.polls.set(key, left)
      }
      events = this.store.readEvents(a.taskId, a.afterSeq, limit, LIMITS.eventPageBytes)
      t = this.task(a.taskId)
    }
    const nextAfterSeq = events.length ? events[events.length - 1].seq : a.afterSeq
    return {
      taskId: a.taskId,
      events,
      nextAfterSeq,
      hasMore: nextAfterSeq < t.lastSeq,
      lastSeq: t.lastSeq,
      minAvailableSeq: this.store.minEventSeq(a.taskId) ?? t.lastSeq + 1,
      taskPhase: t.phase,
    }
  }

  result(a: { taskId: string; afterTurnId?: string; afterExecutionAttemptId?: string }) {
    const t = this.task(a.taskId)
    if (t.resultExpired) throw new DomainError('RESULT_EXPIRED', 'The result body is past its retention period.', { taskId: a.taskId })
    const turns = this.store.listTurns(a.taskId).filter(x => x.delivery !== 'not_sent' || x.state === 'ended')
    const attempts = this.store.listAttempts(a.taskId)
    const tp = pageAfter(turns, x => x.turnId, a.afterTurnId, LIMITS.maxSummariesPerPage)
    const ap = pageAfter(attempts, x => x.executionAttemptId, a.afterExecutionAttemptId, LIMITS.maxSummariesPerPage)
    if (!tp || !ap) throw new DomainError('INVALID_CURSOR', 'Unknown pagination cursor.')
    const lastEnded = [...attempts].reverse().find(x => x.state === 'ended')
    return {
      taskId: t.taskId,
      phase: t.phase,
      controlVersion: t.controlVersion,
      final: t.phase === 'CLOSED',
      executionOutcome: t.executionOutcome,
      turns: tp.page.map(x => turnSummary(x, this.store.getTurnText(x.turnId))),
      nextAfterTurnId: tp.next,
      hasMore: tp.hasMore,
      evidence: {
        backendSessionId: t.owner.backendSessionId ?? lastEnded?.owner.backendSessionId ?? null,
        backendTurnId: t.currentTurnId ? (this.store.getTurn(t.currentTurnId)?.backendTurnId || null) : null,
        transcriptPath: null,
      },
      cleanup: t.cleanup,
      businessAcceptance: 'not_evaluated',
      lastSeq: t.lastSeq,
      fallbackPlanSha256: t.fallbackPlanSha256,
      selectedCandidateIndex: t.selectedCandidateIndex,
      actualBackend: t.actualBackend,
      fallbackSummary: { switchesUsed: t.switchesUsed, executionAttemptCount: t.executionAttemptCount, fallbackState: t.fallbackState },
      executionAttempts: ap.page.map(attemptSummary),
      nextAfterExecutionAttemptId: ap.next,
      attemptsHasMore: ap.hasMore,
    }
  }

  turnText(a: { taskId: string; turnId: string; offsetBytes: number; maxBytes?: number }) {
    const t = this.task(a.taskId)
    if (t.resultExpired) throw new DomainError('RESULT_EXPIRED', 'The result body is past its retention period.')
    const turn = this.store.getTurn(a.turnId)
    if (!turn || turn.taskId !== a.taskId) throw new DomainError('TURN_NOT_FOUND', 'No such turn in this task.', { turnId: a.turnId })
    const text = this.store.getTurnText(a.turnId)
    if (turn.state !== 'ended' || !text) throw new DomainError('RESULT_NOT_READY', 'Final text is not available for this turn.', {}, { retryable: turn.state !== 'ended' })
    const bytes = text.bytes
    const max = a.maxBytes ?? 32768
    if (a.offsetBytes > bytes.byteLength) throw new DomainError('INVALID_CURSOR', 'offsetBytes is beyond the end of the text.')
    if (a.offsetBytes < bytes.byteLength && (bytes[a.offsetBytes] & 0xc0) === 0x80) throw new DomainError('INVALID_CURSOR', 'offsetBytes is not on a code point boundary.')
    let end = Math.min(bytes.byteLength, a.offsetBytes + max)
    while (end > a.offsetBytes && end < bytes.byteLength && (bytes[end] & 0xc0) === 0x80) end--
    if (end === a.offsetBytes && a.offsetBytes < bytes.byteLength) throw new DomainError('INVALID_CURSOR', 'maxBytes is too small for the next code point.')
    return {
      taskId: a.taskId, turnId: a.turnId,
      text: bytes.subarray(a.offsetBytes, end).toString('utf8'),
      offsetBytes: a.offsetBytes, nextOffsetBytes: end, totalBytes: bytes.byteLength, sha256: text.sha256, eof: end === bytes.byteLength,
    }
  }
}
