/** Common domain envelope (spec §3). */
import { DomainError, type DomainErrorBody } from '../errors'

export const ROUTER_CONTRACT_VERSION = '1.1.0'

export interface Envelope {
  routerContractVersion: string
  requestId: string
  ok: boolean
  replayed: boolean
  data: Record<string, unknown> | null
  error: DomainErrorBody | null
}

export function okEnvelope(requestId: string, data: Record<string, unknown>, replayed = false): Envelope {
  return { routerContractVersion: ROUTER_CONTRACT_VERSION, requestId, ok: true, replayed, data, error: null }
}

export function errorEnvelope(requestId: string, error: DomainError | DomainErrorBody, replayed = false): Envelope {
  const body = error instanceof DomainError ? error.toBody() : error
  return { routerContractVersion: ROUTER_CONTRACT_VERSION, requestId, ok: false, replayed, data: null, error: body }
}

/** Re-issue a stored envelope for a replayed operation: same decision/data, current requestId. */
export function replayEnvelope(stored: Envelope, requestId: string): Envelope {
  return { ...stored, requestId, replayed: true }
}
