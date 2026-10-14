import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  criticalPathReport,
  deferredExportFailures,
  extractCriticalPathFiles,
} from './smoke-bundle-size.mjs'

describe('extractCriticalPathFiles', () => {
  it('finds the entry script and modulepreload chunks with lowercase tags/attrs', () => {
    const html = [
      '<script type="module" crossorigin src="/assets/index-abc123.js"></script>',
      '<link rel="modulepreload" crossorigin href="/assets/vendor-react-def456.js">',
    ].join('\n')

    expect(extractCriticalPathFiles(html)).toEqual([
      '/assets/index-abc123.js',
      '/assets/vendor-react-def456.js',
    ])
  })

  it('finds the same files when tag names, attribute names, and rel value are upper/mixed case', () => {
    const html = [
      '<SCRIPT TYPE="module" CROSSORIGIN SRC="/assets/index-abc123.js"></SCRIPT>',
      '<LINK REL="MODULEPRELOAD" CROSSORIGIN HREF="/assets/vendor-react-def456.js">',
    ].join('\n')

    expect(extractCriticalPathFiles(html)).toEqual([
      '/assets/index-abc123.js',
      '/assets/vendor-react-def456.js',
    ])
  })
})

describe('criticalPathReport', () => {
  let dist: string

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'smoke-bundle-size-'))
  })

  afterEach(() => {
    rmSync(dist, { recursive: true, force: true })
  })

  /**
   * A built `dist/` whose critical path is the given files, each filled with
   * random bytes so its gzipped size is close to the requested one.
   */
  function writeDist(files: Record<string, number>): void {
    mkdirSync(join(dist, 'assets'))
    const [entry, ...preloads] = Object.keys(files)
    writeFileSync(
      join(dist, 'index.html'),
      [
        `<script type="module" crossorigin src="/assets/${entry}"></script>`,
        ...preloads.map((f) => `<link rel="modulepreload" crossorigin href="/assets/${f}">`),
      ].join('\n'),
    )
    for (const [file, bytes] of Object.entries(files)) {
      writeFileSync(join(dist, 'assets', file), randomBytes(bytes))
    }
  }

  const text = (report: { lines: { text: string }[] }) => report.lines.map((l) => l.text).join('\n')

  /** The file names the report lists, in the order it lists them. */
  const listed = (report: { lines: { text: string }[] }) =>
    report.lines.flatMap((l) => l.text.match(/\/assets\/(\S+\.js)$/)?.[1] ?? [])

  it('names every critical-path file, largest first, when over the byte budget', () => {
    writeDist({ 'index-a.js': 1024, 'small-b.js': 512, 'big-c.js': 3 * 1024 })

    const report = criticalPathReport(dist, { byteBudgetKb: 2, fileBudget: 10 })

    expect(report.failures).toBe(1)
    expect(text(report)).toMatch(/FAIL {2}critical-path JS .*3 files/)
    expect(listed(report)).toEqual(['big-c.js', 'index-a.js', 'small-b.js'])
  })

  it('names every file when the critical path holds more files than its budget', () => {
    writeDist({ 'index-a.js': 64, 'b.js': 64, 'c.js': 64 })

    const report = criticalPathReport(dist, { byteBudgetKb: 100, fileBudget: 2 })

    expect(report.failures).toBe(1)
    expect(text(report)).toMatch(/FAIL {2}critical-path files: 3 \(budget 2\)/)
    expect(listed(report)).toHaveLength(3)
  })

  it('names every file on a pass within 3% of the byte budget', () => {
    writeDist({ 'index-a.js': 1000, 'b.js': 1000 })

    const report = criticalPathReport(dist, { byteBudgetKb: 2, fileBudget: 10 })

    expect(report.failures).toBe(0)
    expect(text(report)).toMatch(/pass {2}critical-path JS .*within 3% of the budget/)
    expect(listed(report)).toHaveLength(2)
  })

  it('stays one line per budget when both have headroom', () => {
    writeDist({ 'index-a.js': 256, 'b.js': 256 })

    const report = criticalPathReport(dist, { byteBudgetKb: 100, fileBudget: 10 })

    expect(report.failures).toBe(0)
    expect(listed(report)).toEqual([])
    expect(report.lines).toHaveLength(2)
  })
})

describe('deferredExportFailures', () => {
  let dist: string

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'smoke-bundle-deferred-'))
    mkdirSync(join(dist, 'assets'))
  })

  afterEach(() => {
    rmSync(dist, { recursive: true, force: true })
  })

  const asset = (file: string, source: string) => writeFileSync(join(dist, 'assets', file), source)
  const text = (report: { lines: { text: string }[] }) => report.lines.map((l) => l.text).join('\n')

  it('fails every chunk that exports a __tla promise, by name', () => {
    asset(
      'shell-b.js',
      'let a; let __tla = (async () => { a = () => 1 })(); export { a as a, __tla };',
    )
    asset('page-c.js', 'let b;let __tla=(async()=>{b=2})();export{b as t,__tla};')
    asset('index-a.js', 'import{a as e}from"./shell-b.js";e();')

    const report = deferredExportFailures(dist)

    expect(report.failures).toBe(2)
    expect(text(report)).toMatch(/shell-b\.js/)
    expect(text(report)).toMatch(/page-c\.js/)
    expect(text(report)).not.toMatch(/index-a\.js/)
  })

  it('sees an export clause followed by a source-map comment', () => {
    asset('shell-b.js', 'let a;export{a as a,__tla};\n//# sourceMappingURL=shell-b.js.map\n')

    expect(deferredExportFailures(dist).failures).toBe(1)
  })

  it('passes chunks that only mention the word or use native top-level await', () => {
    asset('shell-b.js', 'const m = await fetch("/x.wasm"); export { m as a };')
    asset('notes-c.js', 'const s = "__tla"; export { s as __tlaNote };')

    expect(deferredExportFailures(dist).failures).toBe(0)
  })
})
