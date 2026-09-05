// Moved to @kamiazya/whiteboard-daemon-client (the browser-safe client
// half, now a shared-layer package arch-lint can scan structurally).
// This shim keeps every old path — internal relative imports, the
// published subpath exports, and tsup entries — working until the
// import rewrite lands; do not add new imports through it.
export * from '@kamiazya/whiteboard-daemon-client/test-utils/sse-stream-source-contract'
