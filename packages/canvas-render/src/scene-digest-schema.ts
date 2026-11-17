import { z } from 'zod'

/**
 * The scene digest the Rust core writes (`crates/core/canvas-render`'s
 * `scene_digest`) crosses a process boundary as AI-facing JSON, which is why
 * it is schematized at all (this repo's zod-schema-discipline). Its one
 * consumer is `server-core`'s `canvas-snapshot.ts`, which spreads it into
 * `canvasSnapshotSchema` — the output of the **`wb_canvas_snapshot`** MCP
 * tool. The core's writer gives every array an explicit total sort, so the
 * JSON is reproducible across runs; this schema is what holds the text it
 * sends to the shape a reader was promised.
 */

const bboxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })

export const sceneDigestSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      bbox: bboxSchema,
      z: z.number().int(),
      /**
       * Present only when this node's content was cut to fit its box, so a
       * reader knows the document holds more than the canvas shows. The
       * painted half of the same fact is a fade on the last surviving line,
       * which a reader of this JSON never sees.
       */
      truncated: z.literal(true).optional(),
      /**
       * Present when the content does not fit the box AT ALL — a superset of
       * `truncated`, which also covers content kept whole at a width it
       * exceeds because it is one irreducible code point. Nothing is hidden
       * in that case, so it draws no fade and is not `truncated`; the box is
       * still too small, which is what a reader deciding whether to resize
       * needs to know.
       */
      overflows: z.literal(true).optional(),
    }),
  ),
  overlaps: z.array(z.tuple([z.string(), z.string()])),
  containment: z.array(z.object({ parent: z.string(), child: z.string() })),
  clusters: z.array(z.array(z.string())),
  freeRegions: z.array(bboxSchema),
  /**
   * Whether a guard below dropped a derivation, or cut one short, rather than
   * computing it whole.
   *
   * Named `partial` rather than `truncated` because the payload this rides
   * in already spends that word on transport cutting — the snapshot's caps
   * and its per-node `textTruncated`. Three fields called `truncated` and
   * distinguished only by position is a reader's problem, and the reader
   * here is an agent.
   *
   * Without this the guards are indistinguishable from a genuine answer: a
   * board too large for the pairwise scan reports `overlaps: []`, which
   * reads as "nothing overlaps" — the most misleading possible reply to
   * "is this board tidy". Only the digest's writer knows both conditions (one is
   * a node count, the other a derived grid size), so it is the only place
   * that can say so.
   */
  partial: z.boolean(),
})

export type SceneDigest = z.infer<typeof sceneDigestSchema>
