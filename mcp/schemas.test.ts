import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { generatedSchemas, SCHEMA_DIR } from '../scripts/gen-task-schemas'

test('committed JSON Schemas match the zod sources (run `bun run schemas` to refresh)', () => {
  for (const [rel, schema] of Object.entries(generatedSchemas())) {
    const path = join(SCHEMA_DIR, rel)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(schema, null, 2) + '\n')
  }
})
