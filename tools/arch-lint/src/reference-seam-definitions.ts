import ts from '@typescript/typescript6'
import { parseSource, unwrapExpression } from './ast-helpers.js'

/** The four seams a layout reads to draw what a document points at. */
const SEAM_NAMES: ReadonlySet<string> = new Set([
  'resolveAlias',
  'resolveTitle',
  'resolveEmbed',
  'resolveReference',
])

export interface SeamDefinition {
  readonly name: string
  readonly shape: string
  readonly text: string
}

/** A function written out, as opposed to a call that returns one or a name that points at one. */
function isFunctionBody(expression: ts.Expression | undefined): boolean {
  if (expression === undefined) return false
  const value = unwrapExpression(expression)
  return ts.isArrowFunction(value) || ts.isFunctionExpression(value)
}

/**
 * The seam name a declaration or key spells: bare, quoted (`'resolveEmbed':`),
 * or computed over a string (`['resolveEmbed']:`) all name the same seam.
 */
function seamNameOf(name: ts.Node | undefined): string | undefined {
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return SEAM_NAMES.has(name.text) ? name.text : undefined
  }
  if (ts.isComputedPropertyName(name)) return seamNameOf(unwrapExpression(name.expression))
  return undefined
}

/** The member a write targets: `seams.resolveTitle = …` and `seams['resolveTitle'] = …`. */
function assignedSeamName(target: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(target)) return seamNameOf(target.name)
  if (ts.isElementAccessExpression(target)) return seamNameOf(target.argumentExpression)
  return undefined
}

type Hit = Pick<SeamDefinition, 'name' | 'shape'>

function named(name: string | undefined, shape: string): Hit | undefined {
  return name === undefined ? undefined : { name, shape }
}

/** What `node` defines, when it is a definition of a seam. */
function definitionOf(node: ts.Node): Hit | undefined {
  if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
    return named(seamNameOf(node.name), 'a function declaration named for a seam')
  }
  if (ts.isVariableDeclaration(node) && isFunctionBody(node.initializer)) {
    return named(seamNameOf(node.name), 'a function bound to a seam name')
  }
  if (
    (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) &&
    isFunctionBody(node.initializer)
  ) {
    return named(seamNameOf(node.name), 'a function assigned to a seam key')
  }
  if (ts.isMethodDeclaration(node) && node.body !== undefined) {
    return named(seamNameOf(node.name), 'a method-shorthand seam')
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    isFunctionBody(node.right)
  ) {
    return named(assignedSeamName(node.left), 'a function assigned to a seam member')
  }
  return undefined
}

/**
 * Every place `source` DEFINES a reference seam, read from the syntax tree so
 * a spelling is judged by what it declares and not by how it is laid out. A
 * seam is defined by a function declaration with a body, a binding, property
 * or class field whose value is a written-out function, a method, or an
 * assignment of one to a member. Passing one on (`x: options.x`, shorthand
 * `{ x }`, a call result, a destructure) and mere TYPES of one (an interface
 * member, an overload, `declare function`) define nothing — a shorthand that
 * hands on a locally DECLARED function is caught at the declaration.
 */
export function findSeamDefinitions(fileName: string, source: string): SeamDefinition[] {
  const file = parseSource(fileName, source)
  const found: SeamDefinition[] = []
  const visit = (node: ts.Node): void => {
    const hit = definitionOf(node)
    if (hit !== undefined) {
      found.push({ ...hit, text: node.getText(file).replace(/\s+/g, ' ').trim().slice(0, 80) })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}
