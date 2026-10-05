import ts from '@typescript/typescript6'
import { parseSource } from './ast-helpers.js'

/** The name an identifier DECLARES or labels, as opposed to a use of a binding. */
function isNameSlot(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true
  if (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) return parent.name === node
  if (ts.isBindingElement(parent)) return parent.propertyName === node || parent.name === node
  if (ts.isPropertyAccessExpression(parent)) return false
  return (
    (ts.isFunctionDeclaration(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent)) &&
    parent.name === node
  )
}

/** Local names the file binds a wanted name to, by an aliased import or an aliased destructure. */
export function aliasesOf(file: ts.SourceFile, wanted: ReadonlySet<string>): Set<string> {
  const aliases = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) || ts.isBindingElement(node)) {
      const key = node.propertyName
      if (
        key !== undefined &&
        ts.isIdentifier(key) &&
        wanted.has(key.text) &&
        ts.isIdentifier(node.name)
      ) {
        aliases.add(node.name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return aliases
}

/**
 * Whether `source` can hold a use `countNamedUses` would count. Every such use spells a wanted
 * name in the text — the identifier, the key an alias is bound from, the string key — unless an
 * escape spells it instead: `\u` in an identifier, or any backslash in a string key, whose cooked
 * value drops it. So text with neither a name nor a backslash is answered 0 without the parse,
 * which is the answer the parse gives. Most files a one-place guard walks name nothing it looks
 * for, and the parse is most of what such a guard costs.
 */
function canSpellAny(source: string, names: readonly string[]): boolean {
  return source.includes('\\') || names.some((name) => source.includes(name))
}

/**
 * How many times code USES one of `names`: bare, through a property
 * (`fs.realpathSync.native`, `x.name`), through a string key (`x['name']`), or
 * through a local alias the file binds it to (`import { name as save }`,
 * `const { name: save } = …`).
 *
 * Read from the syntax tree because a text pattern on the name misses every
 * alias and every bracket access, and a one-place guard that an alias walks
 * past is a guard nobody can trust. A declaration, an import or export
 * specifier, a comment and a string that merely mentions the name are not uses.
 */
export function countNamedUses(fileName: string, source: string, names: readonly string[]): number {
  if (!canSpellAny(source, names)) return 0
  const wanted = new Set(names)
  const file = parseSource(fileName, source)
  const aliases = aliasesOf(file, wanted)

  let uses = 0
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (!isNameSlot(node) && (wanted.has(node.text) || aliases.has(node.text))) uses += 1
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      wanted.has(node.argumentExpression.text)
    ) {
      uses += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return uses
}
