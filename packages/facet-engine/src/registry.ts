import type { z } from 'zod'
import { deriveFacetForm, type FacetEditorSpec, type FacetForm, resolveEditorSpec } from './form.js'
import { type StencilAsset, type StencilAssetInput, stencilAssetSchema } from './stencil.js'
import {
  type IconAsset,
  iconAssetSchema,
  type ThemeTokens,
  type ThemeTokensInput,
  themeTokensSchema,
} from './theme-tokens.js'

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

export type FacetTarget = 'document' | 'canvas' | 'node' | 'edge'

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
  /**
   * Fields whose value is the ID of a registered asset (`<plugin>.<name>`),
   * by asset kind. The write path refuses a payload naming an asset no
   * plugin registered, so a document cannot point at a theme that does not
   * exist — while the READ path never checks: a stored id another
   * deployment registered is data, and the renderer degrades on it.
   */
  readonly assetRefs?: Readonly<Record<string, AssetKind>>
}

export type AssetKind = 'themes' | 'icons' | 'stencils'

/**
 * What a plugin registers beside its facets (ADR-0013 decision 3's assets
 * layer): things a document names by id and a renderer resolves in every
 * composition root. Keyed by BARE name; the registry composes
 * `<plugin>.<name>`, the same way silhouettes are namespaced.
 */
export interface FacetPluginAssets {
  readonly themes?: Readonly<Record<string, ThemeTokensInput>>
  readonly icons?: Readonly<Record<string, IconAsset>>
  readonly stencils?: Readonly<Record<string, StencilAssetInput>>
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
  readonly assets?: FacetPluginAssets
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
  // Checked AND normalised: a picker's options come back carrying the value
  // the schema parses them to, so a declaration and a stored payload cannot
  // disagree over a default the schema fills in. See `resolveEditorSpec`.
  const editor =
    definition.editor === undefined
      ? undefined
      : resolveEditorSpec(definition.name, definition.schema, definition.editor)
  if (definition.assetRefs !== undefined) {
    assertAssetRefsFit(definition.name, definition.schema, definition.assetRefs)
  }
  for (const tag of Object.keys(definition.compat ?? {})) {
    if (!VERSION_PATTERN.test(tag)) {
      throw new Error(
        `facet "${definition.name}" compat tag "${tag}" must match ${VERSION_PATTERN}`,
      )
    }
  }
  return editor === undefined ? definition : { ...definition, editor }
}

/**
 * Plugin ids the engine keeps for itself.
 *
 * `workspace` names the synthetic plugin a document-backed stencil library
 * composes into (ADR-0034's amendment), so its stencils read
 * `workspace.<name>`. Refused HERE, at definition, rather than left to
 * collide at registry build: `createFacetRegistry` throws on a duplicate
 * plugin id, so a deployment that took this id would meet a startup crash
 * the first time a workspace grew a library — a long way from the cause, and
 * in front of a user rather than an author.
 */
const RESERVED_PLUGIN_IDS: ReadonlySet<string> = new Set(['workspace'])

export function definePlugin(plugin: FacetPlugin): FacetPlugin {
  if (!SEGMENT_PATTERN.test(plugin.id)) {
    throw new Error(`plugin id "${plugin.id}" must match ${SEGMENT_PATTERN}`)
  }
  if (RESERVED_PLUGIN_IDS.has(plugin.id)) {
    throw new Error(
      `plugin id "${plugin.id}" is reserved by the engine — a workspace's own stencil library registers under it`,
    )
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
  for (const [name, tokens] of Object.entries(plugin.assets?.themes ?? {})) {
    assertAssetName(plugin.id, name)
    const result = themeTokensSchema.safeParse(tokens)
    if (!result.success) {
      throw new Error(
        `plugin "${plugin.id}" theme asset "${name}" is invalid: ${summarizeIssues(result.error)}`,
      )
    }
  }
  for (const [name, icon] of Object.entries(plugin.assets?.icons ?? {})) {
    assertAssetName(plugin.id, name)
    const result = iconAssetSchema.safeParse(icon)
    if (!result.success) {
      throw new Error(
        `plugin "${plugin.id}" icon asset "${name}" is invalid: ${summarizeIssues(result.error)}`,
      )
    }
  }
  // Only the stencil's own SHAPE is checked here. What each of its facet
  // payloads means belongs to the plugin that registered that facet, which
  // may not be this one and is not knowable until every plugin is present —
  // so that half runs in `createFacetRegistry`.
  for (const [name, stencil] of Object.entries(plugin.assets?.stencils ?? {})) {
    assertAssetName(plugin.id, name)
    const result = stencilAssetSchema.safeParse(stencil)
    if (!result.success) {
      throw new Error(
        `plugin "${plugin.id}" stencil asset "${name}" is invalid: ${summarizeIssues(result.error)}`,
      )
    }
  }
  return plugin
}

function assertAssetName(pluginId: string, name: string): void {
  if (!SEGMENT_PATTERN.test(name)) {
    throw new Error(`plugin "${pluginId}" asset name "${name}" must match ${SEGMENT_PATTERN}`)
  }
}

/**
 * Definition-time check for asset refs, the same shape as an editor spec's:
 * a ref naming a field the schema does not declare is a programmer error.
 * Reads the schema's object shape directly rather than the derived form,
 * because a ref field is a plain string the form layer already handles and
 * the check is about NAMES, not controls.
 */
function assertAssetRefsFit(
  facetName: string,
  schema: z.ZodTypeAny,
  assetRefs: Readonly<Record<string, AssetKind>>,
): void {
  const shape = (schema as { shape?: Record<string, unknown> }).shape
  const known = new Set(Object.keys(shape ?? {}))
  for (const field of Object.keys(assetRefs)) {
    if (!known.has(field)) {
      throw new Error(
        `facet "${facetName}" assetRefs names field "${field}", which its schema does not declare`,
      )
    }
  }
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
  /** Registered asset ids of one kind, `<plugin>.<name>`, in registration order. */
  readonly assetIds: (kind: AssetKind) => readonly string[]
  readonly themeAsset: (id: string) => ThemeTokens | undefined
  readonly iconAsset: (id: string) => IconAsset | undefined
  readonly stencilAsset: (id: string) => StencilAsset | undefined
  /**
   * The editor form for a facet — its `editor` spec refined by what its
   * schema derives — or `unsupported` for a key nothing registers.
   *
   * Here rather than at each vessel because a vessel that derives the form
   * itself is a vessel that can derive it DIFFERENTLY, which is the drift
   * a declared editor exists to close: one surface would draw the picker
   * the plugin declared and the next would draw the schema's own fields,
   * from the same registration.
   */
  readonly facetForm: (key: string) => FacetForm
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

const UNSUPPORTED_FORM: FacetForm = { kind: 'unsupported' }

/**
 * A registered thing's own name, humanized from its bare segment when the
 * asset declares none. A stencil carries a `displayName`; a theme and an
 * icon do not, and `pack.public-subnet` reads worse in a picker than
 * "Public subnet" does.
 */
function assetLabel(id: string, declared: string | undefined): string {
  if (declared !== undefined && declared.trim() !== '') return declared
  const bare = id.slice(id.indexOf('.') + 1).replace(/-/g, ' ')
  return bare.charAt(0).toUpperCase() + bare.slice(1)
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

  // Composed once: the registry is immutable data, and every write and
  // every render asks the same question of the same tables.
  const themes = new Map<string, ThemeTokens>()
  const icons = new Map<string, IconAsset>()
  const stencils = new Map<string, StencilAsset>()
  for (const plugin of plugins) {
    for (const [name, tokens] of Object.entries(plugin.assets?.themes ?? {})) {
      // The PARSED tokens, never the plugin's own object: the schema fills
      // `defaults` in, and every reader of `themeAsset` dereferences it.
      themes.set(`${plugin.id}.${name}`, themeTokensSchema.parse(tokens))
    }
    for (const [name, icon] of Object.entries(plugin.assets?.icons ?? {})) {
      icons.set(`${plugin.id}.${name}`, icon)
    }
    for (const [name, stencil] of Object.entries(plugin.assets?.stencils ?? {})) {
      stencils.set(`${plugin.id}.${name}`, stencilAssetSchema.parse(stencil))
    }
  }
  // The half `definePlugin` could not do: a stencil's facet payloads judged
  // by the plugins that own those facets, now that every plugin is present.
  // A stencil is a vocabulary shipped once and applied to many nodes, so an
  // invalid payload here is not one bad write — it is every write that names
  // this stencil, in a deployment, refused one at a time with the author
  // nowhere near. Loud at build is the only place it is cheap.
  for (const [id, stencil] of stencils) {
    for (const [key, payload] of Object.entries(stencil.facets)) {
      const parsed = parseKey(key)
      const definition = parsed === null ? undefined : definitionOf(parsed.namespace, parsed.name)
      if (parsed === null || definition === undefined) {
        throw new Error(`stencil asset "${id}" names facet "${key}", which no plugin registered`)
      }
      if (parsed.version !== definition.version) {
        throw new Error(
          `stencil asset "${id}" names facet "${key}", which is not the current version — use "${currentKey(parsed.namespace, definition)}"`,
        )
      }
      const result = definition.schema.safeParse(payload)
      if (!result.success) {
        throw new Error(
          `stencil asset "${id}" payload for "${key}" is invalid: ${summarizeIssues(result.error)}`,
        )
      }
    }
  }
  const tableOf = (kind: AssetKind): ReadonlyMap<string, unknown> =>
    kind === 'themes' ? themes : kind === 'icons' ? icons : stencils

  /**
   * An asset-ref field's OPTIONS come from THIS registry, replacing whatever
   * the definition declared (ADR-0034 decision 4's UI half).
   *
   * The definition declares the WIDGET; the registry owns the VALUES,
   * because it is the only thing that knows what this deployment has. Before
   * this, `visual.theme` and `visual.stencil` each listed their ids by hand,
   * so a pack could register a stencil that the tool applied and the picker
   * did not offer — registered but unselectable, which is the one state an
   * ecosystem cannot ship.
   *
   * A `null` leads, because an asset ref is optional and "no stencil" is a
   * real answer — without it a picker can dress a box and never undress it.
   * Only fields named in `assetRefs` are touched: a plain enum is the
   * plugin's own vocabulary and none of the registry's business.
   */
  const withAssetOptions = (form: FacetForm, definition: FacetDefinition): FacetForm => {
    const refs = definition.assetRefs
    if (refs === undefined || form.kind !== 'fields') return form
    const fields = form.fields.map((field) => {
      const kind = refs[field.name]
      if (kind === undefined || field.control.kind !== 'segmented') return field
      const options = [
        { value: null, label: 'None' },
        ...[...tableOf(kind).keys()].map((id) => ({
          value: id,
          label: assetLabel(id, kind === 'stencils' ? stencils.get(id)?.displayName : undefined),
        })),
      ]
      return { ...field, control: { ...field.control, options } }
    })
    return { ...form, fields }
  }

  /**
   * After the schema has accepted the payload: every ref field that carries
   * a value must name a registered asset. The message lists what IS
   * registered, because "unknown theme" alone sends an author to the docs
   * for a list this registry already holds.
   */
  const unregisteredRef = (
    definition: FacetDefinition,
    value: unknown,
  ): { field: string; id: string; kind: AssetKind } | undefined => {
    if (definition.assetRefs === undefined || typeof value !== 'object' || value === null) {
      return undefined
    }
    for (const [field, kind] of Object.entries(definition.assetRefs)) {
      const id = (value as Record<string, unknown>)[field]
      if (typeof id === 'string' && !tableOf(kind).has(id)) return { field, id, kind }
    }
    return undefined
  }

  return {
    plugins,
    assetIds: (kind) => [...tableOf(kind).keys()],
    facetForm(key) {
      const parsed = parseKey(key)
      if (parsed === null) return UNSUPPORTED_FORM
      const definition = definitionOf(parsed.namespace, parsed.name)
      if (definition === undefined) return UNSUPPORTED_FORM
      // The SAME version rule `validateFacetWrite` applies, for the same
      // reason. Writes always target the current version (ADR-0013
      // decision 7); an older key exists only as read-side compat. Deriving
      // the current schema's form for one would draw a working-looking
      // control whose every write is refused — the "a choice that silently
      // does nothing" shape a declared picker exists to make impossible.
      if (parsed.version !== definition.version) return UNSUPPORTED_FORM
      return withAssetOptions(deriveFacetForm(definition.schema, definition.editor), definition)
    },
    themeAsset: (id) => themes.get(id),
    iconAsset: (id) => icons.get(id),
    stencilAsset: (id) => stencils.get(id),
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
      const missing = unregisteredRef(definition, result.data)
      if (missing !== undefined) {
        const registered = [...tableOf(missing.kind).keys()]
        return {
          ok: false,
          message: `"${key}" field ${missing.field} names ${missing.kind} asset "${missing.id}", which no plugin registered — registered: ${registered.length === 0 ? '(none)' : registered.join(', ')}`,
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
