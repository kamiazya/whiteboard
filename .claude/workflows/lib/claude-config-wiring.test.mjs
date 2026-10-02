// Run with: node --test .claude/workflows/lib/claude-config-wiring.test.mjs
// A review dimension's identifier is duplicated across three files that nothing cross-checks:
// the `resources/<name>.md` filename (authoritative criteria), reviewer-dimension.md's embedded
// `## Dimensions` list (the legacy fallback used when a caller passes plain strings), and
// review.workflow.mjs's default `dimensions` array. A name added to one and forgotten in another
// degrades silently — the lane still runs, just with the wrong criteria or none at all — so this
// test is the guard, mirroring dev-loop-design-schema-sync.test.mjs's role for DESIGN_SCHEMA.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(__dirname, '..', '..', '..')
const resourcesDir = path.join(repoRoot, '.claude', 'skills', 'review-gate', 'resources')
const reviewerAgentPath = path.join(repoRoot, '.claude', 'agents', 'reviewer-dimension.md')
const reviewWorkflowPath = path.join(repoRoot, '.claude', 'workflows', 'review.workflow.mjs')

function resourceDimensionNames() {
  return readdirSync(resourcesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -'.md'.length))
    .sort()
}

// The skill derives `name` from the FILENAME, not the Title-Case `# ` heading, so this parses the
// agent's bullet keys the same way: `- **<name>**:`.
function agentDimensionNames() {
  const source = readFileSync(reviewerAgentPath, 'utf8')
  const section = source.match(/\n## Dimensions\n([\s\S]*?)\n## /)
  assert.ok(section, 'could not locate the `## Dimensions` section in reviewer-dimension.md')
  return [...section[1].matchAll(/^- \*\*([a-z0-9-]+)\*\*:/gm)].map((m) => m[1]).sort()
}

function defaultWorkflowDimensions() {
  const source = readFileSync(reviewWorkflowPath, 'utf8')
  const match = source.match(/const RAW_DIMENSIONS = A\.dimensions \|\| (\[[^\]]*\])/)
  assert.ok(match, 'could not locate the default `RAW_DIMENSIONS` array in review.workflow.mjs')
  // Evaluating a plain array literal from our own source
  return new Function(`return (${match[1]})`)()
}

test('resources/*.md and reviewer-dimension.md name the same dimensions', () => {
  assert.deepEqual(resourceDimensionNames(), agentDimensionNames())
})

test("review.workflow.mjs's default dimensions are all real dimensions", () => {
  const resources = resourceDimensionNames()
  for (const d of defaultWorkflowDimensions()) {
    assert.ok(resources.includes(d), `default dimension "${d}" has no resources/${d}.md`)
  }
})

// `reachability` is the "built but never wired" gate: a feature that compiles, typechecks, and has
// tests, yet no user can reach because nothing registers/mounts/renders it. Pinned into the DEFAULT
// list rather than left opt-in, because the failure mode is a reviewer not thinking to ask.
test('reachability runs by default, so an unwired increment cannot pass unremarked', () => {
  assert.ok(resourceDimensionNames().includes('reachability'))
  assert.ok(agentDimensionNames().includes('reachability'))
  assert.ok(defaultWorkflowDimensions().includes('reachability'))
})

// `background-work` is the same shape of gate, one layer down: work the server does on its own
// that runs on every instance instead of one, or blocks the loop that answers requests. Both are
// CORRECT code — tests pass, behaviour matches the design — so no other dimension has a reason to
// look, and neither is visible in a diff. Pinned into the DEFAULT list for that reason; dropping
// it back to opt-in is the same as removing it, since opt-in depends on a reviewer thinking to ask.
test('background-work runs by default, so recurring or blocking work cannot pass unremarked', () => {
  assert.ok(resourceDimensionNames().includes('background-work'))
  assert.ok(agentDimensionNames().includes('background-work'))
  assert.ok(defaultWorkflowDimensions().includes('background-work'))
})

// `complexity` is default for the same reason as the two above: code that is hard to follow
// passes its tests and does what it should, and the lint threshold fires only once the shape is
// set. The lane asks whether a structure would remove the difficulty rather than an exemption —
// a user decision (2026-09-23), and opt-in is the same as absent since it depends on a reviewer
// thinking to ask.
test('complexity runs by default, so a harder-to-follow diff is asked for a structural answer', () => {
  assert.ok(resourceDimensionNames().includes('complexity'))
  assert.ok(agentDimensionNames().includes('complexity'))
  assert.ok(defaultWorkflowDimensions().includes('complexity'))
})

// `agentType` is a plain string the Workflow runtime resolves at spawn time: a repo-owned agent
// renamed or typo'd here is not a load error, it is a lane that quietly runs as something else.
// Namespaced ids (`plugin:agent`) come from installed plugins and are not ours to check.
const BUILT_IN_AGENTS = ['Explore', 'Plan', 'general-purpose', 'claude']

test('every repo-owned agentType in a workflow has an agent definition', () => {
  const workflowDir = path.join(repoRoot, '.claude', 'workflows')
  const referenced = new Set()
  for (const file of readdirSync(workflowDir).filter((f) => f.endsWith('.mjs'))) {
    const source = readFileSync(path.join(workflowDir, file), 'utf8')
    for (const m of source.matchAll(/agentType: '([^']+)'/g)) referenced.add(m[1])
  }
  const ours = [...referenced].filter((a) => !a.includes(':') && !BUILT_IN_AGENTS.includes(a)).sort()
  const missing = ours.filter((a) => !existsSync(path.join(repoRoot, '.claude', 'agents', `${a}.md`)))
  assert.deepEqual(missing, [], `agentType with no .claude/agents/<name>.md: ${missing.join(', ')}`)
})

// The Simplify phase must run a repo-owned agent: the plugin-provided code-simplifier carries
// another project's coding standards in its own prompt (arrow-function bans this repo does not
// have), so its "project standards" step applies the wrong rules here.
test('the Simplify phase runs a repo-owned agent, not a foreign plugin agent', () => {
  const source = readFileSync(path.join(repoRoot, '.claude', 'workflows', 'dev-loop.workflow.mjs'), 'utf8')
  const match = source.match(/phase: 'Simplify', agentType: '([^']+)'/)
  assert.ok(match, "could not locate the Simplify phase's agentType in dev-loop.workflow.mjs")
  assert.ok(!match[1].includes(':'), `Simplify runs plugin agent "${match[1]}"; use a repo-owned agent`)
})

// architecture-map.md promises `.claude/rules/package-<name>.md` is path-scoped, and dev-flow.md
// requires every new package to ship that rule. Neither is mechanical, and 6 of the 7 shipped
// without the `paths:` frontmatter that makes the promise true — so every package's rule loaded
// into every session regardless of what was being touched. This is that prose made executable.
// A rule for something under `tools/` is named `tool-<name>.md` and scoped there, for the same
// reason and by the same check: `package-arch-lint.md` scoped to `tools/arch-lint/**` failed this
// guard, and the name was the thing that was wrong — arch-lint is not a package. `apps/` gets
// the same treatment as `app-<name>.md`, so a composition root's rule is scoped the same way.
test('every package-/tool-/app-<name>.md rule is path-scoped to its own directory', () => {
  const rulesDir = path.join(repoRoot, '.claude', 'rules')
  const unscoped = []
  const prefixes = { 'package-': 'packages', 'tool-': 'tools', 'app-': 'apps' }
  for (const file of readdirSync(rulesDir).filter((f) => f.endsWith('.md'))) {
    const prefix = Object.keys(prefixes).find((p) => file.startsWith(p))
    if (prefix === undefined) continue
    const dir = prefixes[prefix]
    const pkg = file.slice(prefix.length, -'.md'.length)
    const frontmatter = readFileSync(path.join(rulesDir, file), 'utf8').match(/^---\n([\s\S]*?)\n---\n/)
    // Match a real `paths:` LIST ITEM, not a substring of the frontmatter: these blocks carry
    // explanatory comments, and a pattern mentioned only in a comment would otherwise satisfy the
    // guard while scoping nothing.
    const isScoped = (frontmatter?.[1] ?? '')
      .split('\n')
      .some((line) => new RegExp(`^\\s*-\\s*["']?${dir}/${pkg}/\\*\\*["']?\\s*$`).test(line))
    if (!isScoped) unscoped.push(file)
  }
  assert.deepEqual(unscoped, [], `rules missing a "paths: <packages|tools>/<name>/**" frontmatter: ${unscoped.join(', ')}`)
})

// The Workflow runtime executes each script as a function body (top-level `return` is legal, so
// `node --check` cannot validate it). Nothing else parses the WHOLE file: the sync tests above
// extract fragments by regex, so a broken template literal between fragments passes every test and
// fails only at launch — which is exactly how an unescaped backtick in a prompt edit shipped to
// main and broke the next dev-loop run.
test('every workflow script parses as a workflow function body', () => {
  const workflowDir = path.join(repoRoot, '.claude', 'workflows')
  const bad = []
  for (const file of readdirSync(workflowDir).filter((f) => f.endsWith('.mjs'))) {
    const source = readFileSync(path.join(workflowDir, file), 'utf8')
      .replace(/^export const meta = /m, 'const meta = ')
    try {
      // The runtime runs scripts as an ASYNC function body (top-level await is legal), so the
      // parse check must use the async function constructor, not `new Function`.
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
      // Parse check of our own scripts, never executed
      new AsyncFunction('args', 'agent', 'workflow', 'phase', 'log', 'parallel', 'pipeline', 'budget', source)
    } catch (err) {
      bad.push(`${file}: ${err.message}`)
    }
  }
  assert.deepEqual(bad, [], `workflow scripts that do not parse:\n${bad.join('\n')}`)
})

// An agent's `skills:` entry is a preload, and a preload that resolves to nothing is not a load
// error — the agent just runs without the skill it was written around. A bare id must be a
// `.claude/skills/<id>/SKILL.md` this repo ships; a `plugin:skill` id must name a plugin the
// tracked settings.json enables, because a plugin is per-machine state that a clone does not
// bring. `ponytail:ponytail` was neither: two agents preloaded a ladder that only existed on one
// machine, and the agent bodies had to restate it "in case the plugin is absent".
function agentSkillIds(source) {
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? ''
  const block = frontmatter.match(/^skills:\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? ''
  return block
    .split('\n')
    .map((line) => line.match(/^\s*-\s+(\S+)\s*$/)?.[1])
    .filter((id) => id !== undefined)
}

function undeclaredSkills(ids, { skillDirs, enabledPlugins }) {
  return ids.filter((id) => {
    const [plugin, skill] = id.includes(':') ? id.split(':') : [undefined, id]
    if (plugin === undefined) return !skillDirs.includes(skill)
    // A plugin entry set to `false` is a disabled plugin, not a declared one.
    return !Object.entries(enabledPlugins).some(
      ([key, enabled]) => key.split('@')[0] === plugin && enabled === true,
    )
  })
}

test('every skill an agent preloads is shipped here or declared as an enabled plugin', () => {
  const agentsDir = path.join(repoRoot, '.claude', 'agents')
  const skillsDir = path.join(repoRoot, '.claude', 'skills')
  const settings = JSON.parse(readFileSync(path.join(repoRoot, '.claude', 'settings.json'), 'utf8'))
  const world = {
    skillDirs: readdirSync(skillsDir).filter((d) => existsSync(path.join(skillsDir, d, 'SKILL.md'))),
    enabledPlugins: settings.enabledPlugins ?? {},
  }
  const agents = readdirSync(agentsDir).filter((f) => f.endsWith('.md'))
  const preloaded = agents.flatMap((f) =>
    agentSkillIds(readFileSync(path.join(agentsDir, f), 'utf8')).map((id) => ({ agent: f, id })),
  )
  // Reached, not assumed: an extraction that matched nothing would pass every id.
  assert.ok(preloaded.length >= 8, `only ${preloaded.length} preloaded skills found`)
  const missing = preloaded.filter(({ id }) => undeclaredSkills([id], world).length > 0)
  assert.deepEqual(missing, [], 'agent preloads a skill that is neither in .claude/skills nor an enabled plugin')
})

test('a namespaced skill needs its plugin declared in settings.json', () => {
  const world = {
    skillDirs: ['local'],
    enabledPlugins: { 'declared@market': true, 'disabled@market': false },
  }
  assert.deepEqual(
    undeclaredSkills(['local', 'declared:any', 'ghost:any', 'absent', 'disabled:any'], world),
    ['ghost:any', 'absent', 'disabled:any'],
  )
})

// A hook command is run by a shell in the SESSION's working directory, which is a package
// directory as often as the repo root. `node .claude/scripts/x.mjs` there dies with a module-load
// error, exit 1 — a non-blocking hook failure — so the PreToolUse blockers silently did not run
// for a session working from `packages/mcp-server`. `$CLAUDE_PROJECT_DIR` names the project the
// session was opened on whatever the cwd is. A hook with no test beside it is the second hole: a
// hook fails open by design, so a broken one reads exactly like one with nothing to say.
const settings = JSON.parse(readFileSync(path.join(repoRoot, '.claude', 'settings.json'), 'utf8'))
const HOOK_COMMAND = /^node "\$CLAUDE_PROJECT_DIR\/([^"]+)"( .*)?$/

function trackedFiles() {
  return execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
    .split('\n')
    .filter(Boolean)
}

function hookCommands() {
  return Object.values(settings.hooks)
    .flat()
    .flatMap((group) => group.hooks)
    .map((hook) => hook.command)
}

/** Hooks whose own test is named for their library, with the reason it has no `<name>.test.mjs`. */
const TESTED_THROUGH_LIBRARY = {}

/** Files in `.claude/scripts/hooks/` that no settings.json entry runs, with the reason. */
const UNREFERENCED_HOOK_FILES = {}

function testCandidates(hookPath) {
  const dir = path.posix.dirname(hookPath)
  const base = path.posix.basename(hookPath, '.mjs')
  return [
    `.claude/scripts/${base}.test.mjs`,
    `.claude/scripts/${base}-lib.test.mjs`,
    `${dir}/${base}.script.test.ts`,
    `${dir}/${base}.test.ts`,
  ]
}

test('every settings.json hook runs a tracked script through $CLAUDE_PROJECT_DIR', () => {
  const commands = hookCommands()
  assert.ok(commands.length >= 9, `expected the nine hooks, read ${commands.length}`)
  const tracked = new Set(trackedFiles())
  for (const command of commands) {
    const match = HOOK_COMMAND.exec(command)
    assert.ok(
      match,
      `hook command is cwd-relative or unquoted, and dies from a package directory: ${command}`,
    )
    assert.ok(tracked.has(match[1]), `hook command names an untracked script: ${match[1]}`)
  }
})

test('every settings.json hook script has a test that a test run picks up', () => {
  const tracked = new Set(trackedFiles())
  for (const command of hookCommands()) {
    const script = HOOK_COMMAND.exec(command)?.[1]
    assert.ok(script, `unparseable hook command: ${command}`)
    const candidates = testCandidates(script)
    const exemption = TESTED_THROUGH_LIBRARY[script]
    const found = candidates.find((c) => tracked.has(c)) ?? exemption?.test
    assert.ok(found && tracked.has(found), `${script} has no test; looked for ${candidates.join(', ')}`)
    // `test:scripts` globs `.claude/scripts/*.test.mjs` and nothing deeper; a hook test anywhere
    // else would exist, pass, and never run there.
    assert.ok(
      /^\.claude\/scripts\/[^/]+\.test\.mjs$/.test(found) ||
        /^packages\/mcp-server\/scripts\/dev\/[^/]+\.test\.ts$/.test(found),
      `${script}'s test ${found} sits where no test project picks it up`,
    )
  }
})

test('a library-test exemption is still needed, and every hook file is wired or recorded', () => {
  const tracked = new Set(trackedFiles())
  const wired = new Set(hookCommands().map((c) => HOOK_COMMAND.exec(c)?.[1]))
  for (const script of Object.keys(TESTED_THROUGH_LIBRARY)) {
    assert.ok(wired.has(script), `exemption for ${script}, which no hook runs`)
    assert.ok(
      !testCandidates(script).some((c) => tracked.has(c)),
      `exemption for ${script} is unneeded: it has a test named for it`,
    )
  }
  const hookFiles = [...tracked].filter((f) => /^\.claude\/scripts\/hooks\/[^/]+\.mjs$/.test(f))
  assert.ok(hookFiles.length >= 5, `expected the hook scripts, read ${hookFiles.length}`)
  for (const file of hookFiles) {
    assert.ok(
      wired.has(file) || file in UNREFERENCED_HOOK_FILES,
      `${file} is run by no settings.json hook and is not recorded as deliberate`,
    )
  }
  for (const file of Object.keys(UNREFERENCED_HOOK_FILES)) {
    assert.ok(tracked.has(file) && !wired.has(file), `stale unreferenced-hook entry: ${file}`)
  }
})
