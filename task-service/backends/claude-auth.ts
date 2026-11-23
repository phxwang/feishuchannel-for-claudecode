/**
 * `claude auth status` probe. Only a positive "logged out" answer counts as
 * invalid credentials; anything we cannot read with confidence (spawn error,
 * timeout, non-JSON output, missing field) is `unknown`, which never makes a
 * task eligible for fallback.
 */

export type AuthState = 'valid' | 'invalid' | 'unknown'
export interface AuthStatus { state: AuthState; detail: string }
export type AuthCheck = () => Promise<AuthStatus>

export const AUTH_STATUS_TIMEOUT_MS = 10_000
const MAX_DETAIL_CHARS = 200

/** Pure: interpret `claude auth status --json` output. */
export function parseClaudeAuthStatus(stdout: string): AuthStatus {
  let doc: unknown
  try { doc = JSON.parse(stdout) } catch { return { state: 'unknown', detail: 'claude auth status did not print JSON' } }
  const loggedIn = (doc as { loggedIn?: unknown } | null)?.loggedIn
  if (loggedIn === false) return { state: 'invalid', detail: 'claude auth status reports loggedIn=false' }
  if (loggedIn === true) return { state: 'valid', detail: 'claude auth status reports loggedIn=true' }
  return { state: 'unknown', detail: 'claude auth status has no boolean loggedIn field' }
}

export function claudeAuthCheck(bin: string, timeoutMs = AUTH_STATUS_TIMEOUT_MS): AuthCheck {
  return async () => {
    try {
      const proc = Bun.spawn([bin, 'auth', 'status', '--json'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
      const timer = setTimeout(() => proc.kill(), timeoutMs)
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]).finally(() => clearTimeout(timer))
      if (proc.signalCode) return { state: 'unknown', detail: `claude auth status was killed (${proc.signalCode}) after ${timeoutMs}ms` }
      const status = parseClaudeAuthStatus(stdout)
      // A logged-out CLI may exit non-zero; trust the JSON, not the exit code. Without JSON, a failure is just unknown.
      return status.state === 'unknown' && code !== 0 ? { state: 'unknown', detail: `${status.detail} (exit ${code})` } : status
    } catch (e) {
      return { state: 'unknown', detail: `claude auth status failed: ${String(e instanceof Error ? e.message : e).slice(0, MAX_DETAIL_CHARS)}` }
    }
  }
}
