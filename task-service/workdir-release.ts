/**
 * Task-scoped agent sessions (temporary workdirs).
 *
 * A workdir chat also routes to (access.json group/default workdirs,
 * agents.yaml projects) is "mapped": its agent session is long-lived and
 * shared, and a task never tears it down. Any other workdir (e.g. a /tmp dir
 * allowed by the dynamic-root policy) is temporary: its agent exists only for
 * the tasks using it, and is released once the LAST of them is CLOSED —
 * not per attempt (a fallback candidate may still reuse it) and not while a
 * concurrent task on the same workdir is still open.
 */
import { realpathSync } from 'fs'
import { isTerminal } from './lifecycle'
import type { TaskRecord } from './model'

/** The workdir the closed task frees, or null if it isn't closed or another open task still uses it. */
export function releasedWorkdir(closed: TaskRecord, open: readonly TaskRecord[]): string | null {
  if (!isTerminal(closed.phase)) return null
  const path = closed.workdir.canonicalPath
  const stillUsed = open.some(t => t.taskId !== closed.taskId && !isTerminal(t.phase) && t.workdir.canonicalPath === path)
  return stillUsed ? null : path
}

function canonical(path: string): string | null {
  try { return realpathSync(path) } catch { return null }
}

/** Whether a task's canonical workdir is one of the configured (long-lived) workdirs. */
export function isMappedWorkdir(canonicalPath: string, configured: readonly (string | undefined | null)[]): boolean {
  return configured.some(p => !!p && (p === canonicalPath || canonical(p) === canonicalPath))
}
