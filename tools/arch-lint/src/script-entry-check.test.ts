/**
 * Whether a script was run as the entry module is decided in ONE place,
 * `tools/checks/src/is-run-as-script.mjs`, and this is its executable half.
 *
 * `import.meta.url` is percent-encoded and `process.argv[1]` is a raw path, so
 * comparing them as strings (`file://${process.argv[1]}`, `new URL(import.meta.url).pathname`)
 * is false under any checkout whose path holds a space, `#` or `%`; comparing
 * `resolve(argv[1])` without `realpath` is false for a symlinked entry. The
 * script then does nothing and exits 0: a build "succeeds" with nothing
 * copied, a `prepack` gate passes with nothing checked.
 *
 * So the scan does not judge the comparison, which has as many spellings as
 * there are ways to build a string: it fails any script but the helper that
 * reads the entry path at all. Named blind spots: `argv` destructured off
 * `process` as an object (`const { argv } = process`) and an index computed at
 * run time are not followed.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource, unwrapExpression } from './ast-helpers.js'
import { REPO_ROOT, scriptFiles } from './scan-roots.js'

const HOME = 'tools/checks/src/is-run-as-script.mjs'

const scripts = scriptFiles().filter((path) => !/\.test\.[mc]?js$/.test(path))

/** Whether `node` is `process.argv`, or an `argv` imported from `node:process`. */
function isArgv(node: ts.Expression, importedArgv: ReadonlySet<string>): boolean {
  const bare = unwrapExpression(node)
  if (ts.isIdentifier(bare)) return importedArgv.has(bare.text)
  return (
    ts.isPropertyAccessExpression(bare) &&
    bare.name.text === 'argv' &&
    ts.isIdentifier(bare.expression) &&
    bare.expression.text === 'process'
  )
}

/** The local names `argv` is imported under from `node:process` / `process`. */
function importedArgvNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const from = (statement.moduleSpecifier as ts.StringLiteral).text
    const bindings = statement.importClause?.namedBindings
    if ((from !== 'node:process' && from !== 'process') || !bindings) continue
    if (!ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 'argv') names.add(element.name.text)
    }
  }
  return names
}

/**
 * Whether a script reads the entry path itself: `process.argv[1]`,
 * `process.argv.at(1)`, or a destructure that binds the second element. Read
 * from the AST, so no spelling of the comparison around it — a template, a
 * concatenation, `pathToFileURL`, `resolve`, `endsWith` — slips past, and a
 * comment naming it is not a read.
 */
function readsEntryPath(fileName: string, source: string): boolean {
  const file = parseSource(fileName, source, false, ts.ScriptKind.JS)
  const argv = importedArgvNames(file)
  let found = false
  const visit = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isElementAccessExpression(node) &&
      isArgv(node.expression, argv) &&
      ts.isNumericLiteral(node.argumentExpression) &&
      node.argumentExpression.text === '1'
    ) {
      found = true
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'at' &&
      isArgv(node.expression.expression, argv)
    ) {
      found = true
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      isArgv(node.initializer, argv) &&
      ts.isArrayBindingPattern(node.name) &&
      node.name.elements.length > 1 &&
      !ts.isOmittedExpression(node.name.elements[1] as ts.ArrayBindingElement)
    ) {
      found = true
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const ARGV1 = 'process.argv[1]'
// A template placeholder as TEXT, for the fixtures that spell a template;
// joined because a literal one reads to the linter as a template mistake.
const INTERP = ['$', '{', ARGV1, '}'].join('')
const FRAGILE_SPELLINGS = [
  `import.meta.url === \`file://${INTERP}\``,
  `import.meta.url === 'file://' + ${ARGV1}`,
  `${ARGV1} === new URL(import.meta.url).pathname`,
  `import.meta.url === new URL(\`file://${INTERP}\`).href`,
  `${ARGV1} && import.meta.url === pathToFileURL(${ARGV1}).href`,
  `${ARGV1} && resolve(${ARGV1}) === fileURLToPath(import.meta.url)`,
  `${ARGV1}?.endsWith('docker-build-inputs.mjs')`,
  'process.argv.at(1) === fileURLToPath(import.meta.url)',
  `'file://' + ${ARGV1} === import.meta.url`,
  `new URL(import.meta.url).pathname === ${ARGV1}`,
  `import.meta.url.endsWith(${ARGV1})`,
]

describe('a script finds out it is the entry module in one place', () => {
  it('reaches the scripts and recognises each spelling when it sees one', () => {
    expect(scripts.length).toBeGreaterThan(60)
    expect(scripts).toContain(HOME)
    expect(scripts).toContain('apps/web/scripts/smoke-pwa-lifecycle.mjs')
    for (const spelling of FRAGILE_SPELLINGS) {
      expect(readsEntryPath('x.mjs', `if (${spelling}) {}`), spelling).toBe(true)
    }
    expect(readsEntryPath('x.mjs', `const [, entry] = process.argv`)).toBe(true)
    expect(readsEntryPath('x.mjs', `import { argv as a } from 'node:process'\nif (a[1]) {}`)).toBe(
      true,
    )
    expect(readsEntryPath('x.mjs', `// ${FRAGILE_SPELLINGS[0]}`)).toBe(false)
    expect(readsEntryPath('x.mjs', 'const args = process.argv.slice(2)')).toBe(false)
    expect(readsEntryPath('x.mjs', 'const [first] = process.argv.slice(2)')).toBe(false)
    expect(readsEntryPath('x.mjs', 'if (isRunAsScript(import.meta.url)) {}')).toBe(false)
    // The subject is present: the home itself reads it.
    expect(readsEntryPath(HOME, readFileSync(join(REPO_ROOT, HOME), 'utf8'))).toBe(true)
  })

  it('no script but the helper reads process.argv[1] to decide anything', () => {
    const hits = scripts.filter(
      (rel) => rel !== HOME && readsEntryPath(rel, readFileSync(join(REPO_ROOT, rel), 'utf8')),
    )
    expect(
      hits,
      `use \`isRunAsScript(import.meta.url)\` from ${HOME}: a hand-written comparison is false under a path that needs URL-encoding or a symlinked entry, and the script silently does nothing`,
    ).toEqual([])
  })

  it.each([
    'a b',
    'a#b',
    'a%20b',
    'a?b',
  ])('the helper answers true for the entry module under a directory named %j', (name) => {
    const root = mkdtempSync(join(tmpdir(), 'script-entry-'))
    try {
      const dir = join(root, name)
      mkdirSync(dir)
      const probe = join(dir, 'probe.mjs')
      const home = join(REPO_ROOT, HOME)
      writeFileSync(
        probe,
        `import { isRunAsScript } from ${JSON.stringify(home)}\nconsole.log(isRunAsScript(import.meta.url))\n`,
      )
      const result = spawnSync(process.execPath, [probe], { encoding: 'utf8' })
      expect(result.stderr).toBe('')
      expect(result.stdout.trim()).toBe('true')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  /** Runs `body` as a module importing the helper, from a fresh directory; answers its stdout and stderr. */
  function runProbe(body: string, entryOf: (real: string, root: string) => string) {
    const root = mkdtempSync(join(tmpdir(), 'script-entry-'))
    try {
      const real = join(root, 'real.mjs')
      writeFileSync(
        real,
        `import { isRunAsScript } from ${JSON.stringify(join(REPO_ROOT, HOME))}\n${body}\nconsole.log(isRunAsScript(import.meta.url))\n`,
      )
      const result = spawnSync(process.execPath, [entryOf(real, root)], { encoding: 'utf8' })
      return { stdout: result.stdout.trim(), stderr: result.stderr }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  // Node runs a symlinked entry under its real path, so `import.meta.url`
  // names the target while `process.argv[1]` still names the link.
  it('the helper answers true when node is started on a symlink to the entry', () => {
    const answer = runProbe('', (real, root) => {
      const link = join(root, 'link.mjs')
      symlinkSync(real, link)
      return link
    })
    expect(answer).toEqual({ stdout: 'true', stderr: '' })
  })

  it('the helper answers false, not true, for an entry path that names nothing on disk', () => {
    const answer = runProbe("process.argv[1] = '/nonexistent/entry.mjs'", (real) => real)
    expect(answer).toEqual({ stdout: 'false', stderr: '' })
  })
})
