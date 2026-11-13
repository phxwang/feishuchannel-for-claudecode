/**
 * Minimal Server-Sent-Events line buffer — pure and independently testable
 * so OpenCodeAdapter's stream handling doesn't need a real HTTP connection
 * under test. Handles the `data: <json>\n\n` framing; ignores `event:`/`id:`/
 * comment lines since OpenCodeAdapter only needs the JSON payload.
 */
export class SSEBuffer {
  private buf = ''
  constructor(private readonly maxBufferChars = 1024 * 1024) {}

  /** Feed a raw chunk of decoded text; returns any complete JSON events found in it. */
  push(chunk: string): unknown[] {
    this.buf = (this.buf + chunk).replace(/\r\n/g, '\n')
    // Malformed/unterminated upstream records must not retain unbounded text.
    // Authoritative polling recovers any skipped progress record.
    if (this.buf.length > this.maxBufferChars) { this.buf = ''; return [] }
    const events: unknown[] = []
    let idx: number
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const block = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      const dataLines = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
      if (!dataLines.length) continue
      try { events.push(JSON.parse(dataLines.join('\n'))) } catch { /* malformed event, drop it */ }
    }
    return events
  }
}
