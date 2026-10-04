import ts from '@typescript/typescript6'

/** Calls that parse a string as markup into the live document. */
const PARSING_CALLS: ReadonlySet<string> = new Set([
  'insertAdjacentHTML',
  'setHTMLUnsafe',
  'createContextualFragment',
])

/** Properties whose assignment parses a string as markup. */
const MARKUP_PROPERTIES: ReadonlySet<string> = new Set(['innerHTML', 'outerHTML'])

function scriptKind(fileName: string): ts.ScriptKind {
  return fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

const isAssignment = (kind: ts.SyntaxKind): boolean =>
  kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment

/** The markup property an assignment target names, through `.x` or `['x']`. */
function markupTarget(target: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(target)) {
    return MARKUP_PROPERTIES.has(target.name.text) ? target.name.text : undefined
  }
  if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
    return MARKUP_PROPERTIES.has(target.argumentExpression.text)
      ? target.argumentExpression.text
      : undefined
  }
  return undefined
}

const nameText = (name: ts.Node): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined

function sinkAt(node: ts.Node): string | undefined {
  // `<div dangerouslySetInnerHTML=… />`, and the same key in a props object
  // handed to `createElement` or spread into an element.
  if (ts.isJsxAttribute(node) && node.name.getText() === 'dangerouslySetInnerHTML') {
    return 'dangerouslySetInnerHTML'
  }
  if (
    (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
    nameText(node.name) === 'dangerouslySetInnerHTML'
  ) {
    return 'dangerouslySetInnerHTML'
  }
  if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
    const property = markupTarget(node.left)
    return property === undefined ? undefined : `${property} =`
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    return PARSING_CALLS.has(node.expression.name.text)
      ? `${node.expression.name.text}()`
      : undefined
  }
  return undefined
}

/**
 * Every place source parses a string as markup into the live document: a
 * `dangerouslySetInnerHTML` (attribute or props key), an assignment to
 * `innerHTML`/`outerHTML`, or a call to `insertAdjacentHTML`,
 * `setHTMLUnsafe` or `createContextualFragment`. One entry per occurrence, in
 * source order.
 *
 * Read from the syntax tree so a comment or string that names a sink — most
 * of the occurrences of the word are prose explaining one — is not counted.
 */
export function htmlSinks(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  )
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const sink = sinkAt(node)
    if (sink !== undefined) found.push(sink)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** What a file is allowed: each sink kind with how many times, and why it is not scene SVG. */
export interface SinkEntry {
  readonly sinks: Readonly<Record<string, number>>
  readonly reason: string
}

const tally = (found: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const sink of found) counts[sink] = (counts[sink] ?? 0) + 1
  return counts
}

/**
 * The disagreements between what was found and what the ledger says, in both
 * directions: a file with a sink the ledger does not hold, a file holding more
 * or fewer than it claims, and an entry for a file that has none. A stale
 * entry reads exactly like a rule being kept, so it fails like a missing one.
 */
export function sinkLedgerViolations(
  found: ReadonlyMap<string, readonly string[]>,
  ledger: Readonly<Record<string, SinkEntry>>,
): string[] {
  const problems: string[] = []
  for (const [file, sinks] of found) {
    const actual = tally(sinks)
    const entry = ledger[file]
    if (entry === undefined) {
      problems.push(`${file}: unclassified ${JSON.stringify(actual)}`)
    } else if (!sameCounts(actual, entry.sinks)) {
      problems.push(
        `${file}: ledger says ${JSON.stringify(entry.sinks)}, source has ${JSON.stringify(actual)}`,
      )
    }
  }
  for (const file of Object.keys(ledger)) {
    if ((found.get(file) ?? []).length === 0) problems.push(`${file}: ledgered but has no sink`)
  }
  return problems
}

function sameCounts(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): boolean {
  const kinds = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...kinds].every((kind) => (a[kind] ?? 0) === (b[kind] ?? 0))
}
