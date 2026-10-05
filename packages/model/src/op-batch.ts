/**
 * The most ops one call of an op-batch tool may carry — `wb_canvas_edit`,
 * `wb_body_edit` and `wb_thread_edit` alike.
 *
 * A ceiling on one REQUEST, not on a document: a batch past it is almost
 * always a model looping, and a refused oversized batch is cheaper to recover
 * from than a half-understood one. It is one number for every batch tool
 * because the reason is the caller's, not the surface's.
 *
 * It is also a COST bound, and that is what sized it. A text op whose offsets
 * miss falls back to searching the whole body for its quote and scoring every
 * occurrence, so one op on a body at `MARKDOWN_MAX_CHARS` that repeats its
 * quote everywhere costs ~8 ms, while the batch holds the workspace's write
 * lock throughout. Measured on 260 Ki characters of `ab` with every offset
 * one off: 200 ops 1.6 s, 1,000 ops 8.1 s, 5,000 ops 38 s. At this ceiling
 * the worst batch stays near the second a whole-document write is already
 * allowed to take.
 */
export const OPS_PER_CALL_MAX = 200

/** The bound as every refusal of it ends. */
export const OPS_PER_CALL_LIMIT_PHRASE = `the ${OPS_PER_CALL_MAX}-op limit for one call; split the batch across calls`
