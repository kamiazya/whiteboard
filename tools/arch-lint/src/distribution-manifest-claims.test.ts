/**
 * What the distribution manifests promise must be something the product does.
 *
 * `server.json` is the MCP registry listing, `.codex-plugin/plugin.json` and
 * `gemini-extension.json` are the first thing a Codex or Gemini user reads
 * and what they offer as starter prompts. Those are prose nothing else
 * reads, and they went stale in one direction: they kept advertising what
 * the product no longer (or never) did. Two claims in particular:
 *
 * - **A PNG export.** No tool returns PNG; the only rendered export an agent
 *   can ask for is SVG (`docs/reference/export-formats.md`), so a starter
 *   prompt asking for PNG cannot be fulfilled.
 * - **A page the daemon serves.** The daemon listens on an owner-only
 *   socket and serves no page of its own (ADR-0050 decision 3); the hosted
 *   app reaches it through the browser extension. A listing that says a
 *   canvas is "served by a local daemon on 127.0.0.1" describes a surface
 *   that is gone.
 *
 * `codex-plugin-spec.test.ts` holds the SHAPE of the Codex manifest and
 * deliberately asserts `expect.any(String)` for the text, so this holds the
 * words. `server.json`'s shape is held here too, against the registry's own
 * schema.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registeredTools } from './registered-tools.js'
import { REPO_ROOT } from './scan-roots.js'

const MANIFESTS = ['.codex-plugin/plugin.json', 'gemini-extension.json', 'server.json'] as const

const RETIRED_CLAIMS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /PNG/, why: 'no tool returns PNG; SVG is the only rendered export' },
  { pattern: /127\.0\.0\.1/, why: 'the daemon listens on an owner-only socket, not a port' },
  { pattern: /served by a local daemon/i, why: 'the daemon serves no page of its own' },
  { pattern: /in your browser/i, why: 'the hosted app reaches the daemon through the extension' },
  { pattern: /patch nodes/i, why: 'no patch tool exists; edits are one wb_canvas_edit batch' },
  { pattern: /create canvases/i, why: 'a workspace holds documents; a canvas is the surface' },
]

/** Every string a JSON document holds, with where it sits. */
function stringsOf(value: unknown, path = ''): { path: string; text: string }[] {
  if (typeof value === 'string') return [{ path, text: value }]
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, held]) => stringsOf(held, `${path}/${key}`))
}

const REGISTRY_DESCRIPTION_MAX = 100

type Schema = { readonly [keyword: string]: unknown }

/**
 * The MCP registry's `server.json` schema (JSON Schema draft-07), vendored
 * verbatim from https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
 * (retrieved 2026-10-03). The registry publishes one URL per dated version,
 * so a newer version is a new fixture and a new `$schema` pin together.
 */
const REGISTRY_SCHEMA = JSON.parse(
  readFileSync(join(import.meta.dirname, '__fixtures__/mcp-registry-server.schema.json'), 'utf-8'),
) as Schema

/**
 * A draft-07 validator for exactly the keywords the registry schema uses,
 * because the repo declares no JSON Schema library and a dependency for one
 * file is more than the check is worth. A keyword it does not implement
 * throws, so a newer schema cannot be validated by silently skipping part of
 * it. NOT checked: `format` (the uri and email formats are annotations here),
 * and the registry's server-side rules that live outside this file, such as
 * proving the `name` namespace is owned by the publisher.
 */
type Check = (arg: unknown, value: unknown, path: string, schema: Schema, root: Schema) => string[]

const ANNOTATIONS = new Set([
  '$comment',
  '$id',
  '$schema',
  'title',
  'description',
  'example',
  'examples',
  'default',
  'format',
  'definitions',
])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}

function resolveRef(ref: string, root: Schema): Schema {
  const target = ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>((held, key) => (isObject(held) ? held[key] : undefined), root)
  if (!isObject(target)) throw new Error(`unresolvable $ref ${ref}`)
  return target
}

const KEYWORD_CHECKS: Record<string, Check> = {
  type: (arg, value, path) =>
    jsonTypeOf(value) === arg ? [] : [`${path}: expected ${String(arg)}, got ${jsonTypeOf(value)}`],
  enum: (arg, value, path) =>
    (arg as unknown[]).includes(value) ? [] : [`${path}: not one of ${JSON.stringify(arg)}`],
  const: (arg, value, path) => (value === arg ? [] : [`${path}: must be ${JSON.stringify(arg)}`]),
  pattern: (arg, value, path) =>
    typeof value !== 'string' || new RegExp(String(arg)).test(value)
      ? []
      : [`${path}: does not match ${String(arg)}`],
  minLength: (arg, value, path) =>
    typeof value !== 'string' || value.length >= Number(arg)
      ? []
      : [`${path}: shorter than ${String(arg)}`],
  maxLength: (arg, value, path) =>
    typeof value !== 'string' || value.length <= Number(arg)
      ? []
      : [`${path}: ${value.length} characters, longer than ${String(arg)}`],
  required: (arg, value, path) =>
    isObject(value)
      ? (arg as string[]).filter((key) => !(key in value)).map((key) => `${path}: missing ${key}`)
      : [],
  properties: (arg, value, path, _schema, root) =>
    isObject(value)
      ? Object.entries(arg as Record<string, Schema>).flatMap(([key, sub]) =>
          key in value ? validateAt(sub, value[key], `${path}/${key}`, root) : [],
        )
      : [],
  additionalProperties: (arg, value, path, schema, root) => {
    if (!isObject(value) || arg === true) return []
    const declared = Object.keys((schema.properties as Record<string, unknown> | undefined) ?? {})
    return Object.keys(value)
      .filter((key) => !declared.includes(key))
      .flatMap((key) =>
        arg === false
          ? [`${path}/${key}: not allowed`]
          : validateAt(arg as Schema, value[key], `${path}/${key}`, root),
      )
  },
  items: (arg, value, path, _schema, root) =>
    Array.isArray(value)
      ? value.flatMap((item, index) => validateAt(arg as Schema, item, `${path}/${index}`, root))
      : [],
  allOf: (arg, value, path, _schema, root) =>
    (arg as Schema[]).flatMap((sub) => validateAt(sub, value, path, root)),
  anyOf: (arg, value, path, _schema, root) =>
    (arg as Schema[]).some((sub) => validateAt(sub, value, path, root).length === 0)
      ? []
      : [`${path}: matches none of the anyOf branches`],
  not: (arg, value, path, _schema, root) =>
    validateAt(arg as Schema, value, path, root).length === 0
      ? [`${path}: matches a schema it must not`]
      : [],
}

function validateAt(schema: Schema, value: unknown, path: string, root: Schema): string[] {
  // draft-07: a `$ref` replaces its siblings.
  if (typeof schema.$ref === 'string')
    return validateAt(resolveRef(schema.$ref, root), value, path, root)
  return Object.entries(schema).flatMap(([keyword, arg]) => {
    if (ANNOTATIONS.has(keyword)) return []
    const check = KEYWORD_CHECKS[keyword]
    if (!check) throw new Error(`unsupported keyword ${keyword} at ${path || '/'}`)
    return check(arg, value, path, schema, root)
  })
}

const validateAgainst = (schema: Schema, value: unknown): string[] =>
  validateAt(schema, value, '', schema)

const readManifest = (file: (typeof MANIFESTS)[number]): unknown =>
  JSON.parse(readFileSync(join(REPO_ROOT, file), 'utf-8'))

const manifests = MANIFESTS.map((file) => ({
  file,
  strings: stringsOf(readManifest(file)),
}))

/** Tool-shaped names a prompt mentions that no server registers. */
function unregisteredToolsIn(prompt: string, registered: readonly string[]): string[] {
  const mentioned = prompt.match(/\b(?:wb_[a-z_]+|canvas_view)\b/g) ?? []
  return mentioned.filter((name) => !registered.includes(name))
}

describe('distribution manifests advertise only what the product does', () => {
  it('reads real text from all three manifests', () => {
    for (const { file, strings } of manifests) {
      expect(
        strings.some(({ text }) => text.length > 40),
        file,
      ).toBe(true)
    }
  })

  it.each(RETIRED_CLAIMS)('claims nothing matching $pattern ($why)', ({ pattern }) => {
    const offending = manifests.flatMap(({ file, strings }) =>
      strings.filter(({ text }) => pattern.test(text)).map(({ path }) => `${file}${path}`),
    )
    expect(offending).toEqual([])
  })

  it('only names, in a starter prompt, a tool the server registers', () => {
    const registered = registeredTools()
    expect(registered.length).toBeGreaterThan(10)
    const prompts = manifests
      .flatMap(({ strings }) => strings)
      .filter(({ path }) => path.startsWith('/interface/defaultPrompt'))
    expect(prompts.length).toBeGreaterThan(1)
    expect(prompts.flatMap(({ text }) => unregisteredToolsIn(text, registered))).toEqual([])
  })

  // The registry listing is read by people choosing whether to install, and
  // it is the one place a stale tool list is read as a promise.
  it('names, in every manifest, only tools the server registers', () => {
    const registered = registeredTools()
    const named = manifests.flatMap(({ file, strings }) =>
      strings.flatMap(({ text }) =>
        unregisteredToolsIn(text, registered).map((name) => `${file}: ${name}`),
      ),
    )
    expect(named).toEqual([])
  })

  // The registry caps `description` at 100 characters, so the listing cannot
  // carry a tool list; the tool names belong in the README and the package
  // description, which have no such cap. The schema is what the registry
  // enforces at publish time, so it is the contract, not a length picked here.
  it('lists a server.json the registry schema accepts', () => {
    expect(validateAgainst(REGISTRY_SCHEMA, readManifest('server.json'))).toEqual([])
  })

  it('pins $schema to the registry schema version this repo validates against', () => {
    expect(readManifest('server.json')).toMatchObject({ $schema: REGISTRY_SCHEMA.$id })
  })

  it('keeps the registry description within the registry cap and not empty', () => {
    const { description } = readManifest('server.json') as { description: string }
    expect(description.length).toBeLessThanOrEqual(REGISTRY_DESCRIPTION_MAX)
    expect(description.length).toBeGreaterThan(0)
  })

  it('rejects what the schema rejects, so a clean answer is not a blind one', () => {
    const listing = {
      name: 'io.github.example/server',
      description: 'An example server.',
      version: '1.0.0',
      packages: [{ registryType: 'npm', identifier: 'example', transport: { type: 'stdio' } }],
    }
    expect(validateAgainst(REGISTRY_SCHEMA, listing)).toEqual([])
    const refused = (change: Record<string, unknown>) =>
      validateAgainst(REGISTRY_SCHEMA, { ...listing, ...change }).length
    expect(refused({ description: 'x'.repeat(REGISTRY_DESCRIPTION_MAX + 1) })).toBeGreaterThan(0)
    expect(refused({ description: 'x'.repeat(REGISTRY_DESCRIPTION_MAX) })).toBe(0)
    expect(refused({ name: 'no-slash' })).toBeGreaterThan(0)
    expect(refused({ version: undefined, packages: [{ registryType: 'npm' }] })).toBeGreaterThan(0)
    expect(() => validateAgainst({ oneOf: [] }, {})).toThrow(/unsupported keyword/)
  })

  // The registry refuses a package whose manifest does not name the listing
  // that claims it, so the two names are one fact written twice.
  it('claims the registry name server.json lists under, as the package says it', () => {
    const listing = JSON.parse(readFileSync(join(REPO_ROOT, 'server.json'), 'utf-8')) as {
      name: string
    }
    const published = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/mcp-server/package.json'), 'utf-8'),
    ) as { mcpName?: string }
    expect(published.mcpName).toBe(listing.name)
  })

  it('recognises a tool name that is not registered, so a clean answer is not a blind one', () => {
    expect(unregisteredToolsIn('Call wb_export_png on it', ['wb_scene_render'])).toEqual([
      'wb_export_png',
    ])
    expect(unregisteredToolsIn('Call wb_scene_render', ['wb_scene_render'])).toEqual([])
  })
})
