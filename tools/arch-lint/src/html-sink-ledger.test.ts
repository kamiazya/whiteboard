/**
 * Every place the source parses a string as markup into the live document is
 * named here, with why that string is safe.
 *
 * The scene's SVG reaches the DOM as markup because the editor and the viewer
 * swap or patch a rendered drawing rather than rebuilding elements. That is
 * sound only while canvas-render's serializer is the sole producer of the
 * string, and the argument for it lived in seven separate comments with
 * nothing holding any of them. It now lives once, in canvas-viewer's
 * `SceneSvg`, and this ledger is what makes an eighth spelling fail until
 * someone says why it is different.
 *
 * Counted per file and per kind, not merely listed: membership alone would
 * let an allowlisted file add a second sink that nobody classified. Guarded
 * from both sides, so an entry for a sink that has since gone fails too.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { htmlSinks, type SinkEntry, sinkLedgerViolations } from './html-sink-scan.js'
import { isExcludedPath, REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

const LEDGER: Readonly<Record<string, SinkEntry>> = {
  'packages/canvas-viewer/src/SceneSvg.tsx': {
    sinks: { dangerouslySetInnerHTML: 1 },
    reason:
      'the one component that injects canvas-render serializer output as markup; every React caller of a scene string goes through it',
  },
  'apps/web/src/lib/keyed-svg-patcher.ts': {
    sinks: { 'innerHTML =': 2 },
    reason:
      "mount-once keyed patching writes the keyed projection's own group strings, which are the serializer's bytes; it decides only which groups to replace, so it cannot go through a component",
  },
  'apps/web/src/components/markdown-editor/shortcode-completion.ts': {
    sinks: { 'innerHTML =': 1 },
    reason:
      "one icon glyph for a CodeMirror completion row, drawn by renderSceneToSvg itself; CodeMirror's DOM is not React, so the component is not available",
  },
}

/** `apps/*` and `packages/*` source; tools are not shipped code. */
const ROOTS = SCAN_ROOTS.filter((root) => !root.startsWith('tools/'))

const found = new Map<string, string[]>()
const scanned: string[] = []
for (const root of ROOTS) {
  for (const path of walkSourceFiles(join(REPO_ROOT, root))) {
    if (isExcludedPath(path) || !isShippedPath(path)) continue
    const source = readFileSync(path, 'utf8')
    scanned.push(path)
    // Every spelling this scan reads contains one of these, so a file without
    // one is not parsed.
    if (
      !/innerhtml|outerhtml|insertadjacenthtml|sethtmlunsafe|createcontextualfragment/i.test(source)
    ) {
      continue
    }
    const sinks = htmlSinks(path, source)
    if (sinks.length > 0) found.set(relativeToRepo(path), sinks)
  }
}

describe('markup sinks are classified', () => {
  it('recognises each spelling of a sink and passes prose and reads through', () => {
    const cases: readonly { source: string; sinks: string[] }[] = [
      {
        source: '<div dangerouslySetInnerHTML={{ __html: svg }} />',
        sinks: ['dangerouslySetInnerHTML'],
      },
      {
        source: "createElement('div', { dangerouslySetInnerHTML: { __html: svg } })",
        sinks: ['dangerouslySetInnerHTML'],
      },
      { source: 'h(props, { dangerouslySetInnerHTML })', sinks: ['dangerouslySetInnerHTML'] },
      { source: 'host.innerHTML = svg', sinks: ['innerHTML ='] },
      { source: 'host.innerHTML += svg', sinks: ['innerHTML ='] },
      { source: "host['innerHTML'] = svg", sinks: ['innerHTML ='] },
      { source: 'host.outerHTML = svg', sinks: ['outerHTML ='] },
      { source: "host.insertAdjacentHTML('beforeend', svg)", sinks: ['insertAdjacentHTML()'] },
      { source: 'host.setHTMLUnsafe(svg)', sinks: ['setHTMLUnsafe()'] },
      { source: 'range.createContextualFragment(svg)', sinks: ['createContextualFragment()'] },
      { source: 'a.innerHTML = x\nb.innerHTML = y', sinks: ['innerHTML =', 'innerHTML ='] },
      { source: 'const html = host.innerHTML', sinks: [] },
      { source: 'if (host.innerHTML === svg) {}', sinks: [] },
      { source: '// dangerouslySetInnerHTML is sound because\nconst x = 1', sinks: [] },
      { source: "const s = 'host.innerHTML = svg'", sinks: [] },
      { source: 'host.textContent = text', sinks: [] },
    ]
    for (const { source, sinks } of cases) {
      expect(htmlSinks('fixture.tsx', source), source).toEqual(sinks)
    }
  })

  it('reports a sink planted outside the ledger, a miscount, and a stale entry', () => {
    const ledger = {
      'a.ts': { sinks: { 'innerHTML =': 1 }, reason: 'x' },
      'gone.ts': { sinks: { 'innerHTML =': 1 }, reason: 'x' },
    }
    const planted = new Map<string, string[]>([
      ['a.ts', ['innerHTML =', 'innerHTML =']],
      ['b.tsx', ['dangerouslySetInnerHTML']],
    ])
    expect(sinkLedgerViolations(planted, ledger)).toEqual([
      'a.ts: ledger says {"innerHTML =":1}, source has {"innerHTML =":2}',
      'b.tsx: unclassified {"dangerouslySetInnerHTML":1}',
      'gone.ts: ledgered but has no sink',
    ])
    expect(
      sinkLedgerViolations(new Map([['a.ts', ['innerHTML =']]]), { 'a.ts': ledger['a.ts'] }),
    ).toEqual([])
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every ledger.
    expect(scanned.length).toBeGreaterThan(1000)
  })

  it('every sink in shipped source is in the ledger, as many times as it claims', () => {
    expect(sinkLedgerViolations(found, LEDGER)).toEqual([])
    // Parses every shipped file that names a sink, which a loaded machine stretches past the default.
  }, 180_000)

  it('every ledger entry names a file that exists and says why in a sentence', () => {
    for (const [rel, entry] of Object.entries(LEDGER)) {
      expect(() => readFileSync(join(REPO_ROOT, rel)), `${rel} is gone`).not.toThrow()
      expect(
        entry.reason.split(/\s+/).length,
        `${rel}'s reason is too short to be one`,
      ).toBeGreaterThan(8)
    }
  })
})
