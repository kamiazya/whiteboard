import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The tenant boundary holds because stores are handed a tenant-bound handle
 * (`tenant-database.ts`), and it holds only while nothing reaches the database
 * around it. Three doors lead around it: the unscoped `getRawDb`, Kysely's `withoutPlugins()`, which
 * strips the tenant plugin off a bound handle, and `executeQuery`, which runs
 * a compiled query without passing it to the plugin at all. Each
 * use is listed here with why it needs the whole database, and the list is
 * checked from both sides — a new caller fails, and so does an entry whose
 * file stopped calling it.
 */
const RAW_DATABASE_CALLERS: Record<string, string> = {
  'server/store/db/index.ts': 'defines getRawDb, and binds getDb on top of it',
  'server/store/db/prepare.ts':
    'runs the migrations, which move rows between tables across every tenant',
  'server/store/db/account-retirement.ts':
    'retires a deleted person’s keeper-wide account only when no tenant’s user still names it, which only every tenant together can answer (ADR-0051)',
}

const SRC = join(import.meta.dirname, '../../..')
// `executeQuery` runs a compiled query straight through the executor, so the
// plugin never sees it; a raw `sql` statement on the handle is refused at run
// time instead (`tenant-database.ts`).
const DOORS = /\bgetRawDb\s*\(|\.withoutPlugins\s*\(|\.executeQuery\s*\(/

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
