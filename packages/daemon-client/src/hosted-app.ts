/**
 * The hosted app's origin, which three parties must agree on: the extension
 * admits only this page (ADR-0050), the daemon opens it on first run, and the
 * web app treats it as production. Each derives its own shape — a match
 * pattern, a URL, a hostname — from this one value, so a move to another
 * address is one edit here.
 *
 * Provisional: the pages.dev address the deployment has until a custom domain
 * is assigned.
 */
export const HOSTED_APP_ORIGIN = 'https://kamiazya-whiteboard.pages.dev'
