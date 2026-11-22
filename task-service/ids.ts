/** Opaque prefixed identifiers (ULID body: 48-bit time + 80-bit randomness, Crockford base32). */
import { randomBytes } from 'crypto'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function ulid(now = Date.now()): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) { time = ALPHABET[t % 32] + time; t = Math.floor(t / 32) }
  const bytes = randomBytes(16)
  let rand = ''
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] % 32]
  return time + rand
}

export type IdPrefix = 'task' | 'xatt' | 'exec' | 'turn' | 'op' | 'xreq' | 'perm' | 'rti' | 'nonce'

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`
}
