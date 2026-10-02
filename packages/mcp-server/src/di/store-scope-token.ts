/**
 * Identifier the store module binds its `StoreScope` under. A symbol of this
 * package's own rather than one of ports' `TOKENS`: a scope is the keeper's
 * directory and tenant, which no port contract mentions.
 */
export const STORE_SCOPE = Symbol.for('whiteboard.mcp-server.store-scope')
