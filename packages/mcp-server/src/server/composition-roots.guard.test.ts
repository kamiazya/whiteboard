import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * What every composition root has to do the same way, held structurally so a
 * new root cannot forget it.
 *
 * - **Boot.** A root reaches `prepareDataDir` through `bootSelfHostDeps` (or
 *   `prepareSelfHostDataDir`), never by calling the pieces: the order is the
 *   contract, and a root that skipped the migration only worked because
 *   `ensureWorkspaceId` happened to run it.
 * - **Live audience.** An HTTP root mounts the sync SSE router through
 *   `createApp`, so it attaches the notifier with `attachLiveAudience`; a
 *   root that does not leaves every tool announcing to nobody
 *   (`wb_viewport_set` answers `delivered: false` to an open page).
 *
 * - **Background work.** Every root arms what the process does on its own
 *   through `startBackgroundWork`, from the declarations that include the
 *   automatic checkpoint (`sharedBackgroundWork` for the HTTP roots,
 *   `stdioBackgroundWork` for stdio), and stops it with `.stopAll()` so the
 *   pending checkpoints are taken. The published stdio entry mounts no router
 *   and took none until it did — an agent-only workspace showed no History
 *   and compaction declined `no-versions` forever.
 * - **Tracing.** Every root initialises OpenTelemetry itself — an HTTP root
 *   through `startHttpRootTracing` (the one helper that names its role), the
 *   stdio root through `initTracing`. The process entries differ (`daemon
 *   run` and `server run` never reach the dev entry's `main`), so tracing
 *   initialised in an entry made `WHITEBOARD_OTEL` a silent no-op on every
 *   shipped deployment.
 *
 * A root is found by what it does — calling `createApp(` or `serveStdio(` —
 * rather than from a list, so a third one is checked the day it appears.
 */
const SERVER_DIR = fileURLToPath(new URL('.', import.meta.url))

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

interface RootFindings {
  readonly kind: 'http' | 'stdio' | null
  readonly missing: string[]
}

function inspectRoot(source: string): RootFindings {
  const code = stripComments(source)
  const kind = /\bcreateApp\(/.test(code) ? 'http' : /\bserveStdio\(/.test(code) ? 'stdio' : null
  if (kind === null) return { kind, missing: [] }
  const missing: string[] = []
  if (!/\b(bootSelfHostDeps|prepareSelfHostDataDir)\(/.test(code)) missing.push('shared boot')
  if (/store\/db\/prepare\.js|\/current-workspace\.js/.test(code)) {
    missing.push('boot through the shared helper, not prepareDataDir/ensureWorkspaceId')
  }
  if (kind === 'http' && !/\battachLiveAudience\(/.test(code)) missing.push('attachLiveAudience')
  if (kind === 'http' && !/\bstartHttpRootTracing\(/.test(code))
    missing.push('startHttpRootTracing')
  if (kind === 'stdio' && !/\binitTracing\(/.test(code)) missing.push('initTracing')
  if (!/\bstartBackgroundWork\(/.test(code)) missing.push('startBackgroundWork')
  if (!/\b(sharedBackgroundWork|stdioBackgroundWork)\(/.test(code)) {
    missing.push('the background work that carries the auto-checkpoint')
  }
  if (!/\.stopAll\(\)/.test(code)) missing.push('stopAll (flush the pending checkpoints)')
  return { kind, missing }
}

async function productionSources(): Promise<Array<{ file: string; source: string }>> {
  const entries = (await readdir(join(SERVER_DIR, '..'), { recursive: true })).map((e) =>
    e.replaceAll('\\', '/'),
  )
  const files = entries.filter(
    (e) => e.endsWith('.ts') && !/\.test\.ts$|^server\/app\.ts$|\/_test-/.test(e),
  )
  return Promise.all(
    files.map(async (file) => ({
      file,
      source: await readFile(join(SERVER_DIR, '..', file), 'utf8'),
    })),
  )
}

describe('composition roots share one boot sequence and one live audience', () => {
  // The positive control: a checker that finds nothing anywhere passes
  // without ever reaching a root.
  it('flags a root that migrates by hand and attaches no audience', () => {
    const findings = inspectRoot(
      [
        "import { prepareDataDir } from './store/db/prepare.js'",
        'await prepareDataDir(dir)',
        'const app = createApp({})',
      ].join('\n'),
    )
    expect(findings.kind).toBe('http')
    expect(findings.missing).toHaveLength(7)
  })

  it('does not read a comment as a call', () => {
    const findings = inspectRoot(
      '// bootSelfHostDeps( attachLiveAudience(\nconst app = createApp({})',
    )
    expect(findings.missing).toEqual([
      'shared boot',
      'attachLiveAudience',
      'startHttpRootTracing',
      'startBackgroundWork',
      'the background work that carries the auto-checkpoint',
      'stopAll (flush the pending checkpoints)',
    ])
  })

  it('flags a stdio root that never starts tracing, and a tracing call in a comment', () => {
    const findings = inspectRoot(
      [
        '// initTracing(',
        'bootSelfHostDeps(dir)',
        'startBackgroundWork(stdioBackgroundWork())',
        'handle.stopAll()',
        'serveStdio(server)',
      ].join('\n'),
    )
    expect(findings).toEqual({ kind: 'stdio', missing: ['initTracing'] })
  })

  it('finds both HTTP roots and the stdio root, and each meets the shared contract', async () => {
    const roots = (await productionSources())
      .map(({ file, source }) => ({ file, ...inspectRoot(source) }))
      .filter((r) => r.kind !== null)

    expect(roots.map((r) => r.file).sort()).toEqual([
      'server/http-server.ts',
      'server/mcp/index.ts',
      'server/server-mode-http.ts',
    ])
    expect(roots.flatMap((r) => r.missing.map((m) => `${r.file}: ${m}`))).toEqual([])
  })
})
