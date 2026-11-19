/**
 * A random peer id: an unsigned 64-bit integer as a decimal string, the form
 * the engine contract names a replica by. `globalThis.crypto` is the one source
 * Node, a browser and a worker all provide.
 */
export function randomPeerId(): string {
  const words = globalThis.crypto.getRandomValues(new Uint32Array(2))
  return ((BigInt(words[0] ?? 0) << 32n) | BigInt(words[1] ?? 0)).toString()
}
