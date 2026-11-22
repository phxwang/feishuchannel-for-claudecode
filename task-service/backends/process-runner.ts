/**
 * Detached child processes for CLI backends (design doc §11.4). The child
 * runs in its own process group with stdin/stdout/stderr bound to files in
 * the attempt's run directory, so a router restart never breaks its output.
 * A process is only ever signalled when both its PID and its start identity
 * match what was recorded at spawn.
 */
import { spawn, spawnSync } from 'child_process'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface ProcessSpec {
  argv: string[]
  cwd: string
  env: Record<string, string>
  runDir: string
  /** File whose contents become the child's stdin. */
  stdinFile: string
  /** Marker value set as ROUTER_TASK_ATTEMPT in the child environment. */
  attemptId: string
}

export interface SpawnedProcess {
  pid: number
  pgid: number
  processStartIdentity: string
  stdoutPath: string
  stderrPath: string
  exitPath: string
}

export const MARKER_ENV = 'ROUTER_TASK_ATTEMPT'

/** Start time of a PID as reported by ps; stable for the life of the process. */
export function processStartIdentity(pid: number): string | null {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
  const out = (r.stdout ?? '').trim()
  return r.status === 0 && out ? out : null
}

export function isSameProcessAlive(pid: number | null, identity: string | null): boolean {
  if (!pid || !identity) return false
  try { process.kill(pid, 0) } catch { return false }
  return processStartIdentity(pid) === identity
}

/** True if any process in the group is still alive. */
export function groupAlive(pgid: number | null): boolean {
  if (!pgid) return false
  try { process.kill(-pgid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

/** Signal the whole process group, but only if its leader is still the recorded process (or already gone). */
export function signalGroup(pid: number | null, pgid: number | null, identity: string | null, signal: NodeJS.Signals): boolean {
  if (!pgid || !pid) return false
  let leaderAlive = true
  try { process.kill(pid, 0) } catch { leaderAlive = false }
  if (leaderAlive && processStartIdentity(pid) !== identity) return false // PID reused by another process: never touch it
  try { process.kill(-pgid, signal); return true } catch { return false }
}

export function spawnDetached(spec: ProcessSpec): SpawnedProcess {
  const stdoutPath = join(spec.runDir, 'stdout.jsonl')
  const stderrPath = join(spec.runDir, 'stderr.log')
  const exitPath = join(spec.runDir, 'exit.json')
  const stdin = openSync(spec.stdinFile, 'r')
  const out = openSync(stdoutPath, 'a', 0o600)
  const err = openSync(stderrPath, 'a', 0o600)
  try {
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: { ...spec.env, [MARKER_ENV]: spec.attemptId },
      detached: true,
      stdio: [stdin, out, err],
    })
    // Attach before anything can throw: an unhandled spawn 'error' (e.g. ENOENT) would crash the router.
    child.on('error', () => {
      try { writeFileSync(exitPath, JSON.stringify({ code: null, signal: null, spawnError: true, at: Date.now() }), { mode: 0o600 }) } catch { /* ignore */ }
    })
    child.on('exit', (code, signal) => {
      try { writeFileSync(exitPath, JSON.stringify({ code, signal, at: Date.now() }), { mode: 0o600 }) } catch { /* run dir gone */ }
    })
    if (!child.pid) throw new Error(`failed to spawn ${spec.argv[0]}`)
    const pid = child.pid
    child.unref()
    const identity = startIdentityWithRetry(pid)
    if (!identity) {
      // Without a start identity the process could never be signalled or verified released; do not own it.
      try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
      throw new Error(`could not read the start identity of pid ${pid}`)
    }
    return { pid, pgid: pid, processStartIdentity: identity, stdoutPath, stderrPath, exitPath }
  } finally {
    closeSync(stdin); closeSync(out); closeSync(err)
  }
}

function startIdentityWithRetry(pid: number, attempts = 3): string | null {
  for (let i = 0; i < attempts; i++) {
    const id = processStartIdentity(pid)
    if (id) return id
    Bun.sleepSync(20)
  }
  return null
}

export function readExit(exitPath: string): { code: number | null; signal: string | null; spawnError?: boolean } | null {
  try { return JSON.parse(readFileSync(exitPath, 'utf8')) } catch { return null }
}

/** Processes (any state) whose environment carries this attempt's marker. Best effort; used only for crash recovery. */
export function findByMarker(attemptId: string): number[] {
  const r = spawnSync('ps', ['-E', '-x', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (r.status !== 0) return []
  const needle = `${MARKER_ENV}=${attemptId}`
  return (r.stdout ?? '').split('\n').filter(l => l.includes(needle)).map(l => Number(l.trim().split(/\s+/)[0])).filter(n => n > 0)
}

/**
 * Tail a growing file line by line starting at `offset`. Ends when `finished()`
 * returns true and the file is drained, or when the signal aborts.
 */
export async function* tailLines(path: string, offset: number, finished: () => boolean, signal: AbortSignal, pollMs = 100): AsyncGenerator<{ line: string; nextOffset: number }> {
  let pos = offset
  // Bytes are split into lines before decoding, so a multi-byte character that
  // straddles a read boundary (or is only half written yet) is never corrupted.
  let carry: Buffer = Buffer.alloc(0)
  const chunk = Buffer.alloc(64 * 1024)
  while (!signal.aborted) {
    // One chunk per pass keeps memory bounded when replaying a large file.
    const n = readChunk(path, pos, chunk)
    const readAny = n > 0
    const lines: { line: string; nextOffset: number }[] = []
    if (readAny) {
      pos += n
      carry = Buffer.concat([carry, chunk.subarray(0, n)])
      let idx: number
      while ((idx = carry.indexOf(0x0a)) !== -1) {
        const line = carry.subarray(0, idx).toString('utf8')
        carry = carry.subarray(idx + 1)
        if (line.trim()) lines.push({ line, nextOffset: pos - carry.length })
      }
    }
    for (const l of lines) { if (signal.aborted) return; yield l }
    if (!readAny && finished()) {
      // Final drain check: nothing new since the process ended.
      if (!existsSync(path) || statSync(path).size <= pos) {
        const rest = carry.toString('utf8')
        if (rest.trim()) yield { line: rest, nextOffset: pos }
        return
      }
      continue
    }
    if (!readAny) await new Promise(r => setTimeout(r, pollMs))
  }
}

/** Read up to one buffer of `path` at `pos`; 0 when the file is missing or has nothing new. */
function readChunk(path: string, pos: number, buf: Buffer): number {
  if (!existsSync(path)) return 0
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (pos >= size) return 0
    return Math.max(0, readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos))
  } finally { closeSync(fd) }
}

/** Wait until the process group is gone, up to `timeoutMs`. */
export async function waitGroupExit(pgid: number | null, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (!groupAlive(pgid)) return true
    await new Promise(r => setTimeout(r, 50))
  }
  return !groupAlive(pgid)
}

/**
 * Stop and verify (design doc §9.10): SIGINT, grace, SIGKILL, then confirm no
 * process in the group remains.
 */
export async function stopGroup(pid: number | null, pgid: number | null, identity: string | null, graceMs: number): Promise<{ released: boolean; detail: string }> {
  if (!pgid) return { released: true, detail: 'no process was started' }
  if (!groupAlive(pgid)) return { released: true, detail: 'process group already exited' }
  if (!signalGroup(pid, pgid, identity, 'SIGINT')) {
    if (!groupAlive(pgid)) return { released: true, detail: 'process group already exited' }
    return { released: false, detail: 'process identity mismatch; refusing to signal' }
  }
  if (await waitGroupExit(pgid, graceMs)) return { released: true, detail: 'exited after SIGINT' }
  signalGroup(pid, pgid, identity, 'SIGKILL')
  if (await waitGroupExit(pgid, 3000)) return { released: true, detail: 'killed after grace period' }
  return { released: false, detail: 'process group still alive after SIGKILL' }
}
