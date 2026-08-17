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
