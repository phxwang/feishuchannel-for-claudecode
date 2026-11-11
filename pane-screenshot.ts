/**
 * Renders an ANSI-colored tmux pane capture to a PNG, for the cases
 * claude-tmux-worker.ts can detect a session is stuck on (no transcript
 * growth, no Stop signal) but can't turn into a choice card — a `/status`-
 * style full-screen panel, for instance, whose tabs are plain-text with no
 * numbered options and no textual "currently selected" marker (only color/
 * style, which a card can't convey but an actual screenshot can).
 *
 * Uses whatever Chromium build Playwright already has cached locally rather
 * than requiring an exact-version `playwright install` — this is a small,
 * occasional-use feature, not worth forcing a new browser download just to
 * pin an exact version. macOS-only for now (hardcoded cache layout), same
 * as the rest of this tmux-mode deployment.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import Convert from 'ansi-to-html'

const PLAYWRIGHT_CACHE_DIR = join(homedir(), 'Library', 'Caches', 'ms-playwright')

/** Find any cached Chromium/headless-shell build, preferring the newest. Returns undefined if none is cached. */
function findCachedChromiumExecutable(): string | undefined {
  if (!existsSync(PLAYWRIGHT_CACHE_DIR)) return undefined
  const dirs = readdirSync(PLAYWRIGHT_CACHE_DIR)
    .filter(d => d.startsWith('chromium_headless_shell-') || d.startsWith('chromium-'))
    .sort()
    .reverse()
  for (const dir of dirs) {
    const headlessShell = join(PLAYWRIGHT_CACHE_DIR, dir, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell')
    if (existsSync(headlessShell)) return headlessShell
    const fullChrome = join(PLAYWRIGHT_CACHE_DIR, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
    if (existsSync(fullChrome)) return fullChrome
  }
  return undefined
}

export function buildHtml(ansiText: string): string {
  const convert = new Convert({ fg: '#e5e5e5', bg: '#1e1e1e', newline: false, escapeXML: true, stream: false })
  const body = convert.toHtml(ansiText)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body { background:#1e1e1e; margin:0; padding:16px; }
pre { font-family: 'Menlo','Monaco','SF Mono',monospace; font-size:14px; line-height:1.3; color:#e5e5e5; white-space:pre; margin:0; }
</style></head><body><pre>${body}</pre></body></html>`
}

/**
 * Render an ANSI-colored pane capture to a PNG, returned as a Buffer — the
 * caller writes it to whatever temp file it wants to hand to sendFeishuFile
 * and is responsible for cleaning that up; this function cleans up its own
 * scratch directory completely (not just the files it happens to remember),
 * so a failure partway through never leaks a stray temp dir into /tmp.
 * Returns null if no cached Chromium build is available — callers should
 * treat that as "feature unavailable on this machine" rather than an error
 * worth surfacing to the chat every time.
 */
export async function renderPaneScreenshot(ansiText: string): Promise<Buffer | null> {
  const executablePath = findCachedChromiumExecutable()
  if (!executablePath) return null

  const { chromium } = await import('playwright-core')
  const dir = mkdtempSync(join(tmpdir(), 'feishu-pane-shot-'))
  try {
    const htmlPath = join(dir, 'pane.html')
    const pngPath = join(dir, 'pane.png')
    writeFileSync(htmlPath, buildHtml(ansiText))

    const browser = await chromium.launch({ executablePath })
    try {
      const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } })
      await page.goto(`file://${htmlPath}`)
      await page.screenshot({ path: pngPath, fullPage: true })
    } finally {
      await browser.close()
    }
    return readFileSync(pngPath)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
