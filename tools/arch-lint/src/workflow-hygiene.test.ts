// Standing workflow-hygiene policy, distinct from gate-isomorphism.test.ts
// (which checks step/gate isomorphism): scans the RAW TEXT of every
// .github/workflows/*.yml for two structural regressions that a diff review
// can miss —
//   1. inline `node -e` / `python -c` style interpreters in a `run:` block
//      (production logic belongs in a versioned, unit-tested script)
//   2. an environment variable placed at job scope (ambient to every step)
//      when it is only needed by one step
// The raw-text scan is deliberate FOR (1), and the reason changed with the
// extractor: it used to be that the scanner could not see inside a multi-line
// `run: |` block at all. `workflow-jobs.ts` parses the YAML and hands back the
// block's real text, so a structured check IS now possible — but the raw scan
// still reads what a `run:` cannot: a composite action's own steps, and any
// interpreter written outside a `run:` key entirely.
//
// (2) is asked of the PARSED workflow. It used to be a 165-line hand-rolled
// indentation scanner in tools/checks, at cognitive complexity 102 — four
// nested loops sharing one cursor, carrying its own comment-dedent fixes and
// its own assumption that this repo indents two spaces. That package stays
// dependency-free because it is the last mile before a real publish, and must
// not need this repo's build pipeline to validate its own policy file; this
// scan is not on that path — its only caller was this file, which already
// parses YAML two tests over. So the question is asked of `yaml`, and the
// hand scanner is deleted rather than simplified.

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github', 'workflows')
const RELEASE_WORKFLOW_PATH = resolve(WORKFLOWS_DIR, 'release.yml')

interface ParsedWorkflow {
  jobs?: Record<
    string,
    { env?: Record<string, unknown>; steps?: { name?: string; env?: Record<string, unknown> }[] }
  >
}

/**
 * Where `key` is declared: on a JOB (ambient to every step that does not
 * override it) or on one STEP.
 *
 * `Object.hasOwn`, not `env[key] !== undefined`: a parsed mapping is an
 * ordinary object, so `env['toString']` answers `Object.prototype.toString`
 * and every job with any `env:` block reports a hit. Measured — the first
 * version of this function did exactly that on four of ci.yml's jobs, caught
 * by differential-testing it against the scanner it replaces over every
 * workflow and every env key in the repo.
 */
function scanEnvKeyPlacements(
  yamlText: string,
  key: string,
): { jobLevel: { jobId: string }[]; stepLevel: { jobId: string; stepName: string }[] } {
  const jobs = Object.entries((parseYaml(yamlText) as ParsedWorkflow | null)?.jobs ?? {})
  return {
    jobLevel: jobs
      .filter(([, job]) => Object.hasOwn(job?.env ?? {}, key))
      .map(([jobId]) => ({ jobId })),
    stepLevel: jobs.flatMap(([jobId, job]) =>
      (job?.steps ?? [])
        .filter((step) => Object.hasOwn(step?.env ?? {}, key))
        .map((step) => ({ jobId, stepName: step.name ?? '' })),
    ),
  }
}

// The full inline-interpreter class this repo has decided never belongs in
// a workflow `run:` block.
const INLINE_INTERPRETER_PATTERNS: RegExp[] = [
  /\bnode\s+-e\b/,
  /\bnode\s+--eval\b/,
  /\bnode\s+-p\b/,
  /\bnode\s+--print\b/,
  /\bpython\s+-c\b/,
  /\bpython3\s+-c\b/,
]

function findInlineInterpreterUsages(yamlText: string): string[] {
  return INLINE_INTERPRETER_PATTERNS.filter((rx) => rx.test(yamlText)).map((rx) => rx.source)
}

describe('workflow hygiene: no inline interpreters', () => {
  it('flags a fixture containing an inline `node -e`', () => {
    const fixture = 'jobs:\n  x:\n    steps:\n      - run: echo hi | node -e "console.log(1)"\n'
    expect(findInlineInterpreterUsages(fixture)).not.toEqual([])
  })

  it('does not flag a fixture that only calls a versioned script', () => {
    const fixture =
      'jobs:\n  x:\n    steps:\n      - run: node tools/checks/src/verify-pack-contents.mjs\n'
    expect(findInlineInterpreterUsages(fixture)).toEqual([])
  })

  const workflowFiles = readdirSync(WORKFLOWS_DIR).filter(
    (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
  )
  it('discovers at least one workflow file to scan', () => {
    expect(workflowFiles.length).toBeGreaterThan(0)
  })

  it.each(workflowFiles)('%s has zero inline interpreter usages', (file) => {
    const text = readFileSync(resolve(WORKFLOWS_DIR, file), 'utf-8')
    expect(findInlineInterpreterUsages(text)).toEqual([])
  })
})

describe('workflow hygiene: WHITEBOARD_DEV is step-scoped, not job-scoped', () => {
  it('scanner fixture: flags a job-level placement', async () => {
    const fixture = [
      'jobs:',
      '  example:',
      '    env:',
      "      WHITEBOARD_DEV: '1'",
      '    steps:',
      '      - name: A step',
      '        run: echo hi',
      '',
    ].join('\n')
    const result = scanEnvKeyPlacements(fixture, 'WHITEBOARD_DEV')
    expect(result.jobLevel).toEqual([{ jobId: 'example' }])
    expect(result.stepLevel).toEqual([])
  })

  it('scanner fixture: an allow-listed step-level placement passes (no job-level hit)', async () => {
    const fixture = [
      'jobs:',
      '  example:',
      '    steps:',
      '      - name: Allowed step',
      '        env:',
      "          WHITEBOARD_DEV: '1'",
      '        run: echo hi',
      '',
    ].join('\n')
    const result = scanEnvKeyPlacements(fixture, 'WHITEBOARD_DEV')
    expect(result.jobLevel).toEqual([])
    expect(result.stepLevel).toEqual([{ jobId: 'example', stepName: 'Allowed step' }])
  })

  it('does not report an inherited object key as a placement', async () => {
    const fixture = [
      'jobs:',
      '  example:',
      '    env:',
      '      FOO: bar',
      '    steps:',
      '      - name: A step',
      '        env:',
      '          BAR: baz',
      '        run: echo hi',
      '',
    ].join('\n')
    // A parsed mapping is an ordinary object. Asking `env[key] !== undefined`
    // answers `Object.prototype.toString` here and reports the job AND the
    // step; `Object.hasOwn` is what makes the answer about this workflow.
    expect(scanEnvKeyPlacements(fixture, 'toString')).toEqual({ jobLevel: [], stepLevel: [] })
  })

  it('is unaffected by a comment dedented inside the env block', async () => {
    const fixture = [
      'jobs:',
      '  example:',
      '    env:',
      '    # comment dedented to job-body indent, before some env keys',
      '      FOO: bar',
      "      WHITEBOARD_DEV: '1'",
      '    steps:',
      '      - name: A step',
      '        run: echo hi',
      '',
    ].join('\n')
    const result = scanEnvKeyPlacements(fixture, 'WHITEBOARD_DEV')
    expect(result.jobLevel).toEqual([{ jobId: 'example' }])
  })

  it('scanner fixture: reports a non-allow-listed step by name too', async () => {
    const fixture = [
      'jobs:',
      '  example:',
      '    steps:',
      '      - name: Unexpected step',
      '        env:',
      "          WHITEBOARD_DEV: '1'",
      '        run: echo hi',
      '',
    ].join('\n')
    const result = scanEnvKeyPlacements(fixture, 'WHITEBOARD_DEV')
    expect(result.stepLevel).toEqual([{ jobId: 'example', stepName: 'Unexpected step' }])
  })

  // Any job-level WHITEBOARD_DEV placement in release.yml is a regression:
  // it would silence the src-vs-dist spawn switch (`WHITEBOARD_DEV` in
  // `store/backup-subprocess.ts`) for every step in that job, not just the one
  // that actually needs it.
  it('release.yml has zero job-level WHITEBOARD_DEV placements', async () => {
    const text = readFileSync(RELEASE_WORKFLOW_PATH, 'utf-8')
    const result = scanEnvKeyPlacements(text, 'WHITEBOARD_DEV')
    expect(result.jobLevel).toEqual([])
  })

  // Non-allow-listed step names here signal a raw `env: { WHITEBOARD_DEV }`
  // reappearing on a step that no longer needs it (the C-item investigation
  // found no publish-tier or docker-tier consumer once `build` always
  // precedes the smokes in matrix order).
  const ALLOW_LISTED_STEPS: string[] = []
  it('release.yml has no step-level WHITEBOARD_DEV placements outside the allow-list', async () => {
    const text = readFileSync(RELEASE_WORKFLOW_PATH, 'utf-8')
    const result = scanEnvKeyPlacements(text, 'WHITEBOARD_DEV')
    const unexpected = result.stepLevel.filter((hit) => !ALLOW_LISTED_STEPS.includes(hit.stepName))
    expect(unexpected).toEqual([])
  })
})

interface SecretJob {
  env?: Record<string, unknown>
  steps?: { name?: string; run?: string; env?: Record<string, unknown> }[]
}

const CLOUDFLARE_SECRET_RE = /secrets\.CLOUDFLARE_/
// Each of these resolves and runs a package with no lockfile behind it, and
// with its lifecycle scripts on — in a job that can deploy the site.
const UNLOCKED_FETCH_PATTERNS: RegExp[] = [
  /\bnpx\s/,
  /\bnpm\s+exec\b/,
  /\bnpm\s+(i|install)\b/,
  /\bpnpm\s+dlx\b/,
]

/**
 * Every way a job that holds the Cloudflare deploy token weakens it: a
 * job-level env entry hands the token to every step (installs included),
 * and an unlocked fetch runs code nobody reviewed next to it.
 */
function cloudflareJobFindings(yamlText: string): string[] {
  const jobs = Object.entries(
    (parseYaml(yamlText) as { jobs?: Record<string, SecretJob> } | null)?.jobs ?? {},
  )
  return jobs.flatMap(([jobId, job]) => {
    if (!CLOUDFLARE_SECRET_RE.test(JSON.stringify(job ?? {}))) return []
    const envHits = Object.entries(job.env ?? {})
      .filter(([, value]) => CLOUDFLARE_SECRET_RE.test(String(value)))
      .map(([key]) => `${jobId}: job-level env ${key} carries a Cloudflare secret`)
    const runHits = (job.steps ?? []).flatMap((step) =>
      UNLOCKED_FETCH_PATTERNS.filter((rx) => rx.test(step.run ?? '')).map(
        (rx) => `${jobId}: step "${step.name ?? ''}" runs ${rx.source}`,
      ),
    )
    return [...envHits, ...runHits]
  })
}

describe('workflow hygiene: a job holding Cloudflare secrets', () => {
  it('scanner fixture: flags job-level secret env and an npx run', () => {
    const fixture = [
      'jobs:',
      '  deploy:',
      '    env:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax, not a JS template placeholder
      '      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
      '    steps:',
      '      - name: Deploy',
      '        run: npx --yes wrangler@4 pages deploy dist',
      '      - name: Tool',
      '        run: pnpm dlx some-tool',
      '',
    ].join('\n')
    expect(cloudflareJobFindings(fixture)).toHaveLength(3)
  })

  it('scanner fixture: step-scoped secrets and a lockfile install pass', () => {
    const fixture = [
      'jobs:',
      '  deploy:',
      '    steps:',
      '      - name: Install',
      '        run: pnpm install --frozen-lockfile',
      '      - name: Deploy',
      '        uses: cloudflare/wrangler-action@x',
      '        with:',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression syntax, not a JS template placeholder
      '          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
      '',
    ].join('\n')
    expect(cloudflareJobFindings(fixture)).toEqual([])
  })

  const workflowFiles = readdirSync(WORKFLOWS_DIR).filter(
    (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
  )
  const holders = workflowFiles.filter((f) =>
    CLOUDFLARE_SECRET_RE.test(readFileSync(resolve(WORKFLOWS_DIR, f), 'utf-8')),
  )

  it('finds the workflows that deploy to Cloudflare', () => {
    expect(holders).toEqual(
      expect.arrayContaining(['deploy-preview.yml', 'preview-pr-deploy.yml', 'release.yml']),
    )
  })

  it.each(
    holders,
  )('%s scopes the secret to its deploy step and fetches nothing unlocked', (file) => {
    const text = readFileSync(resolve(WORKFLOWS_DIR, file), 'utf-8')
    expect(cloudflareJobFindings(text)).toEqual([])
  })
})
