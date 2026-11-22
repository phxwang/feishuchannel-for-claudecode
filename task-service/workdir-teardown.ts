/**
 * Router-side teardown of a temporary workdir's agents once its last task is
 * CLOSED (see workdir-release.ts). Mapped workdirs are never touched.
 *   - tmux CLIs (Claude, agy, Codex): kill the workdir's session and forget its
 *     conversation id, so the next task there starts fresh.
 *   - OpenCode: only release the router's workdir binding; the OpenCode
 *     session itself is kept (owner decision 2026-11-22: "just release session").
 * A session that is busy again (a new turn raced the close) is left alone.
 */
import type { TmuxCliManager } from '../tmux/manager'
import { isMappedWorkdir } from './workdir-release'

export interface WorkdirTeardownDeps {
  /** Read fresh on every call: access.json can change while the router runs. */
  configuredWorkdirs: () => readonly (string | undefined | null)[]
  tmuxManagers: readonly TmuxCliManager[]
  releaseOpenCodeBinding?: (canonicalWorkdir: string) => void
  log: (msg: string) => void
}

export type TeardownResult = 'mapped' | 'released'

export async function teardownTaskScopedWorkdir(workdir: string, d: WorkdirTeardownDeps): Promise<TeardownResult> {
  if (isMappedWorkdir(workdir, d.configuredWorkdirs())) return 'mapped'
  for (const m of d.tmuxManagers) {
    const label = m.profile.kind
    if (m.isBusy(workdir)) { d.log(`task-service: ${label} session for ${workdir} is busy again; not tearing it down`); continue }
    try {
      await m.killSession(workdir, { forget: true })
    } catch (e) {
      d.log(`task-service: killing the ${label} session for ${workdir} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  try { d.releaseOpenCodeBinding?.(workdir) } catch (e) {
    d.log(`task-service: releasing the OpenCode binding for ${workdir} failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  d.log(`task-service: last task on temporary workdir ${workdir} closed; its agent sessions were released`)
  return 'released'
}
