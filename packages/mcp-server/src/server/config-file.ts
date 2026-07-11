// Auto-loads .whiteboardrc / whiteboard.config.json / .whiteboard/config.yaml
// (and a package.json#whiteboard field) for the LOCAL DAEMON, so operators can
// keep WHITEBOARD_ALLOWED_WEB_ORIGINS / port / token / logLevel / dataDir in a
// checked-in-or-dotfile config instead of exporting env vars by hand.
//
// cosmiconfig (not lilconfig) is used deliberately: the user's actual ask was
// YAML support, and cosmiconfig bundles a YAML loader out of the box while
// lilconfig does not. JS loaders (whiteboard.config.js/.cjs/.mjs) are
// deliberately EXCLUDED from searchPlaces below — loading arbitrary JS at
// daemon startup would let a config file execute code, which a declarative
// JSON/YAML/rc format must never do.
//
// Server-mode env config (security/server-mode-env-config.ts) is out of
// scope here: that surface is env-first by design for hosted operators.

import { homedir } from 'node:os'
import { cosmiconfigSync } from 'cosmiconfig'
import { z } from 'zod'
import { getLogger, LOG_LEVELS } from './log.js'

const log = getLogger('config-file')

// Order matters: cosmiconfig checks these, in this order, in each directory
// while walking up from cwd. JSON/YAML/rc-without-extension formats only.
export const CONFIG_FILE_SEARCH_PLACES = [
  '.whiteboardrc',
  '.whiteboardrc.json',
  '.whiteboardrc.yaml',
  '.whiteboardrc.yml',
  '.whiteboard/config.yaml',
  '.whiteboard/config.yml',
  'whiteboard.config.json',
  'package.json',
] as const

// Fallback file consulted when nothing is found walking up from cwd, so a
// single per-user default can apply across every project on a machine.
export const HOME_CONFIG_FILE_RELATIVE_PATH = '.whiteboard/config.yaml'

const KNOWN_KEYS = ['allowedWebOrigins', 'port', 'token', 'logLevel', 'dataDir'] as const
type KnownKey = (typeof KNOWN_KEYS)[number]

// token is intentionally a plain string: file-stored tokens are a dev-only
// convenience (the same footgun as committing a .env with a secret in it).
// Docs must say so; this module never logs the value.
export const whiteboardConfigFileSchema = z
  .object({
    allowedWebOrigins: z.array(z.string()).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    token: z.string().optional(),
    logLevel: z.enum(LOG_LEVELS).optional(),
    dataDir: z.string().optional(),
  })
  .strict()

export type WhiteboardConfigFile = z.infer<typeof whiteboardConfigFileSchema>

export interface LoadedConfigFile {
  readonly filepath: string
  readonly config: WhiteboardConfigFile
}

export interface LoadConfigFileOptions {
  // Overridable for tests; defaults to the real home directory.
  homeDir?: string
}

function isKnownKey(key: string): key is KnownKey {
  return (KNOWN_KEYS as readonly string[]).includes(key)
}

function describeIssuePath(path: readonly PropertyKey[]): string {
  return path.length > 0 ? path.map(String).join('.') : '(root)'
}

// Splits the raw parsed file object into known keys (validated below) and
// unknown ones (warned about, then dropped) so a typo like `allowdWebOrigins`
// is loud instead of silently doing nothing.
function partitionKnownKeys(
  raw: Record<string, unknown>,
  filepath: string,
): Record<string, unknown> {
  const unknownKeys = Object.keys(raw).filter((key) => !isKnownKey(key))
  if (unknownKeys.length > 0) {
    log.warning({ filepath, unknownKeys }, 'ignoring unknown whiteboard config key(s)')
  }
  const known: Record<string, unknown> = {}
  for (const key of KNOWN_KEYS) {
    if (key in raw) known[key] = raw[key]
  }
  return known
}

function parseKnownConfig(known: Record<string, unknown>, filepath: string): WhiteboardConfigFile {
  const result = whiteboardConfigFileSchema.safeParse(known)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const key = describeIssuePath(issue.path)
  throw new Error(`Invalid whiteboard config at ${filepath}: key "${key}" ${issue.message}`)
}

function validateLoadedConfig(rawConfig: unknown, filepath: string): WhiteboardConfigFile {
  if (typeof rawConfig !== 'object' || rawConfig === null || Array.isArray(rawConfig)) {
    throw new Error(`Invalid whiteboard config at ${filepath}: expected an object at the root`)
  }
  const known = partitionKnownKeys(rawConfig as Record<string, unknown>, filepath)
  return parseKnownConfig(known, filepath)
}

// Loads the nearest whiteboard config file, walking up from `cwd`. Falls
// back to `~/.whiteboard/config.yaml` when nothing is found. Returns null
// when no file exists anywhere — daemon behavior must stay byte-identical
// in that case.
export function loadConfigFile(
  cwd: string = process.cwd(),
  options: LoadConfigFileOptions = {},
): LoadedConfigFile | null {
  // cosmiconfig v9 defaults to searchStrategy 'none' (single directory, no
  // walk-up) unless a stopDir is given. Passing the filesystem root opts
  // back into walking up from cwd, matching the spec's "walking up" ask.
  const explorer = cosmiconfigSync('whiteboard', {
    searchPlaces: [...CONFIG_FILE_SEARCH_PLACES],
    searchStrategy: 'global',
    stopDir: '/',
  })

  const found = explorer.search(cwd)
  if (found && !found.isEmpty) {
    return { filepath: found.filepath, config: validateLoadedConfig(found.config, found.filepath) }
  }

  const homeDir = options.homeDir ?? homedir()
  const homeConfigExplorer = cosmiconfigSync('whiteboard', {
    searchPlaces: [HOME_CONFIG_FILE_RELATIVE_PATH],
    searchStrategy: 'global',
    stopDir: homeDir,
  })
  let homeFound: ReturnType<typeof homeConfigExplorer.search>
  try {
    homeFound = homeConfigExplorer.search(homeDir)
  } catch {
    return null
  }
  if (!homeFound || homeFound.isEmpty) return null
  return {
    filepath: homeFound.filepath,
    config: validateLoadedConfig(homeFound.config, homeFound.filepath),
  }
}

// Layers validated config-file values under process.env, dotenv-style: only
// sets a WHITEBOARD_* key that is CURRENTLY UNSET. This is a deliberate,
// narrow exception to the repo's immutability discipline — every existing
// env reader (web-origin-allowlist, resolveToken, the daemon-run token read,
// data-dir-secure) already treats process.env as its seam, so layering file
// values here gives them env-over-file precedence for free without touching
// each seam individually. `port` is excluded: its own precedence chain
// (CLI --port > file port > auto-scan) is not a simple set-if-unset case, so
// callers read `config.port` directly instead.
export function applyConfigFileToEnv(
  config: WhiteboardConfigFile,
  env: Record<string, string | undefined> = process.env,
): void {
  if (config.allowedWebOrigins !== undefined && env.WHITEBOARD_ALLOWED_WEB_ORIGINS === undefined) {
    env.WHITEBOARD_ALLOWED_WEB_ORIGINS = config.allowedWebOrigins.join(',')
  }
  if (config.token !== undefined) {
    if (env.WHITEBOARD_TOKEN === undefined) env.WHITEBOARD_TOKEN = config.token
    if (env.WHITEBOARD_DAEMON_TOKEN === undefined) env.WHITEBOARD_DAEMON_TOKEN = config.token
  }
  if (config.logLevel !== undefined && env.WHITEBOARD_LOG_LEVEL === undefined) {
    env.WHITEBOARD_LOG_LEVEL = config.logLevel
  }
  if (config.dataDir !== undefined && env.WHITEBOARD_DATA_DIR === undefined) {
    env.WHITEBOARD_DATA_DIR = config.dataDir
  }
}
