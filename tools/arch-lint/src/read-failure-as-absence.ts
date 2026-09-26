/**
 * Finds a FILE READ whose failure is answered as an absence without asking
 * whether the file was actually absent.
 *
 * `null` from a read means "there is nothing here", and only ENOENT says that.
 * Every other failure — the file is unreadable, the disk errored — says
 * nothing about whether something is there, and a caller that acts on the
 * `null` can destroy what it could not read. Measured: the daemon identity
 * and the macaroon root key were both read this way and REPLACED on any read
 * failure, because their caller answers `null` by minting a new secret and
 * writing it over the path.
 *
 * Syntactic on purpose, and narrow on purpose. It looks only at a read call
 * (`readFile` / `readFileSync`, any receiver) guarded by a `catch` that
 * answers `null` / `undefined` / `false` / `[]` / `{}` / a missing-ish
 * `kind`, or answers nothing at all, and whose handler never mentions
 * `ENOENT`. The wider family — any failure answered as absence — is hundreds
 * of sites, most of them right (a platform probe, user input), and a scan
 * that cries wolf is a scan people delete.
 */
import ts from '@typescript/typescript6'

export interface AbsenceSite {
  /** `path#enclosingFunction`, stable across edits that only move lines. */
  readonly key: string
  readonly line: number
  readonly answer: string
}

const READ_CALL = /\b(readFile|readFileSync)\s*\(/

const MISSING_KIND = /not-?found|missing|absent|empty|none/i

/** `{ kind: 'missing' }` and its spellings: a union's way of saying "absent". */
function missingKind(e: ts.ObjectLiteralExpression): string | null {
  for (const p of e.properties) {
    if (
      ts.isPropertyAssignment(p) &&
      p.name.getText() === 'kind' &&
      ts.isStringLiteral(p.initializer) &&
      MISSING_KIND.test(p.initializer.text)
    ) {
      return `{ kind: '${p.initializer.text}' }`
    }
  }
  return null
}

/** Each way an expression says "nothing here", tried in order. */
const ABSENCES: readonly ((e: ts.Expression) => string | null)[] = [
  (e) => (e.kind === ts.SyntaxKind.NullKeyword ? 'null' : null),
  (e) => (e.kind === ts.SyntaxKind.FalseKeyword ? 'false' : null),
  (e) =>
    (ts.isIdentifier(e) && e.text === 'undefined') || ts.isVoidExpression(e) ? 'undefined' : null,
  (e) => (ts.isArrayLiteralExpression(e) && e.elements.length === 0 ? '[]' : null),
  (e) => (ts.isObjectLiteralExpression(e) && e.properties.length === 0 ? '{}' : null),
  (e) => (ts.isObjectLiteralExpression(e) ? missingKind(e) : null),
]

function absenceOf(expr: ts.Expression | undefined): string | null {
  let e = expr
  while (e !== undefined && ts.isParenthesizedExpression(e)) e = e.expression
  if (e === undefined) return 'undefined'
  for (const absence of ABSENCES) {
    const answer = absence(e)
    if (answer !== null) return answer
  }
  return null
}

/** What a handler body answers, when that answer is an absence. */
function handlerAnswer(body: ts.ConciseBody): string | null {
  if (!ts.isBlock(body)) return absenceOf(body)
  if (body.statements.length === 0) return 'nothing'
  const last = body.statements[body.statements.length - 1]
  return last !== undefined && ts.isReturnStatement(last) ? absenceOf(last.expression) : null
}

function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name)
      return n.name.getText()
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isVariableDeclaration(n.parent)
    ) {
      return n.parent.name.getText()
    }
  }
  return '<module>'
}

interface Found {
  readonly node: ts.Node
  readonly answer: string
}

/** `try { readFile… } catch { return null }` with no ENOENT in the handler. */
function tryStatementSite(node: ts.Node): Found | null {
  if (!ts.isTryStatement(node) || !node.catchClause || !READ_CALL.test(node.tryBlock.getText()))
    return null
  const handler = node.catchClause.block
  const answer = handlerAnswer(handler)
  return answer === null || handler.getText().includes('ENOENT')
    ? null
    : { node: node.catchClause, answer }
}

/** `readFile(…).catch(() => null)` with no ENOENT in the callback. */
function promiseCatchSite(node: ts.Node): Found | null {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    node.expression.name.text !== 'catch' ||
    !READ_CALL.test(node.expression.expression.getText())
  ) {
    return null
  }
  const fn = node.arguments[0]
  if (fn === undefined || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null
  const answer = handlerAnswer(fn.body)
  return answer === null || fn.body.getText().includes('ENOENT') ? null : { node, answer }
}

export function findReadFailuresAsAbsence(path: string, source: string): AbsenceSite[] {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const sites: AbsenceSite[] = []
  const visit = (node: ts.Node): void => {
    const found = tryStatementSite(node) ?? promiseCatchSite(node)
    if (found !== null) {
      sites.push({
        key: `${path}#${enclosingName(found.node)}`,
        line: sf.getLineAndCharacterOfPosition(found.node.getStart()).line + 1,
        answer: found.answer,
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}
