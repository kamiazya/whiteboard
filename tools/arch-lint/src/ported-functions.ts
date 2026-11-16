import ts from '@typescript/typescript6'
import { parseSource } from './ast-helpers.js'

/**
 * ADR-0054's `PORTED_FUNCTIONS` ledger: every function the Rust core ports
 * that has reached stage 2 or later, with where its TypeScript lives and
 * which Rust export answers it.
 *
 * Both-sided (see `ported-functions.test.ts`): a function listed here that no
 * longer exists fails, and once the stage reaches `rust` the TypeScript export
 * must be a re-export of the shim rather than an implementation. The layout's
 * per-function switch (`LayoutCore['impl']`) was retired in step 7's S18g: the
 * core answers every layout a root hands it. S18h2 deleted the composer and
 * the typesetter, moving the layout and its node queries to stage 4; the
 * routing TypeScript (`layout/edges`) is S18h3's.
 *
 * Stage 4 has three shapes. A function whose callers can import the shim
 * re-exports it. One whose callers are synchronous and reach it by import from
 * a shared package that must not import the shim (it would carry the wasm glue
 * to every consumer, and the shim initialises asynchronously) declares a
 * `realm` instead: the export is a dispatcher over the one core each realm
 * installs, never an implementation, and the files that held the
 * TypeScript must be gone. The OKF envelope, the JSON Canvas codec and the facet write are the second shape.
 * The third is canvas-render's layout: the export takes the core it asks
 * (`options.core`, which every root holds), so there is nothing to install;
 * it declares `handed`, and the files that held the TypeScript must be gone.
 */
export interface PortedFunction {
  /** The name the function goes by in the TypeScript. */
  readonly name: string
  /**
   * ADR-0054's transition table: 2 the TypeScript still implements it (beside
   * a `differential` switch until S18g, beside the core alone since), 3 the
   * TypeScript export re-exports the shim, 4 the TypeScript deleted.
   */
  readonly stage: 2 | 3 | 4
  readonly ts: { readonly file: string; readonly export: string }
  readonly rust: { readonly file: string; readonly fn: string }
  /** What the TypeScript export re-exports from once the stage is 3 or later. */
  readonly shim: { readonly module: string; readonly file: string; readonly member: string }
  /**
   * Stage 4's second shape: the export dispatches to the core the realm
   * installed through `install`, declared in `ts.file`, and every file in
   * `deleted` (where the TypeScript lived) no longer exists.
   */
  readonly realm?: { readonly install: string; readonly deleted: readonly string[] }
  /**
   * Stage 4's third shape: the export asks the core its caller hands it, and
   * every file in `deleted` (where the TypeScript lived) no longer exists.
   */
  readonly handed?: { readonly deleted: readonly string[] }
}

/** Where the OKF envelope's TypeScript lived, which stage 4 requires gone. */
const OKF_TYPESCRIPT = [
  'packages/codec/src/okf/parse.ts',
  'packages/codec/src/okf/serialize.ts',
  'packages/codec/src/okf/frontmatter-yaml.ts',
  'packages/codec/src/okf/yaml-safe.ts',
] as const

/**
 * Where the JSON Canvas codec's TypeScript implementation lived, which stage 4
 * requires gone — the widget's reader included, once the widget stopped
 * reading a canvas (ADR-0054 S17).
 */
const SPATIAL_TYPESCRIPT = [
  'packages/codec/src/spatial/parse.ts',
  'packages/codec/src/spatial/serialize.ts',
  'packages/codec/src/spatial/read-json-canvas-text.ts',
] as const

/**
 * The files that held the daemon's facet-write judgement outside the one module
 * a writer still asks, which stage 4 requires gone: the switch's test-realm
 * loader and the differential test against the TypeScript. The judgement itself
 * lived in `tools/facet-write.ts`, which stays as the dispatcher that resolves
 * what the core is given.
 */
const FACET_WRITE_TYPESCRIPT = [
  'packages/server-core/src/test-utils/facet-write-core.ts',
  'packages/server-core/src/tools/facet-write.core.test.ts',
] as const

/** Where the composer lived (S18h2), which stage 4 requires gone. */
const COMPOSER_TYPESCRIPT = [
  'packages/canvas-render/src/layout/compose-node.ts',
  'packages/canvas-render/src/layout/compose-file-node.ts',
  'packages/canvas-render/src/layout/node-box.ts',
  'packages/canvas-render/src/layout/comments.ts',
  'packages/canvas-render/src/layout/proposals.ts',
  'packages/canvas-render/src/legend/canvas-legend.ts',
] as const

/** Where the typesetter lived (S18h2), which stage 4 requires gone. */
const TYPESETTER_TYPESCRIPT = [
  'packages/canvas-render/src/layout/markdown-body.ts',
  'packages/canvas-render/src/layout/nodes/mdast-blocks.ts',
  'packages/canvas-render/src/layout/nodes/mdast-section.ts',
  'packages/canvas-render/src/layout/nodes/uax-segments.ts',
  'packages/canvas-render/src/vendor/budoux/parser.ts',
] as const

/** Where the comment bubble's placement lived (S18h2), which stage 4 requires gone. */
const COMMENT_TYPESCRIPT = [
  'packages/canvas-render/src/layout/comment-placement.ts',
  'packages/canvas-render/src/layout/comment-body.ts',
] as const

export const PORTED_FUNCTIONS: readonly PortedFunction[] = [
  {
    name: 'routeLayout',
    // Stays 2 although the core answers every layout a root hands it (S18g):
    // the TypeScript export is still the composer's own routing. It moves
    // with the TypeScript's deletion (S18h3).
    stage: 2,
    ts: { file: 'packages/canvas-render/src/layout/edges/layout-core.ts', export: 'routeLayout' },
    rust: { file: 'crates/bindings/wasm/src/spatial_edges.rs', fn: 'edge_route_layout' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'routeLayout',
    },
  },
  {
    name: 'layoutSpatialCanvas',
    // The core answers it on every root (S16a, S16b; the switch retired in
    // S18g), and the crate replays the recording; the composer is gone (S18h2).
    stage: 4,
    ts: {
      file: 'packages/canvas-render/src/layout/spatial-canvas.ts',
      export: 'layoutSpatialCanvasWithAnchors',
    },
    rust: { file: 'crates/bindings/wasm/src/spatial_layout/mod.rs', fn: 'layout_spatial_canvas' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'layoutSpatialCanvas',
    },
    handed: { deleted: COMPOSER_TYPESCRIPT },
  },
  {
    // A markdown NOTE (S18c): the core's markdown entry, a `kind: 'markdown'`
    // request on the whole layout's export (S18b). The TypeScript it was held
    // to, `layoutMdastBlocks` over the parsed body, is gone (S18h2).
    name: 'layoutMarkdown',
    stage: 4,
    ts: {
      file: 'packages/canvas-render/src/layout/markdown-switch.ts',
      export: 'layoutMarkdownDocument',
    },
    rust: { file: 'crates/bindings/wasm/src/spatial_layout/mod.rs', fn: 'layout_spatial_canvas' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'layoutMarkdown',
    },
    handed: { deleted: TYPESETTER_TYPESCRIPT },
  },
  // The layout pieces a root calls on their own (S18d): one export,
  // `layout_query`, with a tagged query per piece. Those the composer answered
  // went to stage 4 with it (S18h2); those the routing still implements, and
  // the outline the SVG and hit-testing draw by, stay 2.
  {
    name: 'layoutSpatialEdges',
    stage: 4,
    ts: {
      file: 'packages/canvas-render/src/layout/spatial-canvas.ts',
      export: 'layoutSpatialEdges',
    },
    rust: { file: 'crates/bindings/wasm/src/spatial_layout/query.rs', fn: 'layout_query' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'layoutQuery',
    },
    handed: { deleted: COMPOSER_TYPESCRIPT },
  },
  {
    name: 'naturalNodeContentSize',
    stage: 4,
    ts: {
      file: 'packages/canvas-render/src/layout/spatial-canvas.ts',
      export: 'naturalNodeContentSize',
    },
    rust: { file: 'crates/bindings/wasm/src/spatial_layout/query.rs', fn: 'layout_query' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'layoutQuery',
    },
    handed: { deleted: COMPOSER_TYPESCRIPT },
  },
  {
    name: 'fittedTextNodeHeight',
    stage: 4,
    ts: {
      file: 'packages/canvas-render/src/layout/fitted-height.ts',
      export: 'fittedTextNodeHeight',
    },
    rust: { file: 'crates/bindings/wasm/src/spatial_layout/query.rs', fn: 'layout_query' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'layoutQuery',
    },
    handed: { deleted: TYPESETTER_TYPESCRIPT },
  },
  {
    name: 'edgeLabelPlacement',
    stage: 2,
    ts: {
      file: 'packages/canvas-render/src/layout/edges/edge-label-anchor.ts',
      export: 'edgeLabelPlacement',
    },
    rust: { file: 'crates/bindings/wasm/src/spatial_layout/query.rs', fn: 'layout_query' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'layoutQuery',
    },
  },
  {
    name: 'labelObstacles',
    stage: 2,
    ts: {
      file: 'packages/canvas-render/src/layout/edges/edge-label-anchor.ts',
      export: 'labelObstacles',
    },
    rust: { file: 'crates/bindings/wasm/src/spatial_layout/query.rs', fn: 'layout_query' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'layoutQuery',
    },
  },
  {
    name: 'frameTitleObstacles',
    stage: 2,
    ts: {
      file: 'packages/canvas-render/src/layout/edges/edge-label-anchor.ts',
      export: 'frameTitleObstacles',
    },
    rust: { file: 'crates/bindings/wasm/src/spatial_layout/query.rs', fn: 'layout_query' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'layoutQuery',
    },
  },
  {
    name: 'placeCommentBubble',
    stage: 4,
    ts: { file: 'packages/canvas-render/src/layout/queries.ts', export: 'queryCommentBubble' },
    rust: { file: 'crates/bindings/wasm/src/spatial_layout/query.rs', fn: 'layout_query' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'layoutQuery',
    },
    handed: { deleted: COMMENT_TYPESCRIPT },
  },
  {
    name: 'outlineContentBox',
    stage: 2,
    ts: {
      file: 'packages/canvas-render/src/outline/node-outline.ts',
      export: 'outlineContentBox',
    },
    rust: { file: 'crates/bindings/wasm/src/spatial_layout/query.rs', fn: 'layout_query' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'layoutQuery',
    },
  },
  // A body's parse and its reference resolution have no entry of their own:
  // the core reaches them only through the whole layout, so that export is
  // the shim's member.
  {
    name: 'parseMarkdownBody',
    stage: 2,
    ts: { file: 'packages/codec/src/markdown/pipeline.ts', export: 'parseMarkdownBody' },
    rust: { file: 'crates/core/codec/src/markdown/mod.rs', fn: 'parse_markdown_body' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'layoutSpatialCanvas',
    },
  },
  {
    name: 'resolveReferences',
    stage: 2,
    ts: { file: 'packages/codec/src/references/resolve.ts', export: 'resolveReferences' },
    rust: { file: 'crates/core/codec/src/references/resolve.rs', fn: 'resolve_references' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'layoutSpatialCanvas',
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
    stage: 4,
    ts: { file: 'packages/codec/src/spatial/spatial-core.ts', export: 'parseSpatial' },
    rust: { file: 'crates/bindings/wasm/src/json_canvas.rs', fn: 'json_canvas_parse' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'parseSpatial',
    },
    realm: { install: 'installSpatialCore', deleted: SPATIAL_TYPESCRIPT },
  },
  {
    name: 'serializeSpatial',
    stage: 4,
    ts: { file: 'packages/codec/src/spatial/spatial-core.ts', export: 'serializeSpatial' },
    rust: { file: 'crates/bindings/wasm/src/json_canvas.rs', fn: 'json_canvas_serialize' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'serializeSpatial',
    },
    realm: { install: 'installSpatialCore', deleted: SPATIAL_TYPESCRIPT },
  },
  {
    // The judgement of a facets bucket and the stencil library's refusal are
    // one call over the wire, so one entry answers both. The name is the
    // function the TypeScript judged with, which the Rust export and the parity
    // doc still call it; the dispatcher a writer asks for the core is
    // `facetWriteCore`.
    name: 'partitionFacetWrites',
    stage: 4,
    ts: { file: 'packages/server-core/src/facet-write-core.ts', export: 'facetWriteCore' },
    rust: { file: 'crates/bindings/wasm/src/facet_write.rs', fn: 'facet_bucket_check' },
    shim: {
      module: '@kamiazya/whiteboard-core-wasm',
      file: 'packages/core-wasm/src/index.ts',
      member: 'facetBucketCheck',
    },
    realm: { install: 'installFacetWriteCore', deleted: FACET_WRITE_TYPESCRIPT },
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

/**
 * The member names of `<interface>['impl']`'s type literal, or `undefined`
 * when it has none: a per-function switch, which S18g retired from `LayoutCore`.
 */
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

/** Stage 4's third shape: the export asks the core it is handed, and the TypeScript gone. */
function checkHanded(
  f: PortedFunction,
  handed: NonNullable<PortedFunction['handed']>,
  declared: Set<string>,
  read: ReadFile,
): string[] {
  const problems: string[] = []
  if (!declared.has(f.ts.export)) {
    problems.push(`${f.name}: ${f.ts.file} no longer exports a function named ${f.ts.export}`)
  }
  for (const path of handed.deleted) {
    if (read(path) !== undefined) {
      problems.push(`${f.name}: stage 4 but ${path}, where the TypeScript lived, still exists`)
    }
  }
  return problems
}

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
  if (f.handed !== undefined) {
    return f.stage === 4
      ? checkHanded(f, f.handed, declared, read)
      : [`${f.name}: a handed core is stage 4's shape, not stage ${f.stage}'s`]
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

/** Every way the ledger and the tree disagree, one sentence each. */
export function checkPortedFunctions(ledger: readonly PortedFunction[], read: ReadFile): string[] {
  const names = ledger.map((f) => f.name)
  const twice = [...new Set(names)]
    .filter((name) => names.filter((n) => n === name).length > 1)
    .map((name) => `${name}: listed twice`)
  const perEntry = ledger.flatMap((f) => [...checkTsExport(f, read), ...checkRustSide(f, read)])
  return [...twice, ...perEntry]
}
