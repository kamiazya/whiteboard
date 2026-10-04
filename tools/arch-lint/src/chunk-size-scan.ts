import ts from '@typescript/typescript6'
import { parseSource } from './ast-helpers.js'
import { aliasesOf } from './named-use-scan.js'

/** A binding or field that holds a snapshot chunk size, under any of the names writers gave it. */
const CHUNK_SIZE_NAME = /^(?:[A-Z0-9_]*CHUNK_BYTES|(?:[a-z]\w*)?[cC]hunkBytes)$/

const CHUNKER = 'chunkSnapshot'

/**
 * Whether an expression writes a number into the value: a literal anywhere in
 * it, other than as an index (`limits[0]` reads a number, it does not state
 * one). `opts.max ?? 1_000_000` and `64 * 1024` both state a size.
 */
function statesANumber(expression: ts.Node): boolean {
  if (ts.isNumericLiteral(expression)) return true
  if (ts.isElementAccessExpression(expression)) return statesANumber(expression.expression)
  return ts.forEachChild(expression, (child) => (statesANumber(child) ? true : undefined)) === true
}

const nameText = (name: ts.Node): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined

/** `name = value`, `name: value` for the declaration kinds that carry an initializer. */
function declaredSize(node: ts.Node, file: ts.SourceFile): string | undefined {
  if (ts.isPropertyAssignment(node)) {
    const name = nameText(node.name)
    return name !== undefined && CHUNK_SIZE_NAME.test(name) && statesANumber(node.initializer)
      ? `${name}: ${node.initializer.getText(file)}`
      : undefined
  }
  if (
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isParameter(node) ||
    ts.isBindingElement(node)
  ) {
    const name = nameText(node.name)
    return name !== undefined &&
      CHUNK_SIZE_NAME.test(name) &&
      node.initializer !== undefined &&
      statesANumber(node.initializer)
      ? `${name} = ${node.initializer.getText(file)}`
      : undefined
  }
  return undefined
}

/** `chunkSnapshot(bytes, <size>)` through the name, a qualifier or an aliased import, with a number stated in the size. */
function chunkerCallWithSize(
  node: ts.Node,
  aliases: ReadonlySet<string>,
  file: ts.SourceFile,
): string | undefined {
  if (!ts.isCallExpression(node)) return undefined
  const callee = node.expression
  const called = ts.isPropertyAccessExpression(callee) ? callee.name : callee
  if (!ts.isIdentifier(called) || (called.text !== CHUNKER && !aliases.has(called.text))) {
    return undefined
  }
  const size = node.arguments[1]
  return size !== undefined && statesANumber(size) ? node.getText(file) : undefined
}

/**
 * Every place source states a snapshot chunk size as a number, one entry per
 * declaration, as `name = value` / `name: value` or the `chunkSnapshot(…)` call.
 *
 * Read from the syntax tree because a text pattern keys on one spelling of
 * each: a type annotation on the constant, a lowercase name, a parameter or
 * binding default, a fallback after `??`, and a first argument that is itself
 * a call or a parenthesised expression all walked past it. A hand-over — a
 * named constant, `opts.maxChunkBytes`, a parameter with no default — states
 * no number and is not an entry.
 */
export function chunkSizeDeclarations(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  const aliases = aliasesOf(file, new Set([CHUNKER]))
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const declared = declaredSize(node, file) ?? chunkerCallWithSize(node, aliases, file)
    if (declared !== undefined) found.push(declared)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}
