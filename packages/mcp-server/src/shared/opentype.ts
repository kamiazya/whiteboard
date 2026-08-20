import * as opentype from 'opentype.js'

// opentype.js is CommonJS. Running from source (tsx) its exports land on the
// namespace root, but tsup's ESM interop nests them under `default` in the
// bundled dist. Reading only one of the two shapes throws
// "opentype.parse is not a function" in exactly one environment — the
// published package — where the fallback measurer then silently absorbs it
// and every export loses the real font metrics. Resolve whichever object
// actually carries the API.
export const opentypeApi =
  (opentype as unknown as { default?: typeof opentype }).default ?? opentype
