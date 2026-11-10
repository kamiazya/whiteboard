import ts from '@typescript/typescript6'
import { parseSource } from './ast-helpers.js'

/**
 * ADR-0054's `PORTED_FUNCTIONS` ledger: every function the Rust core ports
 * that has reached stage 2 (`differential`) or later, with where its
 * TypeScript lives, where its switch is and which Rust export answers it.
 *
 * Both-sided (see `ported-functions.test.ts`): a function missing here while
 * its switch key exists fails, a function listed here that no longer exists
 * fails, and once the stage reaches `rust` the TypeScript export must be a
 * re-export of the shim rather than an implementation.
 *
 * Stage 4 has two shapes. A function whose callers can import the shim
 * re-exports it. One whose callers are synchronous and reach it by import from
 * a shared package that must not import the shim (it would carry the wasm glue
 * to every consumer, and the shim initialises asynchronously) declares a
 * `realm` instead: the export is a dispatcher over the one core each realm
 * installs, never an implementation, and the files that held the
 * TypeScript must be gone. The OKF envelope is the second shape.
 */
export interface PortedFunction {
  /** The name the function goes by in the TypeScript and in the switch. */
  readonly name: string
  /** ADR-0054's transition table: 2 differential, 3 rust, 4 TypeScript deleted. */
  readonly stage: 2 | 3 | 4
  readonly ts: { readonly file: string; readonly export: string }
  /** The `CoreImpl` switch: a key of `<interface>['impl']`, set through `option`. Gone once the TypeScript is deleted. */
  readonly switch?: {
    readonly file: string
    readonly interface: string
    readonly key: string
    readonly option: string
  }
  readonly rust: { readonly file: string; readonly fn: string }
  /** What the TypeScript export re-exports from once the stage is 3 or later. */
  readonly shim: { readonly module: string; readonly file: string; readonly member: string }
  /**
   * Stage 4's second shape: the export dispatches to the core the realm
   * installed through `install`, declared in `ts.file`, and every file in
   * `deleted` (where the TypeScript lived) no longer exists.
   */
  readonly realm?: { readonly install: string; readonly deleted: readonly string[] }
}

/** Where the OKF envelope's TypeScript lived, which stage 4 requires gone. */
const OKF_TYPESCRIPT = [
  'packages/codec/src/okf/parse.ts',
  'packages/codec/src/okf/serialize.ts',
  'packages/codec/src/okf/frontmatter-yaml.ts',
  'packages/codec/src/okf/yaml-safe.ts',
] as const

export const PORTED_FUNCTIONS: readonly PortedFunction[] = [
  {
    name: 'routeLayout',
    // Stays 2 although the switch defaults to `rust`: stage 3 makes the
    // TypeScript export a re-export of the shim, which deletes the
    // implementation the `ts` and `differential` settings (the rollback) run.
    // It moves with the TypeScript's deletion.
    stage: 2,
    ts: { file: 'packages/canvas-render/src/layout/edges/layout-core.ts', export: 'routeLayout' },
    switch: {
      file: 'packages/canvas-render/src/layout/edges/layout-core.ts',
      interface: 'LayoutCore',
      key: 'routeLayout',
      option: 'SpatialLayoutOptions.core',
    },
    rust: { file: 'crates/bindings/wasm/src/spatial_edges.rs', fn: 'edge_route_layout' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'routeLayout',
    },
  },
  {
    name: 'parseOkf',
    stage: 4,
    ts: { file: 'packages/codec/src/okf/okf-core.ts', export: 'parseOkf' },
    rust: { file: 'crates/bindings/wasm/src/okf.rs', fn: 'okf_parse' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'parseOkf',
    },
    realm: { install: 'installOkfCore', deleted: OKF_TYPESCRIPT },
  },
  {
    name: 'serializeOkf',
    stage: 4,
    ts: { file: 'packages/codec/src/okf/okf-core.ts', export: 'serializeOkf' },
    rust: { file: 'crates/bindings/wasm/src/okf.rs', fn: 'okf_serialize' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'serializeOkf',
    },
    realm: { install: 'installOkfCore', deleted: OKF_TYPESCRIPT },
  },
  {
    name: 'parseSpatial',
    stage: 2,
    ts: { file: 'packages/codec/src/spatial/parse.ts', export: 'parseSpatial' },
    switch: {
      file: 'packages/codec/src/spatial/spatial-core.ts',
      interface: 'SpatialCodecCore',
      key: 'parseSpatial',
      option: 'ServerDeps.spatialCore',
    },
    rust: { file: 'crates/bindings/wasm/src/json_canvas.rs', fn: 'json_canvas_parse' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'parseSpatial',
    },
  },
  {
    name: 'serializeSpatial',
    stage: 2,
    ts: { file: 'packages/codec/src/spatial/serialize.ts', export: 'serializeSpatial' },
    switch: {
      file: 'packages/codec/src/spatial/spatial-core.ts',
      interface: 'SpatialCodecCore',
      key: 'serializeSpatial',
      option: 'ServerDeps.spatialCore',
    },
    rust: { file: 'crates/bindings/wasm/src/json_canvas.rs', fn: 'json_canvas_serialize' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'serializeSpatial',
    },
  },
]

/** The text of a file, or `undefined` when it does not exist. */
export type ReadFile = (repoRelativePath: string) => string | undefined

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)

/** Names of the exported functions and consts a file declares itself (not re-exports). */
function declaredExports(file: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const s of file.statements) {
    if (ts.isFunctionDeclaration(s) && s.name !== undefined && isExported(s)) {
      names.add(s.name.text)
    } else if (ts.isVariableStatement(s) && isExported(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.add(d.name.text)
      }
    }
  }
  return names
}

/** Exported names that are re-exports from `module`. */
function reexportsFrom(file: ts.SourceFile, module: string): Set<string> {
  const names = new Set<string>()
  for (const s of file.statements) {
    if (
      ts.isExportDeclaration(s) &&
      s.moduleSpecifier !== undefined &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === module &&
      s.exportClause !== undefined &&
      ts.isNamedExports(s.exportClause)
    ) {
      for (const e of s.exportClause.elements) names.add(e.name.text)
    }
  }
  return names
}

/** The member names of `<interface>['impl']`'s type literal, or `undefined` when it is not one. */
export function switchKeys(text: string, interfaceName: string): string[] | undefined {
  const file = parseSource('layout-core.ts', text, false)
  for (const s of file.statements) {
    if (!ts.isInterfaceDeclaration(s) || s.name.text !== interfaceName) continue
    for (const m of s.members) {
      if (
        ts.isPropertySignature(m) &&
        ts.isIdentifier(m.name) &&
        m.name.text === 'impl' &&
        m.type !== undefined &&
        ts.isTypeLiteralNode(m.type)
      ) {
        return m.type.members.flatMap((k) =>
          ts.isPropertySignature(k) && ts.isIdentifier(k.name) ? [k.name.text] : [],
        )
      }
    }
  }
  return undefined
}

/** A Rust file declares `pub fn <name>(`. */
const declaresRustFn = (text: string, name: string): boolean =>
  new RegExp(`\\bpub\\s+fn\\s+${name}\\s*[(<]`).test(text)

/** Stage 4's second shape: a dispatcher over the realm's installed core, and the TypeScript gone. */
function checkRealm(
  f: PortedFunction,
  realm: NonNullable<PortedFunction['realm']>,
  declared: Set<string>,
  read: ReadFile,
): string[] {
  const problems: string[] = []
  if (!declared.has(f.ts.export)) {
    problems.push(`${f.name}: ${f.ts.file} no longer exports a function named ${f.ts.export}`)
  }
  if (!declared.has(realm.install)) {
    problems.push(
      `${f.name}: ${f.ts.file} declares no ${realm.install}, so no realm can install the core`,
    )
  }
  for (const path of realm.deleted) {
    if (read(path) !== undefined) {
      problems.push(`${f.name}: stage 4 but ${path}, where the TypeScript lived, still exists`)
    }
  }
  return problems
}

/** How the TypeScript export stands against the entry's stage. */
function checkTsExport(f: PortedFunction, read: ReadFile): string[] {
  const tsText = read(f.ts.file)
  if (tsText === undefined) return [`${f.name}: ${f.ts.file} does not exist`]
  const file = parseSource(f.ts.file, tsText, false)
  const declared = declaredExports(file)
  const reexported = reexportsFrom(file, f.shim.module).has(f.ts.export)
  if (f.stage === 2) {
    return declared.has(f.ts.export)
      ? []
      : [`${f.name}: ${f.ts.file} no longer exports a function named ${f.ts.export}`]
  }
  if (f.realm !== undefined) {
    return f.stage === 4
      ? checkRealm(f, f.realm, declared, read)
      : [`${f.name}: a realm dispatcher is stage 4's shape, not stage ${f.stage}'s`]
  }
  if (declared.has(f.ts.export)) {
    return [
      `${f.name}: stage ${f.stage} but ${f.ts.file} still implements ${f.ts.export}; it must be \`export { ${f.ts.export} } from '${f.shim.module}'\``,
    ]
  }
  return reexported
    ? []
    : [
        `${f.name}: stage ${f.stage} needs ${f.ts.file} to re-export ${f.ts.export} from '${f.shim.module}'`,
      ]
}

/** The Rust export and the shim member the entry names still exist. */
function checkRustSide(f: PortedFunction, read: ReadFile): string[] {
  const problems: string[] = []
  const rustText = read(f.rust.file)
  if (rustText === undefined || !declaresRustFn(rustText, f.rust.fn)) {
    problems.push(`${f.name}: ${f.rust.file} declares no \`pub fn ${f.rust.fn}\``)
  }
  const shimText = read(f.shim.file)
  if (shimText === undefined || !new RegExp(`\\b${f.shim.member}\\b`).test(shimText)) {
    problems.push(`${f.name}: ${f.shim.file} has no ${f.shim.member}`)
  }
  return problems
}

/** Both directions between one switch interface's keys and the entries naming it. */
function checkSwitch(
  slot: string,
  listed: readonly Switched[],
  keys: readonly string[] | undefined,
): string[] {
  if (keys === undefined) return [`${slot}: no \`impl\` type literal to read the switch keys from`]
  const missing = listed
    .filter((f) => !keys.includes(f.switch.key))
    .map((f) => `${f.name}: ${f.switch.file} has no switch key ${f.switch.key}`)
  const unlisted = keys
    .filter((key) => !listed.some((f) => f.switch.key === key))
    .map((key) => `${slot}: switch key ${key} is not in PORTED_FUNCTIONS`)
  return [...missing, ...unlisted]
}

/** An entry still held by a switch: stage 4's is gone with the TypeScript it chose between. */
type Switched = PortedFunction & { readonly switch: NonNullable<PortedFunction['switch']> }
const hasSwitch = (f: PortedFunction): f is Switched => f.switch !== undefined

const slotOf = (f: Switched): string => `${f.switch.file}#${f.switch.interface}`

/** Every way the ledger and the tree disagree, one sentence each. */
export function checkPortedFunctions(ledger: readonly PortedFunction[], read: ReadFile): string[] {
  const names = ledger.map((f) => f.name)
  const twice = [...new Set(names)]
    .filter((name) => names.filter((n) => n === name).length > 1)
    .map((name) => `${name}: listed twice`)
  const perEntry = ledger.flatMap((f) => [...checkTsExport(f, read), ...checkRustSide(f, read)])
  const switched = ledger.filter(hasSwitch)
  const perSwitch = [...new Set(switched.map(slotOf))].flatMap((slot) => {
    const listed = switched.filter((f) => slotOf(f) === slot)
    const first = listed[0] as Switched
    const text = read(first.switch.file)
    const keys = text === undefined ? undefined : switchKeys(text, first.switch.interface)
    return checkSwitch(slot, listed, keys)
  })
  return [...twice, ...perEntry, ...perSwitch]
}
