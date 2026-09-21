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

/**
 * The resource an entry names. OKF writes `- resource: <path>`, and half the
 * issues in this backlog were written as bare strings instead — which carry
 * exactly the same thing. Reading both is the difference between judging
 * those documents and silently skipping them: measured 2026-09-22, 11 of 17
 * open issues declared sources this check had been discarding.
 */
export function resourceOf(source) {
  return typeof source === 'string' ? source : source?.resource
}

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
      const resource = resourceOf(source)
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

/**
 * Unwrap an MCP `tools/call` payload, raising BOTH kinds of failure.
 *
 * A tool that refuses reports `result.isError` with the reason in `content`,
 * not a JSON-RPC `error` — so a reader that checks only the latter sees a
 * result with no `structuredContent` and treats it as an empty answer. That
 * is how this check came to report "nothing to report — 0 of 0" over a
 * workspace of 57 documents for as long as it did: `wb_document_get` became a
 * batch read taking `documentIds`, the caller kept sending `documentId`, and
 * every refusal was read as a document with no frontmatter.
 *
 * A check whose own breakage is indistinguishable from a clean result is
 * worse than no check, so this throws and the caller says why.
 */
export function unwrapToolResult(name, payload) {
  if (payload?.error) throw new Error(`${name}: ${payload.error.message}`)
  const result = payload?.result ?? {}
  if (result.isError === true) {
    const said = (result.content ?? [])
      .map((part) => part?.text)
      .filter((text) => typeof text === 'string')
      .join(' ')
      .trim()
    throw new Error(`${name}: ${said === '' ? 'the tool reported an error with no message' : said}`)
  }
  return result.structuredContent ?? {}
}

/**
 * Join a `wb_document_list` listing to a batch `wb_document_get` answer and
 * keep the issues.
 *
 * `unreadableSources` is the third silent skip: a document whose `sources`
 * yield no path at all — every entry an object with no `resource`, or a URL
 * git cannot judge — has made a declaration `collectStaleIssues` cannot read,
 * which is indistinguishable from having declared nothing. It is counted so
 * the caller can say so. Bare-string entries are NOT in it; they are read
 * (see `resourceOf`).
 */
export function issueDocumentsFrom(listed, fetched) {
  const byId = new Map((fetched?.documents ?? []).map((doc) => [doc.documentId, doc]))
  const documents = []
  const unreadableSources = []
  for (const entry of listed) {
    const front = byId.get(entry.documentId)?.frontmatter ?? {}
    if (front.type !== 'issue') continue
    // Unmodelled root keys ride in `facetsRaw` (ADR-0016); a document that
    // predates that, or that never declared any, simply has none.
    const sources = front.facetsRaw?.sources ?? []
    if (sources.length > 0 && !sources.some((source) => isCheckableResource(resourceOf(source)))) {
      unreadableSources.push(entry.path)
    }
    documents.push({
      documentId: entry.documentId,
      path: entry.path,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(front.generated?.at === undefined ? {} : { generatedAt: front.generated.at }),
      ...(front.generated?.by === undefined ? {} : { generatedBy: front.generated.by }),
      sources,
    })
  }
  return { documents, unreadableSources, failed: fetched?.failed ?? [] }
}
