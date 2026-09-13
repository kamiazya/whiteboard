/**
 * Independent oracle for the tool-surface scoreboard.
 *
 * Reads a tool the way a CLIENT receives it — the `tools/list` entry, as
 * JSON — and never imports the registration code, the Zod shapes or
 * TOOL_PROFILES, so a test asserting against it cannot be satisfied by the
 * surface agreeing with itself. The same contract `routing-metrics.ts` holds
 * for the edge router.
 *
 * Two sizes, because two readers pay for a definition:
 *
 *   - MODEL-VISIBLE bytes are what reaches the model's context on every
 *     turn: the name, the description and the input schema, in the shape
 *     the Messages API sends a tool (`name`, `description`, `input_schema`).
 *     Title, annotations and the output schema are for the client — a host
 *     shows the title and reads the hints for its approval UI, and the SDK
 *     validates `structuredContent` against the output schema — and no
 *     client this repo targets forwards them to the model.
 *   - WIRE bytes are the whole entry: what a client parses on connect.
 *
 * Bytes rather than tokens: a tokenizer would make the number depend on
 * which model reads it, and bytes are exact, monotone in tokens for the
 * JSON these definitions are, and need no dependency. Divide by ~4 for an
 * order of magnitude in tokens and say so when you do.
 */

/** A `tools/list` entry, structurally; the SDK's `Tool` minus what this never reads. */
export interface ListedTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema: JsonSchema
  readonly outputSchema?: JsonSchema
  readonly annotations?: Readonly<Record<string, unknown>>
  readonly title?: string
}

/** Enough JSON Schema to walk a Zod-emitted one. Anything else is opaque. */
export type JsonSchema = {
  readonly description?: string
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly items?: JsonSchema | readonly JsonSchema[]
  readonly anyOf?: readonly JsonSchema[]
  readonly oneOf?: readonly JsonSchema[]
  readonly allOf?: readonly JsonSchema[]
  readonly additionalProperties?: JsonSchema | boolean
  readonly enum?: readonly unknown[]
  readonly const?: unknown
  readonly type?: string | readonly string[]
} & Readonly<Record<string, unknown>>

export function modelVisibleBytes(tool: ListedTool): number {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }).length
}

export function wireBytes(tool: ListedTool): number {
  return JSON.stringify(tool).length
}

export interface ParameterCoverage {
  /** Every property the input schema declares, at any depth, by path. */
  readonly parameters: number
  /** Of those, the ones carrying a `description`. */
  readonly described: number
  /** The paths with none, in schema order — what a `.describe()` is missing on. */
  readonly undescribed: readonly string[]
}

/**
 * Walks every `properties` map in the schema, including the arms of a union
 * and the items of an array. A union arm is addressed by its index, so two
 * arms declaring the same field count twice: each is its own line in the
 * schema the model reads, and each is undescribed on its own.
 *
 * `$ref` IS RESOLVED, against the root's `$defs`, and the counting rule above
 * is what decides how: a referenced subschema counts at each site that
 * references it, exactly as an inlined copy would. Registering a schema in
 * zod's global registry is a byte-level change to how the same surface is
 * transmitted, so it must not move a count that means "how many parameters
 * are there".
 *
 * It went unresolved until measured, and it was wrong in BOTH directions —
 * which is worse than being wrong in one, because the two cancel. A `$ref`
 * node carries no `properties`, so the walk stopped there: every property
 * inside the five schemas already named in the registry was invisible to the
 * count, and registering an undescribed subschema read as debt PAID while
 * registering a described one read as debt ADDED. Both are the instrument
 * moving, not the surface.
 *
 * The description is taken from the resolved target, because that is where a
 * model reading the schema finds it; a description on the referencing site
 * still wins, since JSON Schema lets one annotate a `$ref`.
 */
export function parameterCoverage(schema: JsonSchema): ParameterCoverage {
  let parameters = 0
  let described = 0
  const undescribed: string[] = []
  const defs = (schema.$defs ?? {}) as Record<string, JsonSchema | undefined>
  /**
   * The target of a local `$ref`, or the node itself. Only `#/$defs/<name>`
   * is resolved — that is the one shape zod emits, and a pointer this cannot
   * follow must read as unresolved rather than as an empty schema.
   */
  const deref = (node: JsonSchema, seen: ReadonlySet<string>): JsonSchema => {
    const ref = node.$ref
    if (typeof ref !== 'string') return node
    const name = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : undefined
    if (name === undefined || seen.has(name)) return node
    const target = defs[name]
    if (target === undefined) return node
    // The site's own annotations win over the target's.
    return { ...target, ...node, $ref: undefined }
  }
  const walk = (
    node: JsonSchema | boolean | undefined,
    path: string,
    seen: ReadonlySet<string>,
  ): void => {
    if (node === undefined || typeof node === 'boolean') return
    const refName =
      typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/')
        ? node.$ref.slice('#/$defs/'.length)
        : undefined
    if (refName !== undefined && seen.has(refName)) return
    const nextSeen = refName === undefined ? seen : new Set([...seen, refName])
    const resolved = deref(node, seen)
    node = resolved
    if (node.properties !== undefined) {
      for (const [key, rawChild] of Object.entries(node.properties)) {
        parameters += 1
        const childPath = path === '' ? key : `${path}.${key}`
        const child = deref(rawChild, nextSeen)
        if (typeof child.description === 'string' && child.description.length > 0) described += 1
        else undescribed.push(childPath)
        walk(rawChild, childPath, nextSeen)
      }
    }
    if (Array.isArray(node.items)) {
      node.items.forEach((item, i) => {
        walk(item, `${path}[${i}]`, nextSeen)
      })
    } else if (node.items !== undefined) {
      walk(node.items as JsonSchema, `${path}[]`, nextSeen)
    }
    for (const keyword of ['anyOf', 'oneOf', 'allOf'] as const) {
      node[keyword]?.forEach((arm, i) => {
        walk(arm, `${path}|${i}`, nextSeen)
      })
    }
    if (typeof node.additionalProperties === 'object') {
      walk(node.additionalProperties, `${path}.*`, nextSeen)
    }
  }
  walk(schema, '', new Set())
  return { parameters, described, undescribed }
}

/** Words in the description, split on whitespace; 0 when there is none. */
export function descriptionWords(tool: ListedTool): number {
  const text = tool.description?.trim() ?? ''
  return text === '' ? 0 : text.split(/\s+/).length
}

/** The `wb_`-prefixed tool names the description names, other than the tool's own. */
export function crossReferences(tool: ListedTool): readonly string[] {
  const names = tool.description?.match(/\bwb_[a-z_]+\b/g) ?? []
  return [...new Set(names)].filter((name) => name !== tool.name).sort()
}
