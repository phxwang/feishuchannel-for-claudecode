import { randomBytes } from 'crypto'
import type { Socket } from 'net'

// Worker protocol (router.ts side) — see docs/multi-agent-router-design.md §4/§9.
// Router uses these to route permission/confirm-card button clicks to this
// exact worker instead of guessing from chat_id or broadcasting to every
// connected worker.
export const WORKER_ID = randomBytes(8).toString('hex')
export const WORKER_PROTOCOL_VERSION = 1
export const WORKER_CAPABILITIES = ['permission_request', 'confirm_card']

let workerSock: Socket | null = null

export function setWorkerSock(sock: Socket | null) {
  workerSock = sock
}

/** Only clears if `sock` is still the current one — guards against a stale socket's error/close handler nulling a newer replacement. */
export function clearWorkerSockIfCurrent(sock: Socket) {
  if (workerSock === sock) workerSock = null
}

/** Tell the router which workdir issued a permission/confirm card `code`, so its
 *  card.action.trigger handler can route the click precisely (routing/storage.ts PermissionRegistry). */
export function registerCallback(code: string, workdir: string, dbg: (msg: string) => void) {
  if (!workerSock) { dbg(`registerCallback(${code}): no router connection, precise routing unavailable for this card — falling back to chat_id lookup`); return }
  try {
    workerSock.write(JSON.stringify({ type: 'callback_registered', code, workdir }) + '\n')
  } catch (e) { dbg(`registerCallback failed: ${e}`) }
}

/** Fallback cooldown when this worker reports itself rate-limited but Claude's own reset-time
 *  text (e.g. "resets 9:30pm (Asia/Singapore)", parsed by rate-limit-reset.ts) can't be parsed. */
export const DEFAULT_DEGRADED_MS = 30 * 60 * 1000

/** Tell the router this worker's Claude Code instance is rate-limited and won't produce
 *  a real reply until `untilMs` — the router can use this to skip straight to an
 *  OpenCode fallback (if configured) instead of routing to a worker that will just fail. */
export function sendDegraded(reason: string, untilMs: number, dbg: (msg: string) => void) {
  if (!workerSock) { dbg(`sendDegraded(${reason}): no router connection, router won't know to fall back`); return }
  try {
    workerSock.write(JSON.stringify({ type: 'degraded', reason, until: untilMs }) + '\n')
  } catch (e) { dbg(`sendDegraded failed: ${e}`) }
}
