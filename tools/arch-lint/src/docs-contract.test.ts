import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { codeText } from './markdown-code.js'
import { bareScriptNames, declaresScript, scriptsOf } from './pnpm-scripts.js'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

// The user-facing docs/ tree is the contract surface for anything a real
// operator needs to discover (env vars, escape hatches). R5 of the MCP-UI
// retirement (ADR 0001) deletes the WHITEBOARD_LEGACY_UI escape hatch along
// with the legacy UI it toggled — this test fails the build if the flag is
// ever documented again without the code behind it existing.
const DOCS_ROOT = join(REPO_ROOT, 'docs')

// vitest-projects.mjs (tools/checks) is the single source of truth for the
// browser-project inventory, shared with ci-verify-coverage.test.ts and the
// CI-invoked run-shared-layer-tests.mjs derivation. Dynamic import + cast
// matches the established pattern in release-gate-matrix.test.ts.
const { readBrowserProjectNames, readVitestProjects } = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/vitest-projects.mjs')).href
)) as {
  readBrowserProjectNames: (repoRoot: string) => string[]
  readVitestProjects: (repoRoot: string) => { name: string | undefined }[]
}

function collectMarkdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) return collectMarkdownFiles(entryPath)
    return entry.name.endsWith('.md') ? [entryPath] : []
  })
}

describe('docs/ contract', () => {
  it('no longer documents the retired WHITEBOARD_LEGACY_UI escape hatch', () => {
    const markdownFiles = collectMarkdownFiles(DOCS_ROOT)
    const mentioning = markdownFiles.filter((path) =>
      readFileSync(path, 'utf8').includes('WHITEBOARD_LEGACY_UI'),
    )
    expect(mentioning).toEqual([])
  })

  it('describes `pnpm test` as covering every package with a root vitest project', () => {
    // The root vitest.config.ts is the source of truth for which packages
    // `pnpm test` actually exercises. A doc line that omits a package (e.g.
    // canvas-viewer) misleads contributors into skipping its failures.
    const rootVitestConfig = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8')
    const projectPackageDirs = [
      ...new Set(
        [...rootVitestConfig.matchAll(/'((?:packages|apps)\/[^/]+)\//g)].map((match) => match[1]),
      ),
    ]
    // The doc shorthand for each package's project(s) doesn't match its
    // directory name 1:1 (e.g. packages/mcp-server's projects are named
    // "mcp-node"/"mcp-smoke", not "mcp-server"). Check for the substring a
    // reader would recognize as "this package's tests are covered" instead
    // of requiring an exact directory-name match.
    const docMentionTokenForPackageDir: Record<string, string> = {
      'packages/mcp-server': 'mcp',
      'packages/model': 'model',
      'packages/ports': 'ports',
      'packages/facet-engine': 'facet-engine',
      'packages/facet-ui': 'facet-ui',
      'packages/plugin-visual': 'plugin-visual',
      'packages/codec': 'codec',
      'packages/canvas-render': 'canvas-render',
      'packages/loro-adapter': 'loro-adapter',
      'packages/search': 'search node',
      'packages/reference-graph': 'reference-graph node',
      'packages/server-core': 'server-core',
      'packages/workspace-index': 'workspace-index',
      'packages/history': 'history',
      'packages/scene': 'scene',
      'packages/canvas-viewer': 'canvas-viewer',
      'packages/daemon-client': 'daemon-client',
      'apps/extension': 'extension node',
      'apps/web': 'web',
    }
    const docsDescribingFullTestSuite = [
      join(DOCS_ROOT, 'contributing/development.md'),
      join(DOCS_ROOT, 'contributing/testing.md'),
    ]

    for (const docPath of docsDescribingFullTestSuite) {
      const content = readFileSync(docPath, 'utf8')
      // Only the line that spells out the suite composition (identified by
      // its "mcp-smoke" mention) is a drift risk; a plain "pnpm test # all
      // projects" summary line makes no enumeration claim to go stale.
      const fullSuiteLine = content
        .split('\n')
        .find((line) => /^pnpm test\s/.test(line.trim()) && line.includes('mcp-smoke'))
      expect(fullSuiteLine, `${docPath} is missing a \`pnpm test\` description line`).toBeDefined()
      for (const packageDir of projectPackageDirs) {
        const token = docMentionTokenForPackageDir[packageDir]
        expect(token, `add a doc-mention token for ${packageDir} in this test`).toBeDefined()
        expect(
          fullSuiteLine,
          `${docPath}'s \`pnpm test\` line should mention "${token}" (from ${packageDir} in vitest.config.ts)`,
        ).toContain(token)
      }
    }
  })

  it('documents every real-browser vitest project for `pnpm test:browser`', () => {
    // Derive the actual set of browser-mode project names (config `test.name`
    // where `browser.enabled` is true) from the config files vitest.config.ts
    // wires up, rather than counting how many times a filename string occurs.
    // Counting filenames would stay green even if a project's own name
    // diverged from what testing.md documents, or if a differently-named
    // config elsewhere in the tree happened to share the same filename.
    const browserProjectNames = readBrowserProjectNames(REPO_ROOT)
    // Pin the known set so this test also fails (rather than silently
    // shrinking its coverage) if a browser project is ever removed.
    expect(browserProjectNames.sort()).toEqual([
      'canvas-render-browser',
      'canvas-viewer-browser',
      'web-browser',
      'web-browser-window-state',
    ])

    const testingDocPath = join(DOCS_ROOT, 'contributing/testing.md')
    const content = readFileSync(testingDocPath, 'utf8')
    expect(content).not.toContain('There is one real-browser Vitest project')
    for (const projectName of browserProjectNames) {
      expect(content).toContain(projectName)
    }
  })

  // The Browser Testing table is the one place a reader learns what each
  // browser project is FOR, and it said "three" for a long while after a
  // fourth landed — the name appeared in the `pnpm test:browser` comment, so
  // the check above stayed green over a table that omitted the project.
  it('has a table row for every real-browser vitest project, and states no count of them', () => {
    const content = readFileSync(join(DOCS_ROOT, 'contributing/testing.md'), 'utf8')
    const browserProjectNames = readBrowserProjectNames(REPO_ROOT)
    expect(browserProjectNames.length).toBeGreaterThan(0)
    for (const projectName of browserProjectNames) {
      expect(content, `testing.md's browser table lost the ${projectName} row`).toMatch(
        new RegExp(`^\\| \`${projectName}\` \\|`, 'm'),
      )
    }
    expect(content).not.toMatch(/There are (three|four|five) real-browser/i)
  })

  // The mutation target list is owned by stryker.config.mjs (and guarded by
  // stryker-targets.test.ts). testing.md carried a copy that named four paths
  // that no longer exist and omitted one that did, so the doc points at the
  // config instead. A fenced block of source paths is that copy returning.
  it('does not copy the stryker mutate list into testing.md', () => {
    const content = readFileSync(join(DOCS_ROOT, 'contributing/testing.md'), 'utf8')
    expect(content).toContain('packages/mcp-server/stryker.config.mjs')
    expect(/^src\/\S+\.ts$/m.test(content), 'a copied list of src/ paths is back').toBe(false)
  })

  // The quick-start playwright command must work FROM REPO ROOT. The bare
  // `pnpm exec playwright install` form fails there (playwright is a
  // devDependency of apps/web and canvas-viewer only), which a clean-clone
  // contributor hits at step 4 — and CI never notices, because it sets
  // WHITEBOARD_CHROME_PATH and skips playwright install entirely.
  it('gives contributors the filtered playwright install command, never the bare root form', () => {
    const filtered =
      'pnpm --filter @kamiazya/whiteboard-web exec playwright install --with-deps chromium'
    const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8')
    const development = readFileSync(join(DOCS_ROOT, 'contributing/development.md'), 'utf8')
    for (const [name, content] of [
      ['CONTRIBUTING.md', contributing],
      ['development.md', development],
    ] as const) {
      expect(content, `${name} must carry the filtered command`).toContain(filtered)
      expect(
        /^pnpm exec playwright install/m.test(content),
        `${name} still carries the bare root-level form, which fails from repo root`,
      ).toBe(false)
    }
    // The parenthetical names every real-browser project, derived from the
    // configs so a new browser project cannot leave it stale again.
    for (const projectName of readBrowserProjectNames(REPO_ROOT)) {
      expect(contributing, `CONTRIBUTING.md's playwright line must name ${projectName}`).toContain(
        projectName,
      )
    }
  })

  // The single pre-PR gate the repo actually maintains (derived from ci.yml
  // by local-gate-command.test.ts) must be the one the human checklist names —
  // its absence taught contributors five missing gates via a red CI job.
  it('puts pnpm check:local in the PR checklist, cross-referenced from the docs index', () => {
    const contributing = readFileSync(join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8')
    const checklist = contributing.split('## Pull request checklist')[1]?.split('\n## ')[0] ?? ''
    expect(checklist).toContain('pnpm check:local')
    const docsIndex = readFileSync(join(DOCS_ROOT, 'contributing/README.md'), 'utf8')
    expect(docsIndex).toContain('check:local')
  })

  // packageManager pins the exact pnpm; a contributor on an older global pnpm
  // silently rewrites the lockfile on first install and fails CI's
  // --frozen-lockfile. Deriving the version here means a future pnpm bump
  // that forgets the docs fails this test instead of leaving a stale number.
  it('states the pinned pnpm version and corepack enable in both prerequisite blocks', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      packageManager?: string
    }
    const pinned = pkg.packageManager
    expect(pinned).toMatch(/^pnpm@/)
    for (const path of [
      join(REPO_ROOT, 'CONTRIBUTING.md'),
      join(DOCS_ROOT, 'contributing/development.md'),
    ]) {
      const content = readFileSync(path, 'utf8')
      expect(content, `${path} must state the pinned ${pinned}`).toContain(pinned as string)
      expect(content, `${path} must tell contributors to run corepack enable`).toContain(
        'corepack enable',
      )
    }
  })

  // The repo-local dev-override table names the exact config key a
  // contributor is told to edit. Both rows had drifted to a key that does not
  // exist: `.claude/settings.json` has no `mcpServers` field in its schema (a
  // definition there is silently ignored), and Codex's dev entry is
  // `whiteboard_dev` — plain `whiteboard` is the DISABLED published mirror, so
  // following the table would switch the published server back on.
  it('names dev-override config keys that actually exist', () => {
    const content = readFileSync(join(DOCS_ROOT, 'contributing/development.md'), 'utf8')
    const claudeSettings = JSON.parse(
      readFileSync(join(REPO_ROOT, '.claude/settings.json'), 'utf8'),
    ) as Record<string, unknown>
    const codexConfig = readFileSync(join(REPO_ROOT, '.codex/config.toml'), 'utf8')

    if (!('mcpServers' in claudeSettings)) {
      // Scoped to the table rows, which are what NAME a key to go edit. Prose
      // is allowed — required, in fact — to mention the pairing in order to
      // warn that it does not work.
      const prescribing = content
        .split('\n')
        .filter(
          (line) =>
            line.startsWith('|') &&
            line.includes('.claude/settings.json') &&
            line.includes('mcpServers'),
        )
      expect(
        prescribing,
        '.claude/settings.json carries no mcpServers key; the doc must not table it as a config to edit',
      ).toEqual([])
      expect(content).toContain('silently ignored')
    }
    // The mechanism that does work, documented earlier in the same file.
    expect(content).toContain('claude mcp add --scope local')

    // The Codex dev override goes through the stdio proxy, which derives the
    // per-worktree port from its own on-disk location — a hardcoded URL here
    // silently pointed every linked worktree's Codex session at the MAIN
    // checkout's daemon, code, and data. The whole file is held to it: no
    // port literal and no loopback-URL literal may survive anywhere,
    // including the header prose, so the comments cannot drift back to
    // describing the retired HTTP-URL transport.
    const devEntry = codexConfig.split('[mcp_servers.whiteboard_dev]')[1] ?? ''
    expect(devEntry, 'whiteboard_dev must exist').not.toBe('')
    expect(devEntry).toContain('mcp-http-stdio-proxy.mjs')
    expect(/^url\s*=/m.test(devEntry), 'whiteboard_dev must not carry a url key').toBe(false)
    expect(codexConfig, 'no hardcoded port may survive anywhere in the file').not.toContain('3099')
    expect(codexConfig).not.toContain('http://127.0.0.1')
    // The published mirror stays disabled — the separate _dev name is what
    // keeps Codex from merging the override into the stdio entry.
    const publishedEntry = codexConfig
      .split('[mcp_servers.whiteboard]')[1]
      ?.split('[mcp_servers.')[0]
    expect(publishedEntry).toContain('enabled = false')
    // development.md's table row for the dev override must use the transport
    // word that is now true: the stdio proxy.
    const devRow = content
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes('whiteboard_dev'))
    expect(devRow, 'development.md must table the whiteboard_dev override').toBeTruthy()
    expect(devRow).toContain('stdio proxy')
  })

  // What the browser UI server mode serves does (ADR-0047), and the two things
  // an operator scaling out has to set before a user reports stale documents:
  // the workspace tail and a sticky load balancer.
  it('tells self-hosting operators what the browser UI does, and how to run several instances', () => {
    const guide = readFileSync(join(DOCS_ROOT, 'how-to/self-host-with-docker.md'), 'utf8')
    expect(guide).toContain('open one to read and')
    expect(guide).toContain('## Running several instances')
    expect(guide).toContain('WHITEBOARD_WORKSPACE_TAIL_MS')
    expect(guide).toContain('sticky')
    // Both halves of the shared record: rows in one libSQL server, and the
    // images in one volume. Either alone leaves instances diverging.
    expect(guide).toContain('both required')
    // A reverse proxy as a sign-in provider, and the one thing it must do.
    expect(guide).toContain('kind: trusted-header')
    expect(guide).toContain('trustedAddresses')
    expect(guide).toContain('WHITEBOARD_DATABASE_URL')
    // The two surfaces this deployment actually serves.
    expect(guide).toContain('/api')
    expect(guide).toContain('/mcp')
  })

  // A count spelled out in prose is the kind of claim nobody re-reads: it read
  // "seventeen" for at least two added projects, next to an enumeration that
  // still named a `workspace node` project the repo no longer has.
  it('spells the root vitest project count as the number of projects there are', () => {
    const spelled = [
      'ten',
      'eleven',
      'twelve',
      'thirteen',
      'fourteen',
      'fifteen',
      'sixteen',
      'seventeen',
      'eighteen',
      'nineteen',
      'twenty',
      'twenty-one',
      'twenty-two',
      'twenty-three',
      'twenty-four',
      'twenty-five',
      'twenty-six',
      'twenty-seven',
      'twenty-eight',
    ]
    const projectCount = readVitestProjects(REPO_ROOT).length
    const correct = spelled[projectCount - 10]
    expect(correct, `extend the spelled-number list past ${projectCount}`).toBeDefined()

    const content = readFileSync(join(DOCS_ROOT, 'contributing/development.md'), 'utf8')
    const claim = content.match(/out of the ([\w-]+) configured/)
    expect(
      claim,
      'development.md no longer states a project count in the expected form',
    ).not.toBeNull()
    expect(claim?.[1]).toBe(correct)
  })

  // The sentence enumerated what `--project mcp-node` skips, out of "the
  // twenty-eight" — and named twenty-seven, omitting `scene-node`, because a
  // hand list of a derived set is wrong the day a project lands. The set is
  // CONTRIBUTING.md's table's to state.
  it('points at the project table instead of enumerating what `--project mcp-node` skips', () => {
    const content = readFileSync(join(DOCS_ROOT, 'contributing/development.md'), 'utf8')
    const sentence = content.match(/selects only the `mcp-node` project[^\n]*/)?.[0]
    expect(sentence, 'development.md lost the mcp-node narrow-pass sentence').toBeDefined()
    expect(sentence).toContain('CONTRIBUTING.md')
    expect(sentence, 'an enumeration of skipped projects is back').not.toMatch(/also skips/)
    expect(sentence?.length).toBeLessThan(450)
  })

  // The browser projects were "three" in four places after a fourth landed
  // (`web-browser-window-state`), and the checks above only prove each NAME is
  // somewhere, so they stayed green. A spelled count of them in prose is a
  // claim nobody re-reads; it must equal the number the configs declare.
  it('states no count of the browser projects other than the one the configs declare', () => {
    const words = ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
    const count = readBrowserProjectNames(REPO_ROOT).length
    const correct = words[count - 2]
    expect(correct, `extend the spelled-number list past ${count}`).toBeDefined()

    const claim = new RegExp(
      `\\b(${words.join('|')}) (?:real-)?browser(?:-mode)? (?:vitest )?projects?`,
      'gi',
    )
    const files = trackedFiles(REPO_ROOT, '*.md').filter((path) => !path.includes('/adr/'))
    let reached = 0
    const wrong: string[] = []
    for (const path of files) {
      for (const match of readFileSync(join(REPO_ROOT, path), 'utf8').matchAll(claim)) {
        reached++
        if (match[1]?.toLowerCase() !== correct)
          wrong.push(`${path}: "${match[0]}" (declared: ${correct})`)
      }
    }
    // The subject must be present: a regex that matched nothing would pass.
    expect(reached).toBeGreaterThanOrEqual(1)
    expect(wrong).toEqual([])
  })

  it('describes `pnpm test --project mcp-node` as a narrow, not a broad non-browser, pass', () => {
    // mcp-node is one of thirteen root vitest.config.ts projects. A doc that
    // frames it as merely "skipping the Playwright browser project" implies
    // it still covers canvas-viewer and apps/web node/jsdom, which it does not.
    const developmentDocPath = join(DOCS_ROOT, 'contributing/development.md')
    const content = readFileSync(developmentDocPath, 'utf8')
    expect(content).not.toMatch(/skips the Playwright browser project/i)
    expect(content).toMatch(/mcp-node.*only.*project|only the.*mcp-node.*project/i)
  })

  // `pnpm <name>` runs a script of the package the shell is IN, so a bare
  // command in a document is root-runnable only when the root declares it.
  // `pnpm docs:snapshots` and `pnpm build:widget` were written exactly so, and
  // answer ERR_PNPM_NO_SCRIPT from the root — the reader who copies the line
  // learns nothing about where to run it. A package's own README may say a
  // bare command if it also says it runs from the package directory.
  it('every bare `pnpm <script>` in tracked Markdown is a root script, or says where it runs', () => {
    const rootScripts = scriptsOf(REPO_ROOT)
    const files = trackedFiles(REPO_ROOT, '*.md').filter((path) => !path.includes('/adr/'))
    expect(files.length).toBeGreaterThan(200)

    let reached = 0
    const stray: string[] = []
    for (const path of files) {
      const text = readFileSync(join(REPO_ROOT, path), 'utf8')
      const lines = text.split('\n')
      const owner = /^((?:packages|apps)\/[^/]+)\//.exec(path)?.[1]
      const ownScripts = owner ? scriptsOf(REPO_ROOT, owner) : {}
      for (const name of bareScriptNames(codeText(text))) {
        reached++
        if (declaresScript(rootScripts, name)) continue
        // `codeText` drops the prose, so the line is found again in the source.
        const written = lines.filter((l) => l.includes(`pnpm ${name}`))
        const saysWhere = written.some((l) => /package dir|from the package|--filter|-C /i.test(l))
        if (declaresScript(ownScripts, name) && saysWhere) continue
        stray.push(`${path}: pnpm ${name}`)
      }
    }
    expect(reached).toBeGreaterThan(300)
    expect(
      stray,
      'spell it `pnpm --filter <pkg> <script>`, or say it runs from the package dir',
    ).toEqual([])
  })
})
