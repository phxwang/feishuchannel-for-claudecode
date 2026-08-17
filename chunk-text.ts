/** Feishu rejects (or truncates) messages over roughly this many characters. */
export const MAX_CHUNK = 4096

/** Split text into chunks under `limit`, preferring paragraph/line/word boundaries over a hard cut. */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []; let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit), line = rest.lastIndexOf('\n', limit), space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
