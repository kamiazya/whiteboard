import {
  fontCatalogueEntryByFamily,
  fontDownloadUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/fonts'
import {
  createFacetRegistry,
  type FacetPlugin,
  type FacetRegistry,
} from '@kamiazya/whiteboard-facet-engine'
import { bundledPlugins } from '@kamiazya/whiteboard-plugin-visual'
import {
  type BlobStore,
  type DocumentIndex,
  type DocumentStore,
  TOKENS,
} from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import type { LoroWorkspaceDocumentIndex } from '@kamiazya/whiteboard-workspace-index'
import { Container, type ContainerModule } from 'inversify'
import { createExportTextMeasurer } from '../server/export/measure-text.js'
import { resolveSearchEmbedder } from '../server/search/search-embedder.js'
import { documentTeardown } from '../server/store/document-store.js'
import { documentWritten } from '../server/store/document-written.js'
import { liveDocuments, workspaceDocuments } from '../server/store/live-documents.js'
import { FileVersionStore } from '../server/store/version-store.js'
import { agentVersionHistory } from './agent-version-history.js'
import { storeMemoryModule } from './store-memory.module.js'

export function createContainer(storeModule: ContainerModule = storeMemoryModule): Container {
  const container = new Container()
  container.load(storeModule)
  return container
}

/**
 * What a composition root may choose ABOUT THE DEPLOYMENT, as opposed to
 * about its storage — which is what the container carries.
 */
export interface ServerDepsOptions {
  /**
   * The plugin set this deployment registers (ADR-0013 decision 3), default
   * the bundled one. The bundled plugin is ordinary and disable-able, so a
   * root composing only its own gets exactly those.
   */
  readonly plugins?: readonly FacetPlugin[]
  /**
   * An already-built registry, for a root that needs one for something else
   * too — a renderer, a picker. Wins over `plugins`, because a root holding
   * a registry must not be forced to build a second that disagrees with it.
   */
  readonly facetRegistry?: FacetRegistry
}

/**
 * Assembles ServerDeps by resolving the store/sync port tokens from a
 * DI container. Inversify already throws a descriptive "not bound" error
 * when a token has no binding, so this simply surfaces that failure instead
 * of letting a missing binding silently produce undefined deps.
 *
 * It also composes the FACET REGISTRY, which is not a port: a plugin set is
 * a distribution-time choice rather than an I/O seam, so it arrives as an
 * argument instead of a binding.
 *
 * That seam existed on `ServerDeps` and NOTHING supplied it. Every root fell
 * through to each tool's own `?? bundledFacetRegistry`, and every test that
 * exercised the seam built `deps` by hand — so a deployment had no way to
 * register a plugin, and neither side could see it. Built-but-unwired, which
 * is the class this repo's `reachability` review dimension exists for, found
 * only by asking who actually CALLS the seam.
 *
 * Deliberately NOT a config file naming modules to import. ADR-0013 decision
 * 3 forbids runtime facet definition because the governance and security
 * blast radius is wider than it looks, and a config file naming module
 * specifiers is runtime code loading wearing a config file's clothes.
 * Distribution time means whoever builds or embeds this server chooses, in
 * code — which is what an argument is.
 */
export function resolveServerDeps(
  container: Container,
  options: ServerDepsOptions = {},
): ServerDeps {
  // Order matters to container.test.ts, which asserts the not-bound error
  // names DocumentStore — the first token resolved.
  const documentStore: DocumentStore = container.get(TOKENS.DocumentStore)
  const blobStore: BlobStore = container.get(TOKENS.BlobStore)
  const documentIndex: DocumentIndex = container.get(TOKENS.DocumentIndex)
  const trashCapable =
    'listTrash' in documentIndex && 'restoreDocument' in documentIndex
      ? (documentIndex as DocumentIndex & LoroWorkspaceDocumentIndex)
      : null
  return {
    documentStore,
    blobStore,
    documentIndex,
    // Built ONCE per root. The registry is immutable data, and a fresh one
    // per tool call would rebuild every compat chain and asset table on
    // every write.
    facetRegistry: options.facetRegistry ?? createFacetRegistry(options.plugins ?? bundledPlugins),
    // The trash seam, present exactly when the bound index is the tree-backed
    // one (listTrash/restoreDocument are its capability, not the port's).
    // Structural rather than instanceof: the binding is this composition
    // root's own choice, and vitest's module-graph split makes instanceof
    // lie across realms (see ports' isWorkspaceNotFoundError).
    ...(trashCapable === null
      ? {}
      : {
          trash: {
            list: async (input: { workspaceId: string }) =>
              (await trashCapable.listTrash(input)).map((entry) => ({
                documentId: entry.documentId,
                path: entry.path,
                deletedAt: entry.deletedAt,
              })),
            restore: (input: { workspaceId: string; documentId: string }) =>
              trashCapable.restoreDocument(input),
          },
        }),
    // The real font metrics, so every tool that lays a scene out measures
    // text the same way an export does. Without this they fall back to a
    // constant-ratio estimate while the PNG exporter — same process, same
    // canvas — uses opentype.js, and the two disagree on where every wrapped
    // line lands. Memoized inside the measurer, so this reference costs
    // nothing until a render actually asks for it.
    // The export's own measurer, families included, so wb_scene_render
    // declares a theme's family exactly where the PNG export would: from the
    // faces this daemon can measure, never from a second list.
    textMeasurer: createExportTextMeasurer,
    // Where a family a theme names can be downloaded. The catalogue is the
    // daemon's — the same one the font installer takes an id from — and
    // server-core cannot import it (daemon-client depends on server-core, so
    // the edge would close a cycle), so the composition root passes it in.
    // Only the ANSWER travels onward: `canvas_view` puts a family and a URL
    // in its result, never bytes.
    themeFontSource: (family) => {
      const entry = fontCatalogueEntryByFamily(family)
      return entry === undefined ? undefined : { family: entry.family, url: fontDownloadUrl(entry) }
    },
    // clientNotifier is deliberately NOT wired here. It is a bridge onto
    // this package's own WebSocket routes, and importing those from the di
    // graph closes a value cycle (di -> canvas-client-notifier -> ws.ts ->
    // di, now that the routes resolve their deps through
    // getDefaultServerDeps). The field is optional by design — "absent
    // means nobody is told anything" — so the two roots with a live-socket
    // audience (http-server.ts, mcp/index.ts) attach it themselves, and the
    // route-fallback deps correctly carry none.
    // undefined unless the user opted in, and even then the model loads on
    // the first search rather than here — a daemon that starts must not pay
    // a model download before it can answer anything.
    embedder: resolveSearchEmbedder(),
    // Wired here for the same reason clientNotifier is: it is this package's
    // own filesystem and doc cache, not an interchangeable implementation.
    // Without it wbDocumentDelete removes the rows and leaves the
    // thumbnails, the blob and a cached doc instance behind — the HTTP
    // DELETE has always cleaned those up, and the two paths disagreeing is
    // the defect this closes.
    documentTeardown,
    // Same reason as documentTeardown: this package's own op-log
    // maintenance, not an interchangeable implementation. Wired HERE rather
    // than in the HTTP route registration, which is what confined the old
    // saved-listener to one deployment shape.
    documentWritten,
    // The daemon's own version store behind the seam, stamping the daemon's
    // agent identity on a save that names no operator (see the wrapper).
    versions: agentVersionHistory(new FileVersionStore()),
    // Same reason as documentTeardown: this package's own store, cache and
    // lock, bundled once so operations reach them through the seam instead
    // of any adapter importing a mechanic.
    liveDocuments: liveDocuments(),
    workspaceDocuments: workspaceDocuments(),
  }
}
