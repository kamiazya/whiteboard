import {
  fontCatalogueEntryByFamily,
  fontDownloadUrl,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/fonts'
import { createFacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import { bundledPlugins } from '@kamiazya/whiteboard-plugin-visual'
import {
  type BlobStore,
  type DocumentIndex,
  type DocumentStore,
  TOKENS,
} from '@kamiazya/whiteboard-ports'
import type { ServerDeps } from '@kamiazya/whiteboard-server-core'
import { Container, type ContainerModule } from 'inversify'
import { createExportTextMeasurer } from '../server/export/measure-text.js'
import { resolveSearchEmbedder } from '../server/search/search-embedder.js'
import { createDocumentTeardown } from '../server/store/document-store.js'
import { createDocumentWritten } from '../server/store/document-written.js'
import { liveDocuments, workspaceDocuments } from '../server/store/live-documents.js'
import { globalStoreScope, type StoreScope } from '../server/store/store-scope.js'
import { FileVersionStore } from '../server/store/version-store.js'
import { agentVersionHistory } from './agent-version-history.js'
import { STORE_SCOPE } from './store-scope-token.js'

export function createContainer(storeModule: ContainerModule): Container {
  const container = new Container()
  container.load(storeModule)
  return container
}

/**
 * The data directory and tenant the container's stores serve. The store module
 * binds it beside the stores themselves, so the seams built here follow the
 * stores by construction; a container with no binding (the in-memory one a
 * test builds) has no directory of its own, and its seams take the process's.
 */
function storeScopeOf(container: Container): StoreScope {
  return container.isBound(STORE_SCOPE) ? container.get<StoreScope>(STORE_SCOPE) : globalStoreScope
}

/**
 * What a composition root may choose ABOUT THE DEPLOYMENT, as opposed to
 * about its storage — which is what the container carries.
 */
export interface ServerDepsOptions {
  /**
   * This daemon as an OKF actor — its `did:key`, from
   * `daemonDeviceActor(dataDir)`. Stamped on an agent save that names no
   * operator. A deployment fact rather than a storage one, which is why it
   * rides here and not in the container.
   */
  readonly daemonActor?: string
}

/**
 * Assembles ServerDeps by resolving the store/sync port tokens from a
 * DI container. Inversify already throws a descriptive "not bound" error
 * when a token has no binding, so this simply surfaces that failure instead
 * of letting a missing binding silently produce undefined deps.
 *
 * It also composes the FACET REGISTRY, which is not a port. The plugin set
 * is fixed at build time: rendering, export and the web editor read the
 * bundled plugin directly, so a root-chosen set here would make writes and
 * drawings disagree (ADR-0013's 2026-10-03 note). Every tool reads the
 * registry from `ServerDeps`, which is required so none falls back alone.
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
  const scope = storeScopeOf(container)
  return {
    documentStore,
    blobStore,
    documentIndex,
    // Built ONCE per root from the bundled plugin set, the one rendering,
    // export and the web editor also read. The registry is immutable data,
    // and a fresh one per tool call would rebuild every compat chain and
    // asset table on every write.
    facetRegistry: createFacetRegistry(bundledPlugins),
    // The real font metrics, so every tool that lays a scene out measures
    // text the same way an export does. Without this they fall back to a
    // constant-ratio estimate while the PNG exporter — same process, same
    // canvas — uses opentype.js, and the two disagree on where every wrapped
    // line lands. Memoized inside the measurer, so this reference costs
    // nothing until a render actually asks for it.
    // The export's own measurer, families included, so wb_scene_render
    // declares a theme's family exactly where the PNG export would: from the
    // faces this daemon can measure, never from a second list.
    textMeasurer: () => createExportTextMeasurer({ fontsDir: scope.layout.fontsDir }),
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
    // this package's own sync routes, and the di graph must not import the
    // routes layer. The field is optional by design — "absent means nobody
    // is told anything" — so the one root with a live audience
    // (http-server.ts) attaches it itself; the stdio root has none.
    // undefined unless the user opted in, and even then the model loads on
    // the first search rather than here — a daemon that starts must not pay
    // a model download before it can answer anything.
    embedder: resolveSearchEmbedder(scope.dataDir),
    // Wired here for the same reason clientNotifier is: it is this package's
    // own filesystem and doc cache, not an interchangeable implementation.
    // Without it wbDocumentDelete would leave a cached doc instance behind,
    // and the version rows of a delete nothing can restore — the HTTP
    // DELETE cleans both up, and the two paths must not disagree.
    documentTeardown: createDocumentTeardown(scope),
    // Same reason as documentTeardown: this package's own op-log
    // maintenance, not an interchangeable implementation. Wired HERE rather
    // than in the HTTP route registration, which is what confined the old
    // saved-listener to one deployment shape.
    documentWritten: createDocumentWritten(scope),
    // The daemon's own version store behind the seam, stamping the daemon's
    // agent identity on a save that names no operator (see the wrapper).
    versions: agentVersionHistory(new FileVersionStore(scope), options.daemonActor),
    // Same reason as documentTeardown: this package's own store, cache and
    // lock, bundled once so operations reach them through the seam instead
    // of any adapter importing a mechanic.
    liveDocuments: liveDocuments(scope),
    workspaceDocuments: workspaceDocuments(scope),
  }
}
