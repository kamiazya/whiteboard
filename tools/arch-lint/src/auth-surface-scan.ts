import ts from '@typescript/typescript6'
import { parseSource } from './ast-helpers.js'

/**
 * The types a credential-gating surface holds, and the modules that export
 * them. A surface is a file that is handed one of these — however it names the
 * parameter — and then asks it what a request carries.
 */
const GATE_TYPES: ReadonlySet<string> = new Set([
  'CredentialResolver',
  'McpHttpAuthStrategy',
  'AsyncAuthStrategy',
])
const GATE_MODULES: ReadonlySet<string> = new Set([
  'credential-resolver',
  'mcp-auth',
  'oauth-resource-strategy',
])

/** The methods that answer "what does this credential carry". */
const GATE_METHODS: ReadonlySet<string> = new Set(['resolve', 'authorize'])

/** `Promise.resolve` settles a promise; it asks nothing of a credential. */
const NOT_A_GATE_RECEIVER: ReadonlySet<string> = new Set(['Promise'])

function moduleBase(specifier: string): string {
  const last = specifier.slice(specifier.lastIndexOf('/') + 1)
  return last.replace(/\.[cm]?[jt]sx?$/, '')
}

function isGateImport(node: ts.Node): boolean {
  if (!ts.isImportDeclaration(node) || !ts.isStringLiteralLike(node.moduleSpecifier)) return false
  if (GATE_MODULES.has(moduleBase(node.moduleSpecifier.text))) return true
  const bindings = node.importClause?.namedBindings
  return (
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.some((el) => GATE_TYPES.has((el.propertyName ?? el.name).text))
  )
}

function declaresGateType(node: ts.Node): boolean {
  return (
    (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
    GATE_TYPES.has(node.name.text)
  )
}

/** A key as written: `resolve`, `'resolve'` or `"resolve"`. */
function keyText(name: ts.Node | undefined): string | undefined {
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
    ? name.text
    : undefined
}

/** The method a call reads off a receiver: `x.resolve(…)` or `x['resolve'](…)`. */
function calledMethod(
  callee: ts.Expression,
): { name: string; receiver: ts.Expression } | undefined {
  if (ts.isPropertyAccessExpression(callee)) {
    return { name: callee.name.text, receiver: callee.expression }
  }
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return { name: callee.argumentExpression.text, receiver: callee.expression }
  }
  return undefined
}

/**
 * The local names a file binds a gate method to by destructuring
 * (`const { resolve } = r`, `const { authorize: ask } = strategy`). A
 * parameter or an import named `resolve` is not one: `new Promise((resolve) =>
 * …)` and `import { resolve } from 'node:path'` are not asking a credential
 * anything.
 */
function destructuredGateNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclaration(node.parent.parent) &&
      GATE_METHODS.has(keyText(node.propertyName ?? node.name) ?? '')
    ) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names
}

/**
 * The calls in `source` that gate on a credential, keyed on what the file is
 * handed rather than on what it calls the thing: a file that imports the
 * resolver or an auth strategy (or declares one) and calls `.resolve(` or
 * `.authorize(` on ANY receiver, or calls a destructured one. A receiver-name
 * pattern walked past `credentials.resolve(…)`, `strategy.authorize(…)` and a
 * destructured `resolve(…)` alike.
 *
 * Empty for a file that is not handed a gate type at all, so a `resolve` from
 * `node:path` elsewhere is never a finding.
 */
export function credentialGateCalls(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  let handed = false
  const findGate = (node: ts.Node): void => {
    if (isGateImport(node) || declaresGateType(node)) handed = true
    if (!handed) ts.forEachChild(node, findGate)
  }
  findGate(file)
  if (!handed) return []

  const destructured = destructuredGateNames(file)
  const calls: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const method = calledMethod(callee)
      if (method !== undefined) {
        const isPromise =
          ts.isIdentifier(method.receiver) && NOT_A_GATE_RECEIVER.has(method.receiver.text)
        if (GATE_METHODS.has(method.name) && !isPromise) calls.push(method.name)
      } else if (ts.isIdentifier(callee) && destructured.has(callee.text)) {
        calls.push(callee.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}
