/**
 * The grapheme edges of an excerpt, recorded after every other record so the
 * earlier lines stay as they were: long runs of one cluster shape put the
 * cut of `snippetAround` inside a cluster, and a seeded stream of cluster
 * pieces records where `Intl.Segmenter` cuts, which the Rust segmenter is
 * compared against.
 */
import { randomFrom } from '@kamiazya/whiteboard-model/test-utils'
import { snippetAround } from '../snippet.js'

const SEED = 0x6e11_5e65
const GRAPHEME_CASES = 1500

const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' })

/** Cluster shapes: each is one grapheme, or the start of a longer one. */
const SHAPES: readonly string[] = [
  'a',
  'é',
  'é̂̃',
  '🇯🇵',
  '🇺',
  '🙂',
  '🙂\u{1f3fd}',
  '👨‍👩‍👧‍👦',
  '👩‍💻',
  '❤️',
  '1️⃣',
  '؀a',
  '؀؁b',
  'क्ष',
  'क्‍ष',
  'ब्र',
  '한',
  '한',
  '\r\n',
  '\r',
  '\n',
  '‍',
  '‌',
  '️',
  '́',
  'กำ',
  'が',
  '\u{e0020}',
  '\u{1f1e6}\u{1f1e7}\u{1f1e8}',
  'ਕ੍ਕ',
  'ക്ഷ',
  'ᬓ᭄ᬓ',
  'ä‍b',
  '्',
  '\u{11a84}x',
  ' ',
  '日本',
]

const NEEDLE = 'NEEDLE'

/** Runs of one shape around a needle, with the pad shifting where the cut falls. */
function runRecords(): unknown[] {
  const out: unknown[] = []
  for (const shape of SHAPES) {
    for (const pad of [0, 1, 2, 3, 5, 7]) {
      for (const run of [30, 150, 400]) {
        const text = `${'y'.repeat(pad)}${shape.repeat(run)}${NEEDLE}${shape.repeat(run)}`
        const index = text.indexOf(NEEDLE)
        out.push({
          kind: 'snippet-run',
          text,
          index,
          length: NEEDLE.length,
          out: snippetAround(text, index, NEEDLE.length),
        })
      }
    }
  }
  return out
}

function cuts(text: string): number[] {
  return Array.from(GRAPHEMES.segment(text), (each) => each.index)
}

function graphemeRecords(): unknown[] {
  const next = randomFrom(SEED)
  const out: unknown[] = []
  for (let i = 0; i < GRAPHEME_CASES; i++) {
    const parts = 1 + Math.floor(next() * 9)
    let text = ''
    for (let j = 0; j < parts; j++) text += SHAPES[Math.floor(next() * SHAPES.length)]
    out.push({ kind: 'graphemes', in: text, cuts: cuts(text) })
  }
  return out
}

export function segmentRecords(): unknown[] {
  return [...runRecords(), ...graphemeRecords()]
}
