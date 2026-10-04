/**
 * Every value a daemon-client contract enum admits has a producer in the
 * server source.
 *
 * A contract enum is a promise to the client about what the server may say.
 * A member nothing here ever writes is a branch of the client's handling, its
 * copy and its tests that no request can reach — it reads as supported and is
 * not, and the client keeps carrying it because nothing marks it dead.
 *
 * The probe is a quoted literal: a producer writes the code as a string, so a
 * member with no literal in non-test server source has no producer. That is
 * deliberately blunt — a literal could sit in a dead branch — but it is the
 * test that fails when a member is declared first and wired never, which is
 * the order contracts get written in.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { productionSourceFiles } from '../shared/test-utils/source-files.js'
import { stripComments } from '../shared/test-utils/strip-comments.js'

const CONTRACTS = fileURLToPath(
  new URL('../../../daemon-client/src/api-contracts', import.meta.url),
)
const PRODUCER_ROOTS = [
  fileURLToPath(new URL('..', import.meta.url)),
  fileURLToPath(new URL('../../../server-core/src', import.meta.url)),
]

const TEST_SOURCE =
  /\.(?:test|property\.test|smoke|conformance|contract|test-helper)(?:\.\w+)*\.tsx?$|\/test-utils\/|\/migrations\//

function sourceFiles(dir: string): string[] {
  return productionSourceFiles(dir, { skipDirs: ['node_modules', 'dist'] }).filter(
    (path) => !TEST_SOURCE.test(path),
  )
}

interface EnumMember {
  readonly file: string
  readonly value: string
}

/** Every string literal of every `z.enum([...])` a contract file declares. */
function enumMembers(file: string, source: string): EnumMember[] {
  const members: EnumMember[] = []
  for (const declaration of stripComments(source).matchAll(/z\s*\.enum\(\s*\[([^\]]*)\]/g)) {
    for (const literal of (declaration[1] ?? '').matchAll(/'([^']+)'/g)) {
      members.push({ file, value: literal[1] as string })
    }
  }
  return members
}

/** The members whose quoted literal appears in none of `sources`. */
function withoutProducer(members: readonly EnumMember[], sources: readonly string[]): EnumMember[] {
  return members.filter(
    ({ value }) => !sources.some((source) => new RegExp(`['"\`]${value}['"\`]`).test(source)),
  )
}

describe('contract enum members have a producer', () => {
  it('finds no member of a daemon-client contract enum that no server source writes', async () => {
    const contractFiles = sourceFiles(CONTRACTS).sort()
    const members = (
      await Promise.all(
        contractFiles.map(async (file) =>
          enumMembers(file.slice(CONTRACTS.length + 1), await readFile(file, 'utf8')),
        ),
      )
    ).flat()
    const sources = await Promise.all(
      PRODUCER_ROOTS.flatMap((root) => sourceFiles(root)).map(async (file) =>
        stripComments(await readFile(file, 'utf8')),
      ),
    )

    // The subject is present: a scan that found nothing would pass as "every
    // member has a producer".
    expect(members.length).toBeGreaterThan(40)
    expect(members.map((m) => m.value)).toEqual(
      expect.arrayContaining(['not_invited', 'requires_person_session']),
    )
    expect(sources.length).toBeGreaterThan(200)

    expect(withoutProducer(members, sources)).toEqual([])
  })

  it('reports a member whose literal appears in no source, and clears one that does', () => {
    const members = enumMembers('x.ts', "z.enum(['produced', 'orphan'])")
    expect(members.map((m) => m.value)).toEqual(['produced', 'orphan'])
    expect(withoutProducer(members, ["return { error: 'produced' }"]).map((m) => m.value)).toEqual([
      'orphan',
    ])
  })

  it('does not read a comment as a producer', () => {
    const members = enumMembers('x.ts', "// z.enum(['commented'])\nz.enum(['real'])")
    expect(members.map((m) => m.value)).toEqual(['real'])
  })
})
