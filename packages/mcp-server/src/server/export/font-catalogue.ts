import { fontCatalogueItemSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/fonts'
import { z } from 'zod'

/**
 * The one host the font installer will ever talk to.
 *
 * ADR-0012 decided the daemon takes a family ID and builds the request itself,
 * rather than accepting a URL and validating it. That is why this is a
 * constant and not configuration: "where can this reach" is a property of the
 * code, not of a validator someone has to keep correct.
 *
 * `google/fonts` is the Google Fonts catalogue's own repository, and serving
 * from it keeps the download to ONE hop. The `fonts.googleapis.com` CSS API is
 * two — it answers with a stylesheet naming files on `fonts.gstatic.com` — and
 * a fetch whose destination comes from a response body is the thing worth not
 * building. It also only offers `woff2`, which resvg's font database cannot
 * decode.
 */
export const FONT_SOURCE_ORIGIN = 'https://raw.githubusercontent.com'

const FONT_SOURCE_BASE = `${FONT_SOURCE_ORIGIN}/google/fonts/main/`

/**
 * The published item plus the one field the browser has no business seeing.
 *
 * Extended from the HTTP contract rather than declared beside it: the two
 * would otherwise drift, which is the exact failure the Zod-single-source rule
 * exists to prevent. `installed` is omitted because it is per-daemon state
 * answered at request time, not a property of the catalogue.
 */
export const fontCatalogueEntrySchema = fontCatalogueItemSchema.omit({ installed: true }).extend({
  /** Path within the source repository. Joined onto the pinned base. */
  path: z.string().min(1),
})

export type FontCatalogueEntry = z.infer<typeof fontCatalogueEntrySchema>

/**
 * Every font a user can install, as data.
 *
 * One face per script rather than a style choice: this list exists to stop
 * exports rendering as tofu, and a second weight of a script already covered
 * fixes nothing. Noto because it is the family with systematic script
 * coverage, and all of it is OFL-1.1.
 */
export const FONT_CATALOGUE: readonly FontCatalogueEntry[] = [
  {
    id: 'noto-sans-jp',
    family: 'Noto Sans JP',
    scripts: ['Japanese'],
    license: 'OFL-1.1',
    approxBytes: 9_589_900,
    path: 'ofl/notosansjp/NotoSansJP[wght].ttf',
  },
  {
    id: 'noto-sans-sc',
    family: 'Noto Sans SC',
    scripts: ['Chinese (Simplified)'],
    license: 'OFL-1.1',
    approxBytes: 17_772_300,
    path: 'ofl/notosanssc/NotoSansSC[wght].ttf',
  },
  {
    id: 'noto-sans-tc',
    family: 'Noto Sans TC',
    scripts: ['Chinese (Traditional)'],
    license: 'OFL-1.1',
    approxBytes: 11_941_968,
    path: 'ofl/notosanstc/NotoSansTC[wght].ttf',
  },
  {
    id: 'noto-sans-kr',
    family: 'Noto Sans KR',
    scripts: ['Korean'],
    license: 'OFL-1.1',
    approxBytes: 10_414_588,
    path: 'ofl/notosanskr/NotoSansKR[wght].ttf',
  },
  {
    id: 'noto-sans-thai',
    family: 'Noto Sans Thai',
    scripts: ['Thai'],
    license: 'OFL-1.1',
    approxBytes: 218_652,
    path: 'ofl/notosansthai/NotoSansThai[wdth,wght].ttf',
  },
  {
    id: 'noto-sans-devanagari',
    family: 'Noto Sans Devanagari',
    scripts: ['Devanagari'],
    license: 'OFL-1.1',
    approxBytes: 647_144,
    path: 'ofl/notosansdevanagari/NotoSansDevanagari[wdth,wght].ttf',
  },
  {
    id: 'noto-sans-arabic',
    family: 'Noto Sans Arabic',
    scripts: ['Arabic'],
    license: 'OFL-1.1',
    approxBytes: 844_676,
    path: 'ofl/notosansarabic/NotoSansArabic[wdth,wght].ttf',
  },
  {
    id: 'noto-sans-hebrew',
    family: 'Noto Sans Hebrew',
    scripts: ['Hebrew'],
    license: 'OFL-1.1',
    approxBytes: 112_640,
    path: 'ofl/notosanshebrew/NotoSansHebrew[wdth,wght].ttf',
  },
]

export function fontCatalogueEntry(id: string): FontCatalogueEntry | undefined {
  return FONT_CATALOGUE.find((entry) => entry.id === id)
}

/**
 * The single URL the installer may request for this entry.
 *
 * `new URL` percent-encodes the `[wght]` in Google's variable-font file names,
 * which is what the source expects. It also resolves a `path` that starts with
 * `/` or `//` against the *authority* rather than the base path, so an entry
 * spelled `//example.com/x` would silently retarget the download — hence the
 * origin is re-checked here rather than only in a test, which only covers the
 * entries that exist today.
 */
export function fontDownloadUrl(entry: FontCatalogueEntry): string {
  const url = new URL(entry.path, FONT_SOURCE_BASE)
  if (url.origin !== FONT_SOURCE_ORIGIN) {
    throw new Error(`Font catalogue entry ${entry.id} resolves outside ${FONT_SOURCE_ORIGIN}.`)
  }
  return url.toString()
}
