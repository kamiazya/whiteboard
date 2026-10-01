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
 *   — the definition is not counted, each call is, since each call is a wait;
 * - the one-argument call of `setTimeout` imported from `node:timers/promises`.
 *   The two-argument form resolves a value for a `Promise.race` timeout, which
 *   bounds a wait rather than being one.
 *
 * Parsed rather than matched by regex: the delay is an arbitrary expression,
 * and balanced parentheses are not a regular language.
 */
import ts from '@typescript/typescript6'

interface PromiseSleep {
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
  return { delay: timeout.arguments[1], owner: enclosingFunction(node) }
}

/** The name a function is bound to, when it is a declaration or a `const` initialiser. */
function boundName(fn: ts.FunctionLikeDeclaration): string | undefined {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text
  const parent = fn.parent
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
    ? parent.name.text
    : undefined
}

/** The helper a promise-sleep DEFINES: its delay is the owner's own first parameter. */
function definedHelper(sleep: PromiseSleep): string | undefined {
  const { delay, owner } = sleep
  const first = owner?.parameters[0]
  if (delay === undefined || owner === undefined || first === undefined) return undefined
  const isOwnParameter =
    ts.isIdentifier(delay) && ts.isIdentifier(first.name) && delay.text === first.name.text
  return isOwnParameter ? boundName(owner) : undefined
}

function timerAliases(sourceFile: ts.SourceFile): Set<string> {
  const aliases = new Set<string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }
    if (!TIMERS_MODULES.has(statement.moduleSpecifier.text)) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'setTimeout') {
        aliases.add(element.name.text)
      }
    }
  }
  return aliases
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

  const helpers = new Set<string>()
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
    if (helpers.has(name) || aliases.has(name)) count += 1
  }
  return count
}
