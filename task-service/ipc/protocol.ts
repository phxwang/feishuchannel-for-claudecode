/**
 * Private IPC on task-service/task.sock (design doc §7.3): newline-delimited
 * JSON request/response, the same framing style as router.sock but a
 * separate socket and method table.
 *
 *   → {"id": 1, "method": "tool", "params": {"name": "router_task_get", "arguments": {...}}}
 *   ← {"id": 1, "result": {"envelope": {...}}}
 *   ← {"id": 1, "error": {"message": "..."}}
 */

export const IPC_METHODS = ['ping', 'tool', 'resource.read', 'permission.ask', 'admin.inspect', 'admin.release'] as const
export type IpcMethod = (typeof IPC_METHODS)[number]

export interface IpcRequest { id: number; method: IpcMethod; params: Record<string, unknown> }
export type IpcResponse = { id: number; result: unknown } | { id: number; error: { message: string } }

/** Max single frame. A tool request is ≤1 MiB of arguments; allow envelope overhead. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** Incremental NDJSON splitter with a hard frame limit. */
export class LineBuffer {
  private buf = ''
  overflowed = false

  push(chunk: string): string[] {
    this.buf += chunk
    if (this.buf.length > MAX_FRAME_BYTES) { this.buf = ''; this.overflowed = true; return [] }
    const lines: string[] = []
    let idx: number
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (line.trim()) lines.push(line)
    }
    return lines
  }
}

export function frame(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

/** Parameters of the Claude permission relay call (design doc §11.4). */
export interface PermissionAskParams {
  executionAttemptId: string
  relayToken: string
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

export interface PermissionAskResult {
  behavior: 'allow' | 'deny'
  message?: string
}
