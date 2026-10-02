/**
 * Every PNG under `docs/assets/` is a picture of the running UI, written by a
 * `*.docs-snapshot.test.tsx` and shown by a page. An image that nothing
 * generates is a screenshot that can only go stale, and one nothing shows is
 * weight in the repo that reads like documentation: `workspace-list.png` sat
 * in `docs/assets/` with neither.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const ASSETS = join(REPO_ROOT, 'docs/assets')
const SNAPSHOTS = join(REPO_ROOT, 'apps/web/src/docs-snapshots')

function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : filesUnder(path, keep)
    return keep(entry.name) ? [path] : []
  })
}

const pngs = readdirSync(ASSETS).filter((name) => name.endsWith('.png'))

const pages = [
  ...filesUnder(join(REPO_ROOT, 'docs'), (name) => name.endsWith('.md')),
  join(REPO_ROOT, 'README.md'),
].map((path) => ({ rel: relative(REPO_ROOT, path), text: readFileSync(path, 'utf-8') }))

const generators = filesUnder(SNAPSHOTS, (name) => name.endsWith('.docs-snapshot.test.tsx')).map(
  (path) => ({ rel: relative(REPO_ROOT, path), text: readFileSync(path, 'utf-8') }),
)

describe('every PNG in docs/assets is shown by a page and written by a docs snapshot', () => {
  // A scan over nothing passes: the directory holds several images and as many
  // generators, and a count far below that means a path moved.
  it('finds the images and the generators it is meant to hold', () => {
    expect(pngs.length).toBeGreaterThan(5)
    expect(generators.length).toBeGreaterThan(5)
    expect(pages.length).toBeGreaterThan(20)
  })

  it('has a page that shows each image', () => {
    const unshown = pngs.filter((png) => !pages.some((page) => page.text.includes(`assets/${png}`)))
    expect(unshown).toEqual([])
  })

  it('has a docs-snapshot test that writes each image', () => {
    const ungenerated = pngs.filter((png) => !generators.some((test) => test.text.includes(png)))
    expect(ungenerated).toEqual([])
  })
})
