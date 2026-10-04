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
import {
  htmlSinks,
  mayHoldHtmlSink,
  type SinkEntry,
  sinkLedgerViolations,
} from './html-sink-scan.js'
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
    if (!mayHoldHtmlSink(source)) continue
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

  it('recognises the spellings that reach a sink by another route', () => {
    const cases: readonly { source: string; sinks: string[] }[] = [
      { source: 'frame.srcdoc = svg', sinks: ['srcdoc ='] },
      { source: "frame['srcdoc'] = svg", sinks: ['srcdoc ='] },
      { source: "frame.setAttribute('srcdoc', svg)", sinks: ['setAttribute(srcdoc)'] },
      { source: "document.write('<p>')", sinks: ['document.write()'] },
      { source: 'document.writeln(svg)', sinks: ['document.writeln()'] },
      { source: 'frame.contentDocument.write(svg)', sinks: ['document.write()'] },
      { source: 'node.ownerDocument?.write(svg)', sinks: ['document.write()'] },
      { source: 'Object.assign(host, { innerHTML: svg })', sinks: ['Object.assign(innerHTML)'] },
      { source: 'Object.assign(host, { innerHTML })', sinks: ['Object.assign(innerHTML)'] },
      {
        source: 'Object.assign(host, ({ innerHTML: svg }) as Props)',
        sinks: ['Object.assign(innerHTML)'],
      },
      { source: 'Object.assign({ innerHTML: svg }, host)', sinks: [] },
      { source: '(document as Document).write(svg)', sinks: ['document.write()'] },
      {
        source: "Object.assign(host, base, { 'outerHTML': svg })",
        sinks: ['Object.assign(outerHTML)'],
      },
      { source: 'Object.assign(frame, { srcdoc: svg })', sinks: ['Object.assign(srcdoc)'] },
      { source: "Reflect.set(host, 'innerHTML', svg)", sinks: ['Reflect.set(innerHTML)'] },
      { source: "host['insertAdjacentHTML']('beforeend', svg)", sinks: ['insertAdjacentHTML()'] },
      { source: "host?.['setHTMLUnsafe'](svg)", sinks: ['setHTMLUnsafe()'] },
      { source: '(host.insertAdjacentHTML as Fn)(pos, svg)', sinks: ['insertAdjacentHTML()'] },
      {
        source: "h('div', { ['dangerouslySetInnerHTML']: { __html: svg } })",
        sinks: ['dangerouslySetInnerHTML'],
      },
      { source: 'h({ [`dangerouslySetInnerHTML`]: html })', sinks: ['dangerouslySetInnerHTML'] },
      // Reads, other attributes, other writers and other objects are not markup parses.
      { source: 'const doc = frame.srcdoc', sinks: [] },
      { source: "frame.setAttribute('title', svg)", sinks: [] },
      { source: 'stream.write(chunk)', sinks: [] },
      { source: 'Object.assign(host, { textContent: svg })', sinks: [] },
      { source: "Reflect.set(host, 'textContent', svg)", sinks: [] },
      // Only `Reflect.set` writes its second argument as a property name.
      { source: "cache.set(host, 'innerHTML', svg)", sinks: [] },
      { source: "host['classList']('x')", sinks: [] },
      { source: 'h({ [key]: { __html: svg } })', sinks: [] },
    ]
    for (const { source, sinks } of cases) {
      expect(htmlSinks('fixture.tsx', source), source).toEqual(sinks)
    }
  })

  it('reads a file as a possible sink whenever it spells one of the scan names, whatever the casing', () => {
    for (const source of [
      'frame.srcdoc = x',
      'document.write(x)',
      'doc.contentDocument.writeln(x)',
      'host.innerHTML = x',
      '<div dangerouslySetInnerHTML={x} />',
      "host['insertAdjacentHTML'](a, x)",
      'range.createContextualFragment(x)',
      'host.setHTMLUnsafe(x)',
      "Reflect.set(host, 'outerHTML', x)",
    ]) {
      expect(mayHoldHtmlSink(source), source).toBe(true)
    }
    expect(mayHoldHtmlSink('stream.write(chunk)')).toBe(false)
    expect(mayHoldHtmlSink('const a = 1')).toBe(false)
  })

  it('reports a file that gains a second KIND of sink, not only a different count of one', () => {
    const ledger = { 'a.ts': { sinks: { 'innerHTML =': 1 }, reason: 'x' } }
    expect(
      sinkLedgerViolations(new Map([['a.ts', ['innerHTML =', 'insertAdjacentHTML()']]]), ledger),
    ).toEqual([
      'a.ts: ledger says {"innerHTML =":1}, source has {"innerHTML =":1,"insertAdjacentHTML()":1}',
    ])
    expect(sinkLedgerViolations(new Map([['a.ts', ['outerHTML =']]]), ledger)).toHaveLength(1)
    expect(sinkLedgerViolations(new Map([['a.ts', ['innerHTML =']]]), ledger)).toEqual([])
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
