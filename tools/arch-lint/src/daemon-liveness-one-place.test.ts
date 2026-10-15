/**
 * Whether the daemon a daemon.json names is still running is answered in ONE
 * place, `daemon/daemon-liveness.ts`'s `daemonLiveness`, and this scan is the
 * executable half of that.
 *
 * Why it needs a scan. The pid-reuse judgement reached three of the record's
 * readers and not the other four, so `daemon doctor` called a pid another
 * process had taken "running" beside a `daemon status` that said it was not,
 * inside one support bundle. Each reader had chosen its own check, and a
 * bare signal 0 is the one that comes to hand.
 *
 * A READER is a non-test file under mcp-server's `src` that imports the
 * record's parser or registry. It may not import the lower-level answers —
 * `isPidAlive`, `recordedProcess` — except where the
 * ledger below says why, so a new reader reaching for one fails here.
 *
 * The record's VERDICT is one place too: `daemon/daemon-record.ts`'s
 * `parseDaemonRecord` is the only module that parses daemon.json against its
 * schemas. A second parser answered "malformed, remove it" for a record of a
 * live daemon of another version while the first refused to start a second
 * daemon beside it, so a module importing a record schema other than that
 * reader fails here.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { importBindingsOf, parseSource, unwrapExpression } from './ast-helpers.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const SCANNED = 'packages/mcp-server/src'
const ONE_PLACE = 'packages/mcp-server/src/daemon/daemon-liveness.ts'

const isRecordReaderModule = (spec: string) =>
  /(^|\/)daemon-record\.js$/.test(spec) || /(^|\/)daemon-registry\.js$/.test(spec)
const LOWER_ANSWERS: readonly { module: RegExp; names: ReadonlySet<string> }[] = [
  { module: /(^|\/)process-alive\.js$/, names: new Set(['isPidAlive']) },
  { module: /(^|\/)process-identity\.js$/, names: new Set(['recordedProcess']) },
]

const ONE_READER = 'packages/mcp-server/src/daemon/daemon-record.ts'
const RECORD_SCHEMA_MODULE = /(^|\/)daemon-record-schema\.js$/
const RECORD_SCHEMAS = new Set([
  'daemonRecordSchema',
  'daemonRecordBaseSchema',
  'recordedDaemonSchema',
])

/** The record schemas `source` imports, by their exported names. */
function recordSchemas(fileName: string, source: string): string[] {
  return importBindingsOf(parseSource(fileName, source))
    .filter((binding) => RECORD_SCHEMA_MODULE.test(binding.spec))
    .flatMap((binding) =>
      binding.kind === 'namespace'
        ? ['* (namespace)']
        : RECORD_SCHEMAS.has(binding.imported)
          ? [binding.imported]
          : [],
    )
}

/** Relative path -> the lower answer it imports, and why. Both-sided. */
const LEDGER: Readonly<Record<string, { imports: readonly string[]; why: string }>> = {
  'packages/mcp-server/src/cli/daemon-stop.ts': {
    imports: ['isPidAlive'],
    why: "polls the SIGTERM window for the pid's exit after daemonLiveness confirmed it, and re-asks daemonLiveness before SIGKILL",
  },
}

/**
 * The lower-level liveness answers `source` reaches: an imported name, a
 * dynamic `import()` of a module that exports one, or a bare signal 0 —
 * `process.kill(pid, 0)` is the check every reader once reached for, and needs
 * no import at all.
 */
function lowerAnswers(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  const imported = importBindingsOf(file).flatMap((binding) =>
    LOWER_ANSWERS.filter(({ module }) => module.test(binding.spec)).flatMap(({ names }) =>
      binding.kind === 'namespace'
        ? ['* (namespace)']
        : names.has(binding.imported)
          ? [binding.imported]
          : [],
    ),
  )
  const reached: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const [first, second] = node.arguments
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        first !== undefined &&
        ts.isStringLiteralLike(first) &&
        LOWER_ANSWERS.some(({ module }) => module.test(first.text))
      ) {
        reached.push(`import(${first.text})`)
      }
      const callee = unwrapExpression(node.expression)
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'kill' &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'process' &&
        second !== undefined &&
        ts.isNumericLiteral(unwrapExpression(second)) &&
        Number((unwrapExpression(second) as ts.NumericLiteral).text) === 0
      ) {
        reached.push('process.kill(_, 0)')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...imported, ...reached]
}

function readsRecord(fileName: string, source: string): boolean {
  return importBindingsOf(parseSource(fileName, source)).some((binding) =>
    isRecordReaderModule(binding.spec),
  )
}

const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const files = walkSourceFiles(join(REPO_ROOT, SCANNED)).filter((path) => !isTestPath(path))
const sourceOf = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')
const readers = files
  .map(relOf)
  .filter((rel) => rel.endsWith('/daemon-registry.ts') || readsRecord(rel, sourceOf(rel)))

describe("a daemon record's liveness is judged in one place", () => {
  it('scans the readers worth scanning', () => {
    expect(readers.length).toBeGreaterThan(6)
    expect(readers).toEqual(
      expect.arrayContaining([
        'packages/mcp-server/src/cli/daemon-doctor.ts',
        'packages/mcp-server/src/cli/daemon-status.ts',
        'packages/mcp-server/src/server/store/db/prepare.ts',
        'packages/mcp-server/src/daemon/daemon-registry.ts',
      ]),
    )
    expect(lowerAnswers(ONE_PLACE, sourceOf(ONE_PLACE))).toContain('recordedProcess')
  })

  it('no reader of daemon.json judges its pid by a lower-level answer', () => {
    const hits = readers
      .filter((rel) => LEDGER[rel] === undefined)
      .flatMap((rel) => lowerAnswers(rel, sourceOf(rel)).map((name) => `${rel}: ${name}`))
    expect(
      hits,
      "ask `daemonLiveness`: a bare signal 0 calls a pid another process took 'running', and start time alone calls a daemon a stepped clock moved 'reused'",
    ).toEqual([])
  })

  it('recognises a named, aliased and namespace import', () => {
    expect(
      lowerAnswers('f.ts', "import { isPidAlive as alive } from '../shared/process-alive.js'"),
    ).toEqual(['isPidAlive'])
    expect(
      lowerAnswers('f.ts', "import { recordedProcess } from '../shared/process-identity.js'"),
    ).toEqual(['recordedProcess'])
    expect(lowerAnswers('f.ts', "import * as p from '../shared/process-alive.js'")).toEqual([
      '* (namespace)',
    ])
    expect(
      lowerAnswers('f.ts', "import { readProcessStartMs } from '../shared/process-identity.js'"),
    ).toEqual([])
  })

  it('recognises a bare signal 0 and a dynamic import of a lower answer', () => {
    expect(lowerAnswers('f.ts', 'process.kill(record.pid, 0)')).toEqual(['process.kill(_, 0)'])
    expect(lowerAnswers('f.ts', "void import('../shared/process-alive.js')")).toEqual([
      'import(../shared/process-alive.js)',
    ])
    expect(lowerAnswers('f.ts', "const m = import('../shared/process-identity.js')")).toEqual([
      'import(../shared/process-identity.js)',
    ])
    expect(lowerAnswers('f.ts', "process.kill(pid, 'SIGTERM')")).toEqual([])
    expect(lowerAnswers('f.ts', "void import('./daemon-run.js')")).toEqual([])
  })

  it('every ledger entry is a reader that still imports what it records', () => {
    const drift = Object.entries(LEDGER).flatMap(([rel, { imports }]) => {
      const found = lowerAnswers(rel, sourceOf(rel))
      const ok = readers.includes(rel) && imports.every((name) => found.includes(name))
      return ok
        ? []
        : [`${rel}: records ${imports.join(', ')}, found ${found.join(', ') || 'none'}`]
    })
    expect(drift, 'an entry that outlives its site is how a ledger stops being read').toEqual([])
  })

  it('only the one reader parses daemon.json against its schemas', () => {
    expect(recordSchemas(ONE_READER, sourceOf(ONE_READER)).sort()).toEqual(
      [...RECORD_SCHEMAS].sort(),
    )
    const parsers = files
      .map(relOf)
      .filter((rel) => rel !== ONE_READER)
      .flatMap((rel) => recordSchemas(rel, sourceOf(rel)).map((name) => `${rel}: ${name}`))
    expect(
      parsers,
      'read daemon.json through `parseDaemonRecord` (or `loadDaemonRecord`, its projection): a second parser reaches a second verdict',
    ).toEqual([])
  })

  it('recognises a record schema imported by name, alias or namespace', () => {
    expect(
      recordSchemas('f.ts', "import { daemonRecordSchema as s } from './daemon-record-schema.js'"),
    ).toEqual(['daemonRecordSchema'])
    expect(recordSchemas('f.ts', "import * as s from '../daemon/daemon-record-schema.js'")).toEqual(
      ['* (namespace)'],
    )
    expect(
      recordSchemas('f.ts', "import { daemonLaunchOfModule } from './daemon-record-schema.js'"),
    ).toEqual([])
  })
})
