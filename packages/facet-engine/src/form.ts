/**
 * Tier 1 of the editor ladder: an editor DERIVED from the schema a facet
 * already declares, so a facet with no hand-written widget is still
 * visible and editable rather than invisible to everyone but an agent.
 *
 * The output is DATA in a closed control vocabulary — each surface renders
 * it with its own vessel, exactly as `contributions.ts` splits resolution
 * from rendering. The vocabulary is deliberately small: a schema it cannot
 * express answers `unsupported`, which is the honest signal that this facet
 * wants a real widget (tier 2) rather than half a payload in a form.
 */

import { z } from 'zod'

/**
 * The SHAPE glyphs a spec may name — closed, and owned by the core the way
 * contribution points are.
 */
export const FACET_GLYPH_SHAPES = [
  'square',
  'circle',
  'diamond',
  'hexagon',
  'parallelogram',
  'cylinder',
  'none',
] as const
export type FacetGlyphShape = (typeof FACET_GLYPH_SHAPES)[number]

/**
 * What an option may be DRAWN as. Closed in FORM — a plugin cannot add an
 * arm — while open in CONTENT, which is the
 * distinction that matters: a plugin still cannot ship an image or a
 * component (the catalog-as-sandbox principle of ADR-0013), but it is no
 * longer limited to seven silhouettes the core happened to enumerate.
 *
 * The shape list alone was the bottleneck that broke the ladder. It could
 * not name a database icon or a pin, so `visual.symbol` — twelve choices,
 * six of them this plugin's own vendored geometry — had nowhere to go but
 * a hand-written component, and a hand-written component has no styling
 * contract. Four different-looking pickers in one panel followed from
 * that, so the vocabulary is widened rather than the escape hatch used.
 *
 * `asset` names a registered icon (`assets.icons`, ADR-0013 decision 3),
 * so the geometry travels as DATA through the registry both realms already
 * share — the same road a theme takes. `char` is one character or emoji,
 * which needs no registration because there is nothing to resolve.
 *
 * `theme` is the pair: registered geometry DRAWN THE WAY a registered theme
 * draws — its `ink` and its `glow`, nothing else. An option choosing a look
 * has to show the look, and neither of the other arms can: `asset` draws
 * one flat stroke in `currentColor`, so two themes would be one picture
 * twice. A picker that names a theme this way gains its swatch from the
 * asset's own tokens, so registering a theme still needs no UI edit
 * anywhere.
 *
 * Why the two ids rather than a theme id alone: the SPECIMEN is a choice
 * (this product draws its own signature mark), and a core arm that picked
 * one would put a drawing in the engine. The theme says how to ink; the
 * plugin says what to ink.
 */
export type FacetGlyph =
  | { readonly kind: 'shape'; readonly name: FacetGlyphShape }
  | { readonly kind: 'char'; readonly value: string }
  | { readonly kind: 'asset'; readonly id: string }
  | { readonly kind: 'theme'; readonly id: string; readonly icon: string }

/**
 * One choice in a facet-level picker: the WHOLE payload it writes, and how
 * to meet it.
 *
 * `payload: null` says the facet should not exist. It is the only way a
 * picker says that, which is the point — the derived form used to offer a
 * `Clear` button beside a segment that already meant the same thing, so
 * "no theme" had two controls and a reader had to guess whether they
 * differed.
 */
export interface FacetPickerOption {
  readonly payload: unknown | null
  readonly label: string
  readonly glyph?: FacetGlyph
  /**
   * Extra words this option is findable by, beside its label. Only a
   * searchable catalog reads them: an inline row draws every option it
   * has, so there is nothing there to find.
   *
   * It exists because the authoritative name of a thing is often not the
   * word somebody types for it — Unicode calls a rocket "rocket" and files
   * it under `travel-air`, and a person looking for one may well type
   * "launch" or "space".
   */
  readonly keywords?: readonly string[]
}

/**
 * One band of a catalog: a heading, the options under it, and how the band
 * is pictured in the chooser that switches between them.
 *
 * The glyph is declared rather than taken from the band's first option,
 * which is what it was and what looked wrong: nine categories pictured by
 * nine unrelated samples of their own contents sit at nine weights, some
 * colour and some not, and read as a spilled palette rather than as a
 * control. What browses is chrome and what is browsed is content; a plugin
 * that means them to differ has to be able to say so.
 */
export interface FacetPickerCatalogSection {
  readonly label: string
  readonly options: readonly FacetPickerOption[]
  readonly glyph?: FacetGlyph
}

/**
 * Free entry, declared as DATA rather than as a parser: `payload` is the
 * template every typed value is folded into, and `field` is where the text
 * goes. `{ payload: { kind: 'emoji' }, field: 'char' }` says "whatever you
 * type is the char of an emoji payload" without the plugin shipping a
 * function to say it, and without the engine learning what an emoji is.
 *
 * What the value may BE stays the schema's answer, at the write boundary
 * every other control already goes through. That is the whole reason free
 * entry can be offered at all: `visual.symbol` refuses a string of two
 * graphemes, so the control cannot write one, and nothing here has to
 * know that rule in order to be safe.
 */
export interface FacetPickerEntrySpec {
  readonly label: string
  readonly placeholder?: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly field: string
}

/**
 * More choices than a definition can carry: a LOADER, called when a picker
 * is actually opened.
 *
 * Deferred because a facet definition is loaded wherever a document is
 * read — the renderer, the layout worker, the MCP server — and none of
 * those opens a picker. `visual.symbol`'s catalog is 1900-odd rows; listed
 * in the definition they would ride into every one of those graphs to be
 * used by none of them. Returning a promise is what lets the plugin reach
 * for a dynamic import, which is the only thing a bundler treats as a
 * separate chunk.
 *
 * The cost of deferring is that these options are NOT parsed at definition
 * time, the way listed ones are. The write path still refuses a bad one,
 * so nothing invalid is stored; what is lost is the plugin failing to
 * start. A plugin shipping a catalog owes its own test that every row
 * parses — `plugin-visual` has one — because the rows are its data.
 */
export interface FacetPickerCatalogSpec {
  /** Names the search box, for a reader with no heading in view. */
  readonly label: string
  readonly load: () => Promise<readonly FacetPickerCatalogSection[]>
  readonly entry?: FacetPickerEntrySpec
}

/**
 * How a row is DRAWN. `chips` is a picture alone in an inline pill, for a
 * palette where the count makes labels impossible and the glyph is the whole
 * affordance; `cards` is the picture over its word in a bordered cell, for a
 * short vocabulary whose names carry meaning a picture cannot fully take on.
 *
 * Declared rather than derived from the option COUNT, because the count does
 * not know it: six silhouettes would fit as cards and are still better as
 * chips, since "Hexagon" tells a reader nothing the hexagon has not said.
 * The vessel owns what each layout LOOKS like; the plugin says which
 * question it is asking. Same bargain as everything else here.
 */
export type FacetOptionLayout = 'chips' | 'cards'

export interface FacetPickerSpec {
  readonly options: readonly FacetPickerOption[]
  /** Defaults to `chips`. Governs the LISTED options; a catalog is a grid. */
  readonly layout?: FacetOptionLayout
  readonly catalog?: FacetPickerCatalogSpec
}

/**
 * A payload's identity, independent of the order its keys were written in.
 *
 * `JSON.stringify` preserves insertion order, so `{kind, name}` and
 * `{name, kind}` — the same facet value by every rule this engine has —
 * serialize differently. Two places compared payloads that way and each had
 * a defect: the duplicate check below would admit two options writing the
 * same thing, and the UI's "which option is current" comparison would find
 * NO match for a stored value whose keys arrived in another order, drawing
 * a picker with nothing selected.
 *
 * The second is the one that reaches a person, and it is reachable: a facet
 * written by `wb_facet_set` or imported from a document authored elsewhere
 * has whatever order its writer used. Exported so a vessel keys on the same
 * function this engine validates with, rather than on a second definition
 * of "the same payload".
 */
export function facetPayloadKey(payload: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (typeof value !== 'object' || value === null) return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, member]) => [key, canonical(member)]),
    )
  }
  return JSON.stringify(canonical(payload ?? null))
}

export interface FacetSegmentedOption {
  /**
   * The value this segment writes. `null` CLEARS the facet — some defaults
   * are the absence of a value (a rect node stores no shape facet), and a
   * picker with no way to say that cannot express them.
   */
  readonly value: string | null
  readonly label: string
  readonly glyph?: FacetGlyph
}

export type FacetFormControl =
  | { readonly kind: 'text' }
  | { readonly kind: 'number' }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'choice'; readonly options: readonly string[] }
  | {
      readonly kind: 'segmented'
      readonly options: readonly FacetSegmentedOption[]
      readonly layout: FacetOptionLayout
    }

export interface FacetFormField {
  readonly name: string
  /** Human-facing: the spec's label, else the field name. */
  readonly label: string
  readonly control: FacetFormControl
  readonly required: boolean
  /**
   * Whether this field belongs in a one-tap quick band (a context-menu
   * row) as well as the full editor. Only a spec can say so — a derived
   * field defaults to false, because a surface with room for one row
   * should not guess which of five fields deserves it.
   */
  readonly quick: boolean
}

/** What a plugin may declare about ONE field. Widget names are closed. */
export interface FacetFieldSpec {
  readonly widget: 'text' | 'number' | 'toggle' | 'choice' | 'segmented'
  readonly label?: string
  readonly quick?: boolean
  /** Required by `segmented`; ignored by the other widgets. */
  readonly options?: readonly FacetSegmentedOption[]
  /** `segmented` only. Defaults to `chips`. */
  readonly layout?: FacetOptionLayout
}

/**
 * How a plugin says this facet is met. Exactly one of the two: a `picker`
 * is one control writing whole payloads, `fields` is a form over the
 * schema's own fields. Declaring both would be two answers to one
 * question, and `assertEditorSpecFits` refuses it.
 */
export interface FacetEditorSpec {
  readonly picker?: FacetPickerSpec
  readonly fields?: Readonly<Record<string, FacetFieldSpec>>
}

export interface FacetFormVariant {
  /** The discriminant value this arm is selected by, and its heading. */
  readonly label: string
  readonly fields: readonly FacetFormField[]
}

export type FacetForm =
  | {
      readonly kind: 'picker'
      readonly options: readonly FacetPickerOption[]
      readonly layout: FacetOptionLayout
      readonly catalog?: FacetPickerCatalogSpec
    }
  | { readonly kind: 'fields'; readonly fields: readonly FacetFormField[] }
  | {
      readonly kind: 'variants'
      /** The schema field that selects the arm — a storage key. */
      readonly discriminant: string
      /** What to CALL it on screen, humanized like any other field label. */
      readonly discriminantLabel: string
      readonly variants: readonly FacetFormVariant[]
    }
  | { readonly kind: 'unsupported' }

const UNSUPPORTED = { kind: 'unsupported' } as const

/** Peels `.optional()`/`.default()` wrappers off, reporting what it found. */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; required: boolean } {
  let inner = schema
  let required = true
  // A wrapper chain is short by construction; the loop terminates because
  // each step strips exactly one wrapper.
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) {
    required = required && inner instanceof z.ZodDefault
    inner = inner.unwrap() as z.ZodTypeAny
  }
  return { inner, required }
}

function controlOf(schema: z.ZodTypeAny): FacetFormControl | undefined {
  if (schema instanceof z.ZodString) return { kind: 'text' }
  if (schema instanceof z.ZodNumber) return { kind: 'number' }
  if (schema instanceof z.ZodBoolean) return { kind: 'toggle' }
  if (schema instanceof z.ZodEnum) {
    const options = Object.values(schema.enum as Record<string, string>)
    return { kind: 'choice', options }
  }
  return undefined
}

/** The spec's control for a field, when it declares a richer one. */
function specControl(spec: FacetFieldSpec | undefined): FacetFormControl | undefined {
  if (spec === undefined) return undefined
  if (spec.widget === 'segmented') {
    return { kind: 'segmented', options: spec.options ?? [], layout: spec.layout ?? 'chips' }
  }
  if (spec.widget === 'choice') return undefined
  return { kind: spec.widget }
}

function fieldsOf(
  shape: Record<string, z.ZodTypeAny>,
  skip?: string,
  editor?: FacetEditorSpec,
): readonly FacetFormField[] | undefined {
  const fields: FacetFormField[] = []
  for (const [name, member] of Object.entries(shape)) {
    if (name === skip) continue
    const { inner, required } = unwrap(member)
    const derived = controlOf(inner)
    if (derived === undefined) return undefined
    const spec = editor?.fields?.[name]
    fields.push({
      name,
      label: spec?.label ?? humanize(name),
      control: specControl(spec) ?? derived,
      required,
      quick: spec?.quick ?? false,
    })
  }
  return fields
}

/** The discriminating literal of a union arm, when it has exactly one. */
function discriminantOf(shape: Record<string, z.ZodTypeAny>): [string, string] | undefined {
  for (const [name, member] of Object.entries(shape)) {
    if (member instanceof z.ZodLiteral) {
      const value = member.value
      if (typeof value === 'string') return [name, value]
    }
  }
  return undefined
}

/**
 * A schema field name turned into something a person reads: `dueDate` ->
 * `Due date`. The derived label is a FALLBACK — a facet that cares declares
 * one in its editor spec — but a fallback is what most tier-1 facets ship
 * with, so it should not read like a variable.
 */
function humanize(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

export function deriveFacetForm(schema: z.ZodTypeAny, editor?: FacetEditorSpec): FacetForm {
  // A declared picker WINS over anything the schema would derive. Both
  // shapes this serves derive something on their own — a union derives
  // `variants`, an object derives `fields` — and neither is what the
  // plugin means: the derivation describes the STORAGE, and the picker
  // describes the choice a person is actually making.
  if (editor?.picker !== undefined) {
    const catalog = editor.picker.catalog
    return {
      kind: 'picker',
      options: editor.picker.options,
      layout: editor.picker.layout ?? 'chips',
      ...(catalog === undefined ? {} : { catalog }),
    }
  }
  if (schema instanceof z.ZodObject) {
    const fields = fieldsOf(schema.shape as Record<string, z.ZodTypeAny>, undefined, editor)
    return fields === undefined ? UNSUPPORTED : { kind: 'fields', fields }
  }
  if (schema instanceof z.ZodUnion) {
    const arms = schema.options as readonly z.ZodTypeAny[]
    const variants: FacetFormVariant[] = []
    let discriminant: string | undefined
    for (const arm of arms) {
      if (!(arm instanceof z.ZodObject)) return UNSUPPORTED
      const shape = arm.shape as Record<string, z.ZodTypeAny>
      const found = discriminantOf(shape)
      if (found === undefined) return UNSUPPORTED
      const [name, label] = found
      if (discriminant !== undefined && discriminant !== name) return UNSUPPORTED
      discriminant = name
      // Two arms selected by the same literal cannot be told apart by a
      // picker, and the second would be unreachable.
      if (variants.some((variant) => variant.label === label)) return UNSUPPORTED
      const fields = fieldsOf(shape, name)
      if (fields === undefined) return UNSUPPORTED
      variants.push({ label, fields })
    }
    return discriminant === undefined
      ? UNSUPPORTED
      : {
          kind: 'variants',
          discriminant,
          discriminantLabel: humanize(discriminant),
          variants,
        }
  }
  return UNSUPPORTED
}

/**
 * Definition-time check for an editor spec, kept HERE because this module
 * owns what a form can express: a spec that names a field the schema does
 * not declare, or sits on a schema with no derivable form, is a
 * programmer error and throws like the rest of `defineFacet`'s grammar
 * checks.
 *
 * Lives in this module rather than the registry so the dependency stays
 * one-way — the registry may read the form layer, never the reverse.
 */
export function resolveEditorSpec(
  facetName: string,
  schema: z.ZodTypeAny,
  editor: FacetEditorSpec,
): FacetEditorSpec {
  if (editor.picker !== undefined && editor.fields !== undefined) {
    throw new Error(`facet "${facetName}" declares both a picker and fields; it may declare one`)
  }
  if (editor.picker !== undefined) {
    return { ...editor, picker: normalizePicker(facetName, schema, editor.picker) }
  }
  if (editor.fields === undefined) return editor
  const form = deriveFacetForm(schema)
  if (form.kind !== 'fields') {
    throw new Error(
      `facet "${facetName}" declares an editor spec, but its schema has no derivable form`,
    )
  }
  const known = new Set(form.fields.map((field) => field.name))
  for (const name of Object.keys(editor.fields)) {
    if (!known.has(name)) {
      throw new Error(
        `facet "${facetName}" editor names field "${name}", which its schema does not declare`,
      )
    }
  }
  return editor
}

/**
 * Every option's payload is parsed by the facet's OWN schema, here, at
 * definition time — and the PARSED value is what the option carries from
 * then on.
 *
 * The parse is what a declared picker buys over a hand-written component,
 * and it is not a nicety: a component's payload is only ever checked at the
 * write boundary, so a typo in one of twelve options ships, validates as a
 * refused write, and reads to the person as a choice that silently does
 * nothing. Declaring it means the plugin cannot start.
 *
 * KEEPING the parsed value closes the same gap from the other side. A
 * schema may fill a default, drop an unknown key, or transform — so the
 * value a write STORES can differ from the literal a plugin declared. The
 * UI writes the declared literal, but `wb_facet_set` and an imported
 * document go through `validateFacetWrite`, which stores the parsed value;
 * compared against an unparsed declaration, such a payload matches no
 * option and the picker draws with nothing selected. Normalising here means
 * declaration and storage cannot disagree, whichever path did the writing.
 *
 * The duplicate check then runs on the normalised value too, which is
 * strictly stronger: two options that differ only in a field the schema
 * fills in are one option twice, and the second could never read as
 * selected.
 */
function normalizePicker(
  facetName: string,
  schema: z.ZodTypeAny,
  picker: FacetPickerSpec,
): FacetPickerSpec {
  if (picker.options.length === 0) {
    throw new Error(`facet "${facetName}" declares a picker with no options`)
  }
  const seen = new Set<string>()
  const options = picker.options.map((option) => {
    let payload = option.payload
    if (payload !== null) {
      const result = schema.safeParse(payload)
      if (!result.success) {
        throw new Error(
          `facet "${facetName}" picker option "${option.label}" writes a payload its own schema refuses`,
        )
      }
      payload = result.data
    }
    // Two options writing the same thing are two controls a person cannot
    // tell apart, and whichever is drawn second can never read as selected.
    // Keyed by `facetPayloadKey` so key ORDER cannot hide a duplicate.
    const fingerprint = facetPayloadKey(payload)
    if (seen.has(fingerprint)) {
      throw new Error(
        `facet "${facetName}" picker option "${option.label}" writes the same payload as an earlier one`,
      )
    }
    seen.add(fingerprint)
    return { ...option, payload }
  })
  if (picker.catalog !== undefined) {
    assertCatalogFits(facetName, schema, picker.catalog)
  }
  return { ...picker, options }
}

/**
 * What CAN be checked about a catalog at definition time. Its rows cannot
 * be — they are not loaded yet, deliberately — so what is left is the two
 * declarations around them, and both have a failure mode that reaches a
 * person as a control doing nothing rather than as an error.
 */
function assertCatalogFits(
  facetName: string,
  schema: z.ZodTypeAny,
  catalog: FacetPickerCatalogSpec,
): void {
  if (catalog.label.trim() === '') {
    throw new Error(`facet "${facetName}" needs a non-blank catalog label`)
  }
  const entry = catalog.entry
  if (entry === undefined) return
  if (entry.label.trim() === '') {
    throw new Error(`facet "${facetName}" needs a non-blank free-entry label`)
  }
  if (Object.hasOwn(entry.payload, entry.field)) {
    // Two sources for one key, and only the typed one can ever win — so the
    // declared value is a constant nobody will ever read, which reads to
    // the next author as a default that is honoured.
    throw new Error(
      `facet "${facetName}" free-entry template already fills "${entry.field}", the field its text writes`,
    )
  }
  if (schema.safeParse(entry.payload).success) {
    // Then the text is optional, and the control writes the moment it is
    // drawn — an option nobody listed, sitting under the ones that were.
    throw new Error(
      `facet "${facetName}" free-entry template writes a payload its schema accepts before anything is typed`,
    )
  }
}
