// Which open issues name something that has changed since they were written.
//
// Pure, and filesystem-free by design: it takes documents and an `inspect`
// function and returns findings, so the six real cases it was built from can
// be replayed as fixtures without a repo. `stale-issues.mjs` supplies the real
// inspector (git) and the real documents (the daemon).
//
// What it is worth, measured on those six: four were caught, two were not.
// Both halves matter. The two misses share a shape — the fix landed in a file
// the issue never named — and that is the honest ceiling of `sources`: it says
// what a document is ABOUT, not where a fix will land. Nothing here can catch
// the other failure either, a document that was wrong when it was written.

/** OKF §6.2: a path-valued field may be an absolute URL, which git cannot judge. */
export function isCheckableResource(resource) {
  return typeof resource === 'string' && resource !== '' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(resource)
}

/**
 * §6.2 also allows a bundle-relative path beginning with `/`. The bundle root
 * is the repo root here, so the leading slash is dropped rather than being
 * handed to git as an absolute filesystem path.
 */
function toRepoRelative(resource) {
  return resource.startsWith('/') ? resource.slice(1) : resource
}

/**
 * @param documents `{ documentId, path, name?, generatedAt?, generatedBy?, sources }`
 * @param inspect `(repoRelativePath, sinceIso) => 'unchanged' | 'changed' | 'missing'`
 * @returns one finding per document that names something changed or gone
 */
export function collectStaleIssues(documents, inspect) {
  const findings = []
  for (const doc of documents) {
    // Both skips are silent on purpose. A document with nothing declared has
    // nothing to judge, and one with no stamp has no "since when" — which is
    // every document written before the trust family shipped. Reporting either
    // would make the check noise on every session start, and a check nobody
    // reads catches nothing.
    const sources = doc.sources ?? []
    if (sources.length === 0 || typeof doc.generatedAt !== 'string') continue

    const changed = []
    const missing = []
    for (const source of sources) {
      const resource = source?.resource
      if (!isCheckableResource(resource)) continue
      const target = toRepoRelative(resource)
      const verdict = inspect(target, doc.generatedAt)
      if (verdict === 'missing') missing.push(target)
      else if (verdict === 'changed') changed.push(target)
    }
    if (changed.length === 0 && missing.length === 0) continue

    findings.push({
      documentId: doc.documentId,
      path: doc.path,
      ...(doc.name === undefined ? {} : { name: doc.name }),
      generatedAt: doc.generatedAt,
      ...(doc.generatedBy === undefined ? {} : { generatedBy: doc.generatedBy }),
      changed,
      missing,
    })
  }
  return findings
}

/** One block per finding. `missing` leads: a deleted source is the surest signal. */
export function formatFindings(findings, total) {
  if (findings.length === 0) return ''
  const lines = [
    `[stale-issues] ${findings.length} of ${total} issue(s) name something that changed since they were written`,
    '',
  ]
  for (const finding of findings) {
    const who = finding.generatedBy === undefined ? '' : ` by ${finding.generatedBy}`
    lines.push(`  ${finding.name ?? finding.path}`)
    lines.push(`    ${finding.path} — written ${finding.generatedAt}${who}`)
    for (const path of finding.missing) lines.push(`    gone:    ${path}`)
    for (const path of finding.changed) lines.push(`    changed: ${path}`)
    lines.push('')
  }
  lines.push('  Re-read before acting on one. If it is already resolved, close it:')
  lines.push('  type: issue -> note, name prefixed "RESOLVED — " (see the ticketing skill).')
  return lines.join('\n')
}
