// The `#glue` declaration, for the one module here that imports it at runtime.
/// <reference path="./glue.d.ts" />
import { type Core, coreFrom } from './index.js'

/**
 * The core, from the artifact's bytes or a compiled module, with the glue
 * this package stages. Its own entry (`./load`) because it is the one
 * import of `#glue`: a root that bundles the shim and loads the glue from
 * a path of its own (mcp-server) takes `coreFrom` from `.` and never makes
 * its bundler resolve an artifact it may not have.
 */
export async function loadCore(source: BufferSource | WebAssembly.Module): Promise<Core> {
  return coreFrom(await import('#glue'), source)
}
