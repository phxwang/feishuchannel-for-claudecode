/**
 * The service-side half of a facade request ('tool', 'resource.read'), shared
 * by the task.sock server and the in-process HTTP MCP server. Admin methods
 * stay socket-only (see IpcServer) and are never reachable through MCP.
 */
import type { TaskService } from '../core/service'

export type FacadeMethod = 'tool' | 'resource.read'

export async function dispatchFacadeRequest(svc: TaskService, method: FacadeMethod, p: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'tool': return { envelope: await svc.call(String(p.name), (p.arguments ?? {}) as Record<string, unknown>) }
    case 'resource.read': {
      const r = svc.readResource(String(p.uri))
      if (r.kind === 'ok') return { resource: r.data }
      return { resourceError: r }
    }
  }
}
