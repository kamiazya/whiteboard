/**
 * Fences are tracked line by line (a fence closes on its own marker character,
 * at least as long as the opener) because a regex over the whole text
 * mis-pairs backtick runs the moment one fence is nested in a longer one.
 */
function partition(markdown: string): { prose: string[]; fenced: string[] } {
  const prose: string[] = []
  const fenced: string[] = []
  let fence: string | null = null
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence === null) {
      if (marker === undefined) prose.push(line)
      else fence = marker
    } else if (marker?.[0] === fence[0] && marker.length >= fence.length) {
      fence = null
    } else {
      fenced.push(line)
    }
  }
  return { prose, fenced }
}

/**
 * The text of a Markdown document a reader would TYPE: fenced-block bodies (minus
 * their shell comments) and inline code spans, with the surrounding prose dropped. A sentence like "via
 * pnpm lockfile" names no command, so scanning the whole document for
 * `pnpm <word>` would report it as one.
 */
export function codeText(markdown: string): string {
  const { prose, fenced } = partition(markdown)
  const spans = prose.flatMap((line) => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ''))
  // A comment inside a fence is prose ("# pnpm is pinned by ...").
  const commands = fenced.map((line) => line.replace(/(^|\s)#(\s.*)?$/, ''))
  return [...spans, ...commands].join('\n')
}

/** What a reader reads as prose: no fenced blocks and no inline code spans, where an example link is not a link. */
export function proseText(markdown: string): string {
  return partition(markdown)
    .prose.join('\n')
    .replace(/`[^`\n]+`/g, '')
}
