import type { z } from 'zod'

/**
 * The facet engine's definition + registry machinery (ADR-0013 decisions 3,
 * 6, 7). Definitions are authored in code at distribution time; the registry
 * is the single lookup the write path (validation) and the read path
 * (compat resolution) share.
 *
 * Definition objects deliberately carry zod schemas and migration functions,
 * so they are hand-written interfaces rather than `z.infer` types — the
 * payloads they govern stay schema-derived.
 */

const SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/
const VERSION_PATTERN = /^v[0-9]+$/

export type FacetTarget = 'document' | 'canvas' | 'node'

export interface FacetCompatEntry {
  /** The RETAINED schema of that older version — kept so old payloads still parse. */
  readonly schema: z.ZodTypeAny
  /** Pure migration from that version's payload to the NEXT version's shape. */
  readonly migrate: (old: unknown) => unknown
}

export interface FacetDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string
  readonly version: `v${number}`
  readonly targets: readonly FacetTarget[]
  readonly schema: S
  /**
   * Older version tag -> retained schema + stepwise migration (v0→v1→…).
   * The registry composes the chain — hub-and-spoke's linear special case,
   * so no N² converters ever exist.
   */
  readonly compat?: Readonly<Record<string, FacetCompatEntry>>
}

export interface FacetPlugin {
  /** The plugin's id doubles as the facet-key namespace. */
  readonly id: string
  readonly facets: readonly FacetDefinition[]
}

export function defineFacet<S extends z.ZodTypeAny>(
  definition: FacetDefinition<S>,
): FacetDefinition<S> {
  if (!SEGMENT_PATTERN.test(definition.name)) {
    throw new Error(`facet name "${definition.name}" must match ${SEGMENT_PATTERN}`)
  }
  if (!VERSION_PATTERN.test(definition.version)) {
    throw new Error(`facet version "${definition.version}" must match ${VERSION_PATTERN}`)
  }
  if (definition.targets.length === 0) {
    throw new Error(`facet "${definition.name}" declares no targets`)
  }
  for (const tag of Object.keys(definition.compat ?? {})) {
    if (!VERSION_PATTERN.test(tag)) {
      throw new Error(
        `facet "${definition.name}" compat tag "${tag}" must match ${VERSION_PATTERN}`,
      )
    }
  }
  return definition
}

export function definePlugin(plugin: FacetPlugin): FacetPlugin {
  if (!SEGMENT_PATTERN.test(plugin.id)) {
    throw new Error(`plugin id "${plugin.id}" must match ${SEGMENT_PATTERN}`)
  }
  const seen = new Set<string>()
  for (const facet of plugin.facets) {
    if (seen.has(facet.name)) {
      throw new Error(`plugin "${plugin.id}" has a duplicate facet name "${facet.name}"`)
    }
    seen.add(facet.name)
  }
  return plugin
}

export type FacetWriteResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

export type FacetResolution =
  /** Registered and valid (after any compat migration): safe to consume. */
  | { readonly kind: 'resolved'; readonly value: unknown }
  /** Registered but unreadable (schema reject, or no compat path): skip it. */
  | { readonly kind: 'dropped' }
  /** Registered name, NEWER version than this build knows: keep, never render. */
  | { readonly kind: 'preserved'; readonly payload: unknown }
  /** No registration at all: someone else's facet — round-trips untouched. */
  | { readonly kind: 'passthrough'; readonly payload: unknown }

export interface FacetRegistry {
  readonly targetsOf: (key: string) => readonly FacetTarget[] | undefined
  readonly validateFacetWrite: (key: string, payload: unknown) => FacetWriteResult
  readonly resolveFacetPayload: (key: string, payload: unknown) => FacetResolution
}

const versionNumber = (tag: string): number => Number(tag.slice(1))

function parseKey(key: string): { namespace: string; name: string; version: string } | null {
  const match = /^([a-z][a-z0-9-]*)\.([a-z][a-z0-9-]*)\/(v[0-9]+)$/.exec(key)
  if (match === null) return null
  const [, namespace, name, version] = match
  if (namespace === undefined || name === undefined || version === undefined) return null
  return { namespace, name, version }
}

export function createFacetRegistry(plugins: readonly FacetPlugin[]): FacetRegistry {
  const byId = new Map<string, FacetPlugin>()
  for (const plugin of plugins) {
    if (byId.has(plugin.id)) {
      throw new Error(`duplicate plugin id "${plugin.id}"`)
    }
    byId.set(plugin.id, plugin)
  }

  const definitionOf = (namespace: string, name: string): FacetDefinition | undefined =>
    byId.get(namespace)?.facets.find((facet) => facet.name === name)

  const currentKey = (namespace: string, definition: FacetDefinition): string =>
    `${namespace}.${definition.name}/${definition.version}`

  return {
    targetsOf(key) {
      const parsed = parseKey(key)
      if (parsed === null) return undefined
      const definition = definitionOf(parsed.namespace, parsed.name)
      return definition?.targets
    },

    validateFacetWrite(key, payload) {
      const parsed = parseKey(key)
      if (parsed === null) return { ok: false, message: `malformed facet key "${key}"` }
      const definition = definitionOf(parsed.namespace, parsed.name)
      if (definition === undefined) return { ok: true, value: payload }
      if (parsed.version !== definition.version) {
        // Writes always target the current version (ADR-0013 decision 7);
        // old versions exist only as read-side compat.
        return {
          ok: false,
          message: `"${key}" is not the current version — write "${currentKey(parsed.namespace, definition)}"`,
        }
      }
      const result = definition.schema.safeParse(payload)
      if (!result.success) {
        return { ok: false, message: `payload for "${key}" is invalid: ${result.error.message}` }
      }
      return { ok: true, value: result.data }
    },

    resolveFacetPayload(key, payload) {
      const parsed = parseKey(key)
      if (parsed === null) return { kind: 'dropped' }
      const definition = definitionOf(parsed.namespace, parsed.name)
      if (definition === undefined) return { kind: 'passthrough', payload }

      const stored = versionNumber(parsed.version)
      const current = versionNumber(definition.version)
      if (stored > current) return { kind: 'preserved', payload }

      if (stored === current) {
        const result = definition.schema.safeParse(payload)
        return result.success ? { kind: 'resolved', value: result.data } : { kind: 'dropped' }
      }

      // Older version: parse with the retained schema, then walk the chain
      // one version at a time. Any missing entry or failed parse drops the
      // payload — the same drop-not-fail rule every storage read follows.
      const entry = definition.compat?.[parsed.version]
      if (entry === undefined) return { kind: 'dropped' }
      const parsedOld = entry.schema.safeParse(payload)
      if (!parsedOld.success) return { kind: 'dropped' }

      let value: unknown = parsedOld.data
      for (let step = stored; step < current; step += 1) {
        const stepEntry = definition.compat?.[`v${step}`]
        if (stepEntry === undefined) return { kind: 'dropped' }
        value = stepEntry.migrate(value)
      }
      const result = definition.schema.safeParse(value)
      return result.success ? { kind: 'resolved', value: result.data } : { kind: 'dropped' }
    },
  }
}
