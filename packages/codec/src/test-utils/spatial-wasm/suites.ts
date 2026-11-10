/**
 * The spatial suites layer 1 runs against the Rust core: those that reach
 * `parseSpatial` or `serializeSpatial`, directly or through `codecs.ts`. The
 * others test the projections, the degradation and the schemas, which the core
 * does not port, so a run of them would have the core answer nothing.
 * `spatial-layer-one.rust.test.ts` fails on a suite that reaches either
 * function and is not listed.
 */
export const SPATIAL_SUITES: readonly string[] = [
  'src/spatial/parse.test.ts',
  'src/spatial/serialize.test.ts',
  'src/spatial/json-canvas-extension.test.ts',
  'src/spatial/extension-contract.property.test.ts',
  'src/spatial/codecs.property.test.ts',
]
