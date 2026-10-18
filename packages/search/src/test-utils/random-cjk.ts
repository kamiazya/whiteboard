/**
 * `chars` characters drawn from the CJK Unified Ideographs block, the body
 * that maximises what the index tokenizer emits: every character is a
 * unigram, every adjacent pair a bigram, and almost no pair repeats.
 *
 * Deterministic (xorshift32 from `seed`) so a counted assertion over it holds
 * on every run, not only on average.
 */
export function randomCjk(chars: number, seed = 1): string {
  let x = (seed * 2654435761) >>> 0 || 1
  const codes: number[] = []
  for (let i = 0; i < chars; i++) {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    codes.push(0x4e00 + (x % 20992))
  }
  let out = ''
  // Chunked: spreading a quarter-million arguments into one call overflows the stack.
  for (let i = 0; i < codes.length; i += 8192) {
    out += String.fromCodePoint(...codes.slice(i, i + 8192))
  }
  return out
}
