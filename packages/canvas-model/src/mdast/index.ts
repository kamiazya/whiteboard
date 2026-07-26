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
 * mdast is inherently recursive (e.g. a paragraph's children can contain a
 * link whose own children are more phrasing content). Zod's `z.lazy()`
 * cannot have its return type inferred back into a self-referential type
 * without an explicit type parameter to break the cycle for the compiler —
 * this is a documented Zod limitation, not a case of hand-writing a type
 * that z.infer could otherwise produce on its own. `MdastNode` below is
 * intentionally the single type the schema is written AGAINST (via
 * `z.ZodType<MdastNode>`); the mutation-relevant guard is that
 * `z.infer<typeof mdastNodeSchema>` must stay assignable to `MdastNode`,
 * which `pnpm -r typecheck` enforces because `mdastNodeSchema`'s explicit
 * annotation makes any drift a compile error, not a silent widening to
 * `any`.
 */

export type MdastAlign = 'left' | 'right' | 'center' | null

export type MdastNode =
  | { type: 'root'; children: MdastNode[] }
  | { type: 'paragraph'; children: MdastNode[] }
  | { type: 'heading'; depth: 1 | 2 | 3 | 4 | 5 | 6; children: MdastNode[] }
  | { type: 'text'; value: string }
  | { type: 'emphasis'; children: MdastNode[] }
  | { type: 'strong'; children: MdastNode[] }
  | { type: 'inlineCode'; value: string }
  | { type: 'code'; value: string; lang?: string; meta?: string }
  | { type: 'blockquote'; children: MdastNode[] }
  | { type: 'list'; ordered?: boolean; start?: number; spread?: boolean; children: MdastNode[] }
  | { type: 'listItem'; checked?: boolean | null; spread?: boolean; children: MdastNode[] }
  | { type: 'thematicBreak' }
  | { type: 'break' }
  | { type: 'link'; url: string; title?: string; children: MdastNode[] }
  | { type: 'image'; url: string; title?: string; alt?: string }
  | { type: 'html'; value: string }
  | { type: 'table'; align?: MdastAlign[]; children: MdastNode[] }
  | { type: 'tableRow'; children: MdastNode[] }
  | { type: 'tableCell'; children: MdastNode[] }
  | { type: 'delete'; children: MdastNode[] }
  | { type: 'math'; value: string; meta?: string }
  | { type: 'inlineMath'; value: string }
  // Official custom nodes. Internal link representation is ID-based:
  // wikiLink/embed carry a canvasId (ULID) rather than a file path.
  | { type: 'wikiLink'; canvasId: string; alias?: string }
  | { type: 'embed'; canvasId: string }

export const mdastNodeSchema: z.ZodType<MdastNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('root'), children: z.array(mdastNodeSchema) }),
    z.object({ type: z.literal('paragraph'), children: z.array(mdastNodeSchema) }),
    z.object({
      type: z.literal('heading'),
      depth: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6),
      ]),
      children: z.array(mdastNodeSchema),
    }),
    z.object({ type: z.literal('text'), value: z.string() }),
    z.object({ type: z.literal('emphasis'), children: z.array(mdastNodeSchema) }),
    z.object({ type: z.literal('strong'), children: z.array(mdastNodeSchema) }),
    z.object({ type: z.literal('inlineCode'), value: z.string() }),
    z.object({
      type: z.literal('code'),
      value: z.string(),
      lang: z.string().optional(),
      meta: z.string().optional(),
    }),
    z.object({ type: z.literal('blockquote'), children: z.array(mdastNodeSchema) }),
    z.object({
      type: z.literal('list'),
      ordered: z.boolean().optional(),
      start: z.number().int().optional(),
      spread: z.boolean().optional(),
      children: z.array(mdastNodeSchema),
    }),
    z.object({
      type: z.literal('listItem'),
      checked: z.boolean().nullable().optional(),
      spread: z.boolean().optional(),
      children: z.array(mdastNodeSchema),
    }),
    z.object({ type: z.literal('thematicBreak') }),
    z.object({ type: z.literal('break') }),
    z.object({
      type: z.literal('link'),
      url: z.string(),
      title: z.string().optional(),
      children: z.array(mdastNodeSchema),
    }),
    z.object({
      type: z.literal('image'),
      url: z.string(),
      title: z.string().optional(),
      alt: z.string().optional(),
    }),
    z.object({ type: z.literal('html'), value: z.string() }),
    z.object({
      type: z.literal('table'),
      align: z.array(z.enum(['left', 'right', 'center']).nullable()).optional(),
      children: z.array(mdastNodeSchema),
    }),
    z.object({ type: z.literal('tableRow'), children: z.array(mdastNodeSchema) }),
    z.object({ type: z.literal('tableCell'), children: z.array(mdastNodeSchema) }),
    z.object({ type: z.literal('delete'), children: z.array(mdastNodeSchema) }),
    z.object({ type: z.literal('math'), value: z.string(), meta: z.string().optional() }),
    z.object({ type: z.literal('inlineMath'), value: z.string() }),
    z.object({
      type: z.literal('wikiLink'),
      canvasId: canvasIdSchema,
      alias: z.string().optional(),
    }),
    z.object({ type: z.literal('embed'), canvasId: canvasIdSchema }),
  ]),
)
