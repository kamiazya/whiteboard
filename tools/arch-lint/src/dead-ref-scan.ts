import ts from '@typescript/typescript6'
import { parseSource } from './ast-helpers.js'

/** `useRef(…)` or `React.useRef(…)`, type arguments or not. */
function isUseRefCall(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text === 'useRef'
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'useRef'
}

/** The `x` of `x.current = …` — a write, which is the one use that is not a read. */
function isCurrentWrite(identifier: ts.Identifier): boolean {
  const access = identifier.parent
  if (
    !ts.isPropertyAccessExpression(access) ||
    access.expression !== identifier ||
    access.name.text !== 'current'
  ) {
    return false
  }
  const assignment = access.parent
  return (
    ts.isBinaryExpression(assignment) &&
    assignment.left === access &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
  )
}

/**
 * The names of every `const x = useRef(…)` in `source` that nothing reads:
 * the binding appears only in its own declaration and on the left of
 * `x.current = …`. Handing the ref to `ref={x}`, reading `x.current`, or a
 * compound `x.current += …` each counts as a read.
 *
 * Matched by name within the file, so a shadowing binding of the same name
 * can only hide a dead ref, never invent one.
 */
export function writtenNeverReadRefs(fileName: string, source: string): readonly string[] {
  const file = parseSource(fileName, source)
  const declared = new Map<string, ts.Identifier>()
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isUseRefCall(node.initializer)
    ) {
      declared.set(node.name.text, node.name)
    }
    ts.forEachChild(node, collect)
  }
  ts.forEachChild(file, collect)
  // A second pass, because a read may precede its declaration in source
  // order (a callback written above the ref it closes over).
  const read = new Set<string>()
  const findReads = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      declared.has(node.text) &&
      declared.get(node.text) !== node &&
      !isCurrentWrite(node)
    ) {
      read.add(node.text)
    }
    ts.forEachChild(node, findReads)
  }
  ts.forEachChild(file, findReads)
  return [...declared.keys()].filter((name) => !read.has(name))
}
