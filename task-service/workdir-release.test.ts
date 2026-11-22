import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync } from 'fs'
import { join } from 'path'
import type { TaskRecord } from './model'
import { isMappedWorkdir, releasedWorkdir } from './workdir-release'
import { tempRoot } from './test-helpers'

const task = (taskId: string, path: string, phase = 'ACTIVE') =>
  ({ taskId, phase, workdir: { canonicalPath: path, dev: 1, ino: 1 } }) as unknown as TaskRecord

describe('releasedWorkdir', () => {
  test('a closed task frees its workdir when no other open task uses it', () => {
    expect(releasedWorkdir(task('a', '/tmp/x', 'CLOSED'), [task('b', '/tmp/y')])).toBe('/tmp/x')
  })

  test('another open task on the same workdir keeps it in use', () => {
    expect(releasedWorkdir(task('a', '/tmp/x', 'CLOSED'), [task('b', '/tmp/x')])).toBeNull()
  })

  test('the closed task itself in the open list does not count', () => {
    expect(releasedWorkdir(task('a', '/tmp/x', 'CLOSED'), [task('a', '/tmp/x')])).toBe('/tmp/x')
  })

  test('a task that is not CLOSED frees nothing', () => {
    expect(releasedWorkdir(task('a', '/tmp/x', 'QUIESCENT'), [])).toBeNull()
  })
})

describe('isMappedWorkdir', () => {
  test('matches configured workdirs by canonical path, symlinks included', () => {
    const root = tempRoot('wd-scope-')
    const real = join(root, 'real')
    mkdirSync(real)
    symlinkSync(real, join(root, 'link'))
    const canonical = require('fs').realpathSync(real)
    expect(isMappedWorkdir(canonical, [join(root, 'link')])).toBe(true)
    expect(isMappedWorkdir(canonical, [join(root, 'other')])).toBe(false)
  })

  test('ignores empty and missing configured entries', () => {
    expect(isMappedWorkdir('/tmp/x', [undefined, '', '/definitely/not/here'])).toBe(false)
  })
})
