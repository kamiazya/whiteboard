/**
 * What tokenising one fenced code block costs, before and after the default
 * highlighter's cost budget — the call every `wb_scene_render`, snapshot and
 * SVG/PNG export makes for each registered-language fence, synchronously.
 *
 * Run (from packages/mcp-server):
 *   node --import tsx/esm scripts/measure/highlight-token-cost.mjs [--full]
 *
 * `before` calls lowlight directly with the same grammars, which is what the
 * seam did unconditionally; `after` calls canvas-render's `highlightCode`,
 * which prices the fence first and renders one over budget plain (`plain`
 * column). Times are the median of three calls, in milliseconds. `before` is
 * skipped past 32 Ki characters of pathological input unless `--full` is
 * given: a 256 Ki identifier runs for minutes there.
 *
 * Measured on Node 22 (one machine, ms):
 *
 * | grammar    | input                        | before | after | plain |
 * |------------|------------------------------|--------|-------|-------|
 * | javascript | 'a' x 4096                   |     56 |    45 | no    |
 * | javascript | 'a' x 16384                  |    797 |     0 | yes   |
 * | javascript | 'a' x 32768                  |   3231 |     0 | yes   |
 * | typescript | 'a' x 4096                   |     86 |   117 | no    |
 * | typescript | 'a' x 32768                  |   7234 |     0 | yes   |
 * | typescript | 4 x 2048-char identifiers    |    124 |   140 | no    |
 * | bash       | 'a' x 32768                  |   1307 |     0 | yes   |
 * | yaml       | 'a ' x 4096 on one line      |     80 |    62 | no    |
 * | yaml       | 'a ' x 16384 on one line     |    742 |     1 | yes   |
 * | javascript | ordinary 8 Ki                |      8 |     6 | no    |
 * | typescript | ordinary 256 Ki              |    201 |   262 | no    |
 * | yaml       | ordinary 256 Ki              |    168 |   185 | no    |
 *
 * The slowest fence still highlighted is one at the budget (~140ms in
 * typescript); `before` for 'a' x 262144 in javascript was 192s.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { highlightCode } from '../../../canvas-render/src/highlight/lowlight.ts'

const full = process.argv.includes('--full')

// highlight.js and lowlight are canvas-render's dependencies, not this
// package's, so they are resolved from there.
const fromRender = createRequire(new URL('../../../canvas-render/package.json', import.meta.url))
const load = async (specifier) =>
  (await import(pathToFileURL(fromRender.resolve(specifier)).href)).default
const { createLowlight } = await import(pathToFileURL(fromRender.resolve('lowlight')).href)
const lowlight = createLowlight({
  bash: await load('highlight.js/lib/languages/bash'),
  javascript: await load('highlight.js/lib/languages/javascript'),
  python: await load('highlight.js/lib/languages/python'),
  typescript: await load('highlight.js/lib/languages/typescript'),
  yaml: await load('highlight.js/lib/languages/yaml'),
})

const ordinaryLine = 'export const someLongerIdentifierName = computeValue(input, "text") // note\n'
const ordinary = (chars) => ordinaryLine.repeat(Math.ceil(chars / ordinaryLine.length))

const CASES = [
  ['javascript', "'a' x 4096", 'a'.repeat(4096), false],
  ['javascript', "'a' x 16384", 'a'.repeat(16384), true],
  ['javascript', "'a' x 32768", 'a'.repeat(32768), true],
  ['javascript', "'a' x 262144", 'a'.repeat(262144), true],
  ['typescript', "'a' x 4096", 'a'.repeat(4096), false],
  ['typescript', "'a' x 32768", 'a'.repeat(32768), true],
  ['typescript', '4 x 2048-char identifiers', `${'a'.repeat(2048)}\n`.repeat(4), false],
  ['typescript', '64 x 4096-char identifiers', `${'a'.repeat(4096)}\n`.repeat(64), true],
  ['javascript', '256 x 1024-char identifiers', `${'a'.repeat(1024)}\n`.repeat(256), true],
  ['bash', "'a' x 32768", 'a'.repeat(32768), true],
  ['yaml', "'a ' x 4096 on one line", 'a '.repeat(4096), false],
  ['yaml', "'a ' x 16384 on one line", 'a '.repeat(16384), true],
  ['javascript', 'ordinary 8 Ki', ordinary(8192), false],
  ['typescript', 'ordinary 256 Ki', ordinary(262144), false],
  ['yaml', 'ordinary 256 Ki', ordinary(262144), false],
  ['python', "'a' x 32768", 'a'.repeat(32768), false],
]

function median(run, times) {
  const samples = []
  let result
  for (let i = 0; i < times; i += 1) {
    const start = performance.now()
    result = run()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return { ms: samples[Math.floor(samples.length / 2)], result }
}

// Warm both paths so the first row does not carry JIT start-up.
lowlight.highlight('typescript', ordinary(4096))
highlightCode('typescript', ordinary(4096))

console.log('| grammar | input | chars | before ms | after ms | plain |')
console.log('|---|---|---|---|---|---|')
for (const [lang, label, source, slow] of CASES) {
  const skipBefore = slow && source.length > 32768 && !full
  let before = '(skipped)'
  if (!skipBefore) {
    const runs = slow ? 1 : 3
    before = median(() => lowlight.highlight(lang, source), runs).ms.toFixed(0)
  }
  const after = median(() => highlightCode(lang, source), 3)
  console.log(
    `| ${lang} | ${label} | ${source.length} | ${before} | ${after.ms.toFixed(0)} | ${after.result === undefined ? 'yes' : 'no'} |`,
  )
}
