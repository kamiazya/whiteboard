// pnpm-workspace.yaml's `overrides` shape this workspace's install and are
// not published: `npx @kamiazya/whiteboard-mcp` resolves every declared range
// afresh with npm and none of them. An override whose floor sits inside the
// range its parent already declares only speeds up what a fresh resolution
// does anyway. One whose floor sits OUTSIDE that range — protobufjs ^8.6.6
// against @grpc/proto-loader's ^7.5.3 — is a fix this workspace has and its
// consumers do not, and `pnpm audit:prod`, which reads the overridden
// lockfile, reports it cleared.
//
// So every override that a package in the published runtime closure could
// hit is ledgered here per (parent, declared range) edge, with a verdict:
//
//   - `outside-selector`: the declared range cannot resolve into the
//     override's selector at all, so the override never fires for it.
//   - `in-range`: the declared range admits the override's floor, so a fresh
//     npm resolution reaches a fixed version without it.
//   - `cross-range`: it does not. The reason says what a consumer gets
//     instead and names `audit:published`, the gate that audits that
//     resolution (tools/checks/src/audit-published.mjs).
//
// The closure is walked over the INSTALLED manifests — what each locked
// package declares, dependencies plus required peers (npm installs those) —
// from mcp-server's own `dependencies`. Optional dependencies are platform
// binaries and are not followed. The edges are derived; the verdicts are
// judgement, checked against a semver heuristic where the range has a
// simple shape. Both sides fail: an edge with no entry, and an entry no edge
// matches, so a parent changing its declared range forces a re-judgement.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

const MCP_SERVER = join(REPO_ROOT, 'packages/mcp-server')
const PUBLISHED_NAME = '@kamiazya/whiteboard-mcp'
const OVERRIDES =
  (
    parseYaml(readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf-8')) as {
      overrides?: Record<string, string>
    }
  ).overrides ?? {}

type Verdict = 'outside-selector' | 'in-range' | 'cross-range'

/** `<override key> <- <parent> <declared range>` → verdict and reason. */
const LEDGER: Record<string, { verdict: Verdict; reason: string }> = {
  '@grpc/grpc-js@<1.14.5 <- @opentelemetry/otlp-grpc-exporter-base ^1.14.3': {
    verdict: 'in-range',
    reason: '^1.14.3 admits 1.14.5',
  },
  '@libsql/client@<0.17.3 <- @kamiazya/whiteboard-mcp ^0.17.3': {
    verdict: 'outside-selector',
    reason: 'the published manifest asks for ^0.17.3 itself',
  },
  '@libsql/client@<0.17.3 <- @libsql/kysely-libsql ^0.8.0': {
    verdict: 'cross-range',
    reason:
      'a dedupe, not an advisory, so `audit:published` cannot see it: a consumer gets ' +
      '@libsql/client 0.8.x nested under kysely-libsql, with libsql 0.3.19 and its musl ' +
      'prebuild beside the 0.5.x the daemon declares',
  },
  '@modelcontextprotocol/sdk@>=1.12.0 <1.31.0 <- @modelcontextprotocol/ext-apps ^1.29.0': {
    verdict: 'in-range',
    reason: "ext-apps' required peer ^1.29.0 admits 1.31.0",
  },
  '@opentelemetry/propagator-jaeger@<2.9.0 <- @opentelemetry/sdk-node 2.10.0': {
    verdict: 'outside-selector',
    reason: 'sdk-node pins 2.10.0, above the selector',
  },
  'body-parser@<2.4.0 <- express ^2.2.1': {
    verdict: 'in-range',
    reason: '^2.2.1 admits 2.4.0',
  },
  'fast-uri@<3.1.9 <- ajv ^3.0.1': {
    verdict: 'in-range',
    reason: '^3.0.1 admits 3.1.9',
  },
  'hono@<4.13.7 <- @hono/node-server ^4': {
    verdict: 'in-range',
    reason: "a peer, satisfied by the daemon's own ^4.13.7",
  },
  'hono@<4.13.7 <- @kamiazya/whiteboard-mcp ^4.13.7': {
    verdict: 'outside-selector',
    reason: 'the published manifest asks for ^4.13.7 itself',
  },
  'hono@<4.13.7 <- @modelcontextprotocol/sdk ^4.11.4': {
    verdict: 'in-range',
    reason: '^4.11.4 admits 4.13.7, and the daemon declares ^4.13.7 at the top',
  },
  'ip-address@<10.7.4 <- express-rate-limit 10.1.0': {
    verdict: 'cross-range',
    reason:
      'the LOCKED express-rate-limit (8.3.2) pins 10.1.0; a fresh npm resolution picks a ' +
      'later express-rate-limit asking ^10.2.0 and lands on a fixed ip-address, which ' +
      '`audit:published` is what confirms',
  },
  'js-yaml@>=4.0.0 <4.3.2 <- cosmiconfig ^4.1.0': {
    verdict: 'in-range',
    reason: '^4.1.0 admits 4.3.2',
  },
  'kysely@<0.28.17 <- @kamiazya/whiteboard-mcp ^0.29.5': {
    verdict: 'outside-selector',
    reason: 'the published manifest asks for ^0.29.5',
  },
  'kysely@<0.28.17 <- @libsql/kysely-libsql *': {
    verdict: 'in-range',
    reason: "a `*` peer, satisfied by the daemon's own ^0.29.5",
  },
  'nanoid@<3.3.18 <- @kamiazya/whiteboard-mcp ^6.0.1': {
    verdict: 'outside-selector',
    reason: 'the published runtime asks for ^6; the override is for the dev path',
  },
  'nanoid@>=4.0.0 <5.0.9 <- @kamiazya/whiteboard-mcp ^6.0.1': {
    verdict: 'outside-selector',
    reason: 'the published runtime asks for ^6; the override is for the dev path',
  },
  'protobufjs@<8.6.6 <- @grpc/proto-loader ^7.5.3': {
    verdict: 'cross-range',
    reason:
      'a consumer gets 7.x (7.6.6 today), never 8.x. The 8.6.6 floor answers ' +
      'GHSA-j3f2-48v5-ccww, cleared on 7.x at 7.6.5, so the latest 7.x is unaffected — ' +
      'and `audit:published` is the gate that keeps that true',
  },
  'proxy-addr@>=1.1.0 <2.0.8 <- express ^2.0.7': {
    verdict: 'in-range',
    reason: '^2.0.7 admits 2.0.8',
  },
  'qs@<6.16.0 <- body-parser ^6.16.1': {
    verdict: 'outside-selector',
    reason: 'body-parser 2.4.0 asks ^6.16.1, whose floor is above the selector',
  },
  'qs@<6.16.0 <- express ^6.14.0': {
    verdict: 'in-range',
    reason: '^6.14.0 admits 6.16.0',
  },
}

interface Manifest {
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as Manifest
}

/** Node's own lookup: the nearest `node_modules/<name>` above `fromDir`. */
function resolvePackageDir(fromDir: string, name: string): string {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return realpathSync(dirname(candidate))
    if (dirname(dir) === dir) throw new Error(`${name} does not resolve from ${fromDir}`)
  }
}

/** An override key's target package: `a@<1` → `a`, `@s/a@>=1 <2` → `@s/a`. */
function overrideTarget(key: string): string {
  const at = key.indexOf('@', key.startsWith('@') ? 1 : 0)
  const name = at === -1 ? key : key.slice(0, at)
  // pnpm's `parent>child` form scopes an override to one parent; none is
  // used, and reading one as a bare name would ledger the wrong edges.
  if (name.includes('>')) throw new Error(`${key}: a parent-scoped override is not modelled here`)
  return name
}

function publishedOverrideEdges(): { edges: string[]; closureSize: number } {
  const overrideKeys = Object.keys(OVERRIDES)
  const edges = new Set<string>()
  const visited = new Set<string>()
  const queue: { dir: string; manifest: Manifest; isRoot: boolean }[] = [
    { dir: MCP_SERVER, manifest: readManifest(MCP_SERVER), isRoot: true },
  ]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { dir, manifest, isRoot } = next
    // The root's peers are optional by declaration and opt-in for a user;
    // a dependency's required peers are installed by npm alongside it.
    const peers = isRoot
      ? []
      : Object.entries(manifest.peerDependencies ?? {}).filter(
          ([name]) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
        )
    const parent = isRoot ? PUBLISHED_NAME : manifest.name
    for (const [name, range] of [...Object.entries(manifest.dependencies ?? {}), ...peers]) {
      for (const key of overrideKeys) {
        if (overrideTarget(key) === name) edges.add(`${key} <- ${parent} ${range}`)
      }
      const child = resolvePackageDir(dir, name)
      if (visited.has(child)) continue
      visited.add(child)
      queue.push({ dir: child, manifest: readManifest(child), isRoot: false })
    }
  }
  return { edges: [...edges].sort(), closureSize: visited.size }
}

type Version = [number, number, number]

function parseVersion(text: string): Version | undefined {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text)
  if (match === null) return undefined
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/** The versions a caret range spans share this: the major, or `0.minor`. */
function caretFamily(v: Version): string {
  return v[0] === 0 ? `0.${v[1]}` : `${v[0]}`
}

/**
 * Whether `range` admits a version satisfying the caret `floor`, for the
 * range shapes this can decide (`*`, exact, `^x[.y[.z]]`); `undefined`
 * otherwise, which leaves the verdict to the ledger alone.
 */
function admitsFloor(range: string, floor: Version): boolean | undefined {
  if (range === '*') return true
  const exact = parseVersion(range)
  if (exact !== undefined)
    return compare(exact, floor) >= 0 && caretFamily(exact) === caretFamily(floor)
  if (range.startsWith('^')) {
    const lower = parseVersion(range.slice(1))
    return lower === undefined ? undefined : caretFamily(lower) === caretFamily(floor)
  }
  return undefined
}

/** Whether `range`'s lowest version is at or above the selector's `<X` bound. */
function outsideSelector(range: string, selector: string): boolean | undefined {
  const upper = /<\s*([\d.]+)\s*$/.exec(selector)?.[1]
  const lower = parseVersion(range.replace(/^[\^~]|^>=\s*/, ''))
  const bound = upper === undefined ? undefined : parseVersion(upper)
  if (lower === undefined || bound === undefined) return undefined
  return compare(lower, bound) >= 0
}

function judge(edge: string, verdict: Verdict): string | null {
  const [key = '', target = ''] = edge.split(' <- ')
  const range = target.slice(target.lastIndexOf(' ') + 1)
  const floor = parseVersion((OVERRIDES[key] ?? '').replace(/^\^/, ''))
  const selector = key.slice(overrideTarget(key).length + 1)
  if (floor === undefined) return `${edge}: the override's floor is not a caret version`
  if (verdict === 'outside-selector' && outsideSelector(range, selector) !== true) {
    return `${edge}: ledgered outside-selector, but ${range} can resolve into ${selector}`
  }
  if (verdict === 'in-range' && admitsFloor(range, floor) === false) {
    return `${edge}: ledgered in-range, but ${range} does not admit ${floor.join('.')}`
  }
  if (verdict === 'cross-range' && admitsFloor(range, floor) === true) {
    return `${edge}: ledgered cross-range, but ${range} admits ${floor.join('.')}`
  }
  return null
}

describe('overrides the published package reaches', () => {
  const { edges, closureSize } = publishedOverrideEdges()

  it('walks a real runtime closure and finds the overrides in it', () => {
    // A walk that stopped at the root would report every override unreached.
    expect(closureSize).toBeGreaterThan(150)
    expect(edges.length).toBeGreaterThan(10)
  })

  it('has a ledgered verdict for every edge, and no entry for an edge that is gone', () => {
    const unlisted = edges.filter((edge) => !(edge in LEDGER))
    const stale = Object.keys(LEDGER).filter((edge) => !edges.includes(edge))
    expect(unlisted, 'override edges the published closure reaches with no verdict').toEqual([])
    expect(stale, 'ledger entries no published override edge matches').toEqual([])
  })

  it('names the published-resolution audit in every cross-range reason', () => {
    const silent = Object.entries(LEDGER)
      .filter(([, entry]) => entry.verdict === 'cross-range')
      .filter(([, entry]) => !entry.reason.includes('audit:published'))
      .map(([edge]) => edge)
    expect(silent).toEqual([])
  })

  it('agrees with the semver shape of each declared range', () => {
    const wrong = Object.entries(LEDGER)
      .map(([edge, entry]) => judge(edge, entry.verdict))
      .filter((problem) => problem !== null)
    expect(wrong).toEqual([])
  })
})
