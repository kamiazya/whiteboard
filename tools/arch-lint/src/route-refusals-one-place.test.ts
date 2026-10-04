/**
 * The daemon's HTTP routes answer a malformed address the same way: one
 * helper, `parseWorkspaceHandle`, validates the handle, refuses with the
 * `{ error, message }` 400, and resolves the id. This scan is the executable
 * half of that rule.
 *
 * Why: seven handlers each carried the same seven-line try/catch, and four
 * more each spoke their own 400 body. The body is the contract for a
 * malformed address, so the next route copied whichever was nearest — the
 * drift ADR-0018 records, one layer down from the operations it is about.
 *
 * A route may still call `validateWorkspaceId` itself where its 400 is a
 * deliberately DIFFERENT contract; each such file is named below with the
 * reason, and the length is pinned so an addition is a decision in the diff.
 *
 * The 413 is the same story: six routes each hand-built the `payload_too_large`
 * body beside `errorBody()`, which exists so the code slot and the reason slot
 * cannot be written by hand. `limitBody` is the one place that names the code.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countNamedUses } from './named-use-scan.js'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, stripCommentsAndStrings, walkSourceFiles } from './source-scan.js'

const ROUTES_DIR = 'packages/mcp-server/src/server/routes'

const HANDLE_VALIDATOR_NAMES = ['validateWorkspaceId']

/** Files under routes/ that validate a handle by hand, each with why. */
const HANDLE_VALIDATION_ALLOWLIST: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/server/routes/document/path-route.ts':
    'validates the workspace id and the document path in ONE try, and picks the 400 shape (legacy or Problem Details) per route; it does not resolve the handle',
  'packages/mcp-server/src/server/routes/document/workspace-document.ts':
    'a page-facing surface: its 400 is Problem Details `{ title }`, not `{ error, message }`',
  'packages/mcp-server/src/server/routes/replica-key.ts':
    'its 400 is the typed `MembershipRefusal` the client parses, pinned by `satisfies`, and it takes a canonical id, not a handle',
}

/** The one module that may name the code; every route reaches it through `limitBody`. */
const PAYLOAD_TOO_LARGE_HOME = 'packages/mcp-server/src/server/routes/body-limit.ts'
const PAYLOAD_TOO_LARGE = /['"`]payload_too_large['"`]/
const PAYLOAD_TOO_LARGE_SCAN_DIRS = ['packages/mcp-server/src', 'packages/server-core/src']

const files: string[] = []
walkSourceFiles(join(REPO_ROOT, ROUTES_DIR), files)
const production = files.filter((path) => !isTestPath(path))

function rel(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join('/')
}

/** A use of the validator however spelled: bare, qualified, bracketed or through an aliased import. */
function validatesInline(source: string, fileName = 'fixture.ts'): boolean {
  return countNamedUses(fileName, source, HANDLE_VALIDATOR_NAMES) > 0
}

describe('route refusals are written in one place', () => {
  it('recognises an inline handle validation and passes the helper through', () => {
    const fixtures: readonly { readonly source: string; readonly hit: boolean }[] = [
      { source: 'try { validateWorkspaceId(handle) } catch (err) {}', hit: true },
      { source: 'refusedBy(() => validateWorkspaceId(handle))', hit: true },
      {
        source: "import { validateWorkspaceId as check } from '../validators.js'\ncheck(handle)",
        hit: true,
      },
      { source: "validators['validateWorkspaceId'](handle)", hit: true },
      { source: 'const r = await parseWorkspaceHandle(c, handle)', hit: false },
      { source: "import { validateWorkspaceId } from '../validators.js'", hit: false },
      { source: '// validateWorkspaceId(handle) is what the helper calls', hit: false },
    ]
    for (const { source, hit } of fixtures) expect(validatesInline(source), source).toBe(hit)
  })

  it('scans a tree worth scanning', () => {
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(production.length).toBeGreaterThan(25)
  })

  it('no route validates a workspace handle by hand outside the allowlist', () => {
    const hits = production
      .map(rel)
      .filter((path) => HANDLE_VALIDATION_ALLOWLIST[path] === undefined)
      .filter((path) =>
        validatesInline(readFileSync(join(REPO_ROOT, path), 'utf8'), join(REPO_ROOT, path)),
      )
    expect(
      hits,
      'validate a handle through `parseWorkspaceHandle` (or `refuseMalformedHandle`) in server/workspace-handle.ts, so every route answers a malformed address with the same 400',
    ).toEqual([])
  })

  it('every allowlist entry still validates a handle by hand', () => {
    const stale = Object.keys(HANDLE_VALIDATION_ALLOWLIST).filter((path) => {
      try {
        return !validatesInline(readFileSync(join(REPO_ROOT, path), 'utf8'), join(REPO_ROOT, path))
      } catch {
        return true
      }
    })
    expect(
      stale,
      'an entry that outlives its inline validation is how an allowlist stops being read',
    ).toEqual([])
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(Object.keys(HANDLE_VALIDATION_ALLOWLIST)).toHaveLength(3)
  })

  it('recognises the hand-built 413 code in any quote and passes prose through', () => {
    const fixtures: readonly { readonly source: string; readonly hit: boolean }[] = [
      { source: "c.json({ error: 'payload_too_large', message }, 413)", hit: true },
      { source: 'c.json({ error: "payload_too_large" }, 413)', hit: true },
      { source: 'c.json({ error: `payload_too_large` }, 413)', hit: true },
      { source: "limitBody(MAX_FILE_UPLOAD_BYTES, 'Upload')", hit: false },
      { source: '// payload_too_large is what limitBody answers', hit: false },
    ]
    for (const { source, hit } of fixtures) {
      expect(PAYLOAD_TOO_LARGE.test(stripCommentsAndStrings(source)), source).toBe(hit)
    }
  })

  it('no route builds the payload_too_large body outside limitBody', () => {
    const scanned: string[] = []
    for (const dir of PAYLOAD_TOO_LARGE_SCAN_DIRS) walkSourceFiles(join(REPO_ROOT, dir), scanned)
    const sources = scanned.filter((path) => !isTestPath(path)).map(rel)
    // An empty scan agrees with every rule; the count is what keeps it honest.
    expect(sources.length).toBeGreaterThan(200)
    expect(sources).toContain(PAYLOAD_TOO_LARGE_HOME)
    const hits = sources
      .filter((path) => path !== PAYLOAD_TOO_LARGE_HOME)
      .filter((path) =>
        PAYLOAD_TOO_LARGE.test(
          stripCommentsAndStrings(
            readFileSync(join(REPO_ROOT, path), 'utf8'),
            join(REPO_ROOT, path),
          ),
        ),
      )
    expect(
      hits,
      'answer an oversized body with `limitBody(maxSize, noun)` from routes/body-limit.ts, so the 413 is built by `errorBody` in one place',
    ).toEqual([])
  })

  it('the helper still names the code it is the home of', () => {
    expect(
      PAYLOAD_TOO_LARGE.test(
        stripCommentsAndStrings(
          readFileSync(join(REPO_ROOT, PAYLOAD_TOO_LARGE_HOME), 'utf8'),
          join(REPO_ROOT, PAYLOAD_TOO_LARGE_HOME),
        ),
      ),
    ).toBe(true)
  })
})
