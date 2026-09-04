// Quarantine ledger over test files: parse `QUARANTINE(...)` markers and
// judge them against Fowler's bounded-quarantine rule (cap + age), so a
// parked flaky test cannot silently become a permanent skip.
// Marker grammar, one line, directly above the skipped test:
//   // QUARANTINE(<YYYY-MM-DD> <issue-ref>): <reason>
// <issue-ref> names the whiteboard issue (e.g. wb:issues/foo) per the
// ticketing skill; the DATE is when parking started, and the budget is
// judged from it — not from git history, which a refactor rewrites.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const QUARANTINE_CAP = 8
export const QUARANTINE_MAX_AGE_DAYS = 14

const MARKER = /^\s*\/\/\s*QUARANTINE\(([^)]*)\):\s*(.*)$/

export function parseQuarantineMarkers(source, file) {
  const markers = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER.exec(lines[i])
    if (!m) continue
    const head = m[1].trim()
    const space = head.indexOf(' ')
    const date = space === -1 ? head : head.slice(0, space)
    const issue = space === -1 ? '' : head.slice(space + 1).trim()
    markers.push({ file, line: i + 1, date, issue, reason: m[2].trim() })
  }
  return markers
}

export function judgeQuarantine(markers, nowMs) {
  const problems = []
  for (const q of markers) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date) || !Number.isFinite(Date.parse(q.date))) {
      problems.push(`${q.file}:${q.line} QUARANTINE has no parseable YYYY-MM-DD date`)
      continue
    }
    if (q.issue === '') {
      problems.push(`${q.file}:${q.line} QUARANTINE names no issue — park it with a ticket or fix it`)
    }
    const ageDays = (nowMs - Date.parse(q.date)) / 86_400_000
    if (ageDays > QUARANTINE_MAX_AGE_DAYS) {
      problems.push(
        `${q.file}:${q.line} quarantined ${Math.floor(ageDays)}d — past the ${QUARANTINE_MAX_AGE_DAYS}d budget: fix it, or decide to delete it`,
      )
    }
  }
  if (markers.length > QUARANTINE_CAP) {
    problems.push(`${markers.length} quarantined tests exceed the cap of ${QUARANTINE_CAP}`)
  }
  return { ok: problems.length === 0, problems }
}

const SCAN_ROOTS = ['apps/web/src', 'packages', 'tools']
const TEST_FILE = /\.test\.(ts|tsx|mts|mjs)$/

export function scanRepoQuarantine(repoRoot = join(import.meta.dirname, '../../..')) {
  const markers = []
  let scannedFiles = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (TEST_FILE.test(entry.name)) {
        scannedFiles++
        markers.push(...parseQuarantineMarkers(readFileSync(path, 'utf8'), path))
      }
    }
  }
  for (const root of SCAN_ROOTS) walk(join(repoRoot, root))
  return { markers, scannedFiles }
}
