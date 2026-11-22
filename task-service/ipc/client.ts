/**
 * Client for task.sock, used by the MCP facade, the admin CLI and the Claude
 * permission relay. Lazily connects, multiplexes requests by id, and fails
 * every pending request when the connection drops.
 */
import { connect, type Socket } from 'net'
import { frame, LineBuffer, type IpcMethod } from './protocol'

export class IpcUnavailableError extends Error {}
export class IpcTimeoutError extends Error {}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class IpcClient {
  private socket: Socket | null = null
  private connecting: Promise<Socket> | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1

  constructor(private socketPath: string) {}

  private connect(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket)
    if (this.connecting) return this.connecting
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const s = connect(this.socketPath)
      const lines = new LineBuffer()
      s.setEncoding('utf8')
      s.once('connect', () => { this.socket = s; this.connecting = null; resolve(s) })
      s.on('data', (chunk: string) => {
        for (const line of lines.push(chunk)) {
          let msg: any
          try { msg = JSON.parse(line) } catch { continue }
          const p = this.pending.get(msg.id)
          if (!p) continue
          this.pending.delete(msg.id)
          clearTimeout(p.timer)
          if (msg.error) p.reject(new Error(String(msg.error.message ?? 'request failed')))
          else p.resolve(msg.result)
        }
      })
      const fail = (e?: Error) => {
        if (this.connecting) { this.connecting = null; reject(new IpcUnavailableError(e?.message ?? 'task service unavailable')) }
        if (this.socket === s) this.socket = null
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new IpcUnavailableError('connection to the task service closed')); this.pending.delete(id) }
      }
      s.once('error', fail)
      s.once('close', () => fail())
    })
    return this.connecting
  }

  async request(method: IpcMethod, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const socket = await this.connect()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new IpcTimeoutError(`task service did not answer within ${timeoutMs} ms`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      socket.write(frame({ id, method, params }))
    })
  }

  /** Abandon one request locally (MCP request cancellation). The service is not told to cancel anything. */
  close(): void {
    this.socket?.destroy()
    this.socket = null
  }
}
