import ts from '@typescript/typescript6'

export interface MeasuredFunction {
  /** `<repo-relative path>#<qualified name>` — unique, and stable under a move of lines. */
  readonly key: string
  readonly lines: number
  readonly isTest: boolean
}

/** Looks through the wrappers a call may carry on its way to the variable it initialises. */
function outermostWrapper(node: ts.Node): ts.Node {
  let current = node
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isSatisfiesExpression(current.parent) ||
    ts.isNonNullExpression(current.parent)
  )
    current = current.parent
  return current
}

/**
 * What a function-like node is called, or nothing when it is an anonymous
 * callback — whose lines already count toward the named function holding it,
 * which is the one a reader would shrink.
 *
 * Every shape here exists because the scan once went blind to it: a function
 * expression handed to `forwardRef`/`memo` (the largest function in the repo
 * was one), an arrow in a class property, and the callback of a module-level
 * `const x = Wrapper(...)` call. That last shape is limited to a statement
 * of the module itself on purpose — inside a function or a `describe` body, `const f = useCallback(() => {...})` is a
 * part of the component, not a second function to ledger.
 */
function nameOf(node: ts.Node): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name?.getText()
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return undefined
  const parent = node.parent
  if (ts.isVariableDeclaration(parent)) return parent.name.getText()
  if (ts.isFunctionExpression(node) && node.name !== undefined) return node.name.text
  if (ts.isPropertyDeclaration(parent) && parent.initializer === node) return parent.name.getText()
  if (ts.isCallExpression(parent)) {
    const call = outermostWrapper(parent)
    const declaration = call.parent
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer === call &&
      ts.isSourceFile(declaration.parent.parent.parent)
    )
      return declaration.name.getText()
  }
  return undefined
}

/**
 * Every NAMED function in a source text, with the chain of named functions
 * enclosing it.
 *
 * Qualified because a bare `path#name` collides — measured across the repo,
 * qualifying takes the colliding keys to zero.
 */
export function measureSource(text: string, relativePath: string): MeasuredFunction[] {
  const isTest = /\.(test|spec)\.tsx?$/.test(relativePath)
  const source = ts.createSourceFile(
    relativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const found: MeasuredFunction[] = []
  const visit = (node: ts.Node, chain: readonly string[]): void => {
    const name = nameOf(node)
    let inner = chain
    if (name !== undefined && (node as ts.FunctionLikeDeclaration).body !== undefined) {
      const qualified = [...chain, name].join('.')
      const from = source.getLineAndCharacterOfPosition(node.getStart(source)).line
      const to = source.getLineAndCharacterOfPosition(node.getEnd()).line
      found.push({ key: `${relativePath}#${qualified}`, lines: to - from + 1, isTest })
      inner = [...chain, name]
    }
    ts.forEachChild(node, (child) => {
      visit(child, inner)
    })
  }
  ts.forEachChild(source, (child) => {
    visit(child, [])
  })
  // A qualified name can still repeat inside one file — a model-based
  // property test gives every command its own `check`/`run`/`toString`, and
  // 111 keys across the repo collide that way. The ones that repeat get
  // their occurrence index in source order, so a ledger entry names one
  // function rather than whichever the scan happened to see last: without
  // it, a 120-line `run` and a 20-line `run` shared an entry and the guard
  // read the short one.
  const seen = new Map<string, number>()
  for (const row of found) seen.set(row.key, (seen.get(row.key) ?? 0) + 1)
  const taken = new Map<string, number>()
  return found.map((row) => {
    if ((seen.get(row.key) ?? 0) < 2) return row
    const index = (taken.get(row.key) ?? 0) + 1
    taken.set(row.key, index)
    return { ...row, key: `${row.key}~${String(index)}` }
  })
}
