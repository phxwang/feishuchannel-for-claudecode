/** Decodes a base64-encoded `data:` URI. Returns null for anything else (missing
 *  `;base64` marker, malformed) rather than guessing — a plain-text data URI
 *  (e.g. `data:text/plain,Hello`) is valid per spec but not base64, and blindly
 *  passing it to `Buffer.from(..., 'base64')` silently truncates/corrupts it
 *  instead of throwing. */
const DATA_URI_BASE64_RE = /^data:[^,;]*;base64,/

export function decodeBase64DataUri(dataUrl: string): Buffer | null {
  const m = DATA_URI_BASE64_RE.exec(dataUrl)
  if (!m) return null
  return Buffer.from(dataUrl.slice(m[0].length), 'base64')
}
