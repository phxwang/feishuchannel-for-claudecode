/** Shared zod refinements for identifiers, digests and bounded strings (spec §4.1). */
import { z } from 'zod'

export const utf8Bytes = (s: string) => Buffer.byteLength(s, 'utf8')
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** 1–max UTF-8 bytes, no control characters. */
export function boundedString(max: number, min = 1) {
  return z.string()
    .refine(s => utf8Bytes(s) >= min && utf8Bytes(s) <= max, { message: `must be ${min}-${max} UTF-8 bytes` })
    .refine(s => !CONTROL.test(s), { message: 'must not contain control characters' })
}

export const identifier = boundedString(256)
export const idempotencyKey = z.string().regex(/^[\x21-\x7e]{1,128}$/, 'must be 1-128 printable non-whitespace ASCII characters')
export const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be lowercase hex SHA-256')
export const requestId = z.string().uuid()
export const nonNegInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const reason = boundedString(256)

/** Tag maps used by `correlation` and `assignment.metadata`: ≤8 keys, bounded keys/values. */
export function tagMap(maxValueBytes: number) {
  return z.record(
    z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'keys must match [A-Za-z0-9_.-]{1,64}'),
    boundedString(maxValueBytes),
  ).refine(m => Object.keys(m).length <= 8, { message: 'at most 8 keys' })
}

export const BACKEND_KINDS = ['opencode', 'claude', 'codex', 'agy', 'fake'] as const
export type BackendKind = (typeof BACKEND_KINDS)[number]
export const BACKEND_MODES = ['http_sse', 'tmux', 'print', 'acp', 'exec'] as const
export type BackendMode = (typeof BACKEND_MODES)[number]

export const candidateSchema = z.object({
  kind: z.enum(BACKEND_KINDS),
  mode: z.enum(BACKEND_MODES),
  model: boundedString(256),
  variant: boundedString(64).nullable(),
}).strict()
export type Candidate = z.infer<typeof candidateSchema>

export function sameCandidate(a: Candidate, b: Candidate): boolean {
  return a.kind === b.kind && a.mode === b.mode && a.model === b.model && a.variant === b.variant
}

export const ownerRefSchema = z.object({
  executionId: identifier,
  generation: nonNegInt,
}).strict()
export type OwnerRef = z.infer<typeof ownerRefSchema>
