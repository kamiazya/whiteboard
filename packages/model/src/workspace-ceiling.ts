/**
 * The most documents a workspace record held by this keeper may list. A
 * browser keeper refuses to grow past 2000 documents on any device (ADR-0044's
 * 2026-09-28 addendum), so a record the editor produced never arrives larger.
 * Counted in documents because that is the axis the cost follows — the
 * record's memory is super-linear in document count, and each edited document
 * takes a checkpoint — while the body ceilings already bound the bytes.
 *
 * One number for every way documents arrive, held at each: the sync update of
 * the workspace record (`judgeWorkspaceSyncImport`) and a promote judge the record
 * they would leave, and every place that mints ONE new document — the index's
 * create, duplicate and trash restore, and the daemon's per-document save of a
 * path the tree does not hold — asks `refuseNewDocuments` first.
 */
export const WORKSPACE_MAX_DOCUMENTS = 2000

/**
 * The most FOLDERS — nodes holding a path component and no document — a
 * workspace record held by this keeper may list. Every listing walks every
 * node, and a folder costs a listing what a document does (measured: about
 * 22 µs a node, so 10000 folders add about 215 ms to every listing and 50000
 * over a second), while a client mints folders as freely as documents and a
 * path holds at most `DOCUMENT_PATH_MAX_LENGTH / 2` of them.
 *
 * Twice the document ceiling: room for every document to sit in a folder of
 * its own two levels deep. A separate ceiling rather than a share of the
 * document one, because a folder exists only to hold documents — counting it
 * as one would refuse a workspace of 2000 documents for being organised.
 */
export const WORKSPACE_MAX_FOLDERS = 2 * WORKSPACE_MAX_DOCUMENTS
