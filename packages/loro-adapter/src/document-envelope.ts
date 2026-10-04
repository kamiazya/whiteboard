// The document's ENVELOPE: what it is above any one format's structure, and
// the OKF facets it carries. Each family is its own per-key `LoroMap`, so two
// peers writing different keys converge on both surviving a merge.
import {
  type DocumentKind,
  documentKindSchema,
  type ExtensionFacets,
  type StoredCoreFacets,
  storedCoreFacetsSchema,
  type TrustFacets,
  trustFacetsSchema,
} from '@kamiazya/whiteboard-model'
import type { z } from 'zod'
import {
  CORE_KEY,
  DOCUMENT_KEY,
  type DocumentContainers,
  FACETS_KEY,
  type Fields,
  TRUST_KEY,
} from './containers.js'
import { isReadableFacetKey } from './document-envelope-reconcile.js'

/**
 * Replace a whole bucket map: write every incoming key and delete the keys
 * the caller omitted, so a rewrite never merges with stale prior state.
 * Entries stay per-key rather than one opaque object value, so two peers
 * writing different keys converge on both surviving after a CRDT merge.
 *
 * It deletes every stored key the caller did not name, including one this
 * build's reader cannot see. That is right only for a caller that states the
 * whole document (`wb_workspace_edit`'s `document.set`); an edit that started
 * from a read applies itself with the reconcile forms beside this file.
 */
function replaceBucket(doc: DocumentContainers, mapKey: string, entries: Fields): void {
  const map = doc.getMap(mapKey)
  const existingKeys = map.keys()

  for (const [key, value] of Object.entries(entries)) {
    map.set(key, value)
  }
  for (const key of existingKeys) {
    if (!Object.hasOwn(entries, key)) map.delete(key)
  }

  doc.commit()
}

/**
 * Extension facets (the `{namespace}.{name}/v{n}` keyed bucket from
 * model's `extensionFacetsSchema`) are stored the same way as
 * nodes/edges above: a plain-object-valued `LoroMap` keyed by facet key, so
 * one domain's CRDT merge never overwrites another's.
 */
export function writeFacets(doc: DocumentContainers, facets: ExtensionFacets): void {
  replaceBucket(doc, FACETS_KEY, facets)
}

/**
 * A per-key parse (rather than one whole-record parse) means a single
 * corrupt entry in the underlying LoroMap is dropped instead of failing the
 * entire read — consistent with readSpatialCanvas's per-node tolerance.
 */
export function readFacets(doc: DocumentContainers): ExtensionFacets {
  const facetsMap = doc.getMap(FACETS_KEY)
  const result: ExtensionFacets = {}
  for (const key of facetsMap.keys()) {
    if (isReadableFacetKey(key)) result[key] = facetsMap.get(key)
  }
  return result
}

/**
 * Prototype-less on purpose. The keys looked up here come from a LoroMap,
 * whose keys are CRDT strings arriving over sync or import — so `__proto__`
 * is a possible key, and on a plain object it would resolve up the chain to
 * `Object.prototype`: truthy, past any `if (!schema)` guard, and without a
 * `safeParse` to call. A null prototype makes every miss a real miss.
 */
const CORE_FACET_FIELD_SCHEMAS: Record<string, z.ZodTypeAny> = Object.assign(
  Object.create(null),
  storedCoreFacetsSchema.shape,
)

/**
 * Core OKF facets (`type`/`title`/`tags`/`view`/`facetsRaw`) are stored the
 * same way as extension facets above: one `LoroMap` keyed per field, not one
 * opaque object value, so two peers writing different core fields converge
 * on both surviving after a merge. `type` is the only required field; a
 * write always replaces the whole document meta (deletes fields the caller
 * omitted) rather than merging with stale prior state, matching
 * `writeFacets`'s replace-on-rewrite convention.
 */
export function writeCoreFacets(doc: DocumentContainers, meta: StoredCoreFacets): void {
  replaceBucket(doc, CORE_KEY, { ...meta })
}

/** Prototype-less for the same reason `CORE_FACET_FIELD_SCHEMAS` is. */
const TRUST_FACET_FIELD_SCHEMAS: Record<string, z.ZodTypeAny> = Object.assign(
  Object.create(null),
  trustFacetsSchema.shape,
)

/**
 * The OKF v0.2 trust family (§5.2), stored per-key like every other bucket
 * here so two peers writing `generated` and `verified` converge on both.
 * Replace-on-rewrite, matching `writeCoreFacets`/`writeFacets`: a write
 * states the whole family rather than merging with whatever was there.
 */
export function writeTrustFacets(doc: DocumentContainers, trust: TrustFacets): void {
  const entries: Fields = {}
  if (trust.generated !== undefined) entries.generated = { ...trust.generated }
  if (trust.verified !== undefined) entries.verified = trust.verified.map((event) => ({ ...event }))
  replaceBucket(doc, TRUST_KEY, entries)
}

/**
 * A SPATIAL document answers `undefined` whatever its `trust` map holds, for
 * the same reason `readCoreFacets` does: the trust family are OKF root
 * frontmatter keys, and a JSON Canvas document has no frontmatter to project
 * them into (ADR-0016 decision 5).
 *
 * A corrupt field is dropped rather than failing the whole read, matching
 * `readCoreFacets`. Unlike it, there is no required field here — a document
 * with a `verified` list and no `generated` is a perfectly good OKF concept —
 * so an all-dropped read answers `undefined` rather than an empty object.
 */
export function readTrustFacets(doc: DocumentContainers): TrustFacets | undefined {
  if (readDocumentKind(doc) === 'spatial') return undefined

  const trustMap = doc.getMap(TRUST_KEY)
  if (trustMap.keys().length === 0) return undefined

  const candidate: Record<string, unknown> = {}
  for (const key of trustMap.keys()) {
    const fieldSchema = TRUST_FACET_FIELD_SCHEMAS[key]
    if (!fieldSchema) continue
    const parsed = fieldSchema.safeParse(trustMap.get(key))
    if (parsed.success) candidate[key] = parsed.data
  }
  if (Object.keys(candidate).length === 0) return undefined
  return trustFacetsSchema.parse(candidate)
}

/**
 * An empty `core` map (never written, or every field deleted) means no
 * core meta is stored — `undefined`, distinct from an all-optional-fields
 * empty object which is unrepresentable anyway (`type` is required). A
 * single corrupt field is dropped rather than failing the whole read, but
 * a missing/invalid `type` after that per-field filter makes the whole
 * result unrepresentable, since `type` is the one field every consumer
 * (`canvas_export_okf`'s placeholder fallback) depends on being present.
 *
 * A SPATIAL document answers `undefined` whatever its `core` map holds. A
 * facet is OKF frontmatter and a JSON Canvas document has none to put one in
 * (ADR-0009 decision 3), so a spatial document carrying facets is one written
 * before that stopped being true — and every reader that surfaces them
 * (a facet card beside a diagram, an OKF export's frontmatter) is showing
 * metadata the format cannot represent. Enforced on the READ because it is
 * total: it needs no migration, and no writer can reintroduce the state
 * behind it — `wb_facet_set` and `wb_workspace_edit`'s `document.set` both
 * refuse a spatial document, and after this there is no other writer.
 *
 * A document with no kind is allowed through, exactly as those tools allow
 * one: an absent kind is not evidence of a format.
 */
export function readCoreFacets(doc: DocumentContainers): StoredCoreFacets | undefined {
  if (readDocumentKind(doc) === 'spatial') return undefined

  const coreMap = doc.getMap(CORE_KEY)
  if (coreMap.keys().length === 0) return undefined

  const candidate: Record<string, unknown> = {}
  for (const key of coreMap.keys()) {
    const fieldSchema = CORE_FACET_FIELD_SCHEMAS[key]
    if (!fieldSchema) continue
    const parsed = fieldSchema.safeParse(coreMap.get(key))
    if (parsed.success) candidate[key] = parsed.data
  }

  const result = storedCoreFacetsSchema.safeParse(candidate)
  return result.success ? result.data : undefined
}

/**
 * The kind a document was created as. `wb_document_get` serialises through
 * it — a spatial document as JSON Canvas, a markdown one as OKF — so this
 * is what makes a format follow from the document rather than from a
 * caller-supplied parameter (ADR-0009 decision 4).
 */
export function writeDocumentKind(doc: DocumentContainers, kind: DocumentKind): void {
  doc.getMap(DOCUMENT_KEY).set('kind', kind)
  doc.commit()
}

/**
 * `undefined` for a document written before kinds existed, and for a kind
 * this build does not recognise — a peer on a newer version can write one
 * into the same CRDT map. Both cases are for the caller to report; failing
 * here would replace its message with a parse error from three layers down.
 */
export function readDocumentKind(doc: DocumentContainers): DocumentKind | undefined {
  const parsed = documentKindSchema.safeParse(doc.getMap(DOCUMENT_KEY).get('kind'))
  return parsed.success ? parsed.data : undefined
}
