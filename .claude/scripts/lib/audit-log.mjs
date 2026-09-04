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

export function formatNudge(entries, nowMs) {
  const audits = entries.filter((e) => e.kind === 'audit-triage')
  if (audits.length === 0) {
    return '[audit-nudge] no audit-triage run on record — standing problems (unwired features, architecture debt, contract drift, test gaps) are checked by nobody until one runs. Launch the audit-triage workflow when this session has idle capacity, then record it (see the audit-triage skill).'
  }
  const last = Math.max(...audits.map((e) => Date.parse(e.at)))
  const ageDays = Math.floor((nowMs - last) / 86_400_000)
  if (ageDays <= AUDIT_STALE_DAYS) return ''
  return `[audit-nudge] last audit-triage was ${ageDays} days ago (budget: ${AUDIT_STALE_DAYS}d) — run the audit-triage workflow when this session has idle capacity, then record it (see the audit-triage skill).`
}
