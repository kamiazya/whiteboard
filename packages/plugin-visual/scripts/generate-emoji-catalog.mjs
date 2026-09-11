#!/usr/bin/env node
/**
 * Regenerates `src/emoji/catalog-data.ts` from Unicode's own emoji test data.
 *
 * The picker's rows are DERIVED from the standard rather than curated,
 * because "which two hundred emoji does this product like" has no defensible
 * answer and goes stale the moment Unicode ships a version. `emoji-test.txt`
 * already carries exactly the three things a searchable palette needs — the
 * character, its CLDR short name, and the group/subgroup it files under —
 * and it is published in CLDR order, which is the order a keyboard should
 * show them in.
 *
 *   node packages/plugin-visual/scripts/generate-emoji-catalog.mjs
 *   node packages/plugin-visual/scripts/generate-emoji-catalog.mjs --from <path>
 *
 * Network is only needed for the default source; `--from` reads a local
 * copy, which is what CI would use if this ever became a checked step. It
 * is NOT a build step: the generated file is committed, the way the
 * vendored lucide geometry beside it is, so a clone builds offline.
 */
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = 'https://unicode.org/Public/emoji/latest/emoji-test.txt'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'emoji', 'catalog-data.ts')

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

async function read() {
  const flag = process.argv.indexOf('--from')
  if (flag !== -1) return readFile(process.argv[flag + 1], 'utf8')
  const response = await fetch(SOURCE)
  if (!response.ok) throw new Error(`${SOURCE} answered ${response.status}`)
  return response.text()
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

const { version, groups } = parse(await read())
const total = [...groups.values()].reduce((sum, rows) => sum + rows.length, 0)

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

// Formatted by the repo's own formatter rather than by this template
// matching it. A generated file is checked by `pnpm lint` like any other,
// and a template that has to reproduce biome's line-wrapping is a second
// formatter to keep in step — which drifts at the first print-width change
// and reports as a lint failure nobody caused.
execFileSync('pnpm', ['exec', 'biome', 'check', '--write', OUT], { stdio: 'inherit' })

process.stdout.write(`${OUT}: ${total} emoji in ${groups.size} groups (Unicode ${version})\n`)
