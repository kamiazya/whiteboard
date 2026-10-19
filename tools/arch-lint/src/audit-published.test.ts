// `pnpm audit:prod` audits pnpm-lock.yaml, and that lockfile has
// pnpm-workspace.yaml's overrides already applied. Those overrides are not
// published, so `npx @kamiazya/whiteboard-mcp` resolves the package's
// dependency ranges afresh with npm and none of them: protobufjs, pinned
// to ^8.6.6 here, arrives as 7.x through @grpc/proto-loader's ^7.5.3. The
// published audit packs the package, installs the tarball into an empty
// directory outside the workspace, and audits what npm resolved there.
//
// A `pnpm` and an `npm` on PATH stand in for the real ones, recording each
// call and the directory it ran in, so the plan is pinned without the
// registry.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const SCRIPT = join(REPO_ROOT, 'tools/checks/src/audit-published.mjs')
const MCP_SERVER = join(REPO_ROOT, 'packages/mcp-server')

interface Call {
  bin: string
  args: string[]
  cwd: string
  manifest: string | null
}

const workDir = mkdtempSync(join(tmpdir(), 'audit-published-'))
afterAll(() => rmSync(workDir, { recursive: true, force: true }))
let runCount = 0

function fakeBin(binDir: string, name: string, callLog: string, auditStatus: number) {
  writeFileSync(
    join(binDir, name),
    `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const manifest = fs.existsSync('package.json') ? fs.readFileSync('package.json', 'utf8') : null
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify({ bin: ${JSON.stringify(name)}, args, cwd: process.cwd(), manifest }) + '\\n')
if (${JSON.stringify(name)} === 'pnpm' && args.includes('pack')) {
  const dest = args[args.indexOf('--pack-destination') + 1]
  fs.writeFileSync(path.join(dest, 'kamiazya-whiteboard-mcp-0.0.0.tgz'), '')
  process.stdout.write(path.join(dest, 'kamiazya-whiteboard-mcp-0.0.0.tgz') + '\\n')
}
if (${JSON.stringify(name)} === 'npm' && args[0] === 'audit') {
  process.stdout.write(${auditStatus} === 0 ? 'found 0 vulnerabilities\\n' : '1 high severity vulnerability\\n')
  process.exit(${auditStatus})
}
`,
  )
  chmodSync(join(binDir, name), 0o755)
}

function run(opts: { auditStatus?: number; args?: string[] } = {}) {
  runCount += 1
  const binDir = join(workDir, `bin-${runCount}`)
  mkdirSync(binDir)
  const callLog = join(binDir, 'calls.jsonl')
  writeFileSync(callLog, '')
  fakeBin(binDir, 'pnpm', callLog, 0)
  fakeBin(binDir, 'npm', callLog, opts.auditStatus ?? 0)
  const r = spawnSync(process.execPath, [SCRIPT, ...(opts.args ?? [])], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: `${binDir}:${process.env.PATH ?? ''}`, TMPDIR: workDir },
  })
  const calls = readFileSync(callLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Call)
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls }
}

describe('audit-published', () => {
  it('packs mcp-server without its lifecycle scripts, so it needs no build', () => {
    const r = run()
    const pack = r.calls.find((c) => c.bin === 'pnpm')
    expect(pack?.cwd).toBe(MCP_SERVER)
    expect(pack?.args).toContain('pack')
    expect(pack?.args).toContain('--config.ignore-scripts=true')
  })

  it('installs the tarball with npm in an empty directory outside the workspace', () => {
    const r = run()
    const install = r.calls.find((c) => c.bin === 'npm' && c.args[0] === 'install')
    expect(install).toBeDefined()
    expect(install?.args).toEqual(
      expect.arrayContaining(['--package-lock-only', '--ignore-scripts']),
    )
    expect(install?.args.some((a) => a.endsWith('kamiazya-whiteboard-mcp-0.0.0.tgz'))).toBe(true)
    // Outside the repo, so no pnpm-workspace.yaml override and no .npmrc of
    // the workspace's can reach the resolution.
    expect(install?.cwd.startsWith(REPO_ROOT)).toBe(false)
    expect(JSON.parse(install?.manifest ?? '{}')).toEqual({
      name: 'whiteboard-mcp-published-audit',
      private: true,
    })
  })

  it('audits the runtime resolution at high, in the same directory', () => {
    const r = run()
    const install = r.calls.find((c) => c.bin === 'npm' && c.args[0] === 'install')
    const audit = r.calls.find((c) => c.bin === 'npm' && c.args[0] === 'audit')
    expect(audit?.args).toEqual(['audit', '--omit=dev', '--audit-level=high'])
    expect(audit?.cwd).toBe(install?.cwd)
    expect(r.status).toBe(0)
  })

  it('fails with the audit when the published resolution has a finding', () => {
    const r = run({ auditStatus: 1 })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('1 high severity vulnerability')
  })

  it('audits a tarball it is given instead of packing one', () => {
    const given = join(workDir, 'given.tgz')
    writeFileSync(given, '')
    const r = run({ args: ['--tarball', given] })
    expect(r.calls.some((c) => c.bin === 'pnpm')).toBe(false)
    const install = r.calls.find((c) => c.bin === 'npm' && c.args[0] === 'install')
    expect(install?.args).toContain(given)
    expect(r.status).toBe(0)
  })

  it('leaves no scratch directory behind', () => {
    const r = run()
    const install = r.calls.find((c) => c.bin === 'npm' && c.args[0] === 'install')
    expect(install).toBeDefined()
    expect(existsSync(install?.cwd ?? '')).toBe(false)
  })
})
