/**
 * Re-export shim: the `asset:` prefix convention is shared with the daemon's
 * file-GC reference walk (packages/mcp-server/src/server/store/file-gc.ts),
 * so it is single-sourced in canvas-model rather than duplicated here.
 */
export { imageRefId, isImageRef, newImageRef } from '@kamiazya/whiteboard-canvas-model'
