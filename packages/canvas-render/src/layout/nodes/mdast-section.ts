import type { MdastFlowContent, MdastRoot } from '@kamiazya/whiteboard-model/mdast'

/**
 * The section a `#fragment` names in a markdown body: the first top-level
 * heading whose text is the fragment, through everything before the next
 * heading of the same or a shallower depth. Exact text first, then
 * case-insensitive, then nothing — the reading Obsidian gives `[[note#Heading]]`,
 * so a body written there means the same thing here.
 */
export function selectMarkdownSection(root: MdastRoot, fragment: string): MdastRoot | undefined {
  const wanted = fragment.trim()
  if (wanted.length === 0) return undefined
  const texts = root.children.map((child) =>
    child.type === 'heading' ? plainText(child.children).trim() : undefined,
  )
  let start = texts.indexOf(wanted)
  if (start === -1) {
    start = texts.findIndex((text) => text?.toLowerCase() === wanted.toLowerCase())
  }
  const heading = root.children[start]
  if (heading === undefined || heading.type !== 'heading') return undefined
  let end = start + 1
  while (end < root.children.length) {
    const child = root.children[end] as MdastFlowContent
    if (child.type === 'heading' && child.depth <= heading.depth) break
    end += 1
  }
  return { type: 'root', children: root.children.slice(start, end) }
}

function plainText(children: readonly unknown[]): string {
  let text = ''
  for (const child of children as readonly { value?: unknown; children?: unknown[] }[]) {
    if (typeof child.value === 'string') text += child.value
    else if (Array.isArray(child.children)) text += plainText(child.children)
  }
  return text
}
