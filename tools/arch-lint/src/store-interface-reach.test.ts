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
 *
 * The same blindness holds for a CLASS in the browser keeper (`apps/web/src/lib`)
 * and the daemon's stores: a public method outlives its last caller, and its
 * implementation, its fencing and the tests written against it read as proof it
 * is needed. `BrowserBackend.mutateRecord` and `LoroStore.appendDelta` each sat
 * that way, the second with eighty lines of cross-tab fencing, while production
 * wrote through another path. So every public method of such a class needs a
 * shipped caller OUTSIDE its own class body (a method only its siblings call
 * should be private) or a `CLASS_METHOD_LEDGER` entry: a hook the runtime or a
 * protocol calls by name, which no source line shows.
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

/** `Class.method` to why nothing in the source calls it. Only hooks a runtime or protocol invokes by name. */
const CLASS_METHOD_LEDGER: Readonly<Record<string, string>> = {
  'IdbDocumentStore.writeUnreadableRecord':
    "test-only by design: the port's conformance suite needs every implementation to reach the unreadable state, and takes the writer through its makeStore seam rather than a call a source scan can see",
  'LibsqlDocumentStore.writeUnreadableRecord':
    "test-only by design: the port's conformance suite needs every implementation to reach the unreadable state, and takes the writer through its makeStore seam rather than a call a source scan can see",
  'StaticMigrationProvider.getMigrations':
    'the Kysely MigrationProvider interface member; the Migrator calls it by name from inside the library',
  'TenantScopePlugin.transformQuery':
    'the KyselyPlugin interface member; the query executor calls it by name from inside the library',
  'TenantScopePlugin.transformResult':
    'the KyselyPlugin interface member; the query executor calls it by name from inside the library',
}

/** Where a class's methods are declared; every shipped file of any workspace is a possible caller. */
const CLASS_DIRS: readonly string[] = ['apps/web/src/lib', 'packages/mcp-server/src/server/store']

interface DeclaredMethod {
  readonly iface: string
  readonly name: string
}

interface DeclaredClassMethod {
  readonly file: string
  readonly cls: string
  readonly name: string
  /** The class body's extent, so a call from inside it is not a caller. */
  readonly start: number
  readonly end: number
}

interface Use {
  readonly file: string
  readonly name: string
  readonly pos: number
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

/** Every USE of one of `names` in this source, with where it sits. */
function namedUses(source: string, names: ReadonlySet<string>, file = 'scanned.ts'): Use[] {
  const uses: Use[] = []
  // A text prefilter keeps the parse to files that could matter: the walk is
  // every shipped file in the repo and almost none name a store method.
  if (![...names].some((name) => source.includes(name))) return uses
  const at = (name: string, node: ts.Node): void => {
    uses.push({ file, name, pos: node.getStart() })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && names.has(node.name.text)) at(node.name.text, node)
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      names.has(node.argumentExpression.text)
    ) {
      at(node.argumentExpression.text, node)
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name
      if (ts.isIdentifier(key) && names.has(key.text)) at(key.text, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(source, file))
  return uses
}

/** Which of `names` this source USES, as opposed to declaring or mentioning. */
function usedNames(source: string, names: ReadonlySet<string>): Set<string> {
  return new Set(namedUses(source, names).map((use) => use.name))
}

/**
 * Every public method of a named class in `source`. `private`, `protected` and
 * `#name` members are not API; a computed key (`[Symbol.dispose]`) names nothing
 * a property access could spell.
 */
function declaredClassMethods(source: string, file = 'scanned.ts'): DeclaredClassMethod[] {
  const found = new Map<string, DeclaredClassMethod>()
  const hidden = ts.ModifierFlags.Private | ts.ModifierFlags.Protected
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue
        if ((ts.getCombinedModifierFlags(member) & hidden) !== 0) continue
        // An overloaded method is one method, declared once per signature.
        found.set(`${node.name.text}.${member.name.text}`, {
          file,
          cls: node.name.text,
          name: member.name.text,
          start: node.getStart(),
          end: node.end,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(parse(source, file))
  return [...found.values()]
}

/** The methods no `uses` entry reaches from outside the class body that declares them. */
function unreachedClassMethods(
  methods: readonly DeclaredClassMethod[],
  uses: readonly Use[],
): DeclaredClassMethod[] {
  return methods.filter(
    (method) =>
      !uses.some(
        (use) =>
          use.name === method.name &&
          !(use.file === method.file && use.pos >= method.start && use.pos < method.end),
      ),
  )
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

function productionUses(names: ReadonlySet<string>): { uses: Use[]; files: number } {
  const uses: Use[] = []
  let files = 0
  for (const root of SCAN_ROOTS.filter((dir) => !dir.startsWith('tools/'))) {
    for (const file of walkSourceFiles(join(REPO_ROOT, root)).filter(isShippedPath)) {
      files += 1
      uses.push(...namedUses(readFileSync(file, 'utf8'), names, file))
    }
  }
  return { uses, files }
}

function declaredClassMethodsOnDisk(): DeclaredClassMethod[] {
  return CLASS_DIRS.flatMap((dir) =>
    walkSourceFiles(join(REPO_ROOT, dir))
      .filter(isShippedPath)
      .flatMap((file) => declaredClassMethods(readFileSync(file, 'utf8'), file)),
  )
}

const key = ({ iface, name }: DeclaredMethod): string => `${iface}.${name}`
const classKey = ({ cls, name }: DeclaredClassMethod): string => `${cls}.${name}`

// At module scope, once: one walk of every shipped file answers both guards (the
// interface guard asks which names are used anywhere, the class guard asks
// where), and the cost lands in collection rather than under a test's timeout.
const methods = declaredStoreMethods()
const classMethods = declaredClassMethodsOnDisk()
const { uses, files } = productionUses(
  new Set([...methods, ...classMethods].map((method) => method.name)),
)
const used = new Set(uses.map((use) => use.name))

describe('every store interface method has a production caller', () => {
  it('reads the declared store surface and a real production population', () => {
    // A scan that found no methods, or no files, would call nothing unused and
    // read as a clean bill.
    expect(storeFiles().length).toBeGreaterThanOrEqual(9)
    expect(methods.length).toBeGreaterThan(25)
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

describe('every public class method has a caller outside its class', () => {
  it('reads the declared class surface and a real production population', () => {
    expect(classMethods.length).toBeGreaterThan(80)
    expect(classMethods.map(classKey)).toContain('LoroStore.load')
    // Private members are not API: LoroStore's `#serialise` and `#loadInner`.
    expect(classMethods.map(classKey)).not.toContain('LoroStore.#serialise')
    expect(uses.some((use) => use.name === 'load' && use.file.endsWith('.tsx'))).toBe(true)
  })

  it('has a caller for each, or says in CLASS_METHOD_LEDGER why it has none', () => {
    const unexplained = unreachedClassMethods(classMethods, uses)
      .map(classKey)
      .filter((id) => !(id in CLASS_METHOD_LEDGER))
    expect(
      unexplained,
      `${unexplained.join(', ')}: a public class method nothing outside its class calls. Delete it with its tests, make it private, or enter it in CLASS_METHOD_LEDGER with the runtime or protocol that calls it by name.`,
    ).toEqual([])
  })

  it('names only methods that still exist and still have no caller', () => {
    const unreached = new Set(unreachedClassMethods(classMethods, uses).map(classKey))
    const stale = Object.keys(CLASS_METHOD_LEDGER).filter((id) => !unreached.has(id))
    expect(stale, `${stale.join(', ')}: no longer an uncalled method; delete the entry.`).toEqual(
      [],
    )
  })

  it('gives every entry a reason, not a word', () => {
    expect(
      Object.entries(CLASS_METHOD_LEDGER).filter(([, reason]) => reason.split(/\s+/).length < 8),
    ).toEqual([])
  })
})

describe('what the class scan counts', () => {
  /** The unreached methods of `declaring`, with `others` as the rest of the shipped source. */
  function unreached(declaring: string, others: Record<string, string> = {}): string[] {
    const methods = declaredClassMethods(declaring, 'declaring.ts')
    const names = new Set(methods.map((method) => method.name))
    const found = [
      ...namedUses(declaring, names, 'declaring.ts'),
      ...Object.entries(others).flatMap(([file, source]) => namedUses(source, names, file)),
    ]
    return unreachedClassMethods(methods, found).map(classKey)
  }

  it('flags a planted public method nothing calls', () => {
    expect(
      unreached(`export class Planted { used(): void {} unused(): void {} }`, {
        'caller.ts': `new Planted().used()`,
      }),
    ).toEqual(['Planted.unused'])
  })

  it('flags a method only its own class calls, and counts a caller in another class or file', () => {
    const source = `
      export class Own { inner(): void {} run(): void { this.inner() } }
      export class Sibling { go(own: Own): void { own.run() } }`
    const caller = { 'main.ts': `sibling.go(own)` }
    expect(unreached(source, caller)).toEqual(['Own.inner'])
    expect(unreached(source, { ...caller, 'elsewhere.ts': `own.inner()` })).toEqual([])
  })

  it('does not read private, protected, #private, constructor or computed members as API', () => {
    expect(
      unreached(`class Hidden {
        constructor() {}
        private a(): void {}
        protected b(): void {}
        #c(): void {}
        [Symbol.dispose](): void {}
      }`),
    ).toEqual([])
  })

  it('reads a method referenced as a callback, by string key or by destructuring as a caller', () => {
    const names = `export class M { a(): void {} b(): void {} c(): void {} }`
    expect(
      unreached(names, {
        'x.ts': `register(m.a); m['b'](); const { c } = m`,
      }),
    ).toEqual([])
  })

  it('counts an overloaded method once', () => {
    expect(
      declaredClassMethods(
        `class O { f(a: string): void; f(a: number): void; f(a: unknown): void {} }`,
      ),
    ).toHaveLength(1)
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
