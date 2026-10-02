/**
 * A tool that mutates a document holds the workspace write lock, and that is
 * derived here rather than listed: the mutating set is what `TOOL_PROFILES`
 * does not mark read-only, the holders are the files that call
 * `withWorkspaceWrite`, and a mutating tool in neither is named.
 *
 * Why derived. `server-core`'s `write-lock.test.ts` proves each tool it lists
 * takes the lock, but its own comment says a tool added and not listed is not
 * caught. A mutating tool that forgets the bracket is a load-modify-save
 * against a store whose save writes unconditionally, so it silently drops a
 * concurrent writer's change and nothing fails.
 *
 * It lives in arch-lint because the two halves sit on opposite sides of a
 * direction rule: the profile table is `mcp-server`'s, the tools are
 * `server-core`'s, and neither package may import the other.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const PROFILES = 'packages/mcp-server/src/server/mcp/tool-profiles.ts'
const SERVER_CORE = 'packages/server-core/src'
const HELPER = 'packages/server-core/src/tools/write-lock.ts'
const BEHAVIOUR_TEST = 'packages/server-core/src/tools/write-lock.test.ts'

/** Mutating tools that deliberately hold no bracket of their own, and why. Both-sided. */
const EXEMPT: Readonly<Record<string, string>> = {
  wb_viewport_set:
    'writes no document: it relays a frame to a browser that may be watching, so there is no load-modify-save to serialise',
  wb_workspace_edit:
    'each op goes through apply-workspace-document-update, which holds the lock itself; a batch is deliberately not one hold because documents are separate CRDTs',
  wb_version_restore:
    'restoreVersion holds the lock itself, because its reads and writes must share one hold',
}

const READ_ONLY_PROFILE = 'READ_ONLY'

/** Tool name -> the profile constant its entry names; comments between keys are skipped. */
function profilesOf(profilesSource: string): Map<string, string> {
  const entry = /\n {2}([a-z_]+): \{\s*(?:\/\/[^\n]*\n\s*)*profile: (\w+)/g
  return new Map([...profilesSource.matchAll(entry)].map((m) => [m[1] as string, m[2] as string]))
}

const mutatingTools = (profilesSource: string): string[] =>
  [...profilesOf(profilesSource)]
    .filter(([, profile]) => profile !== READ_ONLY_PROFILE)
    .map(([tool]) => tool)

/** The `name: 'wb_x' as const` a tool definition declares, in its file. */
const toolsDefinedIn = (source: string): string[] =>
  [...source.matchAll(/\bname: '([a-z_]+)' as const/g)].map((m) => m[1] as string)

const callsHelper = (source: string): boolean =>
  /\bwithWorkspaceWrite\(/.test(stripCommentsAndStrings(source))

/**
 * What is wrong with `sources` (relative path -> text) as judged against the
 * profile table: mutating tools that neither call the helper nor are exempt,
 * and exemptions that no longer describe anything.
 */
export function lockFindings(
  profilesSource: string,
  sources: Readonly<Record<string, string>>,
  exempt: Readonly<Record<string, string>>,
): string[] {
  const mutating = mutatingTools(profilesSource)
  const holders = new Set<string>()
  const defined = new Set<string>()
  for (const source of Object.values(sources)) {
    for (const tool of toolsDefinedIn(source)) {
      defined.add(tool)
      if (callsHelper(source)) holders.add(tool)
    }
  }
  const findings: string[] = []
  for (const tool of mutating) {
    if (exempt[tool] !== undefined) continue
    if (!defined.has(tool)) findings.push(`${tool}: mutating but no server-core tool declares it`)
    else if (!holders.has(tool))
      findings.push(`${tool}: mutating and never calls withWorkspaceWrite`)
  }
  for (const tool of Object.keys(exempt)) {
    if (!mutating.includes(tool)) findings.push(`${tool}: exempt but not a mutating tool`)
    else if (holders.has(tool)) findings.push(`${tool}: exempt but calls withWorkspaceWrite`)
  }
  return findings
}

const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')
const productionFiles = walkSourceFiles(join(REPO_ROOT, SERVER_CORE))
  .filter((path) => !isTestPath(path))
  .map(relOf)
const sources = Object.fromEntries(productionFiles.map((rel) => [rel, read(rel)]))

const callers = () =>
  productionFiles.filter((rel) => rel !== HELPER && callsHelper(sources[rel] as string))

const FIXTURE_PROFILES = `
export const TOOL_PROFILES = {
  wb_read: { profile: READ_ONLY, title: 'r' },
  wb_write: {
    // a comment between the key and its profile
    profile: MUTATING,
    title: 'w',
  },
}`

describe('a mutating tool holds the workspace write lock', () => {
  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the counts are what keep it honest.
    expect(productionFiles.length).toBeGreaterThan(50)
    expect(mutatingTools(read(PROFILES)).length).toBeGreaterThanOrEqual(8)
    expect(callers().length).toBeGreaterThanOrEqual(6)
  })

  it('every mutating tool calls the helper or is exempt', () => {
    expect(lockFindings(read(PROFILES), sources, EXEMPT)).toEqual([])
  })

  it('no tool reaches for the raw lock: the helper owns the bracket and its rationale', () => {
    const raw = productionFiles
      .filter((rel) => rel.startsWith('packages/server-core/src/tools/') && rel !== HELPER)
      .filter((rel) => /\.withWriteLock\(/.test(stripCommentsAndStrings(sources[rel] as string)))
    expect(raw).toEqual([])
  })

  it('every helper caller has a behavioural row in write-lock.test.ts', () => {
    const behaviour = read(BEHAVIOUR_TEST)
    const unrowed = callers().filter((rel) => {
      const source = sources[rel] as string
      const keys = toolsDefinedIn(source)
      if (keys.length === 0) keys.push(rel.split('/').pop()?.replace(/\.ts$/, '') as string)
      // A row is a key of the WRITERS table, not a mention in an import path.
      return !keys.some((key) => new RegExp(`^\\s+'?${key}'?:`, 'm').test(behaviour))
    })
    expect(unrowed).toEqual([])
  })

  it('names a mutating tool that forgets the bracket', () => {
    const forgetful = { 'tools/w.ts': "export const t = { name: 'wb_write' as const }" }
    expect(lockFindings(FIXTURE_PROFILES, forgetful, {})).toEqual([
      'wb_write: mutating and never calls withWorkspaceWrite',
    ])
  })

  it('accepts a mutating tool that holds the bracket, and ignores a read-only one', () => {
    const holding = {
      'tools/w.ts':
        "export const t = { name: 'wb_write' as const, run: () => withWorkspaceWrite(d, w, f) }",
      'tools/r.ts': "export const t = { name: 'wb_read' as const }",
    }
    expect(lockFindings(FIXTURE_PROFILES, holding, {})).toEqual([])
  })

  it('does not read a comment naming the helper as a call', () => {
    const commented = {
      'tools/w.ts': "// withWorkspaceWrite(x)\nexport const t = { name: 'wb_write' as const }",
    }
    expect(lockFindings(FIXTURE_PROFILES, commented, {})).toHaveLength(1)
  })

  it('names a mutating tool no server-core file declares', () => {
    expect(lockFindings(FIXTURE_PROFILES, {}, {})).toEqual([
      'wb_write: mutating but no server-core tool declares it',
    ])
  })

  it('fails an exemption that no longer describes anything', () => {
    const holding = {
      'tools/w.ts':
        "export const t = { name: 'wb_write' as const, run: () => withWorkspaceWrite(d, w, f) }",
    }
    expect(lockFindings(FIXTURE_PROFILES, holding, { wb_write: 'x' })).toEqual([
      'wb_write: exempt but calls withWorkspaceWrite',
    ])
    expect(lockFindings(FIXTURE_PROFILES, holding, { wb_read: 'x' })).toEqual([
      'wb_read: exempt but not a mutating tool',
    ])
  })

  it('every exemption states a reason', () => {
    for (const [tool, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, tool).toBeGreaterThan(20)
    }
  })
})
