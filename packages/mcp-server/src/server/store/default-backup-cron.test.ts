// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BACKUP_CRON, parseBackupSchedule } from './storage-env.js'

const SERVER_ROOT = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [full] : []
  })
}

describe('the default backup schedule', () => {
  it('is what an unset WHITEBOARD_BACKUP_CRON parses to', () => {
    expect(parseBackupSchedule({})).toMatchObject({
      ok: true,
      value: { expression: DEFAULT_BACKUP_CRON },
    })
  })

  // Three copies of the literal drifted apart in no test, because each
  // consumer (the parser, the scheduler's own fallback, the status report)
  // read it independently. The count pins the other side too: a deleted
  // constant leaves zero holders, which would pass a "nowhere else" check.
  it('is written out in exactly one source file', () => {
    const holders = sourceFiles(SERVER_ROOT).filter((file) =>
      readFileSync(file, 'utf8').includes(`'${DEFAULT_BACKUP_CRON}'`),
    )
    expect(holders.map((file) => file.slice(SERVER_ROOT.length + 1))).toEqual([
      join('store', 'storage-env.ts'),
    ])
  })
})
