#!/usr/bin/env bun
/**
 * Operator-only CLI for the task service (design doc §10.4). Not exposed
 * through MCP.
 *   bun task-service/admin.ts inspect <taskId>
 *   bun task-service/admin.ts release <taskId> --verified-by "<note>"
 */
import { homedir } from 'os'
import { join } from 'path'
import { IpcClient } from './ipc/client'
import { taskServicePaths } from './index'

const [cmd, taskId] = process.argv.slice(2)
const noteIdx = process.argv.indexOf('--verified-by')
const note = noteIdx >= 0 ? process.argv[noteIdx + 1] : undefined
const stateDir = process.env.FEISHU_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'feishu')
const client = new IpcClient(taskServicePaths(stateDir).socketPath)

function usage(): never {
  process.stderr.write('usage: admin.ts inspect <taskId> | release <taskId> --verified-by "<note>"\n')
  process.exit(2)
}

try {
  if (!taskId) usage()
  if (cmd === 'inspect') {
    process.stdout.write(JSON.stringify(await client.request('admin.inspect', { taskId }, 10_000), null, 2) + '\n')
  } else if (cmd === 'release') {
    if (!note) usage()
    process.stdout.write(JSON.stringify(await client.request('admin.release', { taskId, note }, 10_000)) + '\n')
  } else usage()
} catch (e) {
  process.stderr.write(`admin: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 1
} finally {
  client.close()
}
