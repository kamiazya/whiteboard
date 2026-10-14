import ts from '@typescript/typescript6'
import { parseSource, unwrapExpression } from './ast-helpers.js'

/** A POSIX errno name. No underscore, which keeps Node's own `ERR_*` codes out. */
const ERRNO_NAME = /^E[A-Z0-9]+$/

const isErrnoLiteral = (node: ts.Node): boolean =>
  ts.isStringLiteralLike(node) && ERRNO_NAME.test(node.text)

/** `code`, `x.code`, `x?.code` and `x['code']` — what an errno is read through. */
function isCodeRead(node: ts.Expression): boolean {
  const inner = unwrapExpression(node)
  if (ts.isIdentifier(inner)) return inner.text === 'code'
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text === 'code'
  return (
    ts.isElementAccessExpression(inner) &&
    ts.isStringLiteralLike(inner.argumentExpression) &&
    inner.argumentExpression.text === 'code'
  )
}

/** Whether a type mentions `ErrnoException`, under `NodeJS.` or an alias, inside a union or not. */
function namesErrnoException(type: ts.TypeNode): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName
      if ((ts.isIdentifier(name) ? name : name.right).text === 'ErrnoException') found = true
    }
    if (!found) ts.forEachChild(node, visit)
  }
  visit(type)
  return found
}

/** `{ code?: unknown }`, alone or inside a union: an inline type that makes `.code` readable. */
function namesInlineCodeMember(type: ts.TypeNode): boolean {
  let found = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeLiteralNode(node) &&
      node.members.some(
        (member) =>
          ts.isPropertySignature(member) &&
          (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) &&
          member.name.text === 'code',
      )
    ) {
      found = true
    }
    if (!found) ts.forEachChild(node, visit)
  }
  visit(type)
  return found
}

const isErrnoType = (type: ts.TypeNode): boolean =>
  namesErrnoException(type) || namesInlineCodeMember(type)

/** A non-empty array literal of errno literals, or `new Set(...)` over one. */
function isErrnoCollection(node: ts.Expression): boolean {
  const inner = unwrapExpression(node)
  const list =
    ts.isNewExpression(inner) &&
    ts.isIdentifier(inner.expression) &&
    inner.expression.text === 'Set' &&
    inner.arguments?.[0] !== undefined
      ? unwrapExpression(inner.arguments[0])
      : inner
  return (
    ts.isArrayLiteralExpression(list) &&
    list.elements.length > 0 &&
    list.elements.every(isErrnoLiteral)
  )
}

/** The names a file binds to an errno collection: `const TOLERATED = new Set(['EPERM'])`. */
function errnoCollectionNames(file: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isErrnoCollection(node.initializer)
    ) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return names
}

/**
 * `['ENOENT', 'EEXIST'].includes(err.code)`, or `.has`/`.includes` on a name
 * bound to such a list or a `Set` of one: errno literals asked about a `code`
 * read.
 */
function isErrnoCollectionQuery(node: ts.Node, collections: ReadonlySet<string>): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
  const [asked] = node.arguments
  if (asked === undefined || !isCodeRead(asked)) return false
  const method = node.expression.name.text
  const receiver = unwrapExpression(node.expression.expression)
  if (ts.isIdentifier(receiver) && collections.has(receiver.text)) {
    return method === 'has' || method === 'includes'
  }
  return (
    method === 'includes' && ts.isArrayLiteralExpression(receiver) && isErrnoCollection(receiver)
  )
}

const COMPARISON_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
])

function isErrnoTyping(node: ts.Node): boolean {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return isErrnoType(node.type)
  return ts.isVariableDeclaration(node) && node.type !== undefined && isErrnoType(node.type)
}

function isErrnoComparison(node: ts.Node): boolean {
  if (!ts.isBinaryExpression(node) || !COMPARISON_OPERATORS.has(node.operatorToken.kind)) {
    return false
  }
  const left = unwrapExpression(node.left)
  const right = unwrapExpression(node.right)
  return (isCodeRead(left) && isErrnoLiteral(right)) || (isErrnoLiteral(left) && isCodeRead(right))
}

function isErrnoSwitchCase(node: ts.Node): boolean {
  return (
    ts.isCaseClause(node) &&
    isErrnoLiteral(node.expression) &&
    ts.isSwitchStatement(node.parent.parent) &&
    isCodeRead(node.parent.parent.expression)
  )
}

const SPELLINGS: readonly ((node: ts.Node, collections: ReadonlySet<string>) => boolean)[] = [
  isErrnoTyping,
  isErrnoComparison,
  isErrnoSwitchCase,
  isErrnoCollectionQuery,
]

/**
 * The places source reads what an error's `code` says by hand, one entry per
 * spelling found.
 *
 * Two families, read from the syntax tree because a text pattern keys on one
 * spelling of each: the TYPE that makes `.code` readable off a thrown value
 * (an assertion to `ErrnoException` or to an inline type with a `code`
 * member, or a variable declared as either, whatever the alias and wherever
 * `.code` is read afterwards), and the COMPARISON of a `code` read against an
 * errno literal (either operand order, a `switch`, an `includes` over a list
 * of them, or a `has`/`includes` on a name the file binds to such a list or
 * a `Set` of one). A collection asked about `errnoCode(err)` is not a hit:
 * there the helper did the reading.
 */
export function errnoSpellings(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  const collections = errnoCollectionNames(file)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (SPELLINGS.some((isSpelling) => isSpelling(node, collections))) {
      found.push(node.getText(file))
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}
