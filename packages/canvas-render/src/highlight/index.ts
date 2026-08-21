// Re-exported for a caller that wants to compose the default tokeniser
// explicitly — `layoutSpatialCanvas` already applies it, so this is the
// override path, not the wiring one.
export { highlightCode } from './lowlight.js'
