export const meta = {
  name: 'pr-feedback',
  description:
    'Close the post-push feedback loop on a PR without the integrator doing it by hand: enumerate EVERY bot author and failing check on the PR, adversarially verify each finding against the real code, fix the valid ones as commits on the PR branch, and report which local gate could have caught each one. Complements ci-triage, which is read-only.',
  whenToUse:
    'After a push, once checks have run or a review bot has commented — typically launched by the integrator when a Monitor fires. Pass args:{pr, cwd, branch?}. Use ci-triage instead when you want a backlog and explicitly NOT commits. Waiting for CI stays in the main session: a workflow cannot outlive its turn, so it must be launched when the feedback already exists.',
  phases: [
    { title: 'Enumerate', detail: 'discover every commenting author + non-pass check — no hardcoded reviewer list' },
    { title: 'Verify', detail: 'one refuter per finding, against the actual code' },
    { title: 'Fix', detail: 'sequential commits on the PR branch (one writer at a time)' },
    { title: 'GateGap', detail: 'which local gate could have caught each valid finding' },
  ],
}

const A = (() => {
  if (typeof args !== 'string') return args && typeof args === 'object' ? args : {}
  // Malformed args is a caller bug with no sane default. Falling back to {} does not stop the
  // run — it completes against empty inputs and reports "nothing was specified" after spending
  // the whole agent budget, which reads as a finding rather than the input error it is.
  try {
    return JSON.parse(args)
  } catch (err) {
    throw new Error(`args is not valid JSON (${err.message}): ${args.slice(0, 200)}`)
  }
})()
const PR = A.pr
const CWD = A.cwd
const REPO = A.repo || 'kamiazya/whiteboard'
if (!PR) return { error: 'args.pr (PR number) is required' }
if (!CWD) return { error: 'args.cwd (worktree holding the PR branch) is required — fixes are committed there' }

const where = `Run all gh/git/pnpm from ${CWD}.`

// ---------------------------------------------------------------- Enumerate
//
// The reviewer set is DISCOVERED, never assumed. A hardcoded list is what let a
// CodeQL finding through this gate before: the sweep was scoped to two named
// reviewers and github-advanced-security[bot] was not one of them.

const INVENTORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['authors', 'findings'],
  properties: {
    authors: {
      type: 'array',
      description: 'every distinct author seen on the PR feeds, bot or human, with what it produced',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['login', 'produced'],
        properties: {
          login: { type: 'string' },
          produced: {
            enum: ['findings', 'skipped', 'informational'],
            description:
              'skipped = the reviewer explicitly declined (rate/plan limit, WIP title). informational = preview links, sunset notices, summaries with no finding.',
          },
          note: { type: 'string' },
        },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'author', 'kind', 'location', 'claim'],
        properties: {
          id: { type: 'string', description: 'stable short slug, unique within this run' },
          author: { type: 'string' },
          kind: { enum: ['ci-failure', 'review-comment', 'security-scan'] },
          location: { type: 'string', description: 'file:line, or check/job/step for a CI failure' },
          claim: { type: 'string', description: "the finding's assertion, in the reporter's terms" },
          quotedEvidence: { type: 'string', description: 'the failing assertion text or the comment body excerpt' },
        },
      },
    },
  },
}

phase('Enumerate')
const inventory = await agent(
  `Inventory the complete post-push feedback surface of PR #${PR} in ${REPO}. ${where}

**Enumerate authors from the data — do not use a list of expected reviewers.** That mistake has already let a security finding through this gate.

1. \`gh api repos/${REPO}/pulls/${PR}/comments\` — inline review comments. Collect EVERY distinct \`.user.login\`.
2. \`gh pr view ${PR} --json reviews,comments\` — review bodies and issue-level comments. Collect every distinct author here too; the two feeds do not overlap.
3. \`gh pr checks ${PR}\` — every check that is not \`pass\`. For each, get the run id and read \`gh run view <run-id> --log-failed\` for the failing job/step and the actual assertion text.

Classify each author's output:
- **findings** — it made at least one substantive claim about the code.
- **skipped** — it explicitly declined to review. CodeRabbit posts a "Review limit reached" warning when the plan's PR quota is exhausted; a WIP/draft title also makes it skip. Record this verbatim in \`note\` — a reviewer that did not run is NOT a reviewer that approved, and the integrator has to know the difference.
- **informational** — Cloudflare Pages preview links, the Gemini Code Assist sunset notice, CodeRabbit walkthrough summaries. No claim to verify.

For each substantive claim emit one finding with a stable \`id\`, quoting the evidence (assertion text or comment excerpt) rather than paraphrasing it. Do not judge validity here — that is the next phase's job, done by someone who has not already formed an opinion.`,
  { schema: INVENTORY_SCHEMA, label: 'enumerate', phase: 'Enumerate' },
)

const findings = inventory?.findings ?? []
const authors = inventory?.authors ?? []
const skipped = authors.filter((a) => a.produced === 'skipped')
if (skipped.length) log(`reviewers that did NOT run: ${skipped.map((a) => a.login).join(', ')}`)
if (!findings.length) {
  return {
    pr: PR,
    authors,
    skippedReviewers: skipped,
    findings: [],
    committed: [],
    note: 'No substantive findings on the PR feeds. Note any skipped reviewers above before treating this as a clean review.',
  }
}
log(`${findings.length} finding(s) from ${authors.length} author(s)`)

// ------------------------------------------------------------------ Verify
//
// Refute-by-default. CodeRabbit has high recall and fabricates context; a
// finding that cannot be confirmed against the code is not actionable, and
// "fixing" a phantom finding is how a real defect gets introduced.

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'valid', 'rationale'],
  properties: {
    id: { type: 'string' },
    valid: { type: 'boolean' },
    severity: { enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
    blocking: { type: 'boolean', description: 'gates the merge (a failing CI check always does)' },
    rationale: {
      type: 'string',
      description: 'what the code actually does at the cited location, and whether that matches the claim',
    },
    flaky: { type: 'boolean', description: 'CI failure that is test-isolation noise rather than a code defect' },
    fixDirection: { type: 'string' },
  },
}

phase('Verify')
const verdicts = (
  await parallel(
    findings.map((f) => () =>
      agent(
        `Adversarially verify one finding on PR #${PR}. ${where}

Finding \`${f.id}\` from **${f.author}** (${f.kind}) at \`${f.location}\`:
${f.claim}

Evidence as reported:
${f.quotedEvidence || '(none captured)'}

**Your job is to REFUTE it.** Open the cited file and read what the code actually does. Default to \`valid: false\` when you cannot confirm the claim against the code — a finding you merely find plausible is not confirmed.

Reasons a finding is NOT valid:
- The cited line does not do what the claim says (fabricated context).
- The condition it worries about is already handled elsewhere on the path.
- It is a style preference already settled by Biome, or an inapplicable "consider" suggestion.
- It describes an intentional, documented decision — check \`.claude/rules/package-*.md\` for a resolved decision covering it before calling the code wrong.

Reasons it IS valid even if it looks minor:
- A doc or comment states a weaker precondition than the code enforces. Understating a gate in a security-facing document is a real defect, not a nit.
- A security finding on an untrusted-input path (CodeQL, injection, ReDoS) — treat as CRITICAL and confirm the data flow is genuinely reachable and unsanitized.
- A guard or test that cannot fail. See the \`review-gate\` skill's "Reject guards that cannot fail" section.

For a CI failure, distinguish a genuine defect from test-isolation flake (a different test fails per run and passes in isolation). Set \`flaky\` accordingly; a flake is valid-as-signal but is not fixed by editing the code under test.

Quote the code you read in \`rationale\`. An assertion without the line you based it on is not verification.`,
        { schema: VERDICT_SCHEMA, label: `verify:${f.id}`, phase: 'Verify' },
      ),
    ),
  )
).filter(Boolean)

const byId = new Map(findings.map((f) => [f.id, f]))
const valid = verdicts.filter((v) => v.valid && !v.flaky)
const rejected = verdicts.filter((v) => !v.valid)
const flakes = verdicts.filter((v) => v.valid && v.flaky)
log(`${valid.length} confirmed, ${rejected.length} refuted, ${flakes.length} flaky`)

// --------------------------------------------------------------------- Fix
//
// SEQUENTIAL, deliberately. Every fix commits to the same branch in the same
// worktree; concurrent agents would race on the git index and on each other's
// working-tree state. Parallelism here buys nothing and corrupts the branch.

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'committed', 'summary'],
  properties: {
    id: { type: 'string' },
    committed: { type: 'boolean' },
    sha: { type: 'string' },
    summary: { type: 'string' },
    testAdded: { type: 'string', description: 'the regression test that now covers this, or why none was possible' },
    blockedReason: { type: 'string' },
  },
}

phase('Fix')
const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
const ranked = [...valid].sort(
  (a, b) => (b.blocking ? 1 : 0) - (a.blocking ? 1 : 0) || order.indexOf(a.severity) - order.indexOf(b.severity),
)
const fixes = []
for (const v of ranked) {
  const f = byId.get(v.id)
  const res = await agent(
    `Fix one confirmed finding on PR #${PR}, and commit it. ${where}

Finding \`${v.id}\` from **${f?.author}** at \`${f?.location}\` — severity ${v.severity ?? 'unknown'}${v.blocking ? ', BLOCKING' : ''}:
${f?.claim}

Verified against the code:
${v.rationale}

Fix direction: ${v.fixDirection || '(derive it from the rationale)'}

Rules:
- **Red first.** If this is a code defect, write the failing test before the fix and confirm it fails for the intended reason — a \`ReferenceError\` from a missing import in the test is not a real red, and has been mistaken for one in this repo.
- Smallest patch that turns it green. Do not refactor adjacent code.
- If the finding is a documentation defect, fix the doc to describe the **shipped** behaviour, and state the full condition set the code enforces rather than a summary of it.
- No \`console.*\` in server code (\`getLogger\`). Never log an absolute filesystem path — the distribution smoke rejects \`/home/\`, \`/Users/\`, \`/opt/\`, \`/root/\`, \`/private/\`, \`/tmp/\` and \`.ts:\\d\` frames on stderr.
- Zod stays the single source of truth; \`z.infer\`, never a hand-written interface beside a schema.
- Run the nearest-layer tests plus typecheck before committing.
- Commit ONLY the files you changed, with a Conventional Commit subject describing the defect — not the reviewer that found it. Do NOT push; the integrator pushes.

Other fixes may already be committed on this branch — do not revert or reformat them.

If you conclude the fix does not belong in this PR (it needs a decision, or it is scoped to a file another lane owns), commit nothing and say so in \`blockedReason\`. An honest block beats a speculative edit.`,
    { schema: FIX_SCHEMA, label: `fix:${v.id}`, phase: 'Fix', agentType: 'developer' },
  )
  if (res) fixes.push(res)
}

// ----------------------------------------------------------------- GateGap
//
// The self-reinforcement step. A post-push finding is evidence that something
// upstream did not catch it — but NOT every finding is a gate gap, and pretending
// otherwise inflates the rule set until nobody reads it. Naming "none" is a
// first-class answer here.

const GAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gaps'],
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'catchable', 'class'],
        properties: {
          id: { type: 'string' },
          catchable: { type: 'boolean', description: 'false = genuinely needed a fresh reader; do not invent a rule' },
          class: {
            type: 'string',
            description: 'the ABSTRACT defect class, not this instance — what would recur in a different file',
          },
          rung: {
            enum: ['executable', 'pre-push', 'review-criteria', 'prose-rule', 'none'],
            description: 'strongest rung that could realistically catch the class',
          },
          proposal: { type: 'string', description: 'the concrete check or criterion, specific enough to implement' },
          target: { type: 'string', description: 'file that would hold it' },
          recurrence: { type: 'string', description: 'evidence this class has appeared before, or "first sighting"' },
        },
      },
    },
  },
}

phase('GateGap')
const gapReport = await agent(
  `Every finding below reached a human reviewer only AFTER the code was pushed. For each, decide whether a local gate could have caught it — and be willing to answer no.

${valid.map((v) => `- \`${v.id}\` (${v.severity ?? '?'}) ${byId.get(v.id)?.location}: ${byId.get(v.id)?.claim}\n  verified: ${v.rationale}`).join('\n')}

**Abstract to the class, never the instance.** "The security-model doc omitted the webMcpEnabled condition" is an instance. "A doc that states a precondition for a security-relevant behaviour must name the same condition set the code enforces" is a class — it recurs in files nobody has written yet. Only a class is worth a gate.

**Escalation ladder — propose the strongest rung that would actually work:**
1. \`executable\` — a Biome rule, a test, an arch-lint extension. It fails by itself. Always prefer this.
2. \`pre-push\` — added to the lefthook gate. Costs every push some time, so it must be fast.
3. \`review-criteria\` — an entry under \`.claude/skills/review-gate/resources/*.md\`, which the review agents actually read per dimension.
4. \`prose-rule\` — \`.claude/rules/*.md\`. Read by everyone, enforced by nobody. The weakest rung; choose it only when the judgement genuinely cannot be mechanised.
5. \`none\` — set \`catchable: false\`. Naming, doc clarity, and product-judgement findings often belong here. **A rule nobody can act on mechanically is worse than no rule: it dilutes the ones that matter.**

Check whether the proposed criterion already exists before proposing it — read \`.claude/rules/*.md\` and \`.claude/skills/review-gate/\`. If it exists and still missed this, that is the more interesting finding: say why it failed (not read at the right phase? too vague to apply? no example?) and propose the sharpening rather than a duplicate.

In \`recurrence\`, say whether this class has bitten this repo before. A class with repeat evidence justifies a stronger rung than a first sighting.`,
  { schema: GAP_SCHEMA, label: 'gate-gap', phase: 'GateGap' },
)

const committed = fixes.filter((f) => f.committed)
const blocked = fixes.filter((f) => !f.committed)
const gaps = gapReport?.gaps ?? []

return {
  pr: PR,
  branch: A.branch ?? null,
  cwd: CWD,
  authors,
  skippedReviewers: skipped,
  verified: { confirmed: valid.length, refuted: rejected.length, flaky: flakes.length },
  refuted: rejected.map((v) => ({ id: v.id, author: byId.get(v.id)?.author, why: v.rationale })),
  flaky: flakes.map((v) => ({ id: v.id, location: byId.get(v.id)?.location, why: v.rationale })),
  committed,
  blocked,
  gateGaps: gaps.filter((g) => g.catchable),
  notCatchable: gaps.filter((g) => !g.catchable),
  needsIntegrator: [
    ...(blocked.length ? ['fixes were blocked and need a decision'] : []),
    ...(skipped.length ? [`${skipped.map((a) => a.login).join(', ')} did not review — not the same as approving`] : []),
    ...(flakes.length ? ['a flaky CI failure was seen; re-run once, then promote to a root-cause lane'] : []),
    ...(gaps.some((g) => g.catchable) ? ['gate gaps proposed — decide which to land'] : []),
  ],
  note: 'Nothing was pushed. The integrator pushes, re-checks CI, and owns the merge decision.',
}
