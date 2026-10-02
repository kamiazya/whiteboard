import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from '@typescript/typescript6'
import { walk } from './scan-roots.js'

/**
 * Which `store/` exports quietly take the PROCESS's data directory when a
 * caller does not say which one it serves, and every call site that does not
 * say.
 *
 * `findAdapterGlobalReads` matches `getDataDir(` by name, so the process
 * directory entered an adapter through a default parameter it never spelled:
 * `new FileVersionStore()` reads like a constructor and is a decision about
 * which directory, taken by nobody. The list of such exports is DERIVED from
 * the store's own signatures rather than kept by hand, so the next function
 * given a `scope = globalStoreScope` parameter is covered the day it exists.
 *
 * Two shapes are derived:
 *
 * - a trailing PARAMETER whose default is `globalStoreScope`
 *   (`getDoc(workspaceId, path, scope = globalStoreScope)`, and a constructor's
 *   the same way) — a call that passes fewer arguments than the parameter's
 *   position leaves it to the default;
 * - an OPTIONS property read as `options.scope ?? globalStoreScope` in the
 *   body (`purgeDanglingFiles(id, { scope })`) — a call whose options literal
 *   carries no `scope` does too.
 *
 * Naming `globalStoreScope` is reported too — the process's directory chosen
 * explicitly — and so is `storeScope`, which builds one. A caller handed a
 * scope has no reason to do either; `createApp`, which derives the scope the
 * routers are handed from its layout, is the one place that does, and is
 * ledgered.
 *
 * Matching is by the exported NAME, through the identifiers a file imports
 * from a `store/` module (so a local function of the same name is not read as
 * one). A function handed on BY REFERENCE and called elsewhere
 * (`liveDoc: getWorkspaceDoc`) is reported as such, since the call that
 * decides the directory is then in code this scan does not follow.
 */

type Shape = { readonly kind: 'parameter' | 'options'; readonly index: number }

const GLOBAL_SCOPE = 'globalStoreScope'

/** Names that CHOOSE the directory: the process's, or one built from a layout. */
const SCOPE_CHOICES: ReadonlySet<string> = new Set([GLOBAL_SCOPE, 'storeScope'])

function isStoreSource(file: string): boolean {
  return (
    file.endsWith('.ts') &&
    !file.endsWith('.test.ts') &&
    !/(^|[\\/])_test-/.test(file) &&
    !/(^|[\\/])migrations[\\/]/.test(file)
  )
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
}

/** `options.scope ?? globalStoreScope` anywhere in `body`, naming which parameter `options` is. */
function optionsScopeParameter(
  params: readonly ts.ParameterDeclaration[],
  body: ts.Node | undefined,
): number | null {
  if (body === undefined) return null
  let found: number | null = null
  const visit = (node: ts.Node): void => {
    if (
      found === null &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ts.isIdentifier(node.right) &&
      node.right.text === GLOBAL_SCOPE &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression)
    ) {
      const owner = node.left.expression.text
      const index = params.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === owner)
      if (index >= 0) found = index
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return found
}

function shapeOf(
  params: readonly ts.ParameterDeclaration[],
  body: ts.Node | undefined,
): Shape | null {
  const defaulted = params.findIndex(
    (p) =>
      p.initializer !== undefined &&
      ts.isIdentifier(p.initializer) &&
      p.initializer.text === GLOBAL_SCOPE,
  )
  if (defaulted >= 0) return { kind: 'parameter', index: defaulted }
  const options = optionsScopeParameter(params, body)
  return options === null ? null : { kind: 'options', index: options }
}

function functionLike(
  node: ts.Node | undefined,
): { params: readonly ts.ParameterDeclaration[]; body: ts.Node | undefined } | null {
  if (node === undefined) return null
  if (ts.isFunctionDeclaration(node)) return { params: node.parameters, body: node.body }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return { params: node.parameters, body: node.body }
  }
  return null
}

function classShape(node: ts.ClassDeclaration): Shape | null {
  for (const member of node.members) {
    if (ts.isConstructorDeclaration(member)) return shapeOf(member.parameters, member.body)
  }
  return null
}

function variableShapes(statement: ts.VariableStatement): [string, Shape][] {
  const entries: [string, Shape][] = []
  for (const declaration of statement.declarationList.declarations) {
    const fn = functionLike(declaration.initializer)
    const shape = fn === null ? null : shapeOf(fn.params, fn.body)
    if (shape !== null && ts.isIdentifier(declaration.name)) {
      entries.push([declaration.name.text, shape])
    }
  }
  return entries
}

/** The `name -> shape` entries one top-level statement exports, if it exports a defaulting one. */
function statementShapes(statement: ts.Statement): [string, Shape][] {
  if (!hasExportModifier(statement)) return []
  if (ts.isVariableStatement(statement)) return variableShapes(statement)
  if (!(ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))) return []
  if (statement.name === undefined) return []
  const shape = ts.isClassDeclaration(statement)
    ? classShape(statement)
    : shapeOf(statement.parameters, statement.body)
  return shape === null ? [] : [[statement.name.text, shape]]
}

function exportedShapes(source: ts.SourceFile, into: Map<string, Shape>): void {
  for (const statement of source.statements) {
    for (const [name, shape] of statementShapes(statement)) into.set(name, shape)
  }
}

/**
 * Every `store/` export that takes the process's directory when not told one,
 * by name. `srcDir` is `packages/mcp-server/src`.
 */
export function scopeDefaultingExports(srcDir: string): ReadonlyMap<string, Shape> {
  const shapes = new Map<string, Shape>()
  for (const file of walk(join(srcDir, 'server', 'store'), { include: isStoreSource })) {
    exportedShapes(parse(file), shapes)
  }
  return shapes
}

/** Local name -> exported name, for what `source` imports from a `store/` module. */
function storeImports(source: ts.SourceFile): Map<string, string> {
  const locals = new Map<string, string>()
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    if (!/(^|\/)store\/[^'"]+$/.test(statement.moduleSpecifier.text)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      locals.set(element.name.text, (element.propertyName ?? element.name).text)
    }
  }
  return locals
}

function unwrap(expression: ts.Expression): ts.Expression {
  let e = expression
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression
  return e
}

/** The identifiers a callee expression may resolve to: `a`, `(a ?? b)`, `x ? a : b`. */
function calleeIdentifiers(expression: ts.Expression): ts.Identifier[] {
  const e = unwrap(expression)
  if (ts.isIdentifier(e)) return [e]
  if (ts.isBinaryExpression(e)) {
    return [...calleeIdentifiers(e.left), ...calleeIdentifiers(e.right)]
  }
  if (ts.isConditionalExpression(e)) {
    return [...calleeIdentifiers(e.whenTrue), ...calleeIdentifiers(e.whenFalse)]
  }
  return []
}

function carriesScope(argument: ts.Expression): boolean | 'unknown' {
  const e = unwrap(argument)
  if (!ts.isObjectLiteralExpression(e)) return 'unknown'
  return e.properties.some(
    (p) =>
      ts.isSpreadAssignment(p) ||
      ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        p.name.getText() === 'scope'),
  )
}

/** Whether a call with `args` leaves the directory to the default. */
function leavesDefault(shape: Shape, args: readonly ts.Expression[]): boolean {
  if (args.some((a) => ts.isSpreadElement(a))) return false
  const at = args[shape.index]
  if (at === undefined) return true
  if (shape.kind === 'parameter') {
    // An explicit `undefined` is the same omission spelled out.
    return ts.isIdentifier(at) && at.text === 'undefined'
  }
  return carriesScope(at) === false
}

function inTypePosition(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (ts.isTypeNode(n)) return true
    if (ts.isStatement(n)) return false
  }
  return false
}

interface Reader {
  /** What `name` is, if it is a `store/` export that defaults to the process directory. */
  readonly defaulting: (name: string) => { exported: string; shape: Shape } | null
  /** The scope-choosing export `name` is, when it is one imported from `store/`. */
  readonly chosenScope: (name: string) => string | null
}

function readerOf(source: ts.SourceFile, shapes: ReadonlyMap<string, Shape>): Reader {
  const locals = storeImports(source)
  return {
    defaulting: (name) => {
      const exported = locals.get(name)
      const shape = exported === undefined ? undefined : shapes.get(exported)
      return exported === undefined || shape === undefined ? null : { exported, shape }
    },
    chosenScope: (name) => {
      const exported = locals.get(name)
      return exported !== undefined && SCOPE_CHOICES.has(exported) ? exported : null
    },
  }
}

function scanSource(
  source: ts.SourceFile,
  shapes: ReadonlyMap<string, Shape>,
  into: Set<string>,
  label: string,
): void {
  const reader = readerOf(source, shapes)
  const handledAsCallee = new Set<ts.Node>()
  const visitCall = (node: ts.CallExpression | ts.NewExpression): void => {
    const args = node.arguments ? [...node.arguments] : []
    for (const callee of calleeIdentifiers(node.expression)) {
      handledAsCallee.add(callee)
      const chosen = reader.chosenScope(callee.text)
      if (chosen !== null) into.add(`${label} -> ${chosen}`)
      const hit = reader.defaulting(callee.text)
      if (hit !== null && leavesDefault(hit.shape, args)) into.add(`${label} -> ${hit.exported}`)
    }
  }
  const visitReference = (node: ts.Identifier): void => {
    const chosen = reader.chosenScope(node.text)
    if (chosen !== null) {
      // Naming one is choosing it, however it is then used.
      into.add(`${label} -> ${chosen}`)
      return
    }
    const hit = reader.defaulting(node.text)
    if (hit !== null) into.add(`${label} -> ${hit.exported} (by reference)`)
  }
  const isReference = (node: ts.Identifier): boolean =>
    !handledAsCallee.has(node) && !ts.isImportSpecifier(node.parent) && !inTypePosition(node)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) visitCall(node)
    else if (ts.isIdentifier(node) && isReference(node)) visitReference(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
}

/**
 * Every `<file> -> <store export>` where a population file calls (or hands on)
 * a scope-defaulting export without saying which directory it serves.
 *
 * `files` are paths under `serverDir` (`packages/mcp-server/src/server`),
 * already filtered to the population.
 */
export function findScopeDefaultedCalls(srcDir: string, files: readonly string[]): string[] {
  const shapes = scopeDefaultingExports(srcDir)
  const serverDir = join(srcDir, 'server')
  const found = new Set<string>()
  for (const file of files) {
    scanSource(parse(file), shapes, found, relative(serverDir, file).split('\\').join('/'))
  }
  return [...found].sort()
}
