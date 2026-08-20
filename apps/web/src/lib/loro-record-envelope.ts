import { z } from 'zod'

/**
 * Versioned envelope for Loro records persisted in IndexedDB.
 * Single parse boundary — every IDB read for loroDocuments goes through this.
 * Type is derived via z.infer; no parallel hand-written interface.
 *
 * v: envelope format version (literal 1). Bump this when the envelope shape
 *    changes in a backward-incompatible way; old records will be rejected as
 *    'corrupt-snapshot' and the caller is responsible for recovery.
 *
 * It lives apart from `loro-store.ts` because that module imports `loro-crdt`
 * at module scope, and `browser-local-store.ts` — which App.tsx constructs at
 * startup — needs only this schema to read a record's `updatedAt`. Importing
 * it from there pulled the whole CRDT library onto the critical path: measured
 * at +24.3 KB gzip across two extra files, which is what the bundle-size gate
 * caught. A schema is zod and nothing else; keeping it here is what makes that
 * true of its module too.
 */
// z.custom pins the inferred type to Uint8Array<ArrayBuffer> (matching lib:ES2020+DOM),
// which is narrower than the z.instanceof(Uint8Array) result (Uint8Array<ArrayBufferLike>).
const uint8ArraySchema = z.custom<Uint8Array>((v) => v instanceof Uint8Array)

export const loroRecordEnvelopeSchema = z.object({
  v: z.literal(1),
  snapshot: uint8ArraySchema,
  updatedAt: z.string(),
  deltas: z.array(uint8ArraySchema).optional(),
})

export type LoroRecordEnvelope = z.infer<typeof loroRecordEnvelopeSchema>
