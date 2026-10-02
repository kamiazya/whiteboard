import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'
import { trackedFiles } from './tracked-files.js'

// Findings used to be filed as markdown files under `tmp/issues/`. That path
// is gitignored and retired: issues are whiteboard documents of `type: issue`
// (the `ticketing` skill). Prose references to the old path survived
// the move, in the testing guide and in skills a session loads before it
// files anything — so the instruction an agent actually read still sent its
// findings somewhere nobody looks. Nothing failed, because a retired path is
// just a string.
//
// The scan covers what a reader or an agent is TOLD things by: the
// user/contributor docs, `.claude/**` (skills, agents, rules), the workflow
// descriptions under `.claude/workflows` (a workflow's `description` is the
// text its caller reads) and AGENTS.md. The hyphenated and spaced spellings
// ("Tasks/tmp-issues") are the same instruction reworded, and survived a
// reword that only searched for the slash.
// Worktrees under `.claude/worktrees` are other checkouts of this same tree,
// so counting them would report one stale line once per worktree.
const RETIRED = 'tmp/issues'
const RETIRED_SPELLING = /tmp[-/_ ]issues/i

// Files that may spell the retired path, each for a reason, and each checked
// from the other side below: an exemption that no longer needs to exist is a
// hole in the scan.
const MAY_NAME_RETIRED_PATH: Record<string, string> = {
  '.claude/skills/ticketing/SKILL.md':
    'documents the tmp/ buckets, including that tmp/issues is legacy — it spells the path to retire it',
  'AGENTS.md':
    'the Source Comment Discipline tells authors NOT to point a source comment at tmp/issues',
}

function scannedUnder(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (path === '.claude/worktrees' || entry.name === 'node_modules') return []
      return scannedUnder(path)
    }
    return entry.name.endsWith('.md') ||
      (dir.startsWith('.claude/workflows') && entry.name.endsWith('.mjs'))
      ? [path]
      : []
  })
}

const scanned = [...scannedUnder('docs'), ...scannedUnder('.claude'), 'AGENTS.md']

describe('the retired tmp/issues path is not an instruction', () => {
  // Reached, not assumed: a scan over an empty list passes every assertion
  // below. 252 files at the time of writing; the floor is far enough under
  // that a pruned tree is still fine and a broken walk is not.
  it('scans the docs, the .claude Markdown, the workflow scripts and AGENTS.md', () => {
    expect(scanned.length).toBeGreaterThan(150)
    expect(scanned).toContain('docs/contributing/testing.md')
    expect(scanned).toContain('.claude/skills/ci-triage/SKILL.md')
    expect(scanned).toContain('AGENTS.md')
    expect(scanned).toContain('.claude/workflows/audit-triage.workflow.mjs')
    expect(scanned.some((path) => path.startsWith('.claude/worktrees'))).toBe(false)
  })

  it('appears in no scanned file outside the documented exemptions', () => {
    const offenders = scanned
      .filter((path) => !(path in MAY_NAME_RETIRED_PATH))
      .filter((path) => RETIRED_SPELLING.test(readFileSync(join(REPO_ROOT, path), 'utf8')))
    expect(
      offenders,
      'file findings as a whiteboard `type: issue` document (see the ticketing skill), not under tmp/issues',
    ).toEqual([])
  })

  it('every exemption still names the path, so none outlives its reason', () => {
    for (const path of Object.keys(MAY_NAME_RETIRED_PATH)) {
      expect(scanned, `${path} is no longer scanned`).toContain(path)
      expect(
        readFileSync(join(REPO_ROOT, path), 'utf8'),
        `${path} no longer names ${RETIRED}; drop its exemption`,
      ).toContain(RETIRED)
    }
  })
})

// `.claude/` is TRACKED (ADR-0003): the workflows, agents, skills and scripts
// are shared with every clone, and only `worktrees/` and `settings.local.json`
// stay per-machine. A header comment in `new-worktree.mjs` said the directory
// was "gitignored", which is the claim ADR-0003 reversed — and a script header
// is what a session reads before editing the script, so it is believed. The
// scan reads `.claude/` scripts and workflows, comment lines only; a line that
// calls `dist` or `.claude/worktrees` gitignored is true and is not the claim.
describe('`.claude/` is not described as gitignored', () => {
  const CLAIM = /\.claude\/?(?!worktrees|settings\.local)[^\n]{0,40}\bgitignored\b/i

  const headers = (): { file: string; line: string }[] =>
    trackedFiles(REPO_ROOT)
      .filter((path) => /^\.claude\/(scripts|workflows)\/.*\.mjs$/.test(path))
      .flatMap((file) =>
        readFileSync(join(REPO_ROOT, file), 'utf8')
          .split('\n')
          .filter((line) => /^\s*(\/\/|\*|\/\*)/.test(line))
          .map((line) => ({ file, line })),
      )

  it('reaches the script and workflow comments at all', () => {
    expect(new Set(headers().map(({ file }) => file)).size).toBeGreaterThan(30)
    expect(headers().some(({ line }) => /gitignored/.test(line))).toBe(true)
  })

  it('says no script or workflow comment calls .claude/ gitignored', () => {
    const wrong = headers()
      .filter(({ line }) => CLAIM.test(line))
      .map(({ file, line }) => `${file}: ${line.trim()}`)
    expect(wrong, '.claude/ is tracked in git — see ADR-0003').toEqual([])
  })
})
