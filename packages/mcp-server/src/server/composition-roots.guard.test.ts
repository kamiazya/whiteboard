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
 * - **The shared set, taken whole.** An HTTP root passes `sharedBackgroundWork`
 *   the object `createSharedWorkers` returned and nothing else, hands
 *   `createApp` that object's `checkpoints.capture`, and flushes through its
 *   `checkpoints.flush`. The sweeper's capped stop and the holder for the
 *   scheduler `createApp` builds were hand-copied into both roots; a third
 *   root that wrote either itself could take no checkpoints, or wait out a
 *   file-GC pass without a bound, and nothing would fail.
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

type RootKind = 'http' | 'stdio'

/** What an HTTP root hands the shared set, as an identifier it can name. */
const SHARED_BINDING = /\b(\w+)\s*=\s*createSharedWorkers\(/

/**
 * Whether `code` takes `member` of the object `createSharedWorkers` returned,
 * through `pattern` (which captures the object's name). Matching the NAME is
 * what tells a root using the shared set from one that builds its own: a
 * hand-built `fileGc` or a local trigger variable reaches the registry and the
 * type, and answers nothing the shared helper's declaration does.
 */
function usesShared(code: string, pattern: RegExp): boolean {
  const bound = SHARED_BINDING.exec(code)?.[1]
  const used = pattern.exec(code)?.[1]
  return bound !== undefined && bound === used
}

interface RootRule {
  readonly missing: string
  readonly kinds: readonly RootKind[]
  readonly satisfied: (code: string) => boolean
}

const ROOT_RULES: readonly RootRule[] = [
  {
    missing: 'shared boot',
    kinds: ['http', 'stdio'],
    satisfied: (code) => /\b(bootSelfHostDeps|prepareSelfHostDataDir)\(/.test(code),
  },
  {
    missing: 'boot through the shared helper, not prepareDataDir/ensureWorkspaceId',
    kinds: ['http', 'stdio'],
    satisfied: (code) => !/store\/db\/prepare\.js|\/current-workspace\.js/.test(code),
  },
  {
    missing: 'attachLiveAudience',
    kinds: ['http'],
    satisfied: (code) => /\battachLiveAudience\(/.test(code),
  },
  {
    missing: 'startHttpRootTracing',
    kinds: ['http'],
    satisfied: (code) => /\bstartHttpRootTracing\(/.test(code),
  },
  {
    missing: 'initTracing',
    kinds: ['stdio'],
    satisfied: (code) => /\binitTracing\(/.test(code),
  },
  {
    missing: 'startBackgroundWork',
    kinds: ['http', 'stdio'],
    satisfied: (code) => /\bstartBackgroundWork\(/.test(code),
  },
  {
    missing: 'the background work that carries the auto-checkpoint',
    kinds: ['http', 'stdio'],
    satisfied: (code) => /\b(sharedBackgroundWork|stdioBackgroundWork)\(/.test(code),
  },
  {
    missing: 'stopAll (flush the pending checkpoints)',
    kinds: ['http', 'stdio'],
    satisfied: (code) => /\.stopAll\(\)/.test(code),
  },
  {
    missing:
      'sharedBackgroundWork over what createSharedWorkers returned, with no hand-built arming',
    kinds: ['http'],
    satisfied: (code) => usesShared(code, /\bsharedBackgroundWork\(\s*(\w+)\s*\)/),
  },
  {
    missing: "createApp's onAutoVersionTrigger from the shared checkpoint holder",
    kinds: ['http'],
    satisfied: (code) =>
      usesShared(code, /\bonAutoVersionTrigger:\s*(\w+)\.checkpoints\.capture\b/),
  },
  {
    missing: "the shutdown's flushCheckpoints from the shared checkpoint holder",
    kinds: ['http'],
    satisfied: (code) => usesShared(code, /\bflushCheckpoints:\s*(\w+)\.checkpoints\.flush\b/),
  },
]

interface RootFindings {
  readonly kind: RootKind | null
  readonly missing: string[]
}

function inspectRoot(source: string): RootFindings {
  const code = stripComments(source)
  const kind = /\bcreateApp\(/.test(code) ? 'http' : /\bserveStdio\(/.test(code) ? 'stdio' : null
  if (kind === null) return { kind, missing: [] }
  const missing = ROOT_RULES.filter((r) => r.kinds.includes(kind) && !r.satisfied(code)).map(
    (r) => r.missing,
  )
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

const SHARED_ARMING =
  'sharedBackgroundWork over what createSharedWorkers returned, with no hand-built arming'
const SHARED_CAPTURE = "createApp's onAutoVersionTrigger from the shared checkpoint holder"
const SHARED_FLUSH = "the shutdown's flushCheckpoints from the shared checkpoint holder"

const COMPLIANT_HTTP_ROOT = [
  'await startHttpRootTracing("daemon")',
  'const shared = createSharedWorkers(id, options)',
  'const close = createRootShutdown({ flushCheckpoints: shared.checkpoints.flush })',
  'const { serverDeps } = await bootSelfHostDeps(dir)',
  'const deps = attachLiveAudience(serverDeps)',
  'const app = createApp({ onAutoVersionTrigger: shared.checkpoints.capture })',
  'const work = startBackgroundWork(sharedBackgroundWork(shared))',
  'await work.stopAll()',
].join('\n')

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
    expect(findings.missing).toHaveLength(10)
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
      SHARED_ARMING,
      SHARED_CAPTURE,
      SHARED_FLUSH,
    ])
  })

  it('accepts an HTTP root that takes everything from createSharedWorkers', () => {
    expect(inspectRoot(COMPLIANT_HTTP_ROOT)).toEqual({ kind: 'http', missing: [] })
  })

  it('flags a root that hands the registry a hand-built fileGc or checkpoint scheduler', () => {
    const handBuilt = COMPLIANT_HTTP_ROOT.replace(
      'sharedBackgroundWork(shared)',
      'sharedBackgroundWork(shared, { fileGc: { start: () => {}, stop: async () => {} } })',
    )
    expect(inspectRoot(handBuilt).missing).toEqual([SHARED_ARMING])
  })

  it('flags a root that keeps its own trigger instead of the holder', () => {
    const own = COMPLIANT_HTTP_ROOT.replace(
      'onAutoVersionTrigger: shared.checkpoints.capture',
      'onAutoVersionTrigger: (t) => { trigger = t }',
    ).replace(
      'flushCheckpoints: shared.checkpoints.flush',
      'flushCheckpoints: () => trigger.flush()',
    )
    expect(inspectRoot(own).missing).toEqual([SHARED_CAPTURE, SHARED_FLUSH])
  })

  it('flags a root that names a holder other than the one createSharedWorkers returned', () => {
    const other = COMPLIANT_HTTP_ROOT.replace(
      'sharedBackgroundWork(shared)',
      'sharedBackgroundWork(mine)',
    )
    expect(inspectRoot(other).missing).toEqual([SHARED_ARMING])
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
