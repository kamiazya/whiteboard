import { z } from 'zod'
import { canvasIdSchema } from '../ids.js'

/**
 * INTERNAL, versioned mdast subset. Not part of the stable public surface
 * yet — a public release happens once the slice-2 remark pipeline has
 * exercised it against real documents. Exported via the package's
 * `./internal` subpath, not the default `.` export.
 *
 * Covers CommonMark + GFM (table/tableRow/tableCell/delete) + math
 * (math/inlineMath) + this repo's two official custom nodes: wikiLink and
 * embed. Diagrams are NOT a distinct node kind — a ```mermaid fence is a
 * standard `code` node with `lang: 'mermaid'`; this subset does not add
 * diagram-specific structure.
 *
 * Parent-child relations follow the mdast content-model categories
 * (https://github.com/syntax-tree/mdast#content-model): FlowContent (block
 * level — paragraph/heading/blockquote/list/code/html/thematicBreak/
 * definition/table/math), PhrasingContent (inline — text/emphasis/strong/
 * inlineCode/break/html/link/image/linkReference/imageReference/delete/
 * inlineMath/wikiLink/embed), ListContent (listItem only), TableContent
 * (tableRow only), and RowContent (tableCell only). `html` is dual-category
 * (both flow and phrasing) per spec. `wikiLink`/`embed` are this repo's
 * custom nodes and are phrasing-level, matching how they sit inline in a
 * sentence.
 *
 * Per https://github.com/syntax-tree/mdast#tablecell, TableCell content is
 * phrasing WITHOUT `break` (GFM table cells cannot contain a hard line
 * break) — `mdastCellPhrasingContentSchema` encodes that narrower category
 * instead of reusing `mdastPhrasingContentSchema` inside a table cell.
 *
 * `mdastRootSchema` is an intentionally narrower APPLICATION SUBSET of
 * upstream mdast Root (https://github.com/syntax-tree/mdast#root): upstream
 * permits a Root's children to be any ONE homogeneous content category
 * (e.g. a root of only phrasing content is valid mdast). This subset fixes
 * Root to FlowContent only, which is what a remark document AST actually
 * produces for a parsed markdown file. This is a deliberate narrowing, not
 * a claim of full content-model conformance.
 *
 * `mdastNodeSchema` remains the union of every supported node kind with
 * per-kind structurally-valid children (so a single, unparented node —
 * e.g. a standalone `listItem` — still validates on its own); it does NOT
 * enforce where a node kind is allowed to appear. Contextual placement
 * (e.g. "a listItem must be inside a list") is only enforced when parsing
 * through a parent category schema or `mdastRootSchema`.
 *
 * mdast is inherently recursive (e.g. a paragraph's children can contain a
 * link whose own children are more phrasing content). Zod's `z.lazy()`
 * cannot have its return type inferred back into a self-referential type
 * without an explicit type parameter to break the cycle for the compiler —
 * this is a documented Zod limitation, not a case of hand-writing a type
 * that z.infer could otherwise produce on its own. Every recursive category
 * type below is intentionally the type the matching schema is written
 * AGAINST (via `z.ZodType<...>`); the mutation-relevant guard is that each
 * schema's `z.infer<>` must stay assignable to its annotated type, which
 * `pnpm -r typecheck` enforces because the explicit annotation makes any
 * drift a compile error, not a silent widening to `any`.
 */

export type MdastAlign = 'left' | 'right' | 'center' | null

type MdastReferenceType = 'shortcut' | 'collapsed' | 'full'
type MdastHeadingDepth = 1 | 2 | 3 | 4 | 5 | 6

export type MdastPhrasingContent =
  | { type: 'text'; value: string }
  | { type: 'emphasis'; children: MdastPhrasingContent[] }
  | { type: 'strong'; children: MdastPhrasingContent[] }
  | { type: 'inlineCode'; value: string }
  | { type: 'break' }
  | { type: 'html'; value: string }
  | { type: 'link'; url: string; title?: string | null; children: MdastPhrasingContent[] }
  | { type: 'image'; url: string; title?: string | null; alt?: string | null }
  | {
      type: 'linkReference'
      identifier: string
      label?: string | null
      referenceType: MdastReferenceType
      children: MdastPhrasingContent[]
    }
  | {
      type: 'imageReference'
      identifier: string
      label?: string | null
      referenceType: MdastReferenceType
      alt?: string | null
    }
  | { type: 'delete'; children: MdastPhrasingContent[] }
  | { type: 'inlineMath'; value: string }
  // Official custom nodes. Internal link representation is ID-based:
  // wikiLink/embed carry a canvasId (ULID) rather than a file path.
  | { type: 'wikiLink'; canvasId: string; alias?: string }
  | { type: 'embed'; canvasId: string }

/** PhrasingContent minus `break` — see the TableCell note above. */
export type MdastCellPhrasingContent =
  | { type: 'text'; value: string }
  | { type: 'emphasis'; children: MdastCellPhrasingContent[] }
  | { type: 'strong'; children: MdastCellPhrasingContent[] }
  | { type: 'inlineCode'; value: string }
  | { type: 'html'; value: string }
  | { type: 'link'; url: string; title?: string | null; children: MdastCellPhrasingContent[] }
  | { type: 'image'; url: string; title?: string | null; alt?: string | null }
  | {
      type: 'linkReference'
      identifier: string
      label?: string | null
      referenceType: MdastReferenceType
      children: MdastCellPhrasingContent[]
    }
  | {
      type: 'imageReference'
      identifier: string
      label?: string | null
      referenceType: MdastReferenceType
      alt?: string | null
    }
  | { type: 'delete'; children: MdastCellPhrasingContent[] }
  | { type: 'inlineMath'; value: string }
  | { type: 'wikiLink'; canvasId: string; alias?: string }
  | { type: 'embed'; canvasId: string }

export type MdastFlowContent =
  | { type: 'paragraph'; children: MdastPhrasingContent[] }
  | { type: 'heading'; depth: MdastHeadingDepth; children: MdastPhrasingContent[] }
  | { type: 'blockquote'; children: MdastFlowContent[] }
  | { type: 'list'; ordered?: boolean; start?: number; spread?: boolean; children: MdastListItem[] }
  | { type: 'code'; value: string; lang?: string | null; meta?: string | null }
  | { type: 'html'; value: string }
  | { type: 'thematicBreak' }
  | {
      type: 'definition'
      identifier: string
      label?: string | null
      url: string
      title?: string | null
    }
  | { type: 'table'; align?: MdastAlign[]; children: MdastTableRow[] }
  | { type: 'math'; value: string; meta?: string | null }

export type MdastListItem = {
  type: 'listItem'
  checked?: boolean | null
  spread?: boolean
  children: MdastFlowContent[]
}

export type MdastTableRow = { type: 'tableRow'; children: MdastTableCell[] }
export type MdastTableCell = { type: 'tableCell'; children: MdastCellPhrasingContent[] }

/** Document root. See the doc comment above re: the flow-only application subset. */
export type MdastRoot = { type: 'root'; children: MdastFlowContent[] }

export type MdastNode =
  | MdastRoot
  | MdastFlowContent
  | MdastPhrasingContent
  | MdastListItem
  | MdastTableRow
  | MdastTableCell

const referenceTypeSchema = z.enum(['shortcut', 'collapsed', 'full'])
const headingDepthSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
])

// Leaf / no-recursion node schemas — identical shape no matter which
// content category reaches them, so defined once and reused.
const textNodeSchema = z.object({ type: z.literal('text'), value: z.string() })
const inlineCodeNodeSchema = z.object({ type: z.literal('inlineCode'), value: z.string() })
const breakNodeSchema = z.object({ type: z.literal('break') })
const htmlNodeSchema = z.object({ type: z.literal('html'), value: z.string() })
const imageNodeSchema = z.object({
  type: z.literal('image'),
  url: z.string(),
  title: z.string().nullish(),
  alt: z.string().nullish(),
})
const imageReferenceNodeSchema = z.object({
  type: z.literal('imageReference'),
  identifier: z.string(),
  label: z.string().nullish(),
  referenceType: referenceTypeSchema,
  alt: z.string().nullish(),
})
const inlineMathNodeSchema = z.object({ type: z.literal('inlineMath'), value: z.string() })
const wikiLinkNodeSchema = z.object({
  type: z.literal('wikiLink'),
  canvasId: canvasIdSchema,
  alias: z.string().optional(),
})
const embedNodeSchema = z.object({ type: z.literal('embed'), canvasId: canvasIdSchema })
const thematicBreakNodeSchema = z.object({ type: z.literal('thematicBreak') })
const definitionNodeSchema = z.object({
  type: z.literal('definition'),
  identifier: z.string(),
  label: z.string().nullish(),
  url: z.string(),
  title: z.string().nullish(),
})
const codeNodeSchema = z.object({
  type: z.literal('code'),
  value: z.string(),
  lang: z.string().nullish(),
  meta: z.string().nullish(),
})
// mdast-util-math emits `meta: null` for a plain ```math fence (no meta
// string), so `meta` must accept null, not just be absent.
const mathNodeSchema = z.object({
  type: z.literal('math'),
  value: z.string(),
  meta: z.string().nullish(),
})

export const mdastPhrasingContentSchema: z.ZodType<MdastPhrasingContent> = z.lazy(() =>
  z.discriminatedUnion('type', [
    textNodeSchema,
    z.object({ type: z.literal('emphasis'), children: z.array(mdastPhrasingContentSchema) }),
    z.object({ type: z.literal('strong'), children: z.array(mdastPhrasingContentSchema) }),
    inlineCodeNodeSchema,
    breakNodeSchema,
    htmlNodeSchema,
    z.object({
      type: z.literal('link'),
      url: z.string(),
      title: z.string().nullish(),
      children: z.array(mdastPhrasingContentSchema),
    }),
    imageNodeSchema,
    z.object({
      type: z.literal('linkReference'),
      identifier: z.string(),
      label: z.string().nullish(),
      referenceType: referenceTypeSchema,
      children: z.array(mdastPhrasingContentSchema),
    }),
    imageReferenceNodeSchema,
    z.object({ type: z.literal('delete'), children: z.array(mdastPhrasingContentSchema) }),
    inlineMathNodeSchema,
    wikiLinkNodeSchema,
    embedNodeSchema,
  ]),
)

export const mdastCellPhrasingContentSchema: z.ZodType<MdastCellPhrasingContent> = z.lazy(() =>
  z.discriminatedUnion('type', [
    textNodeSchema,
    z.object({ type: z.literal('emphasis'), children: z.array(mdastCellPhrasingContentSchema) }),
    z.object({ type: z.literal('strong'), children: z.array(mdastCellPhrasingContentSchema) }),
    inlineCodeNodeSchema,
    htmlNodeSchema,
    z.object({
      type: z.literal('link'),
      url: z.string(),
      title: z.string().nullish(),
      children: z.array(mdastCellPhrasingContentSchema),
    }),
    imageNodeSchema,
    z.object({
      type: z.literal('linkReference'),
      identifier: z.string(),
      label: z.string().nullish(),
      referenceType: referenceTypeSchema,
      children: z.array(mdastCellPhrasingContentSchema),
    }),
    imageReferenceNodeSchema,
    z.object({ type: z.literal('delete'), children: z.array(mdastCellPhrasingContentSchema) }),
    inlineMathNodeSchema,
    wikiLinkNodeSchema,
    embedNodeSchema,
  ]),
)

export const mdastFlowContentSchema: z.ZodType<MdastFlowContent> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('paragraph'), children: z.array(mdastPhrasingContentSchema) }),
    z.object({
      type: z.literal('heading'),
      depth: headingDepthSchema,
      children: z.array(mdastPhrasingContentSchema),
    }),
    z.object({ type: z.literal('blockquote'), children: z.array(mdastFlowContentSchema) }),
    z.object({
      type: z.literal('list'),
      ordered: z.boolean().optional(),
      start: z.number().int().optional(),
      spread: z.boolean().optional(),
      children: z.array(mdastListItemSchema),
    }),
    codeNodeSchema,
    htmlNodeSchema,
    thematicBreakNodeSchema,
    definitionNodeSchema,
    z.object({
      type: z.literal('table'),
      align: z.array(z.enum(['left', 'right', 'center']).nullable()).optional(),
      children: z.array(mdastTableRowSchema),
    }),
    mathNodeSchema,
  ]),
)

export const mdastListItemSchema: z.ZodType<MdastListItem> = z.lazy(() =>
  z.object({
    type: z.literal('listItem'),
    checked: z.boolean().nullable().optional(),
    spread: z.boolean().optional(),
    children: z.array(mdastFlowContentSchema),
  }),
)

export const mdastTableCellSchema: z.ZodType<MdastTableCell> = z.lazy(() =>
  z.object({ type: z.literal('tableCell'), children: z.array(mdastCellPhrasingContentSchema) }),
)

export const mdastTableRowSchema: z.ZodType<MdastTableRow> = z.lazy(() =>
  z.object({ type: z.literal('tableRow'), children: z.array(mdastTableCellSchema) }),
)

export const mdastRootSchema: z.ZodType<MdastRoot> = z.object({
  type: z.literal('root'),
  children: z.array(mdastFlowContentSchema),
})

/**
 * Union of every supported node kind, each with per-kind structurally-valid
 * children — but NOT contextual placement (see the module doc comment).
 * Useful for validating a single node in isolation.
 */
export const mdastNodeSchema: z.ZodType<MdastNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('root'), children: z.array(mdastFlowContentSchema) }),
    z.object({ type: z.literal('paragraph'), children: z.array(mdastPhrasingContentSchema) }),
    z.object({
      type: z.literal('heading'),
      depth: headingDepthSchema,
      children: z.array(mdastPhrasingContentSchema),
    }),
    textNodeSchema,
    z.object({ type: z.literal('emphasis'), children: z.array(mdastPhrasingContentSchema) }),
    z.object({ type: z.literal('strong'), children: z.array(mdastPhrasingContentSchema) }),
    inlineCodeNodeSchema,
    codeNodeSchema,
    z.object({ type: z.literal('blockquote'), children: z.array(mdastFlowContentSchema) }),
    z.object({
      type: z.literal('list'),
      ordered: z.boolean().optional(),
      start: z.number().int().optional(),
      spread: z.boolean().optional(),
      children: z.array(mdastListItemSchema),
    }),
    z.object({
      type: z.literal('listItem'),
      checked: z.boolean().nullable().optional(),
      spread: z.boolean().optional(),
      children: z.array(mdastFlowContentSchema),
    }),
    thematicBreakNodeSchema,
    breakNodeSchema,
    z.object({
      type: z.literal('link'),
      url: z.string(),
      title: z.string().nullish(),
      children: z.array(mdastPhrasingContentSchema),
    }),
    imageNodeSchema,
    htmlNodeSchema,
    definitionNodeSchema,
    z.object({
      type: z.literal('linkReference'),
      identifier: z.string(),
      label: z.string().nullish(),
      referenceType: referenceTypeSchema,
      children: z.array(mdastPhrasingContentSchema),
    }),
    imageReferenceNodeSchema,
    z.object({
      type: z.literal('table'),
      align: z.array(z.enum(['left', 'right', 'center']).nullable()).optional(),
      children: z.array(mdastTableRowSchema),
    }),
    z.object({ type: z.literal('tableRow'), children: z.array(mdastTableCellSchema) }),
    z.object({ type: z.literal('tableCell'), children: z.array(mdastCellPhrasingContentSchema) }),
    z.object({ type: z.literal('delete'), children: z.array(mdastPhrasingContentSchema) }),
    mathNodeSchema,
    inlineMathNodeSchema,
    wikiLinkNodeSchema,
    embedNodeSchema,
  ]),
)
