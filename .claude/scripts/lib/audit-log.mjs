// Ledger of autonomous-maintenance runs (.claude/audit-log.jsonl, tracked in
// git so every clone shares it). One JSON object per line: {kind, at}.
// Written by record-audit.mjs at the end of a fold; read by audit-nudge.mjs
// at session start.
const AUDIT_STALE_DAYS = 7

export function parseAuditLog(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

const RECORD_COMMAND = 'node .claude/scripts/record-audit.mjs audit-triage'
const LEDGER = '.claude/audit-log.jsonl'

/**
 * Audit-wave commits since `lastAt` that did not themselves append to the ledger. A wave that
 * recorded its run lands in a commit touching the ledger, so counting only the rest keeps a
 * correctly recorded fold silent. `git` runs one git invocation and returns its stdout.
 */
export function countUnrecordedWaves(lastAt, git) {
  const since = `--since=${lastAt}`
  const lines = (text) => text.split('\n').filter((line) => line !== '')
  const waves = lines(git(['log', since, '--regexp-ignore-case', '--grep=audit wave', '--format=%H']))
  const recorded = new Set(lines(git(['log', since, '--format=%H', '--', LEDGER])))
  return waves.filter((hash) => !recorded.has(hash)).length
}

export function formatNudge(entries, nowMs, unrecordedWaves = 0) {
  const audits = entries.filter((e) => e.kind === 'audit-triage')
  if (audits.length === 0) {
    return '[audit-nudge] no audit-triage run on record — standing problems (unwired features, architecture debt, contract drift, test gaps) are checked by nobody until one runs. Launch the audit-triage workflow when this session has idle capacity, then record it (see the audit-triage skill).'
  }
  const last = Math.max(...audits.map((e) => Date.parse(e.at)))
  const ageDays = Math.floor((nowMs - last) / 86_400_000)
  const lines = []
  if (ageDays > AUDIT_STALE_DAYS) {
    lines.push(
      `[audit-nudge] last audit-triage was ${ageDays} days ago (budget: ${AUDIT_STALE_DAYS}d) — run the audit-triage workflow when this session has idle capacity, then record it (see the audit-triage skill).`,
    )
  }
  if (unrecordedWaves > 0) {
    const noun = unrecordedWaves === 1 ? 'commit' : 'commits'
    lines.push(
      `[audit-nudge] ${unrecordedWaves} audit-wave ${noun} landed since the last recorded audit-triage — the fold skipped \`${RECORD_COMMAND}\`. Run it and commit ${LEDGER}.`,
    )
  }
  return lines.join('\n')
}
