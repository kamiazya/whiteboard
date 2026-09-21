/**
 * The daemon HTTP contracts a BROWSER parses, published as their own
 * subpath.
 *
 * `daemon-client` is the daemon's browser-safe half and `apps/web` reads
 * every daemon contract through it. This package's ROOT barrel is
 * `createServer` and everything under it — hono, loro-crdt, canvas-render,
 * search — so a client importing a schema from the root names the whole
 * server graph and relies on a bundler to drop it again.
 *
 * That is not a theory. Recorded at the import site in daemon-client's
 * `api-contracts/index.ts`: taking `apiErrorReason` from the root instead of
 * `/api-errors` put that graph in apps/web's entry chunk — 421.4 KB gzip
 * against a 152 KB budget, a 269 KB difference. Nothing earlier catches it,
 * because no boundary test can see what a re-export DRAGS; only
 * `smoke:bundle-size` can, and only after a build.
 *
 * So the rule is structural rather than measured per change:
 * `daemon-client` reaches this package through a subpath and never its root
 * (`tools/arch-lint`'s `daemon-client-subpath.test.ts`), and this file is
 * the subpath for the tool contracts. It DECLARES nothing — every schema
 * below is re-exported from a schemas-only module beside the tool that
 * serves it, so a tool and the contract it publishes cannot drift.
 *
 * Deliberately narrow, for the reason `daemon-client`'s own barrel is: what
 * is here is what a client parses. `./api-errors` and
 * `./versions/version-entry` are the two older subpaths and stay separate —
 * a caller wanting only the error body should not name the tool contracts
 * either.
 */
export { type BacklinksOutput, backlinksOutputSchema } from './tools/backlinks.schemas.js'
export {
  wbDocumentCreateOutputSchema,
  wbDocumentListOutputSchema,
} from './tools/document-crud.schemas.js'
export {
  type DocumentSearchOutput,
  documentSearchOutputSchema,
} from './tools/document-search.schemas.js'
export { type DocumentTagsOutput, documentTagsOutputSchema } from './tools/document-tags.schemas.js'
export { type ExportOkfOutput, exportOkfOutputSchema } from './tools/export-okf.schemas.js'
export {
  type LinkifyMentionsOutput,
  linkifyMentionsOutputSchema,
} from './tools/linkify-mentions.schemas.js'
