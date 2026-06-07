export const meta = {
  name: 'dependabot-triage',
  description:
    'Triage open Dependabot dependency-bump PRs + Dependabot security alerts for the whiteboard repo into a merge-ordered plan. Per PR: classify (semver x ecosystem), read changelog/release notes, grep the repo for breaking-change impact, check the verify CI, and flag superseded duplicates; load-bearing/major bumps get an adversarial "is it safe to merge?" refutation. Maps each open alert to the PR that fixes it (or flags transitive/manual). Read-only (gh + code reads + WebFetch) — returns a plan; the integrator executes merges per the dependabot-review skill.',
  whenToUse:
    'When Dependabot PRs pile up or security alerts need clearing. Pass args:{prs?:number[] (default: all open app/dependabot PRs), includeAlerts?:bool (default true), cwd?}. Not for merging (the single integrator does that). See the dependabot-review skill for the merge-execution loop + judgement rules.',
  phases: [
    { title: 'Gather', detail: 'list open Dependabot PRs + open alerts via gh' },
    { title: 'Analyze', detail: 'one agent per PR: classify + changelog + impact + CI + supersede' },
    { title: 'Verify', detail: 'adversarial refute "safe to merge" for load-bearing / major bumps' },
    { title: 'Synthesize', detail: 'merge-ordered plan + alert coverage map + backlog items' },
  ],
}

const A = (() => {
  try { return typeof args === 'string' ? JSON.parse(args) : (args && typeof args === 'object' ? args : {}) } catch { return {} }
})()
const ONLY_PRS = Array.isArray(A.prs) && A.prs.length ? A.prs : null
const INCLUDE_ALERTS = A.includeAlerts !== false
const CWD = A.cwd || null
const cwdHint = CWD ? ` Run gh/git/grep from ${CWD}.` : ''
const REPO = 'kamiazya/whiteboard'

// Published-artifact runtime deps carry the highest blast radius: they ship inside
// @kamiazya/whiteboard-mcp on npm AND a prod high+ vuln BLOCKS the `verify` CI
// (`pnpm audit --prod --audit-level=high`). zod is the schema single-source-of-truth;
// loro-crdt is the CRDT persistence/merge core; the MCP SDK gates every tool contract.
const LOAD_BEARING = [
  'zod', 'loro-crdt', '@modelcontextprotocol/sdk', 'hono', '@hono/node-server',
  'kysely', '@libsql/client', '@libsql/kysely-libsql', 'jose', 'ws',
  '@excalidraw/excalidraw', '@excalidraw/utils', 'pino', 'nanoid',
]
const loadBearingHint =
  `Load-bearing published runtime deps (extra scrutiny): ${LOAD_BEARING.join(', ')}. ` +
  `zod = schema single-source-of-truth (a minor can shift inference/parse behavior — check z.infer call sites + parse paths). ` +
  `loro-crdt = CRDT persistence/merge core (reconcile-elements + useWhiteboardSync + export-json must stay green). ` +
  `@modelcontextprotocol/sdk gates every MCP tool contract (re-check initialize negotiation + tools/list + smoke).`

// --- schemas ---
const GATHER_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    prs: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          number: { type: 'number' },
          title: { type: 'string' },
          ecosystem: { enum: ['npm', 'github-actions', 'other'] },
          package: { type: 'string' },
          fromVersion: { type: 'string' },
          toVersion: { type: 'string' },
          isSecurity: { type: 'boolean', description: 'security label or CVE/GHSA in title/body' },
        },
        required: ['number', 'title', 'package'],
      },
    },
    alerts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          ghsa: { type: 'string' },
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          package: { type: 'string' },
          scope: { enum: ['runtime', 'development', 'unknown'], description: 'prod runtime (gates verify CI) vs dev-only' },
          vulnerableRange: { type: 'string' },
          firstPatched: { type: 'string' },
          isDirect: { type: 'boolean', description: 'direct dep vs transitive' },
        },
        required: ['ghsa', 'severity', 'package'],
      },
    },
    alertsAvailable: { type: 'boolean', description: 'false if the alerts API 404d on auth scope' },
    note: { type: 'string' },
  },
  required: ['prs', 'alertsAvailable'],
}

const PR_FINDING_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    number: { type: 'number' },
    package: { type: 'string' },
    ecosystem: { enum: ['npm', 'github-actions', 'other'] },
    level: { enum: ['security', 'patch', 'minor', 'major', 'unknown'], description: 'semver x ecosystem class; treat typescript by changelog not semver' },
    loadBearing: { type: 'boolean' },
    changelogSummary: { type: 'string', description: '1-3 lines from the release notes' },
    breakingChanges: { type: 'array', items: { type: 'string' } },
    repoImpact: { type: 'string', description: 'grep result: does a breaking change hit our usage? cite path(s) or "none found"' },
    ciStatus: { enum: ['pass', 'pending', 'fail', 'blocked', 'unknown'] },
    supersededBy: { type: 'number', description: 'PR number that bumps the same package further, else 0' },
    recommendation: { enum: ['merge', 'merge-with-care', 'needs-migration', 'close-superseded', 'hold'] },
    rationale: { type: 'string' },
  },
  required: ['number', 'package', 'level', 'recommendation', 'rationale'],
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    number: { type: 'number' },
    refuted: { type: 'boolean', description: 'true if "safe to merge" was refuted — a real breaking change hits this repo' },
    why: { type: 'string', description: 'cite the changelog entry + the repo path:line it breaks, or why it is safe' },
  },
  required: ['number', 'refuted', 'why'],
}

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    mergeOrder: {
      type: 'array', description: 'PRs to merge, in order (Security > patch > minor > major; supersedes resolved first)',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          number: { type: 'number' }, package: { type: 'string' }, level: { type: 'string' },
          action: { enum: ['merge', 'merge-with-care', 'close-superseded', 'rebase-first'] },
          note: { type: 'string' },
        },
        required: ['number', 'action'],
      },
    },
    needsMigration: {
      type: 'array', description: 'major/breaking bumps to file as backlog (tmp/issues or Task) — NOT a GitHub issue',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          number: { type: 'number' }, package: { type: 'string' },
          breaking: { type: 'string' }, suggestedTrack: { enum: ['task', 'issue'] },
        },
        required: ['number', 'package', 'breaking', 'suggestedTrack'],
      },
    },
    alertCoverage: {
      type: 'array', description: 'each open alert: fixed by a listed PR, needs a manual bump, or transitive-only',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          ghsa: { type: 'string' }, package: { type: 'string' }, severity: { type: 'string' },
          status: { enum: ['fixed-by-pr', 'needs-manual-bump', 'transitive-no-fix', 'dev-only-nonci'] },
          detail: { type: 'string' },
        },
        required: ['ghsa', 'status'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['mergeOrder', 'summary'],
}

// --- Phase 1: gather (barrier — need the full PR list before per-PR fan-out) ---
phase('Gather')
const prFilter = ONLY_PRS ? ` Restrict to these PR numbers: ${ONLY_PRS.join(', ')}.` : ''
const gathered = await agent(
  `Gather the Dependabot triage surface for ${REPO} (read-only).${cwdHint}\n\n` +
    `1. Open dependency PRs: \`gh pr list --author "app/dependabot" --state open --json number,title,labels --limit 50\`.${prFilter} ` +
    `For each, parse the package name and from/to versions from the "Bump X from A to B" title, classify the ecosystem (npm vs github-actions), and set isSecurity if it has a security label or the body/title cites a CVE/GHSA.\n` +
    (INCLUDE_ALERTS
      ? `2. Open security alerts: \`gh api repos/${REPO}/dependabot/alerts --paginate --jq '[.[] | select(.state=="open")] | .[] | {ghsa: .security_advisory.ghsa_id, severity: .security_advisory.severity, package: .dependency.package.name, scope: .dependency.scope, range: .security_vulnerability.vulnerable_version_range, patched: .security_vulnerability.first_patched_version.identifier, manifest: .dependency.manifest_path}'\`. Map scope "runtime"->runtime, "development"->development. If this 404s on auth scope (needs security_events/admin), set alertsAvailable=false with a note and return prs only — do NOT fail.\n`
      : `2. Skip alerts (includeAlerts=false): set alertsAvailable=false, alerts=[].\n`) +
    `Return the structured lists. Do not analyze yet.`,
  { label: 'gather', phase: 'Gather', agentType: 'general-purpose', schema: GATHER_SCHEMA },
)

const prs = (gathered?.prs || []).filter((p) => !ONLY_PRS || ONLY_PRS.includes(p.number))
if (!prs.length) {
  return { prs: [], plan: null, note: 'No open Dependabot PRs to triage.', alerts: gathered?.alerts || [], needsHumanGate: false }
}
log(`gathered ${prs.length} PR(s); alerts=${gathered?.alertsAvailable ? (gathered.alerts || []).length : 'unavailable'}`)

// --- Phases 2+3: analyze each PR, then adversarially verify the risky ones (pipeline, no barrier) ---
const allPackages = prs.map((p) => `#${p.number} ${p.package} ${p.title}`).join('; ')
const results = await pipeline(
  prs,
  (p) =>
    agent(
      `Analyze ONE Dependabot PR for ${REPO} and recommend an action.${cwdHint}\n\n` +
        `PR #${p.number}: ${p.title}\nPackage: ${p.package} (${p.ecosystem || 'npm'})\n\n` +
        `All open Dependabot PRs (to detect supersedes — a later PR bumping the SAME package to a higher version supersedes an earlier one): ${allPackages}\n\n` +
        `Do ALL of:\n` +
        `1. Read the PR: \`gh pr view ${p.number} --json title,body,labels\`. Classify level: security (label/CVE) | patch | minor | major. NOTE: TypeScript does not follow semver — class it by the changelog, not the number; @types/node must match .node-version (24) — recommend close if its major diverges.\n` +
        `2. Changelog/release notes: read the PR body's compatibility/release section; WebFetch the upstream release notes if needed. Summarize in 1-3 lines and LIST any breaking changes.\n` +
        `3. Repo impact: grep this repo for how ${p.package} is used and whether any breaking change actually hits our call sites. Cite path(s) or "none found".\n` +
        `4. CI: \`gh pr checks ${p.number}\` — set ciStatus (the gating check is "verify"; mergeStateStatus BLOCKED with passing verify just means branch-protection awaits the merge step).\n` +
        `5. Supersede: set supersededBy to the PR number that bumps the same package further (else 0).\n\n` +
        `${loadBearingHint}\n\n` +
        `Recommend: close-superseded (a later PR wins) | merge (patch/safe minor, CI green, no repo impact) | merge-with-care (load-bearing or minor touching our call sites — mergeable but smoke after) | needs-migration (breaking changes hit our code) | hold (CI fail / unclear). Set loadBearing if the package is in the load-bearing list.`,
      { label: `pr:${p.number}:${p.package}`, phase: 'Analyze', agentType: 'general-purpose', schema: PR_FINDING_SCHEMA },
    ),
  (finding, p) => {
    // Only adversarially verify the bumps where a wrong "safe" call is costly:
    // majors, anything that claims breaking changes, and load-bearing minors.
    const risky =
      finding &&
      finding.recommendation !== 'close-superseded' &&
      (finding.level === 'major' ||
        (finding.breakingChanges && finding.breakingChanges.length > 0) ||
        (finding.loadBearing && finding.level === 'minor'))
    if (!risky) return finding
    return agent(
      `Adversarially verify the claim "PR #${p.number} (${p.package} ${p.title}) is safe to merge".${cwdHint}\n\n` +
        `Analysis so far: level=${finding.level}, changelog="${finding.changelogSummary || ''}", breaking=${JSON.stringify(finding.breakingChanges || [])}, repoImpact="${finding.repoImpact || ''}".\n\n` +
        `Try to REFUTE "safe to merge": find a breaking change in the upstream release that DOES reach this repo's usage — grep for the affected API/export and cite path:line. ${loadBearingHint}\n` +
        `Set refuted:true ONLY with concrete evidence (a changelog entry + a repo call site it breaks). If it genuinely checks out, refuted:false. "why" must cite what you looked at.`,
      { label: `verify:${p.number}:${p.package}`, phase: 'Verify', agentType: 'general-purpose', schema: VERDICT_SCHEMA },
    ).then((v) => ({ ...finding, adversarial: v }))
  },
)

const findings = results.filter(Boolean)

// --- Phase 4: synthesize the merge plan + alert coverage (barrier — needs all findings) ---
phase('Synthesize')
const plan = await agent(
  `Synthesize a Dependabot merge plan for ${REPO} from these per-PR findings. The repo uses NO GitHub Issues — backlog goes to native Tasks / tmp/issues, NOT \`gh issue create\`. A single integrator executes merges.\n\n` +
    `Per-PR findings (with any adversarial verdict): ${JSON.stringify(findings)}\n\n` +
    `Open alerts: ${gathered?.alertsAvailable ? JSON.stringify(gathered.alerts || []) : '(alerts API unavailable — note this)'}\n\n` +
    `Produce:\n` +
    `1. mergeOrder: the PRs to act on, ordered Security > patch > minor > major; resolve supersedes FIRST (action close-superseded for the stale one). Honor the adversarial verdict — if refuted=true, downgrade merge -> needs-migration. Mark merge-with-care for load-bearing bumps. Remember the conflict-cascade rule: only ONE lock-touching PR merges cleanly at a time, the rest need rebase-first — reflect that in notes/order.\n` +
    `2. needsMigration: majors/breaking bumps to file as backlog (suggestedTrack task|issue) — these are tmp/issues or Tasks, never GitHub issues.\n` +
    `3. alertCoverage: map each open alert to fixed-by-pr (a listed PR bumps past firstPatched) | needs-manual-bump (no PR; direct dep — integrator bumps it) | transitive-no-fix | dev-only-nonci (development scope — does NOT gate \`pnpm audit --prod\` so not CI-blocking, lower priority). Prioritize critical/high runtime-scope alerts.\n` +
    `Be concrete and decision-ready; do not invent PRs or alerts.`,
  { label: 'synthesize', phase: 'Synthesize', agentType: 'architect', schema: PLAN_SCHEMA },
)

return {
  repo: REPO,
  prCount: prs.length,
  alerts: gathered?.alertsAvailable ? { total: (gathered.alerts || []).length, list: gathered.alerts } : { unavailable: true, note: gathered?.note },
  findings,
  plan,
  needsHumanGate: true,
  note:
    'Read-only triage. Integrator executes per the dependabot-review skill: merge in plan.mergeOrder one-lock-PR-at-a-time (rebase the next via `@dependabot rebase`), close superseded PRs, file plan.needsMigration into Tasks/tmp-issues (NOT GitHub issues), and bump any needs-manual-bump alerts. Re-run `pnpm audit --prod --audit-level=high` after to confirm the CI gate clears.',
}
