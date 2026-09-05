// Run with: node --test .claude/workflows/lib/claude-config-wiring.test.mjs
// A review dimension's identifier is duplicated across three files that nothing cross-checks:
// the `resources/<name>.md` filename (authoritative criteria), reviewer-dimension.md's embedded
// `## Dimensions` list (the legacy fallback used when a caller passes plain strings), and
// review.workflow.mjs's default `dimensions` array. A name added to one and forgotten in another
// degrades silently — the lane still runs, just with the wrong criteria or none at all — so this
// test is the guard, mirroring dev-loop-design-schema-sync.test.mjs's role for DESIGN_SCHEMA.
import assert from 'node:assert/strict'
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
