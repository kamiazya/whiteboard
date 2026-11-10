import { serializeSpatial as serializeSpatialRust } from './core.js'

// What `../../spatial/serialize.js` exports, with `serializeSpatial` answered by the Rust core.
export const serializeSpatial = serializeSpatialRust
