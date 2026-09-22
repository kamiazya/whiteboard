import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A tenant's bytes are isolated only while every module agrees on where they
 * live, so `data-layout.ts` is the one place that names those directories and
 * everything else asks it. This holds the exceptions, each with why it names a
 * directory of its own, from both sides: a new site fails, and so does an
 * entry whose file stopped naming one.
 */
const NAMES_A_STORE_DIRECTORY: Record<string, string> = {
  'server/store/backup-blob-mirror.ts':
    'the mirror is FLAT and shared by design: a blob path there is its digest, so it carries no tenant',
  'server/backup-restore.ts':
    'reads that flat mirror (its live side goes through data-layout) and lists the mirror store dirs',
}

const SRC = join(import.meta.dirname, '../..')
// A path SEGMENT, which is what a `join` makes it. A bare `'files'` elsewhere
// is a different thing — a log field's name, a category in a response — and
// `data-layout.ts`'s own constants are not literals at a join either.
const NAMES_DIRECTORY = /join\([^)]*['"](?:blobs|files)['"]/

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    // A migration names the layout as it stood at its own point in the log,
    // and the boot move runs after them all (`prepare.ts`).
    if (entry.isDirectory() && entry.name !== 'migrations') out.push(...(await sourceFiles(path)))
    else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
      out.push(path)
  }
  return out
}

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('who may name a store directory', () => {
  it('only the files listed, and each listed file still does', async () => {
    const files = await sourceFiles(SRC)
    expect(files.length).toBeGreaterThan(150)
    const namers: string[] = []
    for (const file of files) {
      if (NAMES_DIRECTORY.test(withoutComments(await readFile(file, 'utf8')))) {
        namers.push(relative(SRC, file))
      }
    }
    expect(namers.sort()).toEqual(Object.keys(NAMES_A_STORE_DIRECTORY).sort())
  })
})
