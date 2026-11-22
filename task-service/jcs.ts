/**
 * RFC 8785 JSON Canonicalization Scheme for the value domain this service
 * uses: null, booleans, safe integers, strings, arrays, plain objects.
 * Non-integer numbers are rejected (the contract has no floats in v1), which
 * is exactly the subset where JCS equals ES JSON.stringify with object keys
 * sorted by UTF-16 code units.
 */
import { createHash } from 'crypto'

export class CanonicalizationError extends Error {}

export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false'
    case 'string': return JSON.stringify(value)
    case 'number':
      if (!Number.isSafeInteger(value)) throw new CanonicalizationError(`non-integer or unsafe number: ${value}`)
      return String(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) throw new CanonicalizationError('only plain objects can be canonicalized')
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
    }
    default:
      throw new CanonicalizationError(`unsupported type: ${typeof value}`)
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function jcsSha256(value: unknown): string {
  return sha256Hex(canonicalize(value))
}

/** Fingerprint of validated tool arguments, excluding tracing and idempotency fields (spec §4.2). */
export function operationFingerprint(args: Record<string, unknown>): string {
  const { requestId: _r, idempotencyKey: _k, ...rest } = args
  return jcsSha256(rest)
}
