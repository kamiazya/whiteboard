// PreToolUse(Bash) hook: before `gh pr create`, when the diff changes a
// surface a human looks at, require the body to carry a figure OR to say why
// there is none.
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
// Fail-open everywhere it cannot see clearly: a body it cannot read, a repo
// it cannot diff, any command that is not `gh pr create`. A hook that blocks
// what it cannot inspect is a hook people learn to bypass.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

/** Tests and stories describe a surface; they are not the surface. */
const NOT_A_SURFACE = /\.(test|bench|spec|docs-snapshot)\.[cm]?[jt]sx?$/

/**
 * A figure. Markdown image, HTML img, or a bare attachment URL — a body
 * referencing a local screenshot path for `gh pr create --attach` to upload
 * carries the first, and a body assembled by hand may carry any of them.
 */
const HAS_FIGURE = /!\[[^\]]*\]\([^)]+\)|<img\s|https:\/\/github\.com\/user-attachments\//

/**
 * The stated-absence escape, and the REASON is the whole of it: a bare
 * "none" is the same omission with a sentence in front of it, which is the
 * shape this hook exists to stop one level up. Any of `—`, `–`, `-` or `:`
 * separates it, because insisting on an em dash makes the escape hostile to
 * type and the character is the first thing a keyboard drops.
 */
const STATES_NO_FIGURE = /visual evidence:\s*none\s*[—–:-]\s*\S{3}/i

let input
try {
  input = JSON.parse(readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}

const command = input?.tool_input?.command ?? ''
// At a command POSITION — start of line, or after a separator. Matching the
// bare text blocks `printf 'gh pr create …'`, which creates no PR, and a gate
// that fires on something harmless is one people route around.
if (!/(?:^|[\n;]|&&|\|\||\|)\s*(?:[A-Za-z_][\w]*=\S*\s+)*gh\s+pr\s+create\b/.test(command)) {
  process.exit(0)
}

/** Reads --body '<text>' / --body="<text>" / --body-file <path>. */
function readBody(cmd, cwd) {
  const file = cmd.match(/--body-file[= ]("([^"]*)"|'([^']*)'|[^\s'"]+)/)
  if (file) {
    const path = file[2] ?? file[3] ?? file[1]
    try {
      return readFileSync(resolve(cwd, path), 'utf8')
    } catch {
      return null
    }
  }
  const quoted = cmd.match(/--body[= ]("((?:[^"\\]|\\.)*)"|'([^']*)')/)
  if (quoted) return quoted[2] !== undefined ? quoted[2].replace(/\\(.)/g, '$1') : quoted[3]
  const bare = cmd.match(/--body[= ]([^\s'"]+)/)
  return bare ? bare[1] : null
}

try {
  const cdMatch = command.match(/(?:^|&&|;)\s*cd\s+([^\s'";&|]+)/)
  const where = cdMatch ? cdMatch[1] : process.cwd()
  const git = (args) => execFileSync('git', args, { cwd: where, encoding: 'utf8' }).trim()

  const body = readBody(command, where)
  // A body arriving by stdin, an editor, or --fill is not readable here.
  if (body === null) process.exit(0)
  if (HAS_FIGURE.test(body) || STATES_NO_FIGURE.test(body)) process.exit(0)

  const changed = git(['diff', '--name-only', 'origin/main...HEAD'])
    .split('\n')
    .filter(Boolean)
    .filter((file) => !NOT_A_SURFACE.test(file))
    .filter((file) => VISUAL_PATHS.some((re) => re.test(file)))
  if (changed.length === 0) process.exit(0)

  console.error(
    `[pre-pr-visual-evidence] this diff changes ${changed.length} file(s) a human looks at ` +
      `(${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''}), and the PR body ` +
      `carries no figure.\n` +
      `  • For a FIX, show the defect and the fix: render the same case both ways and compose with\n` +
      `      node .claude/scripts/compose-figure.mjs --before <a.png> --after <b.png> --out tmp/screenshots/figure.png\n` +
      `    (it refuses two identical panels, which is the trap that has produced a misleading figure before),\n` +
      `    then reference it as ![…](tmp/screenshots/figure.png) under a "## Visual repro" section\n` +
      `    and pass --attach tmp/screenshots/figure.png to \`gh pr create\` (gh ≥2.99.0) to upload it.\n` +
      `    See the visual-evidence skill.\n` +
      `  • For a new affordance, one capture of it is enough.\n` +
      `  • If a picture is genuinely the wrong evidence, say so in one line: "Visual evidence: none — <reason>".`,
  )
  process.exit(2)
} catch {
  process.exit(0)
}
