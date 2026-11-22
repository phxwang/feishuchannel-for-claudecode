#!/usr/bin/env bun
/**
 * Writes the published JSON Schemas (design doc §7.2) to schemas/router-task/.
 *   bun scripts/gen-task-schemas.ts          # write
 *   bun scripts/gen-task-schemas.ts --check  # exit 1 if committed files are stale
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { EVENT_SCHEMA, jsonSchema, publishedTools, SNAPSHOT_SCHEMA } from '../mcp/tool-defs'

export function generatedSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const t of publishedTools()) {
    out[`tools/${t.name}.input.json`] = t.inputSchema
    out[`tools/${t.name}.output.json`] = t.outputSchema
  }
  out['event.json'] = jsonSchema(EVENT_SCHEMA)
  out['task-snapshot.json'] = jsonSchema(SNAPSHOT_SCHEMA)
  out['tools.json'] = publishedTools().map(({ name, title, description, annotations }) => ({ name, title, description, annotations }))
  return out
}

export const SCHEMA_DIR = join(import.meta.dir, '..', 'schemas', 'router-task')

if (import.meta.main) {
  const check = process.argv.includes('--check')
  let stale = 0
  for (const [rel, schema] of Object.entries(generatedSchemas())) {
    const path = join(SCHEMA_DIR, rel)
    const text = JSON.stringify(schema, null, 2) + '\n'
    if (check) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== text) { process.stderr.write(`stale: ${rel}\n`); stale++ }
      continue
    }
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  if (check && stale) process.exit(1)
}
