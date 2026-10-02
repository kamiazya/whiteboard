/**
 * What an ADAPTER (a route or an MCP tool registration, ADR-0018) may import of
 * the keeper's own modules, and what it may reach on the host without importing
 * one — as one definition.
 *
 * Two definitions of "mechanic" used to disagree: the adapter-mechanic finder
 * matched five directory patterns, and `mcp-server-layer-order.test.ts` filed a
 * wider set of modules (the top-level `atomic-write`, `output-path`, `config`
 * and the rest) in its `mechanics` layer. An adapter importing one of those
 * showed in neither guard's ledger. The layer is declared here, the finder
 * derives from it, and the layer-order test reads it, so there is nothing for
 * the two to disagree about.
 */

/** `server/<dir>/**` that hold mechanics. */
export const MECHANIC_DIRS: ReadonlySet<string> = new Set([
  'store',
  'security',
  'tenant',
  'export',
  'search',
  'observability',
  'release',
])

/**
 * Top-level `server/*.ts` that are mechanisms: the logger, configuration and
 * environment, atomic writes, the declared background work and what it runs,
 * the live-audience notifier, the backup mechanics, and the identity and
 * workspace resolution the stores and `di/` build on. Named rather than
 * guessed, so a new one has to be placed: a file in no layer fails
 * `belongs to no layer` in the layer-order test.
 */
export const TOP_LEVEL_MECHANICS: readonly string[] = [
  'server/log.ts',
  'server/server-core-logs.ts',
  'server/config.ts',
  'server/config-file.ts',
  'server/startup-env.ts',
  'server/replica-env.ts',
  'server/data-dir-writable.ts',
  'server/data-dir-fallback.ts',
  'server/atomic-write.ts',
  'server/validators.ts',
  'server/output-path.ts',
  'server/backup-restore.ts',
  'server/server-mode-backup-restore.ts',
  'server/background-work.ts',
  'server/background-work-costs.ts',
  'server/shared-background-work.ts',
  'server/canvas-client-notifier.ts',
  // What is open and listening: the registry of sync streams, the audience
  // vocabulary the daemon speaks over it, and the viewport-request cache the
  // two share. The route that opens a stream (`routes/sync-sse.ts`) sits above.
  'server/sync-streams.ts',
  'server/sync-audience.ts',
  'server/viewport-requests.ts',
  'server/daemon-actor.ts',
  'server/daemon-auth-binding.ts',
  'server/current-workspace.ts',
  // Startup clean-up of data-dir artifacts a retired feature left behind.
  'server/purge-legacy-trust-file.ts',
]

/**
 * Mechanic-layer modules an adapter is ENTITLED to import, matched against the
 * module path under `server/` without its extension. Each is policy, a value or
 * live state rather than how a row or a file is kept, so importing one is
 * translation and not a weld to storage. Everything else in the mechanics
 * layer, and `daemon/`, is a mechanic an adapter reaching it must ledger.
 */
export const ADAPTER_ENTITLED_MECHANICS: readonly {
  readonly pattern: RegExp
  readonly reason: string
}[] = [
  {
    pattern: /^security\/(?![a-z0-9-]+-store$)/,
    reason:
      'bearer parsing, credential resolution and the membership decisions: what an adapter asks (who is calling, may they), never how a row is kept — the `*-store` modules are the mechanic',
  },
  {
    pattern: /^tenant\/(?!data-layout$)/,
    reason:
      'the tenant id and the layout SEAM are values an adapter is handed; the layout that places files by them is the mechanic',
  },
  {
    pattern: /^observability\//,
    reason: 'the span around a request an adapter handles: how it reports, not what it stores',
  },
  {
    pattern: /^(?:log|server-core-logs|validators)$/,
    reason:
      'the logger and the input-shape policy every adapter uses; neither reads or writes a keeper',
  },
  {
    pattern: /^(?:sync-streams|sync-audience|viewport-requests)$/,
    reason:
      'the in-memory registry of what is open and listening, shared by the route that opens a stream and the writers that feed it: live state, not stored state',
  },
]

/** The module path under `server/`, without extension, for a `server/…`-rooted file path. */
const withoutExtension = (path: string): string => path.replace(/\.tsx?$/, '')

/** Whether a module (path under `server/`, no extension) is in the mechanics layer. */
export function isMechanicsLayerModule(modulePath: string): boolean {
  const [top] = modulePath.split('/')
  if (modulePath.includes('/')) return MECHANIC_DIRS.has(top as string)
  return TOP_LEVEL_MECHANICS.includes(`server/${modulePath}.ts`)
}

/** The mechanics-layer modules an adapter may import, by the entitlement that says so. */
export function isAdapterEntitled(modulePath: string): boolean {
  return ADAPTER_ENTITLED_MECHANICS.some(({ pattern }) => pattern.test(modulePath))
}

/**
 * Whether an adapter importing this module is reaching a mechanic: a module of
 * the mechanics layer it is not entitled to, or anything under the daemon's own
 * housekeeping (`daemon/`, a layer of its own below the mechanics).
 */
export function isAdapterForbiddenMechanic(modulePath: string): boolean {
  if (modulePath.startsWith('daemon/')) return true
  return isMechanicsLayerModule(modulePath) && !isAdapterEntitled(modulePath)
}

/** The path under `server/` a `server/…` source path names, for layer lookups. */
export const serverModulePath = (relativeToSrc: string): string =>
  withoutExtension(relativeToSrc.replace(/^server\//, ''))

/**
 * Host reach an adapter file has WITHOUT importing a mechanic: the disk, the
 * operating system, a child process or the environment. Shrink-only, for the
 * reason `ADAPTERS_REACHING_MECHANICS` is — an adapter that writes a file has
 * the operation welded to its storage as surely as one that imports a store —
 * and pinned by equality in `adapter-host-reach.test.ts`.
 *
 * Keyed by file, each with the kinds it reaches and why that is the state of
 * things rather than a decision. A kind a file gains is a new edge and fails
 * until it is listed.
 */
export interface HostReach {
  readonly kinds: readonly ('node:fs' | 'node:os' | 'node:child_process' | 'process.env')[]
  readonly reason: string
}

const HARNESS = 'test harness filed under server/mcp'

export const ADAPTER_HOST_REACH: Readonly<Record<string, HostReach>> = {
  'app-helpers.ts': {
    kinds: ['process.env'],
    reason:
      'defaults the MCP HTTP debug flag from the process environment; its callers could pass the environment they hold',
  },
  'mcp/codex-config.distribution-impl.ts': { kinds: ['node:fs'], reason: HARNESS },
  'mcp/daemon-process.smoke-impl.ts': {
    kinds: ['node:child_process', 'process.env'],
    reason: HARNESS,
  },
  'mcp/mcp-e2e-checkpoint.smoke-impl.ts': {
    kinds: ['node:child_process', 'node:fs', 'node:os', 'process.env'],
    reason: HARNESS,
  },
  'mcp/startup.smoke-impl.ts': {
    kinds: ['node:child_process', 'node:fs', 'node:os', 'process.env'],
    reason: HARNESS,
  },
  'mcp/stdio-exit.smoke-impl.ts': {
    kinds: ['node:child_process', 'node:fs', 'node:os', 'process.env'],
    reason: HARNESS,
  },
  'mcp/stdio-session.smoke-impl.ts': {
    kinds: ['node:child_process', 'process.env'],
    reason: HARNESS,
  },
  'mcp/tarball.distribution-impl.ts': {
    kinds: ['node:child_process', 'node:fs', 'node:os', 'process.env'],
    reason: HARNESS,
  },
  'mcp/mcp-apps.ts': {
    kinds: ['node:fs'],
    reason:
      'reads the MCP Apps widget bundle from disk, once, and caches it; the root could hand in the bytes',
  },
  'routes/debug.ts': {
    kinds: ['process.env'],
    reason:
      'defaults the route on from `WHITEBOARD_DEBUG` in the process environment; the router already accepts `enabled`, so the root could always decide',
  },
  'routes/document/_shared.ts': {
    kinds: ['node:os'],
    reason:
      'takes the default human display name from the OS user (`userInfo`); the root could hand in the name',
  },
  'routes/document/export-svg.ts': {
    kinds: ['node:fs'],
    reason:
      'creates the exports directory and writes the rendered SVG; the write is the export keeper’s and belongs behind `export/`',
  },
  'routes/export.ts': {
    kinds: ['node:fs'],
    reason:
      'creates the exports directory and writes the rendered PNG; the write is the export keeper’s and belongs behind `export/`',
  },
  'routes/files.ts': {
    kinds: ['node:fs'],
    reason:
      'an upload and read store inline over the data layout: `mkdir`, `readdir`, `readFile` and an atomic write; a mechanic filed under routes',
  },
  'routes/fonts.ts': {
    kinds: ['node:fs'],
    reason:
      'serves an installed font’s bytes by reading the catalogue file from disk; the read belongs with `export/installed-fonts`',
  },
}

/**
 * How many `<file> -> <kind>` edges {@link ADAPTER_HOST_REACH} holds, pinned by
 * equality: a new reach fails until it is listed, and paying one off fails until
 * this comes down.
 */
export const ADAPTER_HOST_REACH_CEILING = 29
