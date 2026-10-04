import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { productionSourceFiles } from './source-files.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tree(files: readonly string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-source-files-')))
  scratch.push(root)
  for (const file of files) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return root
}

function found(root: string, options?: Parameters<typeof productionSourceFiles>[1]): string[] {
  return productionSourceFiles(root, options)
    .map((path) => relative(root, path).replaceAll('\\', '/'))
    .sort()
}

describe('productionSourceFiles', () => {
  it('takes .ts and .tsx at any depth and leaves everything that is not source', () => {
    const root = tree(['a.ts', 'deep/er/b.tsx', 'c.json', 'd.md', 'e.mjs'])
    expect(found(root)).toEqual(['a.ts', 'deep/er/b.tsx'])
  })

  it('leaves out a test file under every spelling that carries `.test.`', () => {
    const root = tree(['a.ts', 'a.test.ts', 'a.property.test.ts', 'b.test.tsx', 'c.test.helper.ts'])
    expect(found(root)).toEqual(['a.ts'])
  })

  it('leaves out a harness a test imports and a smoke driver', () => {
    const root = tree([
      'a.ts',
      '_test-harness.ts',
      'mcp/startup.smoke-impl.ts',
      'sub/_test-x.ts',
      'db/test-helpers.ts',
    ])
    expect(found(root)).toEqual(['a.ts'])
  })

  it('does not descend into a skipped directory name, at any depth', () => {
    const root = tree(['a.ts', 'migrations/0001.ts', 'x/migrations/0002.ts', 'x/keep.ts'])
    expect(found(root, { skipDirs: ['migrations'] })).toEqual(['a.ts', 'x/keep.ts'])
  })

  it('takes the extensions it is asked for in place of the default', () => {
    const root = tree(['a.ts', 'b.mjs', 'c.js', 'd.test.mjs'])
    expect(found(root, { extensions: ['.ts', '.mjs', '.js'] })).toEqual(['a.ts', 'b.mjs', 'c.js'])
  })
})

// The guards that ask what production code does walk through the one helper. A
// walker of their own is how nine of them came to disagree on what a test file
// is, so this fails on one growing back.
describe('the guards that walk production sources', () => {
  const SERVER = join(import.meta.dirname, '../../server')
  const GUARDS = [
    'background-work.guard.test.ts',
    'backup-secret-surface.test.ts',
    'contract-enum-producers.test.ts',
    'env-docs-contract.test.ts',
    'persisted-json-surface.test.ts',
    'release/web-api-paths-mounted.test.ts',
    'routes/error-body-shape.test.ts',
    'store/db/raw-database-callers.test.ts',
    'store/default-backup-cron.test.ts',
    'tenant/data-layout-callers.test.ts',
  ]
  // env-docs walks the docs tree too, which is not a source directory.
  const OWN_WALKER_ALLOWED = new Set(['env-docs-contract.test.ts'])

  it.each(GUARDS)('%s calls productionSourceFiles and writes no walker of its own', (guard) => {
    const source = readFileSync(join(SERVER, guard), 'utf8')
    expect(source).toMatch(/\bproductionSourceFiles\(/)
    if (!OWN_WALKER_ALLOWED.has(guard)) expect(source).not.toContain('withFileTypes')
  })
})
