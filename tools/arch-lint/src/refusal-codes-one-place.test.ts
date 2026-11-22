/**
 * The refusal codes live in `contracts/api/refusals.json`, and the TypeScript
 * that raises them reads them from its generated module
 * (`packages/model/src/generated/refusals.ts`) rather than spelling them.
 *
 * Two directions, because a list held in two places drifts both ways:
 * - the shared layers (the packages that raise the operations' refusals) hold
 *   no code literal of their own: a literal equal to a contract code is a
 *   respelling, and a literal in a code position (`errorBody('x', …)` or a
 *   `code` member) the contract lacks is a code the Rust side would not know;
 * - every code the contract lists is still reachable from some TypeScript, so
 *   an entry whose last raiser was deleted shows as stale.
 *
 * The daemon's own adapters (`packages/mcp-server`, `apps/web`) answer many
 * more codes of their own (auth, streams, export, promote) and are not held
 * to this: only a contract code spelled there counts as "still emitted".
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parseSource } from './ast-helpers.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const CONTRACT = 'contracts/api/refusals.json'
const GENERATED = 'packages/model/src/generated/refusals.ts'

/** The packages that raise the document operations' refusals. */
const SHARED = ['model', 'ports', 'loro-adapter', 'reference-graph', 'server-core']

/** A shared file that may spell a code, with why. */
const MAY_SPELL: Readonly<Record<string, string>> = {
  'packages/server-core/src/api-errors.ts':
    'the browser bundle reads this file for its error-body schema and it imports zod and nothing else (daemon-client/api-contracts/index.ts); importing the model would put the whole model in that chunk',
}

/**
 * A code a class carries that no response ever answers: the keeper reads its
 * own record keys, and the throw ends the operation as an uncaught fault.
 */
const NEVER_ANSWERED: ReadonlySet<string> = new Set(['stored_workspace_key_refused'])

interface Entry {
  readonly name: string
  readonly code: string
}

const contract = JSON.parse(readFileSync(join(REPO_ROOT, CONTRACT), 'utf8')) as {
  readonly refusals: readonly Entry[]
}
const codes = new Set(contract.refusals.map((entry) => entry.code))

function rel(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/')
}

function production(dir: string): string[] {
  return walkSourceFiles(join(REPO_ROOT, dir))
    .filter((path) => !isTestPath(path) && !rel(path).includes('/generated/'))
    .map(rel)
}

interface Literal {
  readonly text: string
  /** The literal is in a place a code is written: `errorBody`'s first argument, or a `code` member. */
  readonly inCodePosition: boolean
}

/** Every plain string literal of a file, saying whether it sits where a code is written. */
function literalsOf(path: string, source: string): Literal[] {
  const file = parseSource(path, source)
  const found: Literal[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push({ text: node.text, inCodePosition: inCodePosition(node) })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function inCodePosition(node: ts.Node): boolean {
  let child: ts.Node = node
  while (
    child.parent !== undefined &&
    (ts.isAsExpression(child.parent) ||
      ts.isSatisfiesExpression(child.parent) ||
      ts.isParenthesizedExpression(child.parent))
  ) {
    child = child.parent
  }
  const parent = child.parent
  if (parent === undefined) return false
  if (ts.isCallExpression(parent)) {
    return (
      parent.arguments[0] === child &&
      ts.isIdentifier(parent.expression) &&
      parent.expression.text === 'errorBody'
    )
  }
  // A class's own `code` member; an object literal's `code` is as often a zod issue's.
  return (
    ts.isPropertyDeclaration(parent) &&
    parent.initializer === child &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === 'code'
  )
}

/** The literals of `source` this guard objects to, each as `text (why)`. */
function objectionsTo(path: string, source: string, known: ReadonlySet<string>): string[] {
  return literalsOf(path, source).flatMap(({ text, inCodePosition: position }) => {
    if (known.has(text)) return [`${JSON.stringify(text)} respells a contract code`]
    if (NEVER_ANSWERED.has(text)) return []
    return position ? [`${JSON.stringify(text)} is a code the contract does not list`] : []
  })
}

describe('the refusal codes are written in one place', () => {
  const files = SHARED.flatMap((pkg) => production(`packages/${pkg}/src`))

  it('scans a tree worth scanning', () => {
    expect(contract.refusals.length).toBeGreaterThan(100)
    expect(codes.size).toBeGreaterThan(40)
    expect(files.length).toBeGreaterThan(200)
  })

  it('finds a respelled code and an unlisted one in a fixture, and passes the generated constant', () => {
    const known = new Set(['too_many_documents'])
    const objections = (source: string) => objectionsTo('f.ts', source, known)
    expect(objections("const a = 'too_many_documents'")).toHaveLength(1)
    expect(objections("class A { readonly code = 'too_many_documents' as const }")).toHaveLength(1)
    expect(objections("errorBody('brand_new_code', 'm')")).toEqual([
      '"brand_new_code" is a code the contract does not list',
    ])
    expect(objections("class A { readonly code = 'brand_new_code' satisfies X }")).toHaveLength(1)
    expect(objections("const issue = { code: 'custom' }")).toEqual([])
    expect(objections('class A { readonly code = REFUSAL_CODES.tooManyDocuments }')).toEqual([])
    expect(objections("errorBody(REFUSAL_CODES.invalidBody, 'a sentence')")).toEqual([])
    expect(objections("const sentence = 'brand_new_text'")).toEqual([])
  })

  it('has no shared file spelling a contract code or answering one the contract lacks', () => {
    const spelled = files
      .filter((path) => !(path in MAY_SPELL))
      .flatMap((path) =>
        objectionsTo(path, readFileSync(join(REPO_ROOT, path), 'utf8'), codes).map(
          (objection) => `${path}: ${objection}`,
        ),
      )
    expect(spelled).toEqual([])
  })

  it('lets a file spell a code only for a reason that still holds', () => {
    for (const path of Object.keys(MAY_SPELL)) {
      const source = readFileSync(join(REPO_ROOT, path), 'utf8')
      expect(objectionsTo(path, source, codes), `${path} spells no code any more`).not.toEqual([])
    }
  })

  it('reaches every code the contract lists from some TypeScript that is not generated', () => {
    const sources = [
      ...SHARED.flatMap((pkg) => production(`packages/${pkg}/src`)),
      ...production('packages/mcp-server/src'),
      ...production('packages/daemon-client/src'),
      ...production('apps/web/src'),
    ].filter((path) => path !== GENERATED)
    const text = sources.map((path) => readFileSync(join(REPO_ROOT, path), 'utf8')).join('\n')
    const camel = (code: string) => code.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    const stale = [...codes].filter(
      (code) =>
        !text.includes(`REFUSAL_CODES.${camel(code)}`) &&
        !new RegExp(`['"\`]${code}['"\`]`).test(text),
    )
    expect(stale, 'contract codes no TypeScript emits').toEqual([])
  })
})
