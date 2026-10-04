// `ci-gate.mjs` is the one required status check, and its last lines decide the
// merge: read the run, print it, exit 1 on any problem. `ci-gate.test.ts` pins
// the judgement as pure functions; this file runs the script the way ci.yml
// does — a real `node` process, its environment, its exit code — with the
// Actions API answered by a `--import` module that replaces `fetch` before the
// gate runs.
//
// The same module replaces `setTimeout`, recording each delay and firing at
// once, so the settle schedule is observable without spending its ten seconds
// of wall time per test.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const GATE = join(REPO_ROOT, 'tools/checks/src/ci-gate.mjs')

const workDir = mkdtempSync(join(tmpdir(), 'ci-gate-main-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))

// Answers the Nth `fetch` with responses[min(N, last)], and logs every request
// and every timer delay as one JSON line, so a test reads back what the gate
// asked for and how long it chose to wait.
const STUB = join(workDir, 'actions-api-stub.mjs')
writeFileSync(
  STUB,
  `import { appendFileSync } from 'node:fs'
const { responses } = JSON.parse(process.env.STUB_SCENARIO)
const log = (entry) => appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n')
let calls = 0
globalThis.fetch = async (url, init) => {
  const { status, body } = responses[Math.min(calls, responses.length - 1)]
  calls += 1
  log({ url: String(url), headers: init?.headers ?? {} })
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...args) => {
  log({ sleep: ms })
  return realSetTimeout(fn, 0, ...args)
}
`,
)

interface ApiResponse {
  status: number
  body?: unknown
}
type LogEntry = { url: string; headers: Record<string, string> } | { sleep: number }

const FULL_ENV = {
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_RUN_ID: '4242',
  GITHUB_TOKEN: 'token-value',
  NEEDS_JSON: '{"verify":{"result":"success"}}',
}

let runCount = 0
/** Run the gate as CI does; `undefined` in `env` removes that variable. */
function runGate(env: Record<string, string | undefined>, responses: ApiResponse[] = []) {
  runCount += 1
  const logPath = join(workDir, `log-${runCount}.jsonl`)
  writeFileSync(logPath, '')
  const defined = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(STUB).href, GATE], {
    env: {
      PATH: process.env.PATH ?? '',
      STUB_LOG: logPath,
      STUB_SCENARIO: JSON.stringify({ responses }),
      ...defined,
    },
    encoding: 'utf8',
  })
  const log = readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry)
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    requests: log.filter((entry) => 'url' in entry),
    sleeps: log.flatMap((entry) => ('sleep' in entry ? [entry.sleep] : [])),
  }
}

const job = (name: string, conclusion: string | null, status = 'completed') => ({
  name,
  status,
  conclusion,
})
const page = (total: number, jobs: unknown[]): ApiResponse => ({
  status: 200,
  body: { total_count: total, jobs },
})
const pageOf = (url: string) => new URL(url).searchParams.get('page')

describe('the gate refuses to report success when it cannot judge the run', () => {
  it.each([
    ['GITHUB_REPOSITORY', 'repo'],
    ['GITHUB_RUN_ID', 'runId'],
    ['GITHUB_TOKEN', 'token'],
  ])('exits 1 without asking the API when %s is unset', (variable, label) => {
    const r = runGate({ ...FULL_ENV, [variable]: undefined }, [page(1, [job('verify', 'success')])])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`[ci-gate] ${label} is unset; refusing to report success`)
    expect(r.requests).toEqual([])
  })

  it.each([
    ['unset', undefined],
    ['JSON null', 'null'],
    ['a JSON string', '"verify"'],
  ])('exits 1 without asking the API when NEEDS_JSON is %s', (_label, value) => {
    const r = runGate({ ...FULL_ENV, NEEDS_JSON: value }, [page(1, [job('verify', 'success')])])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('[ci-gate] NEEDS_JSON is unreadable; refusing to report success')
    expect(r.requests).toEqual([])
  })

  it('exits 1 naming the status when the API answers non-ok', () => {
    const r = runGate(FULL_ENV, [{ status: 502 }])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("[ci-gate] could not read this run's jobs")
    expect(r.stderr).toContain('answered 502')
    expect(r.stdout).not.toContain('succeeded')
  })
})

describe('the gate reads the whole run from the Actions API', () => {
  it('asks for this run with the token, page by page until total_count is reached', () => {
    const r = runGate({ ...FULL_ENV, NEEDS_JSON: '{"verify":{},"build":{}}' }, [
      page(3, [job('verify', 'success'), job('ci-gate', null, 'in_progress')]),
      page(3, [job('build', 'success')]),
      page(3, [job('never-read', 'failure')]),
    ])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.requests.map((req) => pageOf(req.url))).toEqual(['1', '2'])
    const [first] = r.requests
    expect(first?.url).toBe(
      'https://api.github.com/repos/owner/repo/actions/runs/4242/jobs?per_page=100&page=1',
    )
    expect(first?.headers).toMatchObject({ authorization: 'Bearer token-value' })
  })

  it('passes over its own still-running job when GATE_JOB_NAME is left to its default', () => {
    // ci.yml never sets GATE_JOB_NAME, so the default is what keeps the gate
    // from judging the job it is running in.
    const r = runGate({ ...FULL_ENV, GATE_JOB_NAME: undefined }, [
      page(2, [job('verify', 'success'), job('ci-gate', null, 'in_progress')]),
    ])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('[ci-gate] every job in this run succeeded (2 jobs)')
  })

  it('ends the listing at a page that carries no job list, judging what it already read', () => {
    const r = runGate(FULL_ENV, [page(5, [job('verify', 'success')]), { status: 200, body: {} }])
    expect(r.status).toBe(0)
    expect(r.requests.map((req) => pageOf(req.url))).toEqual(['1', '2'])
  })

  it('takes a page without total_count as the whole run', () => {
    const r = runGate(FULL_ENV, [{ status: 200, body: { jobs: [job('verify', 'success')] } }])
    expect(r.status).toBe(0)
    expect(r.requests.map((req) => pageOf(req.url))).toEqual(['1'])
  })

  it('stops after ten pages however large total_count claims the run is', () => {
    const r = runGate(FULL_ENV, [page(5000, [job('verify', 'success')])])
    expect(r.requests.map((req) => pageOf(req.url))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    )
    expect(r.status).toBe(0)
  })
})

describe('the gate exits on its verdict', () => {
  it('exits 1 on a failed job, listing the run and reporting the failure as an error', () => {
    const r = runGate(FULL_ENV, [page(2, [job('verify', 'failure'), job('lint', 'success')])])
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('  verify: failure\n')
    expect(r.stdout).toContain('  lint: success\n')
    expect(r.stderr).toContain('::error::[ci-gate] verify: failure\n')
    expect(r.stdout).not.toContain('succeeded')
  })

  it('exits 1 when a job named in needs is absent from the run', () => {
    const r = runGate({ ...FULL_ENV, NEEDS_JSON: '{"verify":{},"build":{}}' }, [
      page(1, [job('verify', 'success')]),
    ])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(
      '::error::[ci-gate] build: declared in `needs` but absent from the run',
    )
  })

  it('re-reads a lagging run on the documented schedule, then fails if it never catches up', () => {
    const r = runGate(FULL_ENV, [page(1, [job('verify', null, 'in_progress')])])
    expect(r.status).toBe(1)
    expect(r.requests).toHaveLength(6)
    expect(r.sleeps).toEqual([2000, 2000, 2000, 2000, 2000])
    expect(r.stderr).toContain('::error::[ci-gate] verify: still in_progress when the gate ran')
  })

  it('passes once a lagging job reads back as finished', () => {
    const r = runGate(FULL_ENV, [
      page(1, [job('verify', null, 'in_progress')]),
      page(1, [job('verify', 'success')]),
    ])
    expect(r.status).toBe(0)
    expect(r.requests).toHaveLength(2)
    expect(r.sleeps).toEqual([2000])
  })
})
