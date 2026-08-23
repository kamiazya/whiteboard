#!/usr/bin/env node
// Compose a before/after figure for a PR, and REFUSE when the two panels are
// identical.
//
// The refusal is the reason this exists. The expensive half of visual
// evidence is producing the "before" — reverting the change, re-rendering,
// putting it back — and every way of getting it wrong (a `git stash push` on
// a path with nothing to stash, a revert that did not take, a screenshot
// overwritten by the second run) fails the same way: two files that look
// like a before and an after and are the same picture. Composed and
// uploaded, that figure tells a reviewer the change did nothing, or is
// skimmed past as if it showed something. Checking by hand is one `cmp`
// nobody remembers.
//
// Everything else here is convenience. Labels default to plain "before" /
// "after"; --ring draws the same rectangle on both panels so the reader is
// not asked to spot the difference unaided.
//
// Usage:
//   node .claude/scripts/compose-figure.mjs \
//     --before tmp/screenshots/before.png --after tmp/screenshots/after.png \
//     --out tmp/screenshots/figure.png \
//     [--before-label "…"] [--after-label "…"] [--ring x1,y1,x2,y2]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

const BEFORE_COLOUR = '#c0392b'
const AFTER_COLOUR = '#1e8449'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1]
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

function fail(message) {
  console.error(`[compose-figure] ${message}`)
  process.exit(1)
}

const beforePath = arg('before')
const afterPath = arg('after')
const outPath = arg('out')
if (!beforePath || !afterPath || !outPath) {
  fail('usage: --before <png> --after <png> --out <png> [--before-label …] [--after-label …] [--ring x1,y1,x2,y2]')
}

const read = (path) => {
  try {
    return readFileSync(path)
  } catch {
    return fail(`cannot read ${path}`)
  }
}
const beforeBytes = read(beforePath)
const afterBytes = read(afterPath)

/**
 * Identity by PIXELS, not by bytes. Two renders of the same picture can differ
 * in a comment, a timestamp, or a compression choice, and a byte compare then
 * reports them as a real before/after — which is precisely the case this
 * script exists to refuse. `identify -format '%#'` is ImageMagick's signature
 * over the decoded image, so it ignores everything that is not the picture.
 * Falls back to bytes if ImageMagick cannot read the file; a fallback that
 * catches less is better than a crash that catches nothing.
 */
const pixelSignature = (path) => {
  try {
    return execFileSync('identify', ['-format', '%#', path], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return null
  }
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const beforeSignature = pixelSignature(beforePath) ?? digest(beforeBytes)
const afterSignature = pixelSignature(afterPath) ?? digest(afterBytes)
const beforeDigest = beforeSignature.slice(0, 8)
const afterDigest = afterSignature.slice(0, 8)

if (beforeSignature === afterSignature) {
  fail(
    `the two panels are the same picture (${beforeDigest}). Nothing was re-rendered, so a figure built ` +
      `from them would show one picture under both labels.\n` +
      `  Check that the "before" run actually had the change reverted — a \`git stash push\` on a ` +
      `path with nothing to stash succeeds silently, and a committed change needs ` +
      `\`git checkout <base> -- <file>\` instead.`,
  )
}

const beforeLabel = arg('before-label', 'before')
const afterLabel = arg('after-label', 'after')
const ring = arg('ring')

const magick = (args) => {
  try {
    execFileSync('convert', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (err) {
    fail(`ImageMagick failed: ${String(err.stderr ?? err.message).trim()}`)
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'compose-figure-'))
try {
  const panels = []
  for (const [side, path, label, colour] of [
    ['before', beforePath, beforeLabel, BEFORE_COLOUR],
    ['after', afterPath, afterLabel, AFTER_COLOUR],
  ]) {
    // Each band is built at ITS OWN panel's width. A change is allowed to
    // resize what it renders, and a band sized from the other panel crops
    // the label — silently, in the half of the figure that is the point.
    const width = Number(
      execFileSync('identify', ['-format', '%w', path], { encoding: 'utf-8' }).trim(),
    )
    const lbl = join(scratch, `lbl-${side}.png`)
    const panel = join(scratch, `panel-${side}.png`)
    magick([
      '-background',
      'white',
      '-fill',
      colour,
      '-font',
      'DejaVu-Sans-Bold',
      '-pointsize',
      '17',
      '-size',
      `${width}x30`,
      '-gravity',
      'west',
      `label:  ${label}`,
      lbl,
    ])
    if (ring) {
      const [x1, y1, x2, y2] = ring.split(',').map((n) => Number(n.trim()))
      magick([
        path,
        '-stroke',
        BEFORE_COLOUR,
        '-strokewidth',
        '2',
        '-fill',
        'none',
        '-draw',
        `roundrectangle ${x1},${y1} ${x2},${y2} 3,3`,
        panel,
      ])
    } else {
      magick([path, panel])
    }
    panels.push(lbl, panel)
  }
  mkdirSync(dirname(outPath), { recursive: true })
  magick([...panels, '-append', '-bordercolor', '#d9d9d9', '-border', '1', outPath])
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// The digests are for the PR body: they are what lets a reader confirm the
// panels were two different renders rather than one file used twice.
console.log(`[compose-figure] wrote ${outPath}`)
console.log(`  before ${beforeDigest}  after ${afterDigest}`)
console.log(`  next: gh image ${outPath}   → paste under a "## Visual repro" heading`)
