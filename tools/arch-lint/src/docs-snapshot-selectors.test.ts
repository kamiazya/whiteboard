/**
 * A doc-screenshot generator's wait on an `aria-label` selector is satisfied
 * only by shipped source that renders that label.
 *
 * `docs:snapshots` runs in no CI job, so a selector whose producer was
 * deleted does not fail anywhere a contributor looks: the generator simply
 * never finishes in the one place it runs. Reading the selector literals and
 * asking the shipped tree for each label is the part that can be static.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const SNAPSHOT_DIR = 'apps/web/src/docs-snapshots'

/** `[aria-label="x"]`, `[aria-label^='x']`, `[aria-label*=\"x\"]` — the label text of each. */
const ARIA_LABEL_SELECTOR = /\[aria-label[~|^$*]?=\s*\\?["']([^"'\\\]]+)\\?["']\s*\]/g

function ariaLabelSelectorLiterals(source: string): string[] {
  return [...source.matchAll(ARIA_LABEL_SELECTOR)].map((match) => match[1] ?? '')
}

/** Shipped code a label can come from: not a test, a test helper, a bench or the snapshot generators themselves. */
function isLabelProducer(path: string): boolean {
  const rel = relativeToRepo(path)
  return (
    !isTestPath(path) &&
    !rel.startsWith(`${SNAPSHOT_DIR}/`) &&
    !/\.bench\.tsx?$/.test(rel) &&
    !/(?:^|\/)_test-[^/]*$/.test(rel) &&
    !isExcludedPath(path)
  )
}

/** Labels in `selectors` that no producer source carries beside an `aria-label` / `ariaLabel`. */
function unproducedLabels(
  selectors: readonly string[],
  producers: ReadonlyMap<string, string>,
): string[] {
  const labelled = [...producers.values()].filter((text) => /aria-?label/i.test(text))
  return selectors.filter((label) => !labelled.some((text) => text.includes(label)))
}

describe('docs-snapshot aria-label selectors', () => {
  it('reads every quoting of an attribute selector and ignores other selectors', () => {
    expect(
      ariaLabelSelectorLiterals(`
        a.querySelector('[aria-label^="Switch variation"]')
        b.querySelector("[aria-label='Open menu']")
        c.querySelector(\`[aria-label*=\\"Pin\\"]\`)
        d.querySelector('[data-testid="x"]')
      `),
    ).toEqual(['Switch variation', 'Open menu', 'Pin'])
  })

  it('reports a label nothing ships and accepts one a producer renders', () => {
    const producers = new Map([
      ['Menu.tsx', '<button aria-label="Open menu" />'],
      ['Plain.tsx', 'const copy = "Switch variation"'],
    ])
    // The second source carries the words but no aria-label: prose is not a producer.
    expect(unproducedLabels(['Open menu', 'Switch variation'], producers)).toEqual([
      'Switch variation',
    ])
  })

  const generators = walkSourceFiles(join(REPO_ROOT, SNAPSHOT_DIR))
  const producers = new Map(
    SCAN_ROOTS.flatMap((root) => walkSourceFiles(join(REPO_ROOT, root)))
      .filter(isLabelProducer)
      .map((file) => [file, readFileSync(file, 'utf8')] as const),
  )

  it('scans the generators and the shipped tree it checks them against', () => {
    expect(generators.length).toBeGreaterThan(8)
    expect(producers.size).toBeGreaterThan(800)
  })

  it('every aria-label a generator waits for is rendered by shipped source', () => {
    const missing = generators.flatMap((file) =>
      unproducedLabels(ariaLabelSelectorLiterals(readFileSync(file, 'utf8')), producers).map(
        (label) => `${relativeToRepo(file)}: [aria-label …"${label}"]`,
      ),
    )
    expect(missing).toEqual([])
  })
})
