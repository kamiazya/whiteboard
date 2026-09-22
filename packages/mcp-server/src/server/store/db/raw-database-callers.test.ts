import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The tenant boundary holds because stores are handed a tenant-bound handle
 * (`tenant-database.ts`), and it holds only while nothing reaches the database
 * around it. Two doors lead around it: the unscoped `getRawDb`, and Kysely's
 * `withoutPlugins()`, which strips the tenant plugin off a bound handle. Each
 * use is listed here with why it needs the whole database, and the list is
 * checked from both sides — a new caller fails, and so does an entry whose
 * file stopped calling it.
 */
const RAW_DATABASE_CALLERS: Record<string, string> = {
  'server/store/db/index.ts': 'defines getRawDb, and binds getDb on top of it',
  'server/store/db/prepare.ts':
    'runs the migrations, which move rows between tables across every tenant',
}

const SRC = join(import.meta.dirname, '../../..')
const DOORS = /\bgetRawDb\s*\(|\.withoutPlugins\s*\(/

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)))
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$|test-helpers\.ts$/.test(entry.name))
      out.push(path)
  }
  return out
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('who may reach the database around the tenant-bound handle', () => {
  it('only the files listed, and each listed file still does', async () => {
    const files = await sourceFiles(SRC)
    expect(files.length).toBeGreaterThan(200)
    const callers: string[] = []
    for (const file of files) {
      if (DOORS.test(withoutComments(await readFile(file, 'utf8')))) {
        callers.push(relative(SRC, file))
      }
    }
    expect(callers.sort()).toEqual(Object.keys(RAW_DATABASE_CALLERS).sort())
  })
})
