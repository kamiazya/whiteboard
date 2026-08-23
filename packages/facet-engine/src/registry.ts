import type { z } from 'zod'
import { assertEditorSpecFits, type FacetEditorSpec } from './form.js'

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
  /**
   * The facet's human-facing name, on the same footing as a plugin's.
   * `name` stays machine-only (key grammar, storage, ordering).
   *
   * Without it every reader has to invent a title, and the one that
   * existed concatenated the plugin's name with this identifier —
   * "Visual style shape" under a heading already reading "Visual style".
   */
  readonly displayName: string
  readonly version: `v${number}`
  readonly targets: readonly FacetTarget[]
  readonly schema: S
  /**
   * Older version tag -> retained schema + stepwise migration (v0→v1→…).
   * The registry composes the chain — hub-and-spoke's linear special case,
   * so no N² converters ever exist.
   */
  readonly compat?: Readonly<Record<string, FacetCompatEntry>>
  /**
   * Tier 2 of the editor ladder: how this facet's fields should be
   * presented, declared from a closed widget/glyph vocabulary rather than
   * shipped as UI code. Absent, every field falls back to the control
   * `deriveFacetForm` reads off the schema. Checked at definition time
   * against the schema, so a spec cannot name a field that does not exist.
   */
  readonly editor?: FacetEditorSpec
}

export interface FacetPlugin {
  /** The plugin's id doubles as the facet-key namespace. */
  readonly id: string
  /**
   * The plugin's human-facing name — what UI containers (namespace
   * sections, submenus, tabs) show. The id stays machine-only: key
   * grammar, storage, and deterministic ordering.
   */
  readonly displayName: string
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
  if (definition.displayName.trim() === '') {
    throw new Error(`facet "${definition.name}" needs a non-blank displayName`)
  }
  if (definition.targets.length === 0) {
    throw new Error(`facet "${definition.name}" declares no targets`)
  }
  if (definition.editor !== undefined) {
    assertEditorSpecFits(definition.name, definition.schema, definition.editor)
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
  if (plugin.displayName.trim() === '') {
    throw new Error(`plugin "${plugin.id}" needs a non-blank displayName`)
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
  /** The source plugin list, in registration order (contributions sort by id). */
  readonly plugins: readonly FacetPlugin[]
  readonly targetsOf: (key: string) => readonly FacetTarget[] | undefined
  readonly validateFacetWrite: (key: string, payload: unknown) => FacetWriteResult
  readonly resolveFacetPayload: (key: string, payload: unknown) => FacetResolution
}

/**
 * A rejection an author can act on, rather than a dump of zod's internal
 * issue tree. A union schema's raw `error.message` is nested JSON several
 * levels deep — the valid values ARE in there, buried; this flattens every
 * issue (including a union's per-arm ones) to `field: what was expected`,
 * deduped, on one line.
 */
function summarizeIssues(error: z.ZodError): string {
  const seen = new Set<string>()
  const collect = (issues: readonly z.core.$ZodIssue[]): void => {
    for (const issue of issues) {
      if (issue.code === 'invalid_union') {
        for (const arm of issue.errors) collect(arm)
        continue
      }
      const path = issue.path.length === 0 ? 'payload' : issue.path.join('.')
      seen.add(`${path}: ${issue.message}`)
    }
  }
  collect(error.issues)
  return [...seen].join('; ')
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
    plugins,
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
        return {
          ok: false,
          message: `payload for "${key}" is invalid: ${summarizeIssues(result.error)}`,
        }
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
