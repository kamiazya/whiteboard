// Re-export from lib so callers that import from this hooks-layer path continue to work.
// The canonical implementation lives in lib/ws-text-message.ts, which is importable by
// both lib-layer modules (daemon-backend.ts) and hooks-layer modules without inverting
// the dependency direction.
export { parseServerTextMessage } from '../lib/ws-text-message.js'
