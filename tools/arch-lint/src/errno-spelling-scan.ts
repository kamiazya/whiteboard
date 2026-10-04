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

/** `['ENOENT', 'EEXIST'].includes(err.code)`: a list of errno literals asked about a `code` read. */
function isErrnoListIncludes(node: ts.Node): boolean {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false
  const [asked] = node.arguments
  const list = unwrapExpression(node.expression.expression)
  return (
    node.expression.name.text === 'includes' &&
    asked !== undefined &&
    isCodeRead(asked) &&
    ts.isArrayLiteralExpression(list) &&
    list.elements.length > 0 &&
    list.elements.every(isErrnoLiteral)
  )
}

const COMPARISON_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
])

function isErrnoTyping(node: ts.Node): boolean {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return namesErrnoException(node.type)
  }
  return ts.isVariableDeclaration(node) && node.type !== undefined && namesErrnoException(node.type)
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

const SPELLINGS: readonly ((node: ts.Node) => boolean)[] = [
  isErrnoTyping,
  isErrnoComparison,
  isErrnoSwitchCase,
  isErrnoListIncludes,
]

/**
 * The places source reads what an error's `code` says by hand, one entry per
 * spelling found.
 *
 * Two families, read from the syntax tree because a text pattern keys on one
 * spelling of each: the TYPE that makes `.code` readable off a thrown value
 * (an assertion to `ErrnoException` or a variable declared as one, whatever
 * the alias and wherever `.code` is read afterwards), and the COMPARISON of a
 * `code` read against an errno literal (either operand order, a `switch`, an
 * `includes` over a list of them).
 */
export function errnoSpellings(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (SPELLINGS.some((isSpelling) => isSpelling(node))) found.push(node.getText(file))
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}
