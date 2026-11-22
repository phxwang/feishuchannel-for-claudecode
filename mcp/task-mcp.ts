#!/usr/bin/env bun
/**
 * stdio entry point for the router-task MCP server (design doc §7.4).
 *   bun mcp/task-mcp.ts --stdio [--service-socket <path>]
 * stdout carries JSON-RPC only; diagnostics go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { lstatSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { createFacade } from './server'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function defaultSocket(): string {
  const stateDir = process.env.FEISHU_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'feishu')
  return join(stateDir, 'task-service', 'task.sock')
}

/** Refuse a socket whose parent is not a private directory owned by us (design doc §5.1). */
function checkSocketParent(socketPath: string): string | null {
  try {
    const st = lstatSync(dirname(socketPath))
    if (!st.isDirectory() || st.isSymbolicLink()) return 'socket parent is not a directory'
    if (st.uid !== process.getuid?.()) return 'socket parent is not owned by the current user'
    if ((st.mode & 0o077) !== 0) return 'socket parent must have mode 0700'
    return null
  } catch {
    return null // not created yet: the service is down; tool calls will report SERVICE_UNAVAILABLE
  }
}

function packageVersion(): string {
  try { return JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')).version ?? '0.0.0' } catch { return '0.0.0' }
}

const socketPath = argValue('--service-socket') ?? defaultSocket()
const problem = checkSocketParent(socketPath)
if (problem) {
  process.stderr.write(`router-task: refusing socket ${socketPath}: ${problem}\n`)
  process.exit(1)
}

const server = createFacade({ socketPath, version: packageVersion(), log: m => process.stderr.write(`${m}\n`) })
await server.connect(new StdioServerTransport())
