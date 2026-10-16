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
 *
 * Who serves the socket under `unconfirmed` is read in those two modules
 * alone: `servingPidOf` projects it onto a result, `describeOccupant` and
 * `describeUnconfirmed` say it in a sentence. Each liveness field had to reach
 * every hand-written copy of that projection by hand, and nothing failed when
 * one was missed, so a `.servingPid` read anywhere else fails here.
 *
 * And the question itself is ASKED in that one reader: `parseDaemonRecord`
 * hands every arm that names a daemon its liveness, `valid` included. While
 * `valid` carried none, each reader had to remember to ask, one forgot, and a
 * crashed daemon's socket reached the person as `connect ENOENT` where "start
 * one" was owed. So a module importing `daemonLiveness` other than the reader
 * fails here, unless the ledger below says why it needs a later answer.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { importBindingsOf, importedBindings, parseSource, unwrapExpression } from './ast-helpers.js'
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

/**
 * The guarded names `file` forwards from a module `isModule` accepts:
 * `export { name as alias } from`, and `export *` / `export * as ns`, which
 * forward every name without spelling one. A forward binds nothing in the
 * file, so an import scan reads it as clean — while whoever imports through
 * it holds the guarded answer under a module this guard never names.
 */
function forwards(
  file: ts.SourceFile,
  isModule: (spec: string) => boolean,
  names: ReadonlySet<string>,
): string[] {
  const named = [...importedBindings(file, isModule, names).reexports].map(
    (alias) => `export as ${alias}`,
  )
  const whole = file.statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) &&
    !statement.isTypeOnly &&
    (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause)) &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(statement.moduleSpecifier) &&
    isModule(statement.moduleSpecifier.text)
      ? [`export * from ${statement.moduleSpecifier.text}`]
      : [],
  )
  return [...named, ...whole]
}

/** The record schemas `source` imports or forwards, by their exported names. */
function recordSchemas(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  const imported = importBindingsOf(file)
    .filter((binding) => RECORD_SCHEMA_MODULE.test(binding.spec))
    .flatMap((binding) =>
      binding.kind === 'namespace'
        ? ['* (namespace)']
        : RECORD_SCHEMAS.has(binding.imported)
          ? [binding.imported]
          : [],
    )
  return [...imported, ...forwards(file, (spec) => RECORD_SCHEMA_MODULE.test(spec), RECORD_SCHEMAS)]
}

const SERVING_PID_READERS = new Set([ONE_PLACE, ONE_READER])

/**
 * Where `source` reads a `servingPid` property — `x.servingPid`,
 * `x?.servingPid` or `x['servingPid']`. A destructuring is not a read of a
 * liveness: the projection's own result destructures it, and telling the two
 * apart needs the type checker.
 */
function servingPidReads(fileName: string, source: string): number[] {
  const file = parseSource(fileName, source)
  const lines: number[] = []
  const visit = (node: ts.Node): void => {
    const named =
      (ts.isPropertyAccessExpression(node) && node.name.text === 'servingPid') ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'servingPid')
    if (named) lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return lines
}

/** Relative path -> the lower answer it imports, and why. Both-sided. */
const LEDGER: Readonly<Record<string, { imports: readonly string[]; why: string }>> = {
  'packages/mcp-server/src/cli/daemon-stop.ts': {
    imports: ['isPidAlive'],
    why: "polls the SIGTERM window for the pid's exit after daemonLiveness confirmed it, and re-asks daemonLiveness before SIGKILL",
  },
}

const LIVENESS_MODULE = /(^|\/)daemon-liveness\.js$/

/** Relative path -> why it asks again after the reader answered. Both-sided. */
const RE_ASK_LEDGER: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/cli/daemon-stop.ts':
    "re-asks before SIGKILL: the reader's answer predates the SIGTERM window, and the pid can change hands inside it",
}

const ASKS = new Set(['daemonLiveness'])

/** Where `source` reaches `daemonLiveness`: by name, alias, namespace, dynamic import or a forward. */
function livenessAsks(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  const imported = importBindingsOf(file)
    .filter((binding) => LIVENESS_MODULE.test(binding.spec))
    .flatMap((binding) =>
      binding.kind === 'namespace'
        ? ['* (namespace)']
        : binding.imported === 'daemonLiveness'
          ? ['daemonLiveness']
          : [],
    )
  const dynamic: string[] = []
  const visit = (node: ts.Node): void => {
    const [first] = ts.isCallExpression(node) ? node.arguments : []
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      first !== undefined &&
      ts.isStringLiteralLike(first) &&
      LIVENESS_MODULE.test(first.text)
    ) {
      dynamic.push(`import(${first.text})`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...imported, ...dynamic, ...forwards(file, (spec) => LIVENESS_MODULE.test(spec), ASKS)]
}

/** The lower-level liveness answers `source` forwards to whoever imports it. */
function forwardedLowerAnswers(file: ts.SourceFile): string[] {
  return LOWER_ANSWERS.flatMap(({ module, names }) =>
    forwards(file, (spec) => module.test(spec), names),
  )
}

/**
 * The lower-level liveness answers `source` reaches: an imported name, a
 * forward, a dynamic `import()` of a module that exports one, or a bare signal 0 —
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
  return [...imported, ...forwardedLowerAnswers(file), ...reached]
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

/** Relative path -> source, for every scanned file; a self-test plants into a copy. */
type Sources = ReadonlyMap<string, string>
const realSources: Sources = new Map(files.map(relOf).map((rel) => [rel, sourceOf(rel)]))
const planted = (plants: Record<string, string>): Sources => {
  const copy = new Map(realSources)
  for (const [rel, source] of Object.entries(plants)) copy.set(rel, (copy.get(rel) ?? '') + source)
  return copy
}

/**
 * A forward is never exempt, the one place's own reader included: whoever
 * imports through it reaches the guarded name without importing its module,
 * which is the one thing every scan here reads.
 */
const isForward = (hit: string) => hit.startsWith('export ')

/** Every module asking `daemonLiveness` that is not the one reader or a ledgered re-ask. */
function askersIn(sources: Sources): string[] {
  return [...sources].flatMap(([rel, source]) => {
    if (rel === ONE_PLACE) return []
    const exempt = rel === ONE_READER || RE_ASK_LEDGER[rel] !== undefined
    return livenessAsks(rel, source)
      .filter((hit) => !exempt || isForward(hit))
      .map((hit) => `${rel}: ${hit}`)
  })
}

/** Every module, reader or not, that forwards a lower-level answer. */
function lowerForwardersIn(sources: Sources): string[] {
  return [...sources].flatMap(([rel, source]) =>
    lowerAnswers(rel, source)
      .filter(isForward)
      .map((hit) => `${rel}: ${hit}`),
  )
}

/** Every module reaching a record schema other than the one reader's own import. */
function parsersIn(sources: Sources): string[] {
  return [...sources].flatMap(([rel, source]) =>
    recordSchemas(rel, source)
      .filter((hit) => rel !== ONE_READER || isForward(hit))
      .map((hit) => `${rel}: ${hit}`),
  )
}

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
    expect(
      lowerForwardersIn(realSources),
      'import the answer from its own module: a forward hands it to readers this scan cannot see',
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

  it('only the one reader asks whether the daemon a record names is running', () => {
    expect(livenessAsks(ONE_READER, sourceOf(ONE_READER))).toEqual(['daemonLiveness'])
    expect(
      askersIn(realSources),
      'switch on the `liveness` `parseDaemonRecord` / `loadDaemonRecord` hand you: a reader that asks for itself is one that can forget to',
    ).toEqual([])
  })

  it('every re-ask ledger entry still asks', () => {
    const drift = Object.keys(RE_ASK_LEDGER).filter(
      (rel) => !livenessAsks(rel, sourceOf(rel)).includes('daemonLiveness'),
    )
    expect(drift, 'an entry that outlives its site is how a ledger stops being read').toEqual([])
  })

  it('recognises daemonLiveness imported by name, alias, namespace or dynamically', () => {
    expect(
      livenessAsks('f.ts', "import { daemonLiveness as ask } from '../daemon/daemon-liveness.js'"),
    ).toEqual(['daemonLiveness'])
    expect(livenessAsks('f.ts', "import * as l from './daemon-liveness.js'")).toEqual([
      '* (namespace)',
    ])
    expect(livenessAsks('f.ts', "const m = import('./daemon-liveness.js')")).toEqual([
      'import(./daemon-liveness.js)',
    ])
    expect(
      livenessAsks(
        'f.ts',
        "import { servingPidOf, type DaemonLiveness } from './daemon-liveness.js'",
      ),
    ).toEqual([])
  })

  it('recognises daemonLiveness forwarded by name, alias or export *', () => {
    expect(
      livenessAsks('f.ts', "export { daemonLiveness as askLiveness } from './daemon-liveness.js'"),
    ).toEqual(['export as askLiveness'])
    expect(livenessAsks('f.ts', "export * from './daemon-liveness.js'")).toEqual([
      'export * from ./daemon-liveness.js',
    ])
    expect(livenessAsks('f.ts', "export * as l from './daemon-liveness.js'")).toEqual([
      'export * from ./daemon-liveness.js',
    ])
    expect(
      livenessAsks(
        'f.ts',
        "export { servingPidOf, type DaemonLiveness } from './daemon-liveness.js'",
      ),
    ).toEqual([])
    expect(
      lowerAnswers('f.ts', "export { isPidAlive as alive } from '../shared/process-alive.js'"),
    ).toEqual(['export as alive'])
    expect(
      recordSchemas('f.ts', "export { daemonRecordSchema } from './daemon-record-schema.js'"),
    ).toEqual(['export as daemonRecordSchema'])
  })

  it('counts a forward through the one reader or a new barrel as asking', () => {
    const forward = "\nexport { daemonLiveness as askLiveness } from './daemon-liveness.js'\n"
    expect(askersIn(planted({ [ONE_READER]: forward }))).toEqual([
      `${ONE_READER}: export as askLiveness`,
    ])
    const barrel = 'packages/mcp-server/src/daemon/liveness-ask.ts'
    expect(
      askersIn(planted({ [barrel]: "export { daemonLiveness } from './daemon-liveness.js'\n" })),
    ).toEqual([`${barrel}: export as daemonLiveness`])
    expect(
      lowerForwardersIn(
        planted({ [barrel]: "export { recordedProcess } from '../shared/process-identity.js'\n" }),
      ),
    ).toEqual([`${barrel}: export as recordedProcess`])
    expect(
      parsersIn(planted({ [ONE_READER]: "\nexport * from './daemon-record-schema.js'\n" })),
    ).toEqual([`${ONE_READER}: export * from ./daemon-record-schema.js`])
  })

  it('only the one reader parses daemon.json against its schemas', () => {
    expect(recordSchemas(ONE_READER, sourceOf(ONE_READER)).sort()).toEqual(
      [...RECORD_SCHEMAS].sort(),
    )
    expect(
      parsersIn(realSources),
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

  it('reads who serves the socket only where liveness is judged and worded', () => {
    for (const rel of SERVING_PID_READERS) {
      expect(servingPidReads(rel, sourceOf(rel)), rel).not.toEqual([])
    }
    const reads = files
      .map(relOf)
      .filter((rel) => !SERVING_PID_READERS.has(rel))
      .flatMap((rel) => servingPidReads(rel, sourceOf(rel)).map((line) => `${rel}:${line}`))
    expect(
      reads,
      'project it with `servingPidOf`, or word it with `describeOccupant` / `describeUnconfirmed`',
    ).toEqual([])
  })

  it('recognises a servingPid read by dot, optional chain and element access', () => {
    expect(servingPidReads('f.ts', 'const a = l.servingPid')).toEqual([1])
    expect(servingPidReads('f.ts', 'const a = l?.servingPid')).toEqual([1])
    expect(servingPidReads('f.ts', "const a = l['servingPid']")).toEqual([1])
    expect(
      servingPidReads('f.ts', 'const { servingPid } = n; const o = { servingPid: 1 }'),
    ).toEqual([])
  })
})
