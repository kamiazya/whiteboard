#!/usr/bin/env node
/**
 * Regenerates `src/emoji/catalog-data.ts` and `src/emoji/catalog-ja.ts` from
 * Unicode's own published data.
 *
 * The picker's rows are DERIVED from the standard rather than curated,
 * because "which two hundred emoji does this product like" has no defensible
 * answer and goes stale the moment Unicode ships a version. `emoji-test.txt`
 * already carries exactly the three things a searchable palette needs — the
 * character, its CLDR short name, and the group/subgroup it files under —
 * and it is published in CLDR order, which is the order a keyboard should
 * show them in.
 *
 * The Japanese index is CLDR's, pinned to a RELEASE tag rather than `main`:
 * the files carry no usable version of their own (`$Revision$`), so the tag
 * is the only thing that makes a regeneration reproducible.
 *
 *   node packages/plugin-visual/scripts/generate-emoji-catalog.mjs
 *   node packages/plugin-visual/scripts/generate-emoji-catalog.mjs --from <path> --ja <path> --ja-derived <path>
 *
 * Network is only needed for the default sources; the `--from` flags read
 * local copies, which is what CI would use if this ever became a checked
 * step. It is NOT a build step: the generated files are committed, the way
 * the vendored lucide geometry beside them is, so a clone builds offline.
 */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = 'https://unicode.org/Public/emoji/latest/emoji-test.txt'

/**
 * CLDR's Japanese annotations, in two files: the base set, and the DERIVED
 * set that covers the sequences (a ZWJ family, a flag) the base one does
 * not. Both are needed — measured, the two together cover all 1914 rows and
 * the base alone does not.
 */
const CLDR_TAG = 'release-48'
const CLDR_BASE = `https://raw.githubusercontent.com/unicode-org/cldr/${CLDR_TAG}/common/annotations/ja.xml`
const CLDR_DERIVED = `https://raw.githubusercontent.com/unicode-org/cldr/${CLDR_TAG}/common/annotationsDerived/ja.xml`

const EMOJI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'emoji')
const OUT = join(EMOJI_DIR, 'catalog-data.ts')
const OUT_JA = join(EMOJI_DIR, 'catalog-ja.ts')

/**
 * Skin-tone sequences are dropped: they are 2030 of the 3944 fully-qualified
 * rows and they add no distinct MEANING to a symbol on a box — five more
 * copies of a waving hand in a grid the size of a postcard is worse to
 * search, not more expressive. A person who wants one can still paste it
 * into free entry, which accepts any single grapheme.
 */
const SKIN_TONE = /skin tone/

/** `1F600 ; fully-qualified # 😀 E1.0 grinning face` */
const ROW = /^[0-9A-F ]+;\s*fully-qualified\s*#\s*(\S+)\s+E\d+\.\d+\s+(.+)$/

async function read(url, flag) {
  const at = process.argv.indexOf(flag)
  if (at !== -1) return readFile(process.argv[at + 1], 'utf8')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.text()
}

/**
 * `<annotation cp="X">a | b | c</annotation>` is the keyword list and
 * `<annotation cp="X" type="tts">name</annotation>` the display name. Both
 * are wanted: the name is what a person calls the thing, the keywords are
 * what they might type instead (👍 is サムズアップ, and also いいね).
 *
 * A two-line regex rather than an XML parser, because the shape is fixed,
 * published, and this is a hand-run generator — a dependency for it would
 * be carried by every install to be used by nobody.
 */
function annotations(text) {
  const found = new Map()
  // ONE pass over one alternation, never four passes in sequence: unescaping
  // `&amp;` first turns `&amp;lt;` into `&lt;` and the next replace turns
  // that into `<`, which is a double-unescape — the text said `&lt;` and the
  // parser produced a tag delimiter. CodeQL flags exactly this shape, and a
  // single pass cannot re-read its own output.
  const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  const decode = (value) =>
    value.replace(
      /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g,
      (whole, name, dec, hex) => {
        if (name !== undefined) return ENTITY[name]
        if (dec !== undefined) return String.fromCodePoint(Number(dec))
        if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16))
        return whole
      },
    )
  for (const m of text.matchAll(
    /<annotation cp="([^"]*)"(\s+type="tts")?>([^<]*)<\/annotation>/g,
  )) {
    const cp = decode(m[1])
    const entry = found.get(cp) ?? new Set()
    for (const term of decode(m[3]).split('|')) {
      const trimmed = term.trim()
      if (trimmed !== '') entry.add(trimmed)
    }
    found.set(cp, entry)
  }
  return found
}

function parse(text) {
  const version = text.match(/^# Version: (.+)$/m)?.[1]?.trim()
  if (version === undefined) throw new Error('source states no Version')
  const groups = new Map()
  let group = ''
  let subgroup = ''
  for (const line of text.split('\n')) {
    const isGroup = line.match(/^# group: (.+)$/)
    if (isGroup !== null) {
      group = isGroup[1].trim()
      continue
    }
    const isSubgroup = line.match(/^# subgroup: (.+)$/)
    if (isSubgroup !== null) {
      subgroup = isSubgroup[1].trim()
      continue
    }
    const row = line.match(ROW)
    if (row === null) continue
    const [, char, name] = row
    if (SKIN_TONE.test(name)) continue
    if (!groups.has(group)) groups.set(group, [])
    // Tab-separated, one row per line: the smallest encoding that still
    // reads as data in a diff. The subgroup travels as search KEYWORDS
    // rather than as a heading, and it earns that: measured over the
    // generated set, it takes `transport` from 0 matches to 85, `animal`
    // from 0 to 131, `sport` from 3 to 156 and `weather` from 0 to 47.
    groups.get(group).push(`${char}\t${name}\t${subgroup.replace(/-/g, ' ')}`)
  }
  if (groups.size === 0) throw new Error('source yielded no groups')
  return { version, groups }
}

const { version, groups } = parse(await read(SOURCE, '--from'))
const total = [...groups.values()].reduce((sum, rows) => sum + rows.length, 0)

const ja = annotations(await read(CLDR_BASE, '--ja'))
for (const [cp, terms] of annotations(await read(CLDR_DERIVED, '--ja-derived'))) {
  if (!ja.has(cp)) ja.set(cp, terms)
}

/**
 * CLDR's base file strips U+FE0F from every `cp`, and says so in its own
 * header — so a fully-qualified character from `emoji-test.txt` misses on
 * the first lookup and hits on the second. Silently taking the miss would
 * have left an index that looked fine and answered nothing for the
 * variation-selector rows.
 */
const japanese = []
let indexed = 0
for (const rows of groups.values()) {
  for (const row of rows) {
    const char = row.split('\t')[0]
    const terms = ja.get(char) ?? ja.get(char.replace(/\uFE0F/g, ''))
    if (terms === undefined) continue
    indexed += 1
    japanese.push(`${char}\t${[...terms].join(' ')}`)
  }
}
if (indexed < total) {
  // Not fatal, but never silent: a locale index that quietly covers half
  // the catalog is a search that quietly answers nothing for the other
  // half, and the shortfall is invisible in the generated file.
  process.stdout.write(`warning: ${total - indexed} of ${total} rows have no Japanese entry\n`)
}

const body = [...groups]
  .map(([label, rows]) => `  [${JSON.stringify(label)}, ${JSON.stringify(rows.join('\n'))}],`)
  .join('\n')

await writeFile(
  OUT,
  `/**
 * GENERATED — do not edit. Run \`node packages/plugin-visual/scripts/generate-emoji-catalog.mjs\`.
 *
 * Source: ${SOURCE} (UTS #51 emoji-test.txt), Unicode Emoji ${version}.
 * © Unicode, Inc. Distributed under the Unicode Terms of Use,
 * https://www.unicode.org/terms_of_use.html
 *
 * ${total} fully-qualified sequences in CLDR order, skin-tone variants
 * omitted. Each row is \`character<TAB>name<TAB>subgroup\`; the subgroup is
 * search keywords, not a heading.
 */

export const EMOJI_VERSION = ${JSON.stringify(version)}

export const EMOJI_GROUPS: ReadonlyArray<readonly [string, string]> = [
${body}
]
`,
  'utf8',
)

await writeFile(
  OUT_JA,
  `/**
 * GENERATED — do not edit. Run \`node packages/plugin-visual/scripts/generate-emoji-catalog.mjs\`.
 *
 * Japanese search index: CLDR ${CLDR_TAG} \`common/annotations/ja.xml\` plus
 * \`common/annotationsDerived/ja.xml\`.
 * © Unicode, Inc. SPDX-License-Identifier: Unicode-3.0
 *
 * ${indexed} of ${total} rows, as \`character<TAB>terms\` — each row's CLDR
 * display name and keywords, deduped, space-joined. It is a SEARCH index and
 * not a label set: what the picker shows is still the English short name,
 * because the UI around it is English.
 */

export const EMOJI_JA_TAG = ${JSON.stringify(CLDR_TAG)}

export const EMOJI_JA = ${JSON.stringify(japanese.join('\n'))}
`,
  'utf8',
)

// Formatted by the repo's own formatter rather than by this template
// matching it. A generated file is checked by `pnpm lint` like any other,
// and a template that has to reproduce biome's line-wrapping is a second
// formatter to keep in step — which drifts at the first print-width change
// and reports as a lint failure nobody caused.
execFileSync('pnpm', ['exec', 'biome', 'check', '--write', OUT, OUT_JA], { stdio: 'inherit' })

process.stdout.write(
  `${OUT}: ${total} emoji in ${groups.size} groups (Unicode ${version})\n` +
    `${OUT_JA}: ${indexed} indexed (CLDR ${CLDR_TAG})\n`,
)
