/**
 * Text stream normalization (design doc §9.6): backend snapshots or appends
 * become non-duplicating `text.delta` events (with `text.reset` when a
 * snapshot rewrites earlier text), split at UTF-8 boundaries to stay under
 * the per-event byte budget.
 */

export const TEXT_EVENT_MAX_BYTES = 60 * 1024

/** Split into chunks of at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function splitUtf8Bytes(text: string, maxBytes = TEXT_EVENT_MAX_BYTES): string[] {
  const out: string[] = []
  let chunk = ''
  let size = 0
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8')
    if (size + n > maxBytes && chunk) { out.push(chunk); chunk = ''; size = 0 }
    chunk += ch
    size += n
  }
  if (chunk) out.push(chunk)
  return out
}

export type TextOp = { kind: 'delta'; streamId: string; text: string } | { kind: 'reset'; streamId: string }

export class TextStreams {
  private streams = new Map<string, string>()
  private totalBytes = 0

  /** Rebuild state from already-persisted events (after a restart). */
  restore(streamId: string, text: string): void {
    this.totalBytes += Buffer.byteLength(text, 'utf8') - Buffer.byteLength(this.streams.get(streamId) ?? '', 'utf8')
    this.streams.set(streamId, text)
  }

  apply(streamId: string, text: string, mode: 'snapshot' | 'append'): TextOp[] {
    const prev = this.streams.get(streamId) ?? ''
    const ops: TextOp[] = []
    let next: string
    let delta: string
    if (mode === 'append') {
      next = prev + text
      delta = text
    } else if (text.startsWith(prev)) {
      next = text
      delta = text.slice(prev.length)
    } else {
      next = text
      delta = text
      ops.push({ kind: 'reset', streamId })
    }
    this.totalBytes += Buffer.byteLength(next, 'utf8') - Buffer.byteLength(prev, 'utf8')
    this.streams.set(streamId, next)
    for (const part of delta ? splitUtf8Bytes(delta) : []) ops.push({ kind: 'delta', streamId, text: part })
    return ops
  }

  bytes(): number { return this.totalBytes }

  /** Concatenated text of every stream, in first-seen order. */
  joined(): string { return [...this.streams.values()].join('') }
}
