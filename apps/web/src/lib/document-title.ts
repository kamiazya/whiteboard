import { type DocumentKind, shownName } from '@kamiazya/whiteboard-model'

const APP_NAME = 'Whiteboard'

/**
 * The tab title for a page: what it is, then the app. Every route sets one,
 * because the title is what a tab strip, a history entry and a screen
 * reader's window list say about where you are.
 */
export function pageTitle(name: string): string {
  return `${name} · ${APP_NAME}`
}

/** What a screen reader hears on arriving at a document: its name, then its kind. */
export function documentArrival(name: string, kind: DocumentKind): string {
  return `${name}, ${kind === 'spatial' ? 'canvas' : 'markdown note'}`
}

/**
 * The page heading for a document: its chosen name, or — unnamed — what the
 * document list shows for it at `path` (`Untitled 2` for a generated
 * address), so the page and the list never call one document two things.
 */
export function documentHeading(name: string | null | undefined, path: string): string {
  return shownName('document', { path, name })
}
