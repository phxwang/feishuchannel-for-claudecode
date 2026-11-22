/**
 * Socket server for task.sock. Owns no state: every request goes to the
 * TaskService. A client disconnect only ends that transport (design doc §5.2).
 */
import { chmodSync, existsSync, lstatSync, unlinkSync } from 'fs'
import { createServer, type Server, type Socket } from 'net'
import type { TaskService } from '../core/service'
import { frame, LineBuffer, type IpcRequest } from './protocol'

export interface IpcServerOptions {
  socketPath: string
  service: TaskService
  log: (msg: string) => void
}

export class IpcServer {
  private server: Server | null = null
  private sockets = new Set<Socket>()

  constructor(private o: IpcServerOptions) {}

  get connectionCount(): number { return this.sockets.size }

  listen(): Promise<void> {
    const path = this.o.socketPath
    if (Buffer.byteLength(path, 'utf8') > 103) throw new Error(`socket path is too long for a Unix socket (${path.length} > 103): ${path}`)
    if (existsSync(path)) {
      const st = lstatSync(path)
      if (!st.isSocket()) throw new Error(`${path} exists and is not a socket; refusing to replace it`)
      unlinkSync(path)
    }
    this.server = createServer(socket => this.onConnection(socket))
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(path, () => {
        try { chmodSync(path, 0o600) } catch (e) { reject(e); return }
        resolve()
      })
    })
  }

  close(): void {
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
    this.server?.close()
    this.server = null
    try { if (existsSync(this.o.socketPath) && lstatSync(this.o.socketPath).isSocket()) unlinkSync(this.o.socketPath) } catch { /* ignore */ }
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket)
    const lines = new LineBuffer()
    const inflight = new AbortController()
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) void this.handle(socket, line, inflight.signal)
      if (lines.overflowed) { socket.destroy(); }
    })
    const done = () => { inflight.abort(); this.sockets.delete(socket) }
    socket.on('close', done)
    socket.on('error', done)
  }

  private async handle(socket: Socket, line: string, signal: AbortSignal): Promise<void> {
    let req: IpcRequest
    try { req = JSON.parse(line) } catch { return }
    const reply = (body: Record<string, unknown>) => { if (!socket.destroyed) socket.write(frame({ id: req.id, ...body })) }
    try {
      reply({ result: await this.dispatch(req, signal) })
    } catch (e) {
      this.o.log(`task-service ipc: ${req.method} failed: ${e instanceof Error ? e.message : String(e)}`)
      reply({ error: { message: e instanceof Error ? e.message : 'request failed' } })
    }
  }

  private async dispatch(req: IpcRequest, signal: AbortSignal): Promise<unknown> {
    const p = req.params ?? {}
    const svc = this.o.service
    switch (req.method) {
      case 'ping': return { ok: true }
      case 'tool': return { envelope: await svc.call(String(p.name), p.arguments ?? {}) }
      case 'resource.read': {
        const r = svc.readResource(String(p.uri))
        if (r.kind === 'ok') return { resource: r.data }
        return { resourceError: r }
      }
      case 'admin.inspect': return svc.adminInspect(String(p.taskId))
      case 'admin.release': return svc.adminRelease(String(p.taskId), String(p.note ?? ''))
      default: throw new Error(`unknown method ${String(req.method)}`)
    }
  }
}
