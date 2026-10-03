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
// Three kinds of text are read. Source comments (product code AND tests — a
// test's comment names the helper its case was written for just as often), the
// dev-workflow prose agents read at the moment they act: `.claude/rules/*.md`
// and `.claude/skills/**/*.md`, and the documents that sit beside a package's
// code: its README, and `apps/web`'s DESIGN.md and BRAND.md. The prose has no comment marker, so every
// backticked name in it counts, under a wider shape (any camelCase, PascalCase
// or CONSTANT_CASE name of six characters or more) because a rule names classes
// and constants as often as functions. That is also where foreign names live,
// so they are ledgered by NAME in groups below rather than one sentence each.
//
// The SOURCE-comment shape is not widened to every long camelCase name, and
// the package docs are read instead: measured, that widening left 83 unresolved
// names of which about 70 were vendor APIs or deliberate history, so it would
// start from a ledger longer than the defects it finds. The docs read under the
// prose shape need no such ledger, because a README or design document names
// the repo's own symbols far more often than a vendor's.
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

const SELF = 'tools/arch-lint/src/comment-identifier-pointers.test.ts'

/**
 * Comment sources: product code and tests, not migrations. The guard's own
 * file is out: its comments name the stale pointers it was written about, as
 * its own fixtures.
 */
const isCommentSource = (path: string): boolean =>
  /^(?:packages|apps|tools)\/[^/]+\/src\/.*\.tsx?$/.test(path) &&
  path !== SELF &&
  !path.includes('/test-utils/') &&
  !path.includes('/migrations/')

/** Prose the dev workflow reads: the always-on and path-scoped rules, and every skill. */
const isWorkflowProse = (path: string): boolean =>
  /^\.claude\/rules\/[^/]+\.md$/.test(path) || /^\.claude\/skills\/.+\.md$/.test(path)

/**
 * The documents a package ships beside its source. The same rot, and a reader
 * who trusts them more because they are the front door: `packages/model`'s README
 * named a hand-written type that was never there and a subpath the manifest
 * does not export. A CHANGELOG is history by design and is not read.
 */
const isPackageDoc = (path: string): boolean =>
  /^(?:packages|apps)\/[^/]+\/(?:README|DESIGN|BRAND)\.md$/.test(path)

const PROSE_SHAPE =
  /^(?:[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+|(?:[A-Z][a-z0-9]+){2,}|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/

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
  'apps/web/src/lib/app-routes.test.ts#parseBrowserRoute':
    'the cases it kept from a parser that was merged into the shared one, named to say whose they were',
  'apps/web/src/lib/loro-codemirror-sync.test.ts#isInitDispatch':
    'the same upstream flag as the source file, named to say what this binding avoids',
  'apps/web/src/pages/BrowserDocumentPage.comments-panel.browser.test.tsx#getAllBy':
    "Testing Library's query family, named to say why a wait is shaped as it is",
  'apps/web/src/pages/BrowserIndexPage.back-after-foreign-write.browser.test.tsx#resolveManualMock':
    "a vitest internal the comment names to say what the test's mock path goes through",
  'apps/web/src/pages/BrowserIndexPage.back-during-load.browser.test.tsx#resolveManualMock':
    'same sentence',
  'apps/web/src/scoped-screen-state.test.ts#saveState':
    'narrates a defect and its fix in the state the code no longer carries under that name',
  'packages/mcp-server/src/server/export/headless-renderer.test.ts#LABEL_APPEARANCE':
    'narrates the verified export defect the test guards, by the constant it involved',
  'packages/mcp-server/src/server/security/secret-file-mode.test.ts#O_TRUNC':
    'a POSIX open flag Node exposes on `fs.constants`, named to explain a mode check',
  'tools/arch-lint/src/root-composite-scripts.test.ts#ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT':
    "pnpm's own error code, the failure the guard exists to prevent",
  'tools/arch-lint/src/test-only-exports.test.ts#resolveEdgeStyle':
    'the header names the deletions that motivated the guard',
  'tools/arch-lint/src/test-only-exports.test.ts#isOriginAllowedForServerMode': 'same sentence',
  'tools/arch-lint/src/vocabulary-check.test.ts#BROWSER_LOCAL':
    'a retired word, spelled in every casing in order to ban it',

  // Dev-workflow prose (.claude/rules, .claude/skills). History and worked
  // examples first: each names a thing that is gone, in a sentence that says so.
  '.claude/rules/app-web.md#drawAs': 'names the deleted state to describe the chain it fed',
  '.claude/rules/app-web.md#AppShellWorkspaces':
    'a history sentence about the seam both implementations used to share',
  '.claude/rules/coverage-ledger.md#StateDotTone':
    'a worked example of a closed vocabulary, naming a type since removed',
  '.claude/rules/package-canvas-render.md#ResolvedDocBundle':
    'a history sentence about the shape an invariant was first stated over',
  '.claude/rules/package-canvas-render.md#resolveFileLabel':
    'a history sentence about the parallel callbacks the references bundle replaced',
  '.claude/rules/package-facet-engine.md#facetPayloadSamples':
    'names the form-derived sampler the plugin-supplied one replaced',
  '.claude/rules/package-scene.md#facetPayloadSamples': 'same sentence',
  '.claude/rules/vocabulary.md#OpenCanvas': 'the retired name, spelled in order to retire it',
  '.claude/rules/vocabulary.md#browserLocal':
    'the retired casing, listed so a sweep does not miss it',
  '.claude/rules/vocabulary.md#BrowserLocal': 'same sentence',
  '.claude/rules/vocabulary.md#BROWSER_LOCAL': 'same sentence',
  '.claude/rules/vocabulary.md#canvasPath':
    'a retired container-noun helper, named as an example of what a rename leaves behind',
  '.claude/rules/vocabulary.md#listCanvasesV1': 'same sentence',
  '.claude/skills/audit-triage/resources/contract-drift.md#manifestJson':
    'an illustrative persisted-JSON field name, not a pointer into code',
  '.claude/skills/review-gate/resources/boundary.md#manifestJson': 'same sentence',
  '.claude/skills/zod-schema-discipline/SKILL.md#manifestJson': 'same sentence',
  '.claude/skills/mcp-tool-surface/SKILL.md#nodeExtensionWriteSchema':
    'a measured row that describes a schema since cut, by the name it had',
  '.claude/skills/measured-change/SKILL.md#DaemonDetectedBanner':
    'a worked measurement of a component that has since been split',
  '.claude/skills/measured-change/SKILL.md#decideConnectGate': 'same worked measurement',
  '.claude/skills/measured-change/SKILL.md#explainProbeFailure': 'same worked measurement',
  '.claude/skills/measured-change/SKILL.md#deriveCapabilityTier': 'same worked measurement',
  '.claude/skills/measured-change/SKILL.md#shouldShowDaemonCta': 'same worked measurement',
}

/**
 * Names in workflow prose that belong to someone else's API, a harness tool or
 * example code, so resolving to nothing here is correct. Grouped by what they
 * are rather than one sentence each: what the group says is why none can ever
 * resolve. A name leaves its group when no prose mentions it.
 */
const FOREIGN_NAMES: Readonly<Record<string, readonly string[]>> = {
  'vitest, Stryker and Biome options and APIs the testing skills explain': [
    'detectAsyncLeaks',
    'frameLocator',
    'toBeInViewport',
    'schemaMatching',
    'UserEvent',
    'recordCanvas',
    'inlineImages',
    'sharedViteServer',
    'testNamePattern',
    'vmForks',
    'vmThreads',
    'defineCacheKeyGenerator',
    'VITEST_POOL_ID',
    'VITEST_WORKER_ID',
    'VITEST_BROWSER_CONNECTION_CLOSED',
    'filterMeta',
    'outputFile',
    'outputJson',
    'perFile',
    'AI_AGENT',
    'restoreMocks',
    'clearMocks',
    'unstubEnvs',
    'unstubGlobals',
    'thenReturn',
    'thenResolve',
    'thenReject',
    'thenReturnOnce',
    'toHaveBeenExhausted',
    'TestContext',
    'noExportsInTest',
    'toBeFasterThan',
    'samplesCount',
    'testFilter',
    'getTaskFullName',
    'fullTestName',
    'resolveManualMock',
    'IS_REACT_ACT_ENVIRONMENT',
  ],
  'React and Next.js APIs and illustrative example code in the vendored React guidance': [
    'useEffectEvent',
    'getFlag',
    'someCondition',
    'useKeyboardShortcut',
    'offsetWidth',
    'suppressHydrationWarning',
    'prefetchDNS',
    'preloadModule',
    'preinitModule',
    'useTransition',
    'isPending',
    'UserProfile',
    'sortOrder',
    'useDeferredValue',
    'currentUser',
    'getChat',
    'getUser',
    'noImplicitAny',
    'optimizePackageImports',
  ],
  "the agent harness's own tools": [
    'TaskStop',
    'TaskCreate',
    'TaskList',
    'TaskUpdate',
    'TaskGet',
    'CronCreate',
    'ScheduleWakeup',
  ],
  'loro-crdt, zod/JSON Schema, Lucene, Node, pnpm and browser-API names': [
    'LoroTree',
    'LoroList',
    'ensureMergeableText',
    'skipWaiting',
    'unevaluatedProperties',
    'fromJsonSchema',
    'outputUnigrams',
    'NotImplementedError',
    'ERR_PNPM_OUTDATED_LOCKFILE',
  ],
}

const FOREIGN_REASON = new Map(
  Object.entries(FOREIGN_NAMES).flatMap(([reason, names]) =>
    names.map((name) => [name, reason] as const),
  ),
)

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

function proseMentions(): Mention[] {
  const found: Mention[] = []
  for (const file of tracked.filter((path) => isWorkflowProse(path) || isPackageDoc(path))) {
    for (const match of readFileSync(join(REPO_ROOT, file), 'utf8').matchAll(
      /`([A-Za-z_$][\w$]*)`/g,
    )) {
      const name = match[1] ?? ''
      if (name.length >= 6 && (PROSE_SHAPE.test(name) || looksLikeOwnSymbol(name))) {
        found.push({ key: `${file}#${name}`, file, name })
      }
    }
  }
  return found
}

const EXISTING = codeIdentifiers()
const MENTIONS = mentions()
const PROSE = proseMentions()
const UNRESOLVED = MENTIONS.filter(({ name }) => !EXISTING.has(name))
const UNRESOLVED_PROSE = PROSE.filter(({ name }) => !EXISTING.has(name))
const isLedgered = ({ key, name }: Mention): boolean =>
  key in DELIBERATELY_GONE || FOREIGN_REASON.has(name)

describe('an identifier a source comment points at is one the code still has', () => {
  it('reads a plausible number of comment pointers, most of which resolve', () => {
    // A scan whose regexes matched nothing, or whose corpus came up empty,
    // reports a clean tree. Measured at 886 mentions and 7 unresolved before
    // tests were read, and well past 1000 with them.
    expect(MENTIONS.length).toBeGreaterThan(900)
    expect(EXISTING.size).toBeGreaterThan(20_000)
    expect(UNRESOLVED.length).toBeLessThan(MENTIONS.length / 10)
    expect(MENTIONS.some(({ file }) => /\.test\.tsx?$/.test(file))).toBe(true)
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
})

describe('an identifier the rules, skills and package docs point at is one the code still has', () => {
  it('reads the prose it is about, and most of what it names resolves', () => {
    // Measured at ~2,000 mentions across ~100 files, ~120 of them unresolved
    // (a third are vitest/React/harness names, ledgered by name).
    expect(PROSE.length).toBeGreaterThan(1_000)
    expect(new Set(PROSE.map(({ file }) => file)).size).toBeGreaterThan(40)
    expect(PROSE.some(({ file }) => file.startsWith('.claude/rules/'))).toBe(true)
    expect(PROSE.some(({ file }) => file.startsWith('.claude/skills/'))).toBe(true)
    expect(PROSE.some(({ file }) => isPackageDoc(file))).toBe(true)
    expect(UNRESOLVED_PROSE.length).toBeLessThan(PROSE.length / 10)
  })

  it('names no symbol that is gone, outside the ledger', () => {
    const stale = [
      ...new Set(
        UNRESOLVED_PROSE.filter((mention) => !isLedgered(mention)).map(
          ({ file, name }) => `${file}: \`${name}\` is named by no code anywhere`,
        ),
      ),
    ]
    expect(stale).toEqual([])
  })
})

describe('the ledgers hold nothing that has stopped being true', () => {
  it('holds no exemption for a pointer that resolves now or is no longer written', () => {
    const stillUnresolved = new Set([...UNRESOLVED, ...UNRESOLVED_PROSE].map(({ key }) => key))
    const obsolete = Object.keys(DELIBERATELY_GONE).filter((key) => !stillUnresolved.has(key))
    expect(obsolete).toEqual([])
  })

  it('holds no foreign name that no prose mentions, or that the code now has', () => {
    const unresolvedNames = new Set(UNRESOLVED_PROSE.map(({ name }) => name))
    const obsolete = [...FOREIGN_REASON.keys()].filter((name) => !unresolvedNames.has(name))
    expect(obsolete).toEqual([])
  })
})
