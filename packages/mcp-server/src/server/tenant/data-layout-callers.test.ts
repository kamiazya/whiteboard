import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { productionSourceFiles } from '../../shared/test-utils/source-files.js'
import { stripComments } from '../../shared/test-utils/strip-comments.js'

/**
 * A tenant's bytes are isolated only while every module agrees on where they
 * live, so `data-layout.ts` is the one place that names those directories and
 * everything else asks it. This holds the exceptions, each with why it names a
 * directory of its own, from both sides: a new site fails, and so does an
 * entry whose file stopped naming one.
 */
const NAMES_A_STORE_DIRECTORY: Record<string, string> = {
  // Empty: the backup mirror is flat and shared by design (a blob path there is
  // its digest, so it carries no tenant) and names the same two stores, but
  // through `BLOBS_DIRNAME` / `FILES_DIRNAME`, which data-layout exports.
}

const SRC = join(import.meta.dirname, '../..')
// A path SEGMENT, which is what a `join` makes it. A bare `'files'` elsewhere
// is a different thing — a log field's name, a category in a response — and
// `data-layout.ts`'s own constants are not literals at a join either.
const NAMES_DIRECTORY = /join\([^)]*['"](?:blobs|files)['"]/
// The other way to name one: taking a path apart and comparing a segment, which
// is how a report that sorts bytes by store respelled the layout (`segments[1]
// === 'files'`) without a single join. Indexed or `head` comparisons only —
// `category === 'files'` is a response's own vocabulary, not a path.
const COMPARES_A_SEGMENT =
  /(?:\[\d+\]|\bhead)\s*[!=]==\s*['"](?:tenants|workspaces|blobs|files|exports)['"]/

describe('who may name a store directory', () => {
  it('only the files listed, and each listed file still does', async () => {
    // A migration names the layout as it stood at its own point in the log, and
    // the boot move runs after them all (`prepare.ts`).
    const files = productionSourceFiles(SRC, { skipDirs: ['migrations'], extensions: ['.ts'] })
    expect(files.length).toBeGreaterThan(150)
    const namers: string[] = []
    for (const file of files) {
      const text = stripComments(await readFile(file, 'utf8'))
      if (NAMES_DIRECTORY.test(text) || COMPARES_A_SEGMENT.test(text)) {
        namers.push(relative(SRC, file))
      }
    }
    expect(namers.sort()).toEqual(Object.keys(NAMES_A_STORE_DIRECTORY).sort())
  })
})
