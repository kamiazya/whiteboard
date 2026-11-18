import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { refusalCopy } from '../refusal.js'
import { type NoticeRecord, noticeInputs } from '../test-utils/render-oracle/notice-oracle.js'
import { decodeLines } from '../test-utils/render-oracle/oracle.js'

/**
 * The committed recording of the refusal notice (`notice.jsonl`): what the
 * TypeScript notice drawing and SVG backend (both deleted, ADR-0054 A3.6)
 * answered for each notice `noticeInputs` names, as digests.
 * `core-notice.rust.test.ts` holds the core's notice to it. It is frozen:
 * nothing re-records it.
 */
const FILE = new URL('./notice.jsonl', import.meta.url)

describe('the recorded refusal notice', () => {
  const text = readFileSync(FILE, 'utf8')
  const recorded = decodeLines<NoticeRecord>(text)

  it('holds every refusal, mode, width, place and envelope, and the host-measure notices', () => {
    expect(recorded.map((r) => r.id)).toEqual(noticeInputs().map((input) => input.id))
    expect(recorded.filter((r) => r.id.startsWith('grid/')).length, 'grid').toBe(12 * 2 * 6 * 3)
    expect(new Set(recorded.map((r) => r.refusal.reason)).size, 'reasons').toBe(11)
    expect(recorded.filter((r) => r.keyed !== undefined).length, 'keyed').toBe(432)
    expect(recorded.filter((r) => r.measure !== 'fake').length, 'host measures').toBe(5)
    // The reachability guard: every input draws its own notice, except that no
    // width is the default 480 and no place is the origin: 12 refusals x 2
    // modes x 5 widths x 2 places, and the five host-measure notices.
    expect(new Set(recorded.map((r) => r.scene.h)).size).toBe(12 * 2 * 5 * 2 + 5)
    // `refusalCopy` is what draws the words, so a reason it has none for still reads.
    expect(refusalCopy({ code: 'malformed', reason: 'no-words-of-its-own' }).title).not.toBe('')
  })
})
