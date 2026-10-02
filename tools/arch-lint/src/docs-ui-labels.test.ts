/**
 * A tutorial or how-to names a control in bold, and a reader hunts the screen
 * for that exact string. Nothing compiles the sentence, so a label renamed in
 * the app (or misremembered when written) sends them looking for a control
 * that is not there: the getting-started tutorial said **Name and location…**
 * for a menu entry that reads "Name and folder…", with every test green.
 *
 * The check is presence: a short bold phrase must appear somewhere in the web
 * app's own source. Bold is also used for emphasis, so the candidates are held
 * narrow (a title-cased phrase of at most four words, no code, link or
 * punctuation) and what is left over is a ledger of phrases that are NOT this
 * app's UI, each with its reason. The ledger is held from the other side too:
 * an entry that now matches the app, or that no doc says any more, fails.
 *
 * Presence is deliberately weak: it cannot tell a label from a comment that
 * happens to contain the words. It catches the failure that happens, which is
 * a phrase that exists nowhere.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

const GUIDE_DIRS = ['docs/how-to', 'docs/tutorials'] as const

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    // A README is an index whose bold entries are page titles, not controls.
    return entry.name.endsWith('.md') && entry.name !== 'README.md' ? [path] : []
  })
}

const appSource = walkSourceFiles(join(REPO_ROOT, 'apps/web/src'))
  .filter((path) => !isTestPath(path))
  .map((path) => readFileSync(path, 'utf-8'))
  .join('\n')
  .toLowerCase()

interface Candidate {
  readonly key: string
  readonly segment: string
}

/** Bold phrases that read as a control's name, one per `→`/`>` step of a path. */
function candidates(): Candidate[] {
  return GUIDE_DIRS.flatMap((dir) => markdownFiles(join(REPO_ROOT, dir))).flatMap((path) => {
    const rel = relative(REPO_ROOT, path)
    const text = readFileSync(path, 'utf-8')
    return [...text.matchAll(/\*\*([^*\n]+?)\*\*/g)].flatMap((match) => {
      const phrase = (match[1] ?? '').replace(/(…|\.\.\.)$/, '')
      if (/[`[\]()]/.test(phrase) || /[.:;!?,]$/.test(phrase)) return []
      if (phrase.split(/\s+/).length > 4 || !/^\p{Lu}/u.test(phrase)) return []
      return phrase
        .split(/\s*(?:→|>)\s*/)
        .filter((segment) => segment !== '')
        .map((segment) => ({ key: `${rel}::${segment}`, segment }))
    })
  })
}

/** Bold in these guides that is emphasis or somebody else's UI, not a control of this app. */
const NOT_THIS_APPS_UI: Readonly<Record<string, string>> = {
  'docs/how-to/connect-to-local-daemon.md::Developer mode':
    "the browser's own extensions page, where the unpacked extension is loaded",
  'docs/how-to/connect-to-local-daemon.md::Load unpacked':
    "the browser's own extensions page, where the unpacked extension is loaded",
  'docs/how-to/choose-a-theme.md::Yomogi':
    'a font family from the downloadable catalogue, not a label of the app',
  'docs/how-to/define-your-own-stencils.md::One library per workspace':
    'a bold lead-in to a constraint, not a control',
  'docs/how-to/self-host-with-docker.md::Backup': 'a bold lead-in to a section of prose',
  'docs/how-to/self-host-with-docker.md::In the sign-in configuration':
    'a bold lead-in to a sentence about configuration, not a control',
  'docs/how-to/view-canvas-in-chat.md::Phase A': "the name of a stage of a feature's roadmap",
}

const found = candidates()
const missing = found.filter(({ segment }) => !appSource.includes(segment.toLowerCase()))

describe('the controls a guide names in bold exist in the app', () => {
  // A scan over nothing passes: the guides name dozens of controls, and a
  // count far below that means the extractor stopped matching.
  it('finds the controls the guides name, and most of them are in the app', () => {
    expect(found.length).toBeGreaterThan(40)
    expect(found.length - missing.length).toBeGreaterThan(30)
  })

  it('names no control that appears nowhere in the web app', () => {
    const unknown = missing.filter(({ key }) => !(key in NOT_THIS_APPS_UI)).map(({ key }) => key)
    expect(unknown).toEqual([])
  })

  it('keeps no ledger entry for a phrase the guides no longer say or the app now has', () => {
    const stillMissing = new Set(missing.map(({ key }) => key))
    expect(Object.keys(NOT_THIS_APPS_UI).filter((key) => !stillMissing.has(key))).toEqual([])
  })
})
