/**
 * Counts the fixed-duration sleeps in one test file.
 *
 * Three spellings of the same wait for TIME, because a probe for only the
 * first is how the other two went unledgered:
 *
 * - `new Promise((r) => setTimeout(r, <expr>))` inline, with any FIXED delay
 *   that is not the literal 0 — a constant offset such as `PAUSE_MS + 50` is
 *   as fixed as `50`. A delay read from a parameter, `this` or a property is
 *   a fake's injected latency (the code under test waiting on a slow
 *   dependency), which no condition could replace, so it is not counted;
 * - a call to a LOCAL helper whose whole body is that promise over its own
 *   parameter (`const sleep = (ms) => new Promise((r) => setTimeout(r, ms))`)
 *   — the definition is not counted, each call is, since each call is a wait.
 *   A function that sleeps and then does more is a fake with injected
 *   latency, so a call to it is configuration rather than a wait;
 * - the one-argument call of `setTimeout` imported from `node:timers/promises`.
 *   The two-argument form resolves a value for a `Promise.race` timeout, which
 *   bounds a wait rather than being one.
 *
 * A call is counted by what its name RESOLVES to, not by the name: a
 * parameter or local that shadows the helper or the import is some other
 * function, and a call through it waits on whatever was passed in.
 *
 * Parsed rather than matched by regex: the delay is an arbitrary expression,
 * and balanced parentheses are not a regular language.
 */
import ts from '@typescript/typescript6'

interface PromiseSleep {
  readonly node: ts.NewExpression
  readonly delay: ts.Expression | undefined
  readonly owner: ts.FunctionLikeDeclaration | undefined
}

const TIMERS_MODULES = new Set(['node:timers/promises', 'timers/promises'])

function isZeroLiteral(node: ts.Expression | undefined): boolean {
  return node === undefined || (ts.isNumericLiteral(node) && Number(node.text) === 0)
}

function isParameterOfEnclosingFunction(node: ts.Identifier): boolean {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue
    const bound = (current as ts.SignatureDeclarationBase).parameters
    if (bound.some((p) => ts.isIdentifier(p.name) && p.name.text === node.text)) return true
  }
  return false
}

/** Literals and constants combined arithmetically: what a test author wrote as a duration. */
function isFixedDuration(node: ts.Expression): boolean {
  if (ts.isNumericLiteral(node)) return true
  if (ts.isIdentifier(node)) return !isParameterOfEnclosingFunction(node)
  if (ts.isParenthesizedExpression(node)) return isFixedDuration(node.expression)
  if (ts.isBinaryExpression(node)) {
    return isFixedDuration(node.left) && isFixedDuration(node.right)
  }
  return false
}

function isFixedNonZero(node: ts.Expression | undefined): boolean {
  return node !== undefined && !isZeroLiteral(node) && isFixedDuration(node)
}

/** `resolve` in `new Promise((resolve) => ...)`, or undefined for any other shape. */
function resolverName(executor: ts.Expression | undefined): string | undefined {
  if (executor === undefined) return undefined
  if (!ts.isArrowFunction(executor) && !ts.isFunctionExpression(executor)) return undefined
  const first = executor.parameters[0]
  return first !== undefined && ts.isIdentifier(first.name) ? first.name.text : undefined
}

/** The `setTimeout(resolve, <delay>)` an executor hands its resolver to. */
function findResolverTimeout(executor: ts.Node, resolver: string): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'setTimeout' &&
      node.arguments[0] !== undefined &&
      ts.isIdentifier(node.arguments[0]) &&
      node.arguments[0].text === resolver
    ) {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(executor)
  return found
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current)
    ) {
      return current
    }
  }
  return undefined
}

function asPromiseSleep(node: ts.NewExpression): PromiseSleep | undefined {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'Promise') return undefined
  const executor = node.arguments?.[0]
  const resolver = resolverName(executor)
  if (executor === undefined || resolver === undefined) return undefined
  const timeout = findResolverTimeout(executor, resolver)
  if (timeout === undefined) return undefined
  return { node, delay: timeout.arguments[1], owner: enclosingFunction(node) }
}

/** The declaration a function is bound through: itself, or the `const` it initialises. */
function boundDeclaration(fn: ts.FunctionLikeDeclaration): ts.Node | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name === undefined ? undefined : fn
  const parent = fn.parent
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent : undefined
}

function unwrapAwait(expression: ts.Expression): ts.Expression {
  return ts.isAwaitExpression(expression) ? expression.expression : expression
}

/**
 * Whether `expression` is the WHOLE of `owner`'s body: an expression body, or
 * one statement that returns or awaits it. A function that sleeps and then
 * does something else is a fake with injected latency, not a sleep helper,
 * and a call to it with a literal is that fake's configuration.
 */
function isWholeBody(owner: ts.FunctionLikeDeclaration, expression: ts.Expression): boolean {
  const body = owner.body
  if (body === undefined) return false
  if (!ts.isBlock(body)) return unwrapAwait(body) === expression
  const [only] = body.statements
  if (only === undefined || body.statements.length !== 1) return false
  if (ts.isReturnStatement(only)) {
    return only.expression !== undefined && unwrapAwait(only.expression) === expression
  }
  return ts.isExpressionStatement(only) && unwrapAwait(only.expression) === expression
}

/** The helper a promise-sleep DEFINES: its delay is the owner's own first parameter, and it is the owner's whole body. */
function definedHelper(sleep: PromiseSleep): ts.Node | undefined {
  const { node, delay, owner } = sleep
  const first = owner?.parameters[0]
  if (delay === undefined || owner === undefined || first === undefined) return undefined
  const isOwnParameter =
    ts.isIdentifier(delay) && ts.isIdentifier(first.name) && delay.text === first.name.text
  return isOwnParameter && isWholeBody(owner, node) ? boundDeclaration(owner) : undefined
}

/** The import specifiers that bind `setTimeout` from `node:timers/promises`. */
function timerAliases(sourceFile: ts.SourceFile): Set<ts.Node> {
  const aliases = new Set<ts.Node>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    if (!TIMERS_MODULES.has(statement.moduleSpecifier.text)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'setTimeout') aliases.add(element)
    }
  }
  return aliases
}

/** What one statement declares under `name`: a function, a variable, or a named import. */
function declaredBy(statement: ts.Statement, name: string): ts.Node | undefined {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name?.text === name ? statement : undefined
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.find(
      (d) => ts.isIdentifier(d.name) && d.name.text === name,
    )
  }
  if (ts.isImportDeclaration(statement)) {
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) return undefined
    return bindings.elements.find((e) => e.name.text === name)
  }
  return undefined
}

function declaredIn(statements: readonly ts.Statement[], name: string): ts.Node | undefined {
  for (const statement of statements) {
    const found = declaredBy(statement, name)
    if (found !== undefined) return found
  }
  return undefined
}

/** What `scope` itself binds `name` to, if anything. */
function bindingIn(scope: ts.Node, name: string): ts.Node | undefined {
  if (ts.isFunctionLike(scope)) {
    return (scope as ts.SignatureDeclarationBase).parameters.find(
      (p) => ts.isIdentifier(p.name) && p.name.text === name,
    )
  }
  if (ts.isCatchClause(scope)) {
    const variable = scope.variableDeclaration
    return variable !== undefined && ts.isIdentifier(variable.name) && variable.name.text === name
      ? variable
      : undefined
  }
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
    return declaredIn(scope.statements, name)
  }
  return undefined
}

/**
 * The declaration `name` resolves to from `from`, by lexical scope. A name
 * alone is not a binding: a parameter or local named `delay` shadows the
 * timers import, and a call through it is whatever was passed in.
 */
function nearestBinding(from: ts.Node, name: string): ts.Node | undefined {
  for (let current = from.parent; current !== undefined; current = current.parent) {
    const found = bindingIn(current, name)
    if (found !== undefined) return found
  }
  return undefined
}

export function countFixedSleeps(source: string): number {
  if (!/setTimeout|timers\/promises/.test(source)) return 0
  const sourceFile = ts.createSourceFile(
    't.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const aliases = timerAliases(sourceFile)
  const promiseSleeps: PromiseSleep[] = []
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const sleep = asPromiseSleep(node)
      if (sleep !== undefined) promiseSleeps.push(sleep)
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  const helpers = new Set<ts.Node>()
  let count = 0
  for (const sleep of promiseSleeps) {
    const helper = definedHelper(sleep)
    if (helper !== undefined) helpers.add(helper)
    else if (isFixedNonZero(sleep.delay)) count += 1
  }
  for (const call of calls) {
    const name = (call.expression as ts.Identifier).text
    const [only, ...rest] = call.arguments
    if (rest.length > 0 || !isFixedNonZero(only)) continue
    const binding = nearestBinding(call, name)
    if (binding !== undefined && (helpers.has(binding) || aliases.has(binding))) count += 1
  }
  return count
}
