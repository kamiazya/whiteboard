import ts from '@typescript/typescript6'
import { parseSource, unwrapExpression } from './ast-helpers.js'

/** Calls that parse a string as markup into the live document. */
const PARSING_CALLS: ReadonlySet<string> = new Set([
  'insertAdjacentHTML',
  'setHTMLUnsafe',
  'createContextualFragment',
])

/**
 * Properties whose assignment parses a string as markup. `srcdoc` is a whole
 * document an iframe parses and runs, so it is a sink in the same sense.
 */
const MARKUP_PROPERTIES: ReadonlySet<string> = new Set(['innerHTML', 'outerHTML', 'srcdoc'])

/** The attribute a script writes with `setAttribute` to hand an iframe markup. */
const MARKUP_ATTRIBUTES: ReadonlySet<string> = new Set(['srcdoc'])

const DOCUMENT_WRITERS: ReadonlySet<string> = new Set(['write', 'writeln'])

/** Names a receiver goes by when it is the document being written to. */
const DOCUMENT_NAMES: ReadonlySet<string> = new Set([
  'document',
  'contentDocument',
  'ownerDocument',
])

const PROPS_KEY = 'dangerouslySetInnerHTML'

/**
 * Whether a file might hold a sink, cheaply enough to skip parsing the ones
 * that cannot. Built from the same sets the scan reads, so a spelling added to
 * one is never skipped by a hand-kept copy of the other; `write` alone is too
 * common to be a signal, so it counts only beside a document name.
 */
const SINK_WORDS = new RegExp(
  [...PARSING_CALLS, ...MARKUP_PROPERTIES, ...MARKUP_ATTRIBUTES, PROPS_KEY].join('|'),
  'i',
)
const DOCUMENT_WRITE = new RegExp(String.raw`\b(${[...DOCUMENT_WRITERS].join('|')})\b`)
const DOCUMENT_WORD = new RegExp([...DOCUMENT_NAMES].join('|'), 'i')

export function mayHoldHtmlSink(source: string): boolean {
  return SINK_WORDS.test(source) || (DOCUMENT_WRITE.test(source) && DOCUMENT_WORD.test(source))
}

const isAssignment = (kind: ts.SyntaxKind): boolean =>
  kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment

/** A name written as an identifier or a string, computed or not: `x`, `'x'`, `['x']`. */
function nameText(name: ts.Node): string | undefined {
  if (ts.isComputedPropertyName(name)) return nameText(name.expression)
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined
}

/** The string a key or argument spells, when it is written as a literal. */
const literalText = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined

/** The name a member access reads, through `.x` or `['x']`. */
function memberName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  if (ts.isElementAccessExpression(expression)) return literalText(expression.argumentExpression)
  return undefined
}

/** The markup property an assignment target names, through `.x` or `['x']`. */
function markupTarget(target: ts.Expression): string | undefined {
  const name = memberName(target)
  return name !== undefined && MARKUP_PROPERTIES.has(name) ? name : undefined
}

/** The markup property an object literal hands to `Object.assign`, if it writes one. */
function assignedMarkupProperty(argument: ts.Expression): string | undefined {
  const literal = unwrapExpression(argument)
  if (!ts.isObjectLiteralExpression(literal)) return undefined
  for (const property of literal.properties) {
    const name =
      ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
        ? nameText(property.name)
        : undefined
    if (name !== undefined && MARKUP_PROPERTIES.has(name)) return name
  }
  return undefined
}

/** `document.write`, through `window.document`, an iframe's `contentDocument` or a node's `ownerDocument`. */
function writesToDocument(callee: ts.Expression): string | undefined {
  const writer = memberName(callee)
  if (writer === undefined || !DOCUMENT_WRITERS.has(writer)) return undefined
  const receiver =
    ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
      ? unwrapExpression(callee.expression)
      : undefined
  if (receiver === undefined) return undefined
  const named = ts.isIdentifier(receiver) ? receiver.text : memberName(receiver)
  return named !== undefined && DOCUMENT_NAMES.has(named) ? `document.${writer}()` : undefined
}

/** A call through `Object.assign` or `Reflect.set`, which write a property by another name. */
function writeByHelper(
  callee: ts.Expression,
  args: ts.NodeArray<ts.Expression>,
): string | undefined {
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression))
    return undefined
  const helper = `${callee.expression.text}.${callee.name.text}`
  if (helper === 'Object.assign') {
    const property = args
      .slice(1)
      .map(assignedMarkupProperty)
      .find((name) => name !== undefined)
    return property === undefined ? undefined : `Object.assign(${property})`
  }
  if (helper === 'Reflect.set') {
    const property = literalText(args[1])
    return property !== undefined && MARKUP_PROPERTIES.has(property)
      ? `Reflect.set(${property})`
      : undefined
  }
  return undefined
}

function callSink(node: ts.CallExpression): string | undefined {
  const callee = unwrapExpression(node.expression)
  const called = memberName(callee)
  if (called !== undefined && PARSING_CALLS.has(called)) return `${called}()`
  if (called === 'setAttribute' && MARKUP_ATTRIBUTES.has(literalText(node.arguments[0]) ?? '')) {
    return `setAttribute(${literalText(node.arguments[0])})`
  }
  return writesToDocument(callee) ?? writeByHelper(callee, node.arguments)
}

function sinkAt(node: ts.Node): string | undefined {
  // `<div dangerouslySetInnerHTML=… />`, and the same key in a props object
  // handed to `createElement` or spread into an element.
  if (ts.isJsxAttribute(node) && node.name.getText() === PROPS_KEY) return PROPS_KEY
  if (
    (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
    nameText(node.name) === PROPS_KEY
  ) {
    return PROPS_KEY
  }
  if (ts.isBinaryExpression(node) && isAssignment(node.operatorToken.kind)) {
    const property = markupTarget(node.left)
    return property === undefined ? undefined : `${property} =`
  }
  return ts.isCallExpression(node) ? callSink(node) : undefined
}

/**
 * Every place source parses a string as markup into the live document, WRITTEN
 * AS ITS OWN NAME: a `dangerouslySetInnerHTML` (attribute or props key, plain or
 * computed), an assignment to `innerHTML`/`outerHTML`/`srcdoc` or a
 * `setAttribute('srcdoc', …)`, a call to `insertAdjacentHTML`, `setHTMLUnsafe`
 * or `createContextualFragment` (dotted, bracketed, optional or wrapped in a
 * cast), `document.write`/`writeln` on a receiver named `document`,
 * `contentDocument` or `ownerDocument`, and `Object.assign(el, { innerHTML })`
 * or `Reflect.set(el, 'innerHTML', …)`. One entry per occurrence, in source
 * order.
 *
 * What a name cannot show stays unseen: a method read into a variable or
 * destructured, `.call`/`.apply` on one, a computed key that is not a literal,
 * and `write` on a document held under another name.
 *
 * Read from the syntax tree so a comment or string that names a sink — most
 * of the occurrences of the word are prose explaining one — is not counted.
 */
export function htmlSinks(fileName: string, source: string): string[] {
  const file = parseSource(fileName, source)
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
