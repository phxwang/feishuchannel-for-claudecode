/**
 * Claude Adapter — wraps the existing Unix-socket worker protocol
 * (router.ts <-> server.ts) behind the AgentAdapter interface.
 *
 * IMPORTANT — honest scope: today the socket protocol is router -> worker
 * only for task delivery (channel_message/permission_response/confirm_response).
 * The worker's actual reply text is posted directly to Feishu by server.ts's
 * own `reply` tool (see docs/multi-agent-router-design.md §2) and never
 * flows back through this socket. So `send()` cannot yield real
 * text.delta/tool.* events, and getFinalMessage/getDiff have nothing to
 * read — those throw ClaudeNotSupportedError rather than fabricate data.
 * Extending server.ts to forward granular events is tracked as follow-up
 * work (design doc §4 "Claude Adapter" bullet list), not done in this PR.
 *
 * Not wired into router.ts's live socket handling yet — this is a
 * standalone, unit-tested layer, same staged approach as routing/*.ts.
 */
import type {
  AgentAdapter, AgentEvent, AgentSession, AgentTarget, AgentTask,
  ConversationContext, FileDiff, FinalMessage, HealthStatus, PermissionDecision,
} from '../agent-adapter'
import type { AgentKind } from '../../routing/types'

export class ClaudeNotSupportedError extends Error {}

export interface ClaudeWorkerLink {
  readonly workdir: string
  /** Mirrors router.ts's sendToWorker/routeToWorkdir contract: true if a live socket accepted the write. */
  send(payload: Record<string, unknown>): boolean
}

export interface ClaudeWorkerLocator {
  find(workdir: string): ClaudeWorkerLink | undefined
}

const SESSION_PREFIX = 'claude:'

export class ClaudeAdapter implements AgentAdapter {
  readonly kind: AgentKind = 'claude'

  constructor(
    private workers: ClaudeWorkerLocator,
    /** Resolves a pending permission/confirm code to the workdir that issued it — same registry as routing/storage.ts PermissionRegistry. */
    private resolvePermissionWorkdir: (requestId: string) => string | undefined,
  ) {}

  async health(target: AgentTarget): Promise<HealthStatus> {
    const link = this.workers.find(target.workdir)
    return {
      healthy: !!link,
      detail: link ? undefined : `no worker registered for ${target.workdir}`,
      checkedAt: new Date().toISOString(),
    }
  }

  async createSession(ctx: ConversationContext): Promise<AgentSession> {
    // Claude Code workers are one-process-per-workdir with no explicit
    // multi-session concept today — the "session" is the worker's lifetime.
    // The id is therefore synthetic and scoped to the workdir, not a real
    // backend-issued session identifier.
    return { sessionId: `${SESSION_PREFIX}${ctx.workdir}`, agent: 'claude' }
  }

  async resumeSession(sessionId: string): Promise<AgentSession> {
    return { sessionId, agent: 'claude' }
  }

  async *send(task: AgentTask, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const workdir = workdirFromSession(task.sessionId)
    const link = this.workers.find(workdir)
    if (!link) { yield { type: 'task.failed', taskId: task.taskId, reason: 'backend_unavailable' }; return }

    yield { type: 'task.started', taskId: task.taskId }
    const delivered = link.send({
      type: 'channel_message',
      content: task.prompt,
      meta: {
        chat_id: '', message_id: task.taskId, user: '', user_id: '',
        ts: new Date().toISOString(), chat_type: 'p2p',
      },
    })
    if (!delivered) { yield { type: 'task.failed', taskId: task.taskId, reason: 'backend_unavailable' }; return }
    if (signal.aborted) { yield { type: 'task.aborted', taskId: task.taskId }; return }
    // No progress stream available (see class doc) — the best this adapter
    // can honestly report is "delivered, worker is now responsible for it".
    yield { type: 'session.idle', taskId: task.taskId }
  }

  async abort(sessionId: string, taskId: string): Promise<void> {
    const link = this.workers.find(workdirFromSession(sessionId))
    if (!link) throw new ClaudeNotSupportedError(`no worker for session ${sessionId}`)
    link.send({ type: 'abort', task_id: taskId })
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const workdir = this.resolvePermissionWorkdir(requestId)
    if (!workdir) throw new ClaudeNotSupportedError(`no known workdir for permission request ${requestId}`)
    const link = this.workers.find(workdir)
    if (!link) throw new ClaudeNotSupportedError(`no worker connected for ${workdir}`)
    link.send({ type: 'permission_response', request_id: requestId, behavior: decision.behavior })
  }

  async getFinalMessage(_sessionId: string, taskId: string): Promise<FinalMessage> {
    throw new ClaudeNotSupportedError(`getFinalMessage(${taskId}): Claude worker protocol does not expose task output to the router today — replies go directly to Feishu`)
  }

  async getDiff(): Promise<FileDiff[]> {
    throw new ClaudeNotSupportedError('getDiff: Claude worker protocol does not expose file diffs to the router today')
  }
}

function workdirFromSession(sessionId: string): string {
  return sessionId.startsWith(SESSION_PREFIX) ? sessionId.slice(SESSION_PREFIX.length) : sessionId
}
