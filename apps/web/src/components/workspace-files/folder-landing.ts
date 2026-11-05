/**
 * Where focus lands once a folder dialog closes. Radix gives focus back to
 * whatever opened the dialog, and that is usually a menu item gone by then,
 * so focus fell to <body> and the next Tab started over from the app header.
 * Each landing is a list of selectors inside the panel, tried in order.
 */

/** The deepest crumb of the folder trail: the folder the contents pane is showing. */
const CURRENT_FOLDER = 'nav[aria-label="Folder path"] [aria-current="true"]'

function at(path: string): string {
  return `[data-folder-path="${CSS.escape(path)}"]`
}

/**
 * A folder, or the nearest of its ancestors on screen: its card in the
 * contents pane first, then its row in the tree or its crumb, and the folder
 * being shown when none of them is.
 */
export function folderLanding(folder: string): string[] {
  const segments = folder === '' ? [] : folder.split('/')
  const prefixes = segments.map((_, i) => segments.slice(0, segments.length - i).join('/'))
  return [
    ...prefixes.flatMap((path) => [`[data-testid="folder-contents"] ${at(path)}`, at(path)]),
    CURRENT_FOLDER,
  ]
}

/** A document's card or row. */
export function documentLanding(path: string): string[] {
  return [`[data-doc-path="${CSS.escape(path)}"]`, CURRENT_FOLDER]
}

/**
 * Focus the first element the selectors find that actually takes focus — one
 * hidden by a breakpoint does not — and answer whether any did.
 */
export function focusLanding(root: HTMLElement | null, selectors: readonly string[]): boolean {
  if (root === null) return false
  for (const selector of selectors) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      element.focus({ preventScroll: false })
      if (document.activeElement === element) return true
    }
  }
  return false
}
