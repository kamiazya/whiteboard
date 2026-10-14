import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  criticalPathReport,
  entryAwaitFailures,
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

describe('entryAwaitFailures', () => {
  let dist: string

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'smoke-bundle-entry-'))
    mkdirSync(join(dist, 'assets'))
    writeFileSync(
      join(dist, 'index.html'),
      '<script type="module" crossorigin src="/assets/index-a.js"></script>',
    )
    // What vite-plugin-top-level-await makes of a chunk holding a dynamic
    // import: exports assigned inside an async body, plus the promise for it.
    writeFileSync(
      join(dist, 'assets', 'shell-b.js'),
      'let a; let __tla = (async () => { a = () => 1 })(); export { a as a, __tla };',
    )
  })

  afterEach(() => {
    rmSync(dist, { recursive: true, force: true })
  })

  it('fails an entry that reads a deferred chunk without awaiting it', () => {
    writeFileSync(join(dist, 'assets', 'index-a.js'), 'import{a as e}from"./shell-b.js";e();')

    const report = entryAwaitFailures(dist)

    expect(report.failures).toBe(1)
    expect(report.lines.map((l) => l.text).join('\n')).toMatch(/index-a\.js.*shell-b\.js/)
  })

  it('passes an entry that awaits the chunk before running', () => {
    writeFileSync(
      join(dist, 'assets', 'index-a.js'),
      'import { a as e, __tla as __tla_0 } from "./shell-b.js"; Promise.all([__tla_0]).then(async () => { e() });',
    )

    expect(entryAwaitFailures(dist).failures).toBe(0)
  })

  it('still sees a deferred chunk whose export is followed by a comment', () => {
    writeFileSync(
      join(dist, 'assets', 'shell-b.js'),
      'let a; let __tla = (async () => { a = () => 1 })(); export { a as a, __tla };\n//# sourceMappingURL=shell-b.js.map\n/* licence */\n',
    )
    writeFileSync(join(dist, 'assets', 'index-a.js'), 'import{a as e}from"./shell-b.js";e();')

    expect(entryAwaitFailures(dist).failures).toBe(1)
  })

  it('reports an imported chunk missing from dist as a failure', () => {
    writeFileSync(join(dist, 'assets', 'index-a.js'), 'import{a as e}from"./gone-c.js";e();')

    const report = entryAwaitFailures(dist)

    expect(report.failures).toBe(1)
    expect(report.lines.map((l) => l.text).join('\n')).toMatch(/gone-c\.js.*missing/)
  })

  it('reports an entry script missing from dist as a failure', () => {
    const report = entryAwaitFailures(dist)

    expect(report.failures).toBe(1)
    expect(report.lines.map((l) => l.text).join('\n')).toMatch(/index-a\.js.*missing/)
  })
})
