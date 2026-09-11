// The drawing scoreboard's `fixture/architecture` row is a COPY of the board
// `scripts/eval/fixture.mjs` seeds: canvas-render cannot import this
// package, and the fixture is written as tool calls rather than as a canvas,
// so the corpus restates it. A copy drifts in silence — the scoreboard
// would keep pinning a board the lane no longer draws, and `--dry-run`'s
// `drawing` line would stop matching the pin with nothing saying why. This
// reads both files and holds every box, the group and every edge of the
// fixture's board to the corpus's spelling of it, in both directions.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '../../../scripts/eval/fixture.mjs')
const CORPUS = join(HERE, '../../../../canvas-render/src/test-utils/drawing-corpus.ts')

/** The fixture's `boards/architecture` edit, from its document id to the next board's. */
function fixtureArchitecture(): string {
  const text = readFileSync(FIXTURE, 'utf8')
  const start = text.indexOf("ids['boards/architecture']")
  const end = text.indexOf("ids['boards/roadmap']", start)
  expect(start, 'the fixture seeds boards/architecture').toBeGreaterThan(-1)
  expect(end, 'the fixture seeds boards/roadmap after it').toBeGreaterThan(start)
  return text.slice(start, end)
}

/** The corpus's `fixtureArchitecture` canvas, from its declaration to the next one. */
function corpusArchitecture(): string {
  const text = readFileSync(CORPUS, 'utf8')
  const start = text.indexOf('const fixtureArchitecture')
  const end = text.indexOf('\nconst ', start + 1)
  expect(start, 'the corpus declares fixtureArchitecture').toBeGreaterThan(-1)
  expect(end, 'another declaration follows it').toBeGreaterThan(start)
  return text.slice(start, end)
}

describe('the drawing corpus restates the eval fixture board exactly', () => {
  const fixture = fixtureArchitecture()
  const corpus = corpusArchitecture()

  const boxes = [...fixture.matchAll(/box\('([^']+)', '([^']+)', (\d+), (\d+)\)/g)].map(
    ([, id, text, x, y]) => `box('${id}', '${text}', ${x}, ${y})`,
  )
  const groups = [
    ...fixture.matchAll(
      /id: '([^']+)',\s*type: 'group',\s*label: '([^']+)',\s*x: (\d+),\s*y: (\d+),\s*width: (\d+),\s*height: (\d+)/g,
    ),
  ].map(([, id, label, x, y, w, h]) => `group('${id}', '${label}', ${x}, ${y}, ${w}, ${h})`)
  // Whitespace-tolerant because an endpoint is an OBJECT since ADR-0035
  // slice 3, so the formatter is free to wrap these where it could not wrap
  // two flat keys — and a regex that stops matching reports itself as "the
  // corpus is empty", which the count below is here to contradict.
  const edges = [
    ...fixture.matchAll(
      /edge:\s*\{\s*id: '([^']+)',\s*from:\s*\{\s*kind: 'node',\s*node: '([^']+)',?\s*\},\s*to:\s*\{\s*kind: 'node',\s*node: '([^']+)',?\s*\},\s*label: '([^']+)',?\s*\}/g,
    ),
  ].map(([, id, from, to, label]) => `edge('${id}', '${from}', '${to}', '${label}')`)

  it('reads the fixture board rather than matching nothing', () => {
    // A regex that stopped matching would pass every check below vacuously.
    expect({ boxes: boxes.length, groups: groups.length, edges: edges.length }).toEqual({
      boxes: 6,
      groups: 1,
      edges: 3,
    })
  })

  it.each([...boxes, ...groups, ...edges])('the corpus carries %s', (line) => {
    expect(corpus).toContain(line)
  })

  it('the corpus carries nothing the fixture does not', () => {
    const count = (re: RegExp) => (corpus.match(re) ?? []).length
    expect({ boxes: count(/box\(/g), groups: count(/group\(/g), edges: count(/edge\(/g) }).toEqual({
      boxes: boxes.length,
      groups: groups.length,
      edges: edges.length,
    })
  })
})
