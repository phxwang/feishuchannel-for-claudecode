import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

export type ProcessAlive = (pid: number) => boolean

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Atomically claim router ownership. Stale locks are removed and retried once. */
export function acquireRouterLock(
  lockDir: string,
  pid = process.pid,
  processAlive: ProcessAlive = defaultProcessAlive,
): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'pid'), `${pid}\n`, { mode: 0o600 })
      return true
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
      let owner = 0
      try { owner = Number(readFileSync(join(lockDir, 'pid'), 'utf8').trim()) } catch {}
      if (owner > 0 && processAlive(owner)) return false
      try { rmSync(lockDir, { recursive: true, force: true }) } catch {}
    }
  }
  return false
}

export function releaseRouterLock(lockDir: string): void {
  try { rmSync(lockDir, { recursive: true, force: true }) } catch {}
}
