// Minimal type stub for wawoff2 (no published @types). Only the methods we use.
declare module 'wawoff2' {
  const def: {
    decompress(input: Uint8Array | Buffer): Promise<Uint8Array>
    compress(input: Uint8Array | Buffer): Promise<Uint8Array>
  }
  export default def
}
