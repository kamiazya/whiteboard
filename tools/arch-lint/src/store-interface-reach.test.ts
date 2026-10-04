/**
 * Every method on a keeper's store INTERFACE is called by production code, or
 * is ledgered here with why it is not.
 *
 * `knip` follows exports and cannot see a member of an interface or a class.
 * A method added "for completeness" therefore survives the deletion of its
 * last real caller: it keeps an implementation, a mock entry and a test
 * written against it, and each of those reads as evidence the method is
 * needed. `MemberProfileStore.listMembers` and `VersionStore.getFrontiersBase64`
 * each sat that way, called only by the tests that pinned them, while
 * production listed members through `workspace-roles.ts` and read frontiers
 * through `earliestWorkspaceFrontiers`.
 *
 * The scope is the interfaces in `server/security/*-store.ts` and
 * `server/store/*-store.ts`, where a store's whole surface is declared in one
 * place and every caller is a keeper or a route. A "use" is the method's name
 * as a property access, an element access by string, or a destructured key, in
 * a shipped file of any workspace (tests, their helpers and harnesses never
 * count — that is the point), read from the syntax tree so prose naming a
 * method is not one.
 *
 * Blind spot, deliberately accepted: the match is by NAME, so a method sharing
 * its name with an unrelated call elsewhere (`list`, `save`) reads as used.
 * That errs toward silence, never toward a false failure, and the two dead
 * methods this was written for have names nothing else uses.
 *
 * Guarded from both sides, like every allowlist in this tool: an entry for a
 * method that is gone or that has since gained a caller fails, so the ledger
 * cannot outlive the debt it names.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, relativeToRepo, SCAN_ROOTS } from './scan-roots.js'
import { isShippedPath, walkSourceFiles } from './source-scan.js'

const STORE_DIRS: readonly string[] = [
  'packages/mcp-server/src/server/security',
  'packages/mcp-server/src/server/store',
]

/** `Interface.method` to why production never calls it. Empty is the goal. */
const LEDGER: Readonly<Record<string, string>> = {
  'WorkspaceReplicaKeyStore.tierFor':
    'the raw stored tier, null when never chosen, which effectiveTier folds into the default; production reads only effectiveTier, and the store tests observe the stored choice through this. Drop it from the interface and read the column in those tests when next touched',
}

interface DeclaredMethod {
  readonly iface: string
  readonly name: string
}

function parse(source: string, fileName = 'scanned.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
}

/** A property whose declared type is a function — `foo: (x) => void` is a method too. */
function isFunctionTyped(member: ts.PropertySignature): boolean {
  return member.type !== undefined && ts.isFunctionTypeNode(member.type)
}

/** Every method an interface in `source` declares, `method(): T` and `method: () => T` alike. */
function declaredMethods(source: string): DeclaredMethod[] {
  const found: DeclaredMethod[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      for (const member of node.members) {
        const named =
          ts.isMethodSignature(member) ||
          (ts.isPropertySignature(member) && isFunctionTyped(member))
        if (named && ts.isIdentifier(member.name)) {
          found.push({ iface: node.name.text, name: member.name.text })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(source))
  return found
}

/** Which of `names` this source USES, as opposed to declaring or mentioning. */
function usedNames(source: string, names: ReadonlySet<string>): Set<string> {
  const used = new Set<string>()
  // A text prefilter keeps the parse to files that could matter: the walk is
  // every shipped file in the repo and almost none name a store method.
  if (![...names].some((name) => source.includes(name))) return used
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && names.has(node.name.text)) used.add(node.name.text)
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      names.has(node.argumentExpression.text)
    ) {
      used.add(node.argumentExpression.text)
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name
      if (ts.isIdentifier(key) && names.has(key.text)) used.add(key.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(source))
  return used
}

function storeFiles(): string[] {
  return STORE_DIRS.flatMap((dir) =>
    readdirSync(join(REPO_ROOT, dir))
      .filter((entry) => entry.endsWith('-store.ts'))
      .map((entry) => join(REPO_ROOT, dir, entry)),
  )
}

function declaredStoreMethods(): DeclaredMethod[] {
  return storeFiles().flatMap((file) => declaredMethods(readFileSync(file, 'utf8')))
}

function productionUses(names: ReadonlySet<string>): { used: Set<string>; files: number } {
  const used = new Set<string>()
  let files = 0
  for (const root of SCAN_ROOTS.filter((dir) => !dir.startsWith('tools/'))) {
    for (const file of walkSourceFiles(join(REPO_ROOT, root)).filter(isShippedPath)) {
      files += 1
      for (const name of usedNames(readFileSync(file, 'utf8'), names)) used.add(name)
    }
  }
  return { used, files }
}

const key = ({ iface, name }: DeclaredMethod): string => `${iface}.${name}`

describe('every store interface method has a production caller', () => {
  const methods = declaredStoreMethods()
  const { used, files } = productionUses(new Set(methods.map((method) => method.name)))

  it('reads the declared store surface and a real production population', () => {
    // A scan that found no methods, or no files, would call nothing unused and
    // read as a clean bill.
    expect(storeFiles().length).toBeGreaterThanOrEqual(9)
    expect(methods.length).toBeGreaterThan(30)
    expect(methods.map(key)).toContain('MemberProfileStore.profileForBinding')
    expect(files).toBeGreaterThan(500)
    expect(used.has('profileForBinding')).toBe(true)
  })

  it('has a production caller for each, or says in LEDGER why it has none', () => {
    const unexplained = methods.map(key).filter((id) => {
      const name = id.slice(id.indexOf('.') + 1)
      return !used.has(name) && !(id in LEDGER)
    })
    expect(
      unexplained,
      `${unexplained.join(', ')}: declared on a store interface and called only by tests. Delete the method with its implementation, mock entry and tests, or enter it in LEDGER with why production does not call it.`,
    ).toEqual([])
  })

  it('names only methods that still exist and still have no caller', () => {
    const declared = new Set(methods.map(key))
    const stale = Object.keys(LEDGER).filter(
      (id) => !declared.has(id) || used.has(id.slice(id.indexOf('.') + 1)),
    )
    expect(stale, `${stale.join(', ')}: no longer an uncalled method; delete the entry.`).toEqual(
      [],
    )
  })

  it('gives every entry a reason, not a word', () => {
    expect(Object.entries(LEDGER).filter(([, reason]) => reason.split(/\s+/).length < 8)).toEqual(
      [],
    )
  })
})

describe('what the scan counts', () => {
  const NAMES = new Set(['listMembers'])

  it('reads a method signature and a function-typed property off an interface', () => {
    expect(
      declaredMethods(
        `export interface S { a(x: string): void; b: (x: string) => void; c: number }`,
      ),
    ).toEqual([
      { iface: 'S', name: 'a' },
      { iface: 'S', name: 'b' },
    ])
  })

  it('reads a call, a string-keyed call and a destructured key as uses', () => {
    expect([...usedNames(`store.listMembers('ws')`, NAMES)]).toEqual(['listMembers'])
    expect([...usedNames(`store['listMembers']('ws')`, NAMES)]).toEqual(['listMembers'])
    expect([...usedNames(`const { listMembers } = store`, NAMES)]).toEqual(['listMembers'])
    expect([...usedNames(`const { listMembers: list } = store`, NAMES)]).toEqual(['listMembers'])
  })

  it('does not read a declaration, an implementation, a mock entry or prose as a use', () => {
    expect(usedNames(`interface S { listMembers(w: string): void }`, NAMES).size).toBe(0)
    expect(usedNames(`const s = { async listMembers(w: string) {} }`, NAMES).size).toBe(0)
    expect(usedNames(`const s = { listMembers: vi.fn() }`, NAMES).size).toBe(0)
    expect(usedNames(`// store.listMembers('ws')\nconst a = 1`, NAMES).size).toBe(0)
    expect(usedNames(`const a = 'store.listMembers'`, NAMES).size).toBe(0)
  })

  it('leaves out tests, their helpers and harnesses from the production population', () => {
    const at = (relative: string) => join(REPO_ROOT, relative)
    const dir = 'packages/mcp-server/src/server'
    expect(isShippedPath(at(`${dir}/security/workspace-roles.ts`))).toBe(true)
    expect(isShippedPath(at(`${dir}/security/member-profile-store.test.ts`))).toBe(false)
    expect(isShippedPath(at(`${dir}/store/test-utils/version-store-mock.ts`))).toBe(false)
    expect(relativeToRepo(at(`${dir}/store/version-store.ts`))).toBe(
      `${dir}/store/version-store.ts`,
    )
  })

  it('flags a method whose only caller is a test', () => {
    // The planted case, end to end through the same two functions the real
    // scan uses: a store declaring `plantedOnlyTested`, a production file that
    // never calls it, and a test that does.
    const declared = declaredMethods(
      `export interface S { plantedOnlyTested(): void; kept(): void }`,
    )
    const names = new Set(declared.map((method) => method.name))
    const production = [`s.kept()`]
    const inTests = [`s.plantedOnlyTested()`]
    const calledInProduction = new Set(production.flatMap((src) => [...usedNames(src, names)]))
    expect(declared.filter((m) => !calledInProduction.has(m.name)).map(key)).toEqual([
      'S.plantedOnlyTested',
    ])
    expect(inTests.flatMap((src) => [...usedNames(src, names)])).toEqual(['plantedOnlyTested'])
  })
})
