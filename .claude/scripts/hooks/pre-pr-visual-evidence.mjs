// PreToolUse(Bash) hook: before a PR is created — `gh pr create`, or the REST
// `gh api -X POST …/pulls` a web session uses (hook-command-lib.mjs) — when
// the diff changes a surface a human looks at, require the body to carry a
// figure OR to say why there is none.
//
// AGENTS.md has asked for visual evidence in prose since the rule was
// written, and the practice hollowed out anyway — the observed shape is a
// `## Visual repro` heading with a single "after" capture for a change that
// is a fix, which satisfies a reader skimming for the section while showing
// the reviewer nothing they could not have assumed. Prose cannot catch that
// because nobody is asked at the moment the body is written; this hook is
// the moment.
//
// It does not judge whether a figure is GOOD — a hook cannot see whether the
// panels differ or whether the before is real (that is what
// `.claude/scripts/compose-figure.mjs` refuses to let go wrong, and what the
// `visual-evidence` skill describes). It only makes the ABSENCE a stated
// decision instead of an omission, the same way the design schema's `none:`
// and `foundation:` sentinels do.
//
// Fail-open everywhere it cannot see clearly: a repo it cannot diff, any
// command that creates no PR, and a `gh pr create` whose body it cannot read
// (an editor, `--fill`, stdin). A hook that blocks what it cannot inspect is a
// hook people learn to bypass. The one exception is a REST create whose body
// arrives where this hook cannot read it — on stdin from another command, or
// from a file that is not there: a web session has no other gate behind it, so
// on a diff that needs a figure that blocks, naming the forms it can read.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { prActionFromHookInput } from '../hook-command-lib.mjs'

/**
 * Paths whose diff a human can SEE the result of. Deliberately narrow: an
 * over-broad matcher fires on wiring-only changes, and a gate that cries
 * wolf gets bypassed rather than obeyed — which is how the prose rule this
 * replaces stopped being followed.
 */
const VISUAL_PATHS = [
  /^apps\/web\/src\/.*\.tsx$/,
  /^apps\/web\/src\/.*\.css$/,
  /^packages\/canvas-viewer\/src\/.*\.tsx$/,
  /^packages\/canvas-render\/src\//,
]

/**
 * Tests, stories and test PLUMBING describe a surface; they are not the
 * surface. The `test-utils/` segment is here because `canvas-render`'s entry
 * in the list above is the whole package, so a three-line fast-check
 * configuration under it was reported as "a file a human looks at" and asked
 * for a figure of itself.
 */
const NOT_A_SURFACE =
  /\.(test|bench|spec|docs-snapshot)\.[cm]?[jt]sx?$|(^|\/)(test-utils|__fixtures__|__mocks__)\//

/**
 * A figure: a markdown image or HTML img whose source is a URL, or a bare
 * attachment URL. A LOCAL path is not one — nothing uploads it (`gh image`
 * replaced `--attach`, which used to), so on GitHub it is a broken image that
 * reads like evidence here.
 */
const HAS_FIGURE =
  /!\[[^\]]*\]\(https?:\/\/[^)]+\)|<img\s[^>]*src=["']https?:|https:\/\/github\.com\/user-attachments\//

/**
 * The stated-absence escape, and the REASON is the whole of it: a bare
 * "none" is the same omission with a sentence in front of it, which is the
 * shape this hook exists to stop one level up. Any of `—`, `–`, `-` or `:`
 * separates it, because insisting on an em dash makes the escape hostile to
 * type and the character is the first thing a keyboard drops.
 */
const STATES_NO_FIGURE = /visual evidence:\s*none\s*[—–:-][ \t]*(\S.*)/i

/** At least three non-space characters of REASON — see `statesNoFigure`. */
const MIN_REASON_CHARS = 3

/**
 * Whether the body states a reason rather than merely the word "none".
 *
 * The length is counted over the reason with whitespace removed, which is
 * the fix for a real defect: the rule was `\S{3}` directly in the pattern,
 * meaning THREE CONSECUTIVE non-space characters immediately after the dash.
 * A reason beginning "a " or "an " therefore failed — measured at three of
 * five real skip lines written in one session — and the cheapest way out was
 * to reword until the regex was happy, which teaches that the rule is about
 * the wording rather than about deciding.
 */
function statesNoFigure(body) {
  const reason = body.match(STATES_NO_FIGURE)?.[1]?.trim() ?? ''
  return reason.replace(/\s+/g, '').length >= MIN_REASON_CHARS
}

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

// Matched at a command position by the shared reader: the bare text would block
// `printf 'gh pr create …'`, which creates no PR.
const create = prActionFromHookInput(input, { action: 'create' })
if (create === null) process.exit(0)

/** Whether `gh image` (a third-party extension, not part of gh) is installed. */
function hasGhImage(cwd) {
  try {
    execFileSync('gh', ['image', '--help'], { cwd, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

try {
  const where = create.cd ?? process.cwd()
  const git = (args) => execFileSync('git', args, { cwd: where, encoding: 'utf8' }).trim()

  const { body } = create
  // A `gh pr create` body arriving by stdin, an editor, or --fill is not readable here.
  if (body === null) process.exit(0)
  if ('text' in body && (HAS_FIGURE.test(body.text) || statesNoFigure(body.text))) process.exit(0)

  const changed = git(['diff', '--name-only', 'origin/main...HEAD'])
    .split('\n')
    .filter(Boolean)
    .filter((file) => !NOT_A_SURFACE.test(file))
    .filter((file) => VISUAL_PATHS.some((re) => re.test(file)))
  if (changed.length === 0) process.exit(0)
  const files = `${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''}`

  if ('unreadable' in body) {
    console.error(
      `[pre-pr-visual-evidence] this diff changes ${changed.length} file(s) a human looks at ` +
        `(${files}), and this hook could not read the body of ${create.via} (${body.unreadable}). ` +
        `Pass the body where it can be read, then re-run: -f body='<text>', -F body=@<file>, ` +
        `--input <file.json>, or -F body=@- fed by a heredoc in the same command.`,
    )
    process.exit(2)
  }

  const NO_FIGURE =
    `  • If a picture is genuinely the wrong evidence — or cannot be uploaded from here — say so in one line:\n` +
    `    "Visual evidence: none — <reason>".`
  const HOW_TO_MAKE_ONE =
    `  • For a FIX, show the defect and the fix: render the same case both ways and compose with\n` +
    `      node .claude/scripts/compose-figure.mjs --before <a.png> --after <b.png> --out tmp/screenshots/figure.png\n` +
    `    (it refuses two identical panels, which is the trap that has produced a misleading figure before),\n` +
    `    then upload it with \`gh image tmp/screenshots/figure.png\` and paste the markdown it prints\n` +
    `    under a "## Visual repro" section (a local path is not uploaded by anything).\n` +
    `    See the visual-evidence skill.\n` +
    `  • For a new affordance, one capture of it is enough.`
  const uploaderInstalled = hasGhImage(where)
  // The upload step needs an extension a fresh machine lacks, so the escape that
  // always works comes first when it is missing rather than last.
  const remedy = uploaderInstalled
    ? `${HOW_TO_MAKE_ONE}\n${NO_FIGURE}`
    : `${NO_FIGURE}\n` +
      `  • \`gh image\` is not installed here, and it is what uploads a figure: \`gh extension install drogers0/gh-image\`,\n` +
      `    then \`gh image check-token\` (it uses a logged-in browser session; see the visual-evidence skill).\n` +
      HOW_TO_MAKE_ONE
  console.error(
    `[pre-pr-visual-evidence] this diff changes ${changed.length} file(s) a human looks at ` +
      `(${files}), and the PR body ` +
      `carries no figure.\n${remedy}`,
  )
  process.exit(2)
} catch {
  process.exit(0)
}
