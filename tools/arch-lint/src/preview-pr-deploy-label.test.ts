// preview-pr-deploy.yml holds the Cloudflare deploy token and publishes a
// PR's pre-built site with `wrangler pages deploy --branch=<label>`. The
// production branch of the Pages project is `main`, so a label that comes out
// as `main` makes a PRODUCTION deployment of PR-built JS on the one origin the
// browser extension admits; `latest` overwrites main's preview alias.
//
// The build half runs the PR's own copy of its workflow, so anything it
// uploads is attacker-written. These tests run the deploy job's real label
// step under bash against a hostile artifact and check that the label and the
// PR number come from the workflow_run event alone, and never name a
// reserved alias. The cleanup and retention workflows recompute the same
// label to find what to release, so their copies are held to the deploy's.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

const WORKFLOWS = join(REPO_ROOT, '.github/workflows')
const RESERVED_LABELS = ['main', 'latest', 'stable']

interface Step {
  id?: string
  name?: string
  run?: string
  env?: Record<string, string>
}

function readWorkflow(name: string): string {
  return readFileSync(join(WORKFLOWS, name), 'utf-8')
}

function deploySteps(): Step[] {
  const doc = parseYaml(readWorkflow('preview-pr-deploy.yml')) as {
    jobs: { deploy: { steps: Step[] } }
  }
  return doc.jobs.deploy.steps
}

/** The step whose outputs feed `--branch` and the PR comment. */
function labelStep(): Step {
  const step = deploySteps().find((s) => s.id === 'meta')
  if (!step?.run) throw new Error('preview-pr-deploy.yml: no `meta` step with a run block')
  return step
}

/** Resolves `${{ github.event.workflow_run.<path> }}` against a fixture event. */
function resolveExpression(value: string, workflowRun: unknown): string {
  const m = /^\$\{\{\s*github\.event\.workflow_run\.([\w.[\]]+)\s*\}\}$/.exec(value.trim())
  if (!m) throw new Error(`unsupported env expression in the label step: ${value}`)
  let cur: unknown = workflowRun
  for (const part of m[1].split(/\.|\[(\d+)\]/).filter((p) => p !== undefined && p !== '')) {
    cur = cur == null ? undefined : (cur as Record<string, unknown>)[part]
  }
  return cur == null ? '' : String(cur)
}

const tmpRoots: string[] = []
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
})

interface RunResult {
  status: number | null
  outputs: Record<string, string>
  stderr: string
}

/**
 * Runs the label step the way the runner would: its `env:` resolved from the
 * event, cwd holding the downloaded artifacts — here a hostile pr.txt that
 * names `main` and an unrelated PR, as a malicious build could upload.
 */
function runLabelStep(workflowRun: Record<string, unknown>): RunResult {
  const step = labelStep()
  const cwd = mkdtempSync(join(tmpdir(), 'preview-label-'))
  tmpRoots.push(cwd)
  mkdirSync(join(cwd, 'artifacts/preview-pr-meta'), { recursive: true })
  writeFileSync(join(cwd, 'artifacts/preview-pr-meta/pr.txt'), 'pr=31337\nbranch=main\n')
  const outFile = join(cwd, 'github-output')
  writeFileSync(outFile, '')
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    GITHUB_OUTPUT: outFile,
  }
  for (const [k, v] of Object.entries(step.env ?? {})) env[k] = resolveExpression(v, workflowRun)
  const res = spawnSync('bash', ['-e', '-c', step.run ?? ''], { cwd, env, encoding: 'utf-8' })
  const outputs: Record<string, string> = {}
  for (const line of readFileSync(outFile, 'utf-8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return { status: res.status, outputs, stderr: res.stderr }
}

const SHA = 'a'.repeat(40)
function event(headBranch: string, overrides: Record<string, unknown> = {}) {
  return {
    head_branch: headBranch,
    head_sha: SHA,
    pull_requests: [{ number: 42, head: { ref: headBranch, sha: SHA } }],
    ...overrides,
  }
}

describe('preview-pr-deploy.yml — the label never names a reserved alias', () => {
  const hostileBranches = [
    'Main',
    'main_',
    '-main',
    'main-',
    'main',
    'MAIN',
    'latest',
    'Latest_',
    'stable',
  ]

  for (const branch of hostileBranches) {
    it(`head branch ${JSON.stringify(branch)} deploys as pr-42, not a reserved alias`, () => {
      const res = runLabelStep(event(branch))
      expect(res.status, res.stderr).toBe(0)
      expect(RESERVED_LABELS).not.toContain(res.outputs.branch)
      expect(res.outputs.branch).toBe('pr-42')
      expect(res.outputs.pr).toBe('42')
    })
  }

  it('an ordinary branch keeps its sanitized name as the label', () => {
    const res = runLabelStep(event('feat/Some_Thing'))
    expect(res.status, res.stderr).toBe(0)
    expect(res.outputs.branch).toBe('feat-some-thing')
    expect(res.outputs.pr).toBe('42')
  })

  it('the label stays [a-z0-9-] and at most 28 characters', () => {
    const res = runLabelStep(event(`x/${'Ab_'.repeat(30)}`))
    expect(res.status, res.stderr).toBe(0)
    expect(res.outputs.branch).toMatch(/^[a-z0-9-]{1,28}$/)
  })

  it('refuses a run with no pull request attached', () => {
    const res = runLabelStep(event('feat-x', { pull_requests: [] }))
    expect(res.status).not.toBe(0)
    expect(res.outputs.branch).toBeUndefined()
  })

  it('refuses a pull request entry that carries no usable number', () => {
    for (const number of [undefined, '12;x']) {
      const res = runLabelStep(event('feat-x', { pull_requests: [{ number, head: { sha: SHA } }] }))
      expect(res.status, String(number)).not.toBe(0)
      expect(res.outputs.branch).toBeUndefined()
    }
  })

  it('skips, without deploying, a run whose pull request head is not the built commit', () => {
    const res = runLabelStep(
      event('feat-x', {
        pull_requests: [{ number: 42, head: { ref: 'feat-x', sha: 'b'.repeat(40) } }],
      }),
    )
    expect(res.status, res.stderr).toBe(0)
    expect(res.outputs.skip).toBe('true')
    expect(res.outputs.branch).toBeUndefined()
  })

  it('gates the deploy step on the skip the label step can answer', () => {
    expect(readWorkflow('preview-pr-deploy.yml')).toContain(
      "if: steps.meta.outputs.skip != 'true' &&",
    )
  })
})

describe('preview-pr-deploy.yml — nothing PR-built decides where or what it comments on', () => {
  it('the label and PR number ignore the uploaded artifact', () => {
    // The fixture artifact says pr=31337, branch=main; the event says 42.
    const res = runLabelStep(event('feat-x'))
    expect(res.status, res.stderr).toBe(0)
    expect(res.outputs).toMatchObject({ pr: '42', branch: 'feat-x' })
  })

  it('the deploy job reads no PR metadata artifact', () => {
    const text = readWorkflow('preview-pr-deploy.yml')
    expect(text).not.toMatch(/pr\.txt|preview-pr-meta/)
    // The only artifact the job may download is the built site.
    const download = deploySteps().find((s) =>
      String((s as { uses?: string }).uses ?? '').startsWith('actions/download-artifact@'),
    ) as { with?: Record<string, string> } | undefined
    expect(download?.with?.name).toBe('preview-pr-dist')
  })

  it('the build half no longer uploads a metadata file nothing should trust', () => {
    expect(readWorkflow('preview-pr-build.yml')).not.toMatch(/pr\.txt|preview-pr-meta/)
  })

  it('the label step passes event data through env, never inline in run', () => {
    expect(labelStep().run).not.toContain('${{')
  })
})

/** The `preview_label() { ... }` function from a workflow, verbatim. */
function labelFunction(workflow: string): string {
  const m = /^( *)preview_label\(\) \{\n[\s\S]*?^\1\}$/m.exec(readWorkflow(workflow))
  if (!m) throw new Error(`${workflow}: no preview_label() function`)
  return m[0]
}

function callLabelFunction(fn: string, branch: string, pr: string): string {
  const res = spawnSync('bash', ['-c', `${fn}\npreview_label "$1" "$2"`, 'x', branch, pr], {
    encoding: 'utf-8',
  })
  if (res.status !== 0) throw new Error(res.stderr)
  return res.stdout
}

describe('preview cleanup and retention compute the label the deploy used', () => {
  const branches = [
    'feat/Some_Thing',
    'Main',
    'latest',
    'main-',
    '___',
    'stable',
    `y-${'q'.repeat(40)}`,
  ]

  for (const workflow of [
    'preview-pr-deploy.yml',
    'preview-cleanup.yml',
    'preview-retention.yml',
  ]) {
    it(`${workflow} maps branches to the same labels as the deploy`, () => {
      const deploy = labelFunction('preview-pr-deploy.yml')
      const fn = labelFunction(workflow)
      for (const branch of branches) {
        const label = callLabelFunction(fn, branch, '7')
        expect(label, `${workflow}: ${branch}`).toBe(callLabelFunction(deploy, branch, '7'))
        expect(RESERVED_LABELS).not.toContain(label)
      }
    })
  }

  it('retention keeps every copy of the function identical, one per keep list', () => {
    const text = readWorkflow('preview-retention.yml')
    const copies = [...text.matchAll(/^( *)preview_label\(\) \{\n[\s\S]*?^\1\}$/gm)].map((m) =>
      m[0].replace(/^ +/gm, ''),
    )
    expect(copies.length).toBe(2)
    expect(new Set(copies).size).toBe(1)
  })
})
