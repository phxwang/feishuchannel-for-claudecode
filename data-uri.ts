/**
 * Decodes a base64-encoded `data:` URI, e.g. `data:image/png;base64,iVBOR...`
 * or with extra params before the marker, e.g. `data:image/png;name=x.png;base64,...`.
 *
 * Rejects (returns `{ok:false}`) rather than guessing when:
 *  - there's no `;base64` marker right before the comma — a data URI can
 *    legally carry plain (non-base64) data instead (e.g. `data:text/plain,Hello`),
 *    and blindly passing that to `Buffer.from(str, 'base64')` silently
 *    truncates/corrupts it instead of throwing.
 *  - `maxBytes` is given and the encoded data would decode past it — checked
 *    from the base64 string's own length, so an oversized payload is rejected
 *    without paying for the decode/allocation first.
 */
const HEADER_RE = /^data:([^,]*),/

export type DecodedDataUri =
  | { ok: true; buf: Buffer }
  | { ok: false; reason: 'not_base64' | 'too_large' }

export function decodeBase64DataUri(dataUrl: string, maxBytes?: number): DecodedDataUri {
  const m = HEADER_RE.exec(dataUrl)
  if (!m || !/;base64$/i.test(m[1])) return { ok: false, reason: 'not_base64' }

  const encoded = dataUrl.slice(m[0].length)
  if (maxBytes !== undefined) {
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
    const estimatedBytes = Math.floor((encoded.length / 4) * 3) - padding
    if (estimatedBytes > maxBytes) return { ok: false, reason: 'too_large' }
  }
  return { ok: true, buf: Buffer.from(encoded, 'base64') }
}
