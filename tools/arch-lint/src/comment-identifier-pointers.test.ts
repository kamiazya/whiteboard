import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

// A backticked identifier in a comment is a POINTER the way a backticked
// filename is (`comment-file-pointers.test.ts`), and it goes stale the same
// silent way: the function is renamed or deleted, the comment keeps naming it,
// and a grep for the name finds exactly the comment that is wrong. Nine such
// pointers were found by hand in one pass — `withDocumentWriteLock` for the
// daemon's `withWorkspaceWriteLock`, `useMarkdownEmbedContent`,
// `assertEditorSpecFits` for a check that is inline in `resolveEditorSpec`,
// `loadPasskeys` — each one sending a reader to a symbol that does not exist.
//
// Narrowed on purpose. A first scan of every camelCase/PascalCase backticked
// word that appears nowhere in code flagged 35 names, and three quarters of
// them were right to be unresolvable: a vendor API a comment explains
// (`basicSetup`, `SubtleCrypto`, `noUncheckedIndexedAccess`), a field of an
// external format (OCIF's `fillColor`), a deliberate typo. A list that long
// is not a decision per entry, it is a licence. What stays is the shape the
// stale pointers actually had — an identifier that LOOKS like this repo's own
// function or constant: a verb-prefixed camelCase name (`useX`, `withX`,
// `resolveX`, …) or a multi-word CONSTANT_CASE. Those are overwhelmingly
// exports, and the few that are deliberately gone are named below.
//
// "Exists" means the name occurs on a NON-comment line of some tracked source,
// test or config file: a name only ever mentioned in other comments is the
// same dangling pointer one hop further away.

const VERB_PREFIXED =
  /^(?:use|get|set|create|resolve|with|assert|load|close|apply|has|build|make|read|write|parse|render|compute|derive|ensure|find|list|save|drop|handle|is|to|from)[A-Z][A-Za-z0-9]*$/
const CONSTANT_CASE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/

const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line)

const looksLikeOwnSymbol = (name: string): boolean =>
  VERB_PREFIXED.test(name) || CONSTANT_CASE.test(name)

/** Comment sources: product code, not tests (a test's own history is its own) and not migrations. */
const isCommentSource = (path: string): boolean =>
  /^(?:packages|apps|tools)\/[^/]+\/src\/.*\.tsx?$/.test(path) &&
  !/\.test\.tsx?$/.test(path) &&
  !path.includes('/test-utils/') &&
  !path.includes('/migrations/')

/** Names that are SUPPOSED to resolve to nothing, each with the sentence that makes it so. */
const DELIBERATELY_GONE: Readonly<Record<string, string>> = {
  'apps/web/src/lib/provider.ts#hasBranches':
    "names the since-retired branches backend's capability to say a markdown body never had one",
  'apps/web/src/lib/loro-codemirror-sync.ts#isInitDispatch':
    'a flag in the upstream binding this file was deliberately NOT copied from; the comment names it to say what it avoids',
  'packages/mcp-server/src/server/backup-restore.ts#ERR_FS_CP_EEXIST':
    "Node's own error code, which the comment says the failure used to surface raw as",
  'packages/mcp-server/src/server/routes/_test-helpers.ts#getDefaultServerDeps':
    'opens with "This used to be" — the sentence is the record of what the helper replaced',
  'packages/mcp-server/src/server/security/auth-strategy.ts#createLocalTokenAuthStrategy':
    'the header says the file USED to carry it and why that seam was deleted',
  'packages/mcp-server/src/server/security/auth-strategy.ts#createAuthStrategyMiddleware':
    'same sentence',
  'packages/mcp-server/src/server/security/route-scope-registry.ts#resolveServerModeApiScopes':
    'the header describes the catch-all function this module replaced, by name, to say why',
}

const SELF = 'tools/arch-lint/src/comment-identifier-pointers.test.ts'

interface Mention {
  readonly key: string
  readonly file: string
  readonly name: string
}

const tracked = trackedFiles(REPO_ROOT)

function codeIdentifiers(): Set<string> {
  const names = new Set<string>()
  for (const file of tracked) {
    if (!/\.(?:tsx?|mjs|cjs|js|json|css|sql)$/.test(file)) continue
    // Its allowlist spells every exempt name, so reading it would make each
    // one "exist" the moment this file is committed.
    if (file === SELF) continue
    for (const line of readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')) {
      if (isComment(line)) continue
      for (const match of line.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(match[0])
    }
  }
  return names
}

function mentions(): Mention[] {
  const found: Mention[] = []
  for (const file of tracked.filter(isCommentSource)) {
    for (const line of readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')) {
      if (!isComment(line)) continue
      for (const match of line.matchAll(/`([A-Za-z_$][\w$]*)`/g)) {
        const name = match[1] ?? ''
        if (looksLikeOwnSymbol(name)) found.push({ key: `${file}#${name}`, file, name })
      }
    }
  }
  return found
}

const EXISTING = codeIdentifiers()
const MENTIONS = mentions()
const UNRESOLVED = MENTIONS.filter(({ name }) => !EXISTING.has(name))

describe('an identifier a source comment points at is one the code still has', () => {
  it('reads a plausible number of comment pointers, most of which resolve', () => {
    // A scan whose regexes matched nothing, or whose corpus came up empty,
    // reports a clean tree. Measured at 886 mentions and 7 unresolved.
    expect(MENTIONS.length).toBeGreaterThan(500)
    expect(EXISTING.size).toBeGreaterThan(20_000)
    expect(UNRESOLVED.length).toBeLessThan(MENTIONS.length / 10)
  })

  it('has no pointer at a symbol that is gone', () => {
    const stale = [
      ...new Set(
        UNRESOLVED.filter(({ key }) => !(key in DELIBERATELY_GONE)).map(
          ({ file, name }) => `${file}: \`${name}\` is named by no code anywhere`,
        ),
      ),
    ]
    expect(stale).toEqual([])
  })

  it('holds no exemption for a pointer that resolves now or is no longer written', () => {
    const stillUnresolved = new Set(UNRESOLVED.map(({ key }) => key))
    const obsolete = Object.keys(DELIBERATELY_GONE).filter((key) => !stillUnresolved.has(key))
    expect(obsolete).toEqual([])
  })
})
