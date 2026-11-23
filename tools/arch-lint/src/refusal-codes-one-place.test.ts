/**
 * The refusal codes live in `contracts/api/refusals.json`, and the TypeScript
 * that raises them reads them from its generated module
 * (`packages/model/src/generated/refusals.ts`, and each raising package's own
 * `src/generated/refusals.ts`) rather than spelling them.
 *
 * Two directions, because a list held in two places drifts both ways:
 * - the shared layers (the packages that raise the operations' refusals) hold
 *   no code literal of their own: a literal equal to a contract code is a
 *   respelling, and a literal in a code position (`errorBody('x', …)`, through
 *   whatever name `errorBody` is imported under, or a class's own `code`
 *   member, quoted or not) the contract lacks is a code the Rust side would
 *   not know;
 * - every code the contract lists is still reachable from some TypeScript, so
 *   an entry whose last raiser was deleted shows as stale.
 *
 * Which files count: `isShippedPath` (`source-scan.ts`), so `test`,
 * `test-support`, `harness`, `bench` and `docs-snapshot` sources are all out,
 * as is anything under a `generated/` directory. No non-shipped category is
 * included. The reachability direction reads the shared layers AND the daemon's
 * adapter sources (`packages/mcp-server`, `packages/daemon-client`,
 * `apps/web`): they answer many codes of their own (auth, streams, export,
 * promote) and are not held to the first direction, but a contract code one of
 * them still spells or reads through the generated module is still emitted.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { importBindingsOf, parseSource, unwrapExpression } from './ast-helpers.js'
import { REPO_ROOT } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

const CONTRACT = 'contracts/api/refusals.json'

/** The packages that raise the document operations' refusals. */
const SHARED = ['model', 'ports', 'loro-adapter', 'reference-graph', 'server-core']

/**
 * A shared file that may spell one code, with why. Only that exact spelling is
 * excused: anything else the file says is judged like any other file.
 */
const MAY_SPELL: Readonly<Record<string, { readonly code: string; readonly why: string }>> = {
  'packages/server-core/src/api-errors.ts': {
    code: 'invalid_request',
    why: 'the browser bundle reads this file for its error-body schema and it imports zod and nothing else (daemon-client/api-contracts/index.ts); importing the model would put the whole model in that chunk',
  },
}

/**
 * A code a class carries that no response ever answers: the keeper reads its
 * own record keys, and the throw ends the operation as an uncaught fault. Only
 * that class's own `code` member is excused, not the same text anywhere else.
 */
const NEVER_ANSWERED: Readonly<Record<string, string>> = {
  stored_workspace_key_refused: 'StoredWorkspaceKeyError',
}

interface Entry {
  readonly name: string
  readonly code: string
  readonly breach?: unknown
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
    .filter((path) => isShippedPath(path) && !rel(path).includes('/generated/'))
    .map(rel)
}

interface Literal {
  readonly text: string
  /** The literal is in a place a code is written: `errorBody`'s first argument, or a `code` member. */
  readonly inCodePosition: boolean
  /** The class declaring it, when it is a class's `code` member. */
  readonly declaredIn?: string | undefined
}

/** Every plain string literal of a file, saying whether it sits where a code is written. */
function literalsOf(path: string, source: string): Literal[] {
  const file = parseSource(path, source)
  // `errorBody` under any name the file imports it as; a namespace import is read as `ns.errorBody`.
  const aliases = new Set(
    importBindingsOf(file)
      .filter((binding) => binding.kind === 'named' && binding.imported === 'errorBody')
      .map((binding) => binding.local),
  )
  aliases.add('errorBody')
  const found: Literal[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push({ text: node.text, ...codePosition(node, aliases) })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** The `as`, `satisfies` or parenthesised expression a literal is the operand of, outermost. */
function outermostWrapped(node: ts.Expression): ts.Node {
  let outer: ts.Node = node
  while (outer.parent !== undefined && unwrapExpression(outer.parent as ts.Expression) === node) {
    outer = outer.parent
  }
  return outer
}

/** Where a literal sits: a code position, and the class that declares it when it is a `code` member. */
function codePosition(
  node: ts.Node,
  aliases: ReadonlySet<string>,
): { inCodePosition: boolean; declaredIn?: string } {
  const child = ts.isExpression(node) ? outermostWrapped(node) : node
  const parent = child.parent
  if (parent === undefined) return { inCodePosition: false }
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression
    const named =
      (ts.isIdentifier(callee) && aliases.has(callee.text)) ||
      (ts.isPropertyAccessExpression(callee) && callee.name.text === 'errorBody')
    return { inCodePosition: parent.arguments[0] === child && named }
  }
  // A class's own `code` member, spelled with or without quotes; an object
  // literal's `code` is as often a zod issue's.
  if (
    ts.isPropertyDeclaration(parent) &&
    parent.initializer === child &&
    (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name)) &&
    parent.name.text === 'code'
  ) {
    const owner = parent.parent
    return {
      inCodePosition: true,
      declaredIn: ts.isClassLike(owner) ? owner.name?.text : undefined,
    }
  }
  return { inCodePosition: false }
}

/** The literals of `source` this guard objects to, each as `text (why)`. */
function objectionsTo(
  path: string,
  source: string,
  known: ReadonlySet<string>,
  excused?: { readonly code: string },
): string[] {
  return literalsOf(path, source).flatMap(({ text, inCodePosition: position, declaredIn }) => {
    if (text === excused?.code) return []
    if (known.has(text)) return [`${JSON.stringify(text)} respells a contract code`]
    if (position && declaredIn !== undefined && NEVER_ANSWERED[text] === declaredIn) return []
    return position ? [`${JSON.stringify(text)} is a code the contract does not list`] : []
  })
}

/** Whether `text` reaches `code` through the generated module: its constant, or the keyed table. */
function reachesCode(text: string, code: string): boolean {
  const camel = code.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  return (
    new RegExp(`\\bREFUSAL_CODE_${code.toUpperCase()}(?![\\w$])`).test(text) ||
    new RegExp(`\\bREFUSAL_CODES\\.${camel}(?![\\w$])`).test(text) ||
    text.includes(`REFUSAL_CODES['${camel}']`) ||
    text.includes(`REFUSAL_CODES["${camel}"]`) ||
    new RegExp(`['"\`]${code}['"\`]`).test(text)
  )
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

  it('reads an aliased errorBody, a quoted code member and the stored-key class by what they are', () => {
    const known = new Set(['too_many_documents'])
    const objections = (source: string) => objectionsTo('f.ts', source, known)
    expect(
      objections(
        "import { errorBody as refusalBody } from './x.js'\nrefusalBody('brand_new_code', 'm')",
      ),
    ).toEqual(['"brand_new_code" is a code the contract does not list'])
    expect(
      objections("import * as api from './x.js'\napi.errorBody('brand_new_code', 'm')"),
    ).toHaveLength(1)
    expect(
      objections(
        "import { other as refusalBody } from './x.js'\nrefusalBody('brand_new_code', 'm')",
      ),
    ).toEqual([])
    expect(objections("class A { readonly 'code' = 'brand_new_code' }")).toHaveLength(1)
    expect(objections('class A { readonly "code" = \'brand_new_code\' as const }')).toHaveLength(1)
    const stored =
      "class StoredWorkspaceKeyError { readonly code = 'stored_workspace_key_refused' }"
    expect(objections(stored)).toEqual([])
    expect(
      objections("class Another { readonly code = 'stored_workspace_key_refused' }"),
    ).toHaveLength(1)
    expect(objections("errorBody('stored_workspace_key_refused', 'm')")).toHaveLength(1)
    expect(objections(`${stored}\nerrorBody('stored_workspace_key_refused', 'm')`)).toHaveLength(1)
  })

  it('excuses one spelling in a file and judges every other', () => {
    const known = new Set(['invalid_request'])
    const excused = { code: 'invalid_request' }
    expect(objectionsTo('f.ts', "errorBody('invalid_request', 'm')", known, excused)).toEqual([])
    expect(objectionsTo('f.ts', "errorBody('brand_new_code', 'm')", known, excused)).toHaveLength(1)
    expect(objectionsTo('f.ts', "const a = 'invalid_request'", known)).toHaveLength(1)
  })

  it('reaches a code through its constant, either keyed form of the table, or a literal', () => {
    const code = 'too_many_documents'
    for (const text of [
      'REFUSAL_CODE_TOO_MANY_DOCUMENTS',
      'REFUSAL_CODES.tooManyDocuments',
      "REFUSAL_CODES['tooManyDocuments']",
      'REFUSAL_CODES["tooManyDocuments"]',
      "const c = 'too_many_documents'",
    ]) {
      expect(reachesCode(text, code), text).toBe(true)
    }
    expect(reachesCode('REFUSAL_CODES.tooManyFolders too_many_documents_x', code)).toBe(false)
    // A longer member or constant sharing the prefix names another code.
    expect(reachesCode('REFUSAL_CODES.tooManyDocumentsExtra', code)).toBe(false)
    expect(reachesCode('REFUSAL_CODE_TOO_MANY_DOCUMENTS_EXTRA', code)).toBe(false)
  })

  it('has no shared file spelling a contract code or answering one the contract lacks', () => {
    const spelled = files.flatMap((path) =>
      objectionsTo(path, readFileSync(join(REPO_ROOT, path), 'utf8'), codes, MAY_SPELL[path]).map(
        (objection) => `${path}: ${objection}`,
      ),
    )
    expect(spelled).toEqual([])
  })

  it('lets a file spell a code only for a reason that still holds', () => {
    for (const [path, { code }] of Object.entries(MAY_SPELL)) {
      expect(files, `${path} is scanned`).toContain(path)
      const source = readFileSync(join(REPO_ROOT, path), 'utf8')
      expect(
        objectionsTo(path, source, codes),
        `${path} spells no code but ${code}, and still needs to`,
      ).toEqual([`${JSON.stringify(code)} respells a contract code`])
    }
  })

  it('reaches every code the contract lists from some TypeScript that is not generated', () => {
    const sources = [
      ...files,
      ...production('packages/mcp-server/src'),
      ...production('packages/daemon-client/src'),
      ...production('apps/web/src'),
    ]
    const text = sources.map((path) => readFileSync(join(REPO_ROOT, path), 'utf8')).join('\n')
    const tableCodes = new Set(
      contract.refusals.filter((entry) => entry.breach !== undefined).map((entry) => entry.code),
    )
    const tables = /SYNC_(TEXT|WORKSPACE)_BREACH_CODES/.test(text)
    const stale = [...codes].filter(
      (code) => !reachesCode(text, code) && !(tables && tableCodes.has(code)),
    )
    expect(stale, 'contract codes no TypeScript emits').toEqual([])
  })
})
