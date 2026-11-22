/** Public views of durable records: TaskSnapshot (spec §4.4) and result pages (spec §5.7). */
import type { AttemptRecord, TaskRecord, TurnRecord } from '../model'
import { LIMITS } from '../schema/tools'
import { formatTimestamp } from '../time'

const ts = (ms: number | null) => (ms === null ? null : formatTimestamp(ms))

export function resourceUris(taskId: string) {
  return { snapshotUri: `router://tasks/${taskId}/snapshot`, resultUri: `router://tasks/${taskId}/result` }
}

export function toSnapshot(task: TaskRecord, currentTurn: TurnRecord | undefined) {
  return {
    taskId: task.taskId,
    clientId: task.clientId,
    clientTaskId: task.clientTaskId,
    scopeKey: task.scopeKey,
    correlation: task.correlation,
    projectId: task.projectId,
    workdirSource: task.workdirSource,
    workdir: task.workdir.canonicalPath,
    backend: task.backend,
    policy: task.policy,
    permissionPolicy: task.permissionPolicy,
    assignment: task.assignment,
    phase: task.phase,
    controlVersion: task.controlVersion,
    sealed: task.sealed,
    owner: task.owner,
    currentTurn: currentTurn ? {
      turnId: currentTurn.turnId,
      state: currentTurn.state,
      outcome: currentTurn.outcome,
      delivery: currentTurn.delivery,
      startedAt: ts(currentTurn.startedAtMs),
      endedAt: ts(currentTurn.endedAtMs),
    } : null,
    executionOutcome: task.executionOutcome,
    lastSeq: task.lastSeq,
    createdAt: formatTimestamp(task.createdAtMs),
    updatedAt: formatTimestamp(task.updatedAtMs),
    fallbackPlanSha256: task.fallbackPlanSha256,
    selectedCandidateIndex: task.selectedCandidateIndex,
    actualBackend: task.actualBackend,
    currentExecutionAttemptId: task.currentExecutionAttemptId,
    executionAttemptCount: task.executionAttemptCount,
    fallbackState: task.fallbackState,
    pendingAuthorization: task.pendingAuthorization ? {
      transitionRequestId: task.pendingAuthorization.transitionRequestId,
      action: task.pendingAuthorization.action,
      candidateIndex: task.pendingAuthorization.candidateIndex,
      backend: task.pendingAuthorization.backend,
      executionAttemptId: task.pendingAuthorization.executionAttemptId,
      previousOwner: task.pendingAuthorization.previousOwner,
      triggerCode: task.pendingAuthorization.triggerCode,
      evidenceDigest: task.pendingAuthorization.evidenceDigest,
      checkpointSha256: task.pendingAuthorization.checkpointSha256,
      effectiveInputSha256: task.pendingAuthorization.effectiveInputSha256,
      transitionSha256: task.pendingAuthorization.transitionSha256,
      expiresAt: formatTimestamp(task.pendingAuthorization.expiresAtMs),
      requiredBusinessChecks: task.pendingAuthorization.requiredBusinessChecks,
    } : null,
    needsAttention: task.needsAttention,
    terminalReason: task.terminalReason,
  }
}

export type TaskSnapshot = ReturnType<typeof toSnapshot>

/** Inline prefix of at most `limit` bytes, cut on a code point boundary. */
export function utf8Prefix(bytes: Buffer, limit: number): { text: string; truncated: boolean } {
  if (bytes.byteLength <= limit) return { text: bytes.toString('utf8'), truncated: false }
  let end = limit
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

export function attemptSummary(a: AttemptRecord) {
  return {
    executionAttemptId: a.executionAttemptId,
    ordinal: a.ordinal,
    candidateIndex: a.candidateIndex,
    backend: a.backend,
    executionId: a.executionId,
    generation: a.generation,
    triggerCode: a.triggerCode,
    evidenceDigest: a.evidenceDigest,
    isStartupRetry: a.isStartupRetry,
    delivery: a.delivery,
    effectStatus: a.effectStatus,
    state: a.state,
    outcome: a.outcome,
    failure: a.failure,
    blockedReason: a.blockedReason,
    backendSessionId: a.owner.backendSessionId,
    ownerReleased: a.ownerReleased,
    startedAt: formatTimestamp(a.startedAtMs),
    endedAt: ts(a.endedAtMs),
  }
}

export function turnSummary(t: TurnRecord, text: { bytes: Buffer; sha256: string } | undefined) {
  const inline = text ? utf8Prefix(text.bytes, LIMITS.inlineFinalTextBytes) : null
  return {
    turnId: t.turnId,
    executionAttemptId: t.executionAttemptId,
    candidateIndex: t.candidateIndex,
    state: t.state,
    outcome: t.outcome,
    delivery: t.delivery,
    startedAt: ts(t.startedAtMs),
    endedAt: ts(t.endedAtMs),
    finalText: inline ? inline.text : null,
    finalTextSha256: t.finalTextSha256,
    finalTextBytes: t.finalTextBytes,
    finalTextTruncated: inline ? inline.truncated : false,
    finalTextComplete: t.finalTextComplete,
    protocol: t.protocol,
    process: t.process,
    evidence: t.evidence,
  }
}

/** Page after an opaque cursor id (exclusive). Unknown cursor → null (caller reports INVALID_CURSOR). */
export function pageAfter<T>(items: T[], idOf: (t: T) => string, after: string | undefined, size: number): { page: T[]; hasMore: boolean; next: string | null } | null {
  let start = 0
  if (after !== undefined) {
    const i = items.findIndex(x => idOf(x) === after)
    if (i < 0) return null
    start = i + 1
  }
  const page = items.slice(start, start + size)
  const hasMore = start + size < items.length
  return { page, hasMore, next: page.length ? idOf(page[page.length - 1]) : (after ?? null) }
}
