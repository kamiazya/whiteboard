/**
 * The `visual` plugin's data half: react-free, so it runs unchanged wherever
 * a document is read — Node, a worker, the browser. Its React half is
 * `@kamiazya/whiteboard-plugin-visual/ui`.
 *
 * Nothing here is privileged. The engine does not import this package; a
 * third-party plugin is shaped exactly the same way, and the only thing
 * "bundled" means is that this repo ships it.
 */
export * from './data.js'
export type { LucideIconElement } from './icons/icons.js'
export { BUILT_IN_ICON_NAMES, LUCIDE_ICONS, LUCIDE_VIEWBOX } from './icons/icons.js'
