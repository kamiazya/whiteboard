import type { BoundaryViolationKind } from './scanner.js'

/**
 * Data-driven mirror of the "May depend on" column in
 * .claude/rules/architecture-map.md, extended with each package's allowed
 * third-party (non-workspace) dependencies. `allowedInternalDeps` feeds
 * `direction-check.ts` (internal-package direction); `allowedThirdParty`
 * feeds `allowed-deps-check.ts` (everything else a `dependencies` entry
 * could name). `devDependencies` are exempt from both for a shared-layer
 * package — tooling, not runtime coupling — but a composition root that
 * bundles its workspace packages is direction-checked over them too.
 *
 * `exemptBoundaryViolationKinds` opts a package OUT of specific
 * `scanner.ts` violation kinds it legitimately needs — e.g. canvas-viewer
 * is a browser-runtime UI package (DOM globals are its whole job), so it is
 * exempted from `dom-global` while still banned from `node-builtin-import`/
 * `inversify-import` like every other shared-layer package.
 * `exemptBoundaryFiles` does the same for one file: canvas-viewer's one
 * embedded Node-side build-time module (`widget/build-fonts-module.ts` uses
 * `Buffer` to base64-encode font bytes at build time) is the only place
 * `node-ambient-global` is allowed, because the rest of the package ships
 * into the browser and the widget iframe, where `process` does not exist.
 */
interface BoundaryFileExemption {
  readonly kinds: readonly BoundaryViolationKind[]
  readonly reason: string
}

interface PackageArchEntry {
  readonly allowedInternalDeps: readonly string[]
  readonly allowedThirdParty: readonly string[]
  readonly exemptBoundaryViolationKinds?: readonly BoundaryViolationKind[]
  /**
   * Violation kinds exempt in ONE file, keyed by its path relative to the
   * package's `src/`. For a use that is legitimate in a single build-time
   * module and a defect anywhere else the package ships, where a package-wide
   * kind would silently exempt every other file. `repo-coverage.test.ts` fails
   * an entry whose file is gone or no longer contains that kind of use.
   */
  readonly exemptBoundaryFiles?: Readonly<Record<string, BoundaryFileExemption>>
}

export const ARCHITECTURE_MAP: Readonly<Record<string, PackageArchEntry>> = {
  '@kamiazya/whiteboard-model': {
    allowedInternalDeps: [],
    allowedThirdParty: ['zod'],
  },
  '@kamiazya/whiteboard-codec': {
    allowedInternalDeps: ['@kamiazya/whiteboard-model'],
    allowedThirdParty: [
      'zod',
      'unified',
      'remark-parse',
      'remark-stringify',
      'remark-gfm',
      'remark-math',
      'yaml',
    ],
  },
  '@kamiazya/whiteboard-scene': {
    // The scene vocabulary and the renderer/plugin contract. Types only, and
    // positioned rather than populated: it sits below the renderer and below
    // every plugin so neither imports the other to agree what a scene is.
    allowedInternalDeps: ['@kamiazya/whiteboard-model', '@kamiazya/whiteboard-facet-engine'],
    allowedThirdParty: [],
  },
  '@kamiazya/whiteboard-canvas-render': {
    // codec: the mdast body parser this package DEFAULTS to. Every consumer
    // already bundles codec to pass it in, so the dependency adds nothing to
    // any bundle and removes the same line from seven call sites.
    // plugin-visual: resolveCanvasEdgeStyle is the DEFAULT read for edge
    // style (facet first, legacy x-whiteboard.edgeRouting fallback) — the
    // lowlight lesson again: an opt-in resolution step at four call sites
    // is a step that gets missed, so the shared renderer owns the default.
    // The same package owns the icon geometry, for the same reason: the
    // renderer draws exactly the names `visual.symbol` enumerates.
    //
    // ponytail: this is a hard-coded dependency on one plugin. The backend
    // already accepts caller-supplied glyph geometry, so the upgrade path
    // is injection — the layout pass takes the resolvers the way it takes
    // `highlightCode`. Worth doing when a SECOND plugin wants to change how
    // a node is drawn; before that it is indirection with one implementation.
    // facet-engine: the theme TOKEN CONTRACT (ADR-0030 decision 3) — the one
    // shape a registered theme has, declared in the engine so ADR-0013
    // decision 8 can build on it without moving it; this package maps it
    // onto its palette. zod-only, so it holds on Node, the browser and a
    // worker alike — checked before adopting.
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-plugin-visual',
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-scene',
    ],
    // css-line-break: deciding WHERE a line may break is this package's own
    // job, and the answer is a Unicode standard (UAX #14 + CSS `line-break`,
    // which is where Japanese kinsoku lives), not something to hand-roll from
    // a character table. Pure and DOM-free, so it holds in Node, the browser
    // and a worker alike — verified before adopting.
    // BudouX (phrase boundaries for Japanese) is deliberately NOT here: it is
    // vendored under src/vendor/budoux, because depending on it drags in
    // linkedom and the native canvas package and breaks the published build.
    // lowlight/highlight.js: the DEFAULT implementation of this package's own
    // `highlightCode` seam, behind the `/highlight` subpath so the barrel
    // never drags a highlighter into a consumer that renders no code. It sits
    // here because canvas-render is the only package all three surfaces that
    // render a markdown body can see — the editor, the viewer (and the MCP
    // Apps widget through it), and export — and the alternative is the same
    // scope-to-role table written out three times. Pure JS, no DOM and no
    // `node:*`, so it holds on Node, the browser and a Worker alike.
    allowedThirdParty: ['zod', 'css-line-break', 'lowlight', 'highlight.js'],
    exemptBoundaryFiles: {
      'layout/edges/spatial-edges.bench.ts': {
        kinds: ['test-framework-import'],
        reason: 'a vitest bench: it runs under `vitest bench` and never ships in the package',
      },
      'layout/nodes/mdast-blocks.bench.ts': {
        kinds: ['test-framework-import'],
        reason: 'a vitest bench: it runs under `vitest bench` and never ships in the package',
      },
      'layout/spatial-canvas.bench.ts': {
        kinds: ['test-framework-import'],
        reason: 'a vitest bench: it runs under `vitest bench` and never ships in the package',
      },
    },
  },
  '@kamiazya/whiteboard-ports': {
    allowedInternalDeps: ['@kamiazya/whiteboard-model'],
    allowedThirdParty: ['zod'],
  },
  // The facet ENGINE (ADR-0013): definePlugin/defineFacet, the registry,
  // write validation and compat resolution. Machinery, not schemas — which
  // is why it is not in model (whose rule excludes runtime behavior beyond
  // validation). Pure zod, so it holds on Node, the browser and a worker alike.
  // The engine, and nothing a plugin owns. Its dependency list is empty of
  // workspace packages BY RESULT, not by rule: the model types it once held
  // left with the `visual` plugin, which is the shape ADR-0013 asks for —
  // the engine is generic over schemas it never names.
  '@kamiazya/whiteboard-facet-engine': {
    allowedInternalDeps: [],
    allowedThirdParty: ['zod'],
    exemptBoundaryFiles: {
      'testing/facet-arbitraries.ts': {
        kinds: ['test-framework-import'],
        reason:
          "the package's `./testing` entry: fast-check generators over the registry, imported " +
          "only by test files and kept out of the default entry, so no consumer's bundle loads it",
      },
    },
  },
  // Lexical search: a dictionary-free tokenizer (latin words, CJK bigrams),
  // BM25 ranking, snippets, and the ONE definition of what text a document
  // contributes. Pure and runtime-agnostic on purpose — the daemon and the
  // browser must rank the same corpus the same way, and a second copy of
  // either half is a second set of answers.
  // It takes content already read (a body, or a canvas), so it needs
  // neither the CRDT nor the bridge — model's types are the whole surface.
  '@kamiazya/whiteboard-search': {
    allowedInternalDeps: ['@kamiazya/whiteboard-model'],
    allowedThirdParty: [],
    exemptBoundaryFiles: {
      'snippet.bench.ts': {
        kinds: ['test-framework-import'],
        reason: 'a vitest bench: it runs under `vitest bench` and never ships in the package',
      },
    },
  },
  // What the documents of a workspace point at, as a graph: the facts one
  // document contributes, the aggregate that answers backlinks and unlinked
  // mentions, and the frontier-stamped cache that keeps those facts between
  // reads. Its own package because BOTH keepers answer these questions, and
  // server-core — where it grew — carries hono and the daemon's tool surface
  // into anything that imports it. The keeper-specific half is one port,
  // `DocumentContentSource`; everything that decides what a reference IS
  // stays here, once.
  '@kamiazya/whiteboard-reference-graph': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-ports',
      '@kamiazya/whiteboard-loro-adapter',
      '@kamiazya/whiteboard-search',
    ],
    // loro-crdt: the port hands the cache a LoroDoc, which extraction reads.
    // zod: the aggregate's facts and the backlink entry are schemas the
    // daemon's published output schema composes.
    allowedThirdParty: ['loro-crdt', 'zod'],
  },
  '@kamiazya/whiteboard-loro-adapter': {
    // Deliberately NOT ports: this package adapts loro-crdt to the model and
    // knows nothing about where a document sits, so it implements no port.
    // The port implementations live in the composition roots.
    allowedInternalDeps: ['@kamiazya/whiteboard-model'],
    // loro-crdt: this package owns the LoroDoc<->model bridge (see
    // .claude/rules/package-loro-adapter.md), so it's the one shared-
    // layer package (besides server-core, which re-exposes the bridge via
    // its Loro-backed store ports) allowed to import it directly.
    // zod: the bridge validates the persisted `core` LoroMap entries against
    // model's storedCoreFacetsSchema field-by-field on read.
    allowedThirdParty: ['loro-crdt', 'zod'],
  },
  '@kamiazya/whiteboard-workspace-index': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-ports',
      '@kamiazya/whiteboard-loro-adapter',
    ],
    // loro-crdt: this package reads a workspace's tree, so it needs the same
    // runtime `loro-adapter` does. It exists as its own package precisely
    // because neither of the two that could otherwise host it can: this needs
    // BOTH ports and loro-crdt, and `loro-adapter` is deliberately closed to
    // ports while `ports` is deliberately closed to loro-crdt.
    allowedThirdParty: ['loro-crdt'],
  },
  '@kamiazya/whiteboard-history': {
    // A document's history as pure mechanics over the workspace record: the
    // checkpoint scheduler, version retention, and frontier encoding. Both
    // keepers run them; what differs between the keepers is where the rows
    // live, which stays in each composition root. loro-crdt because a
    // checkpoint's identity is a frontier of the record. model for the one
    // base64 codec a frontier is stored through. Branch operations
    // and merge planning were here too until ADR-0029 retired the branch.
    allowedInternalDeps: ['@kamiazya/whiteboard-model'],
    allowedThirdParty: ['loro-crdt'],
  },
  '@kamiazya/whiteboard-server-core': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-canvas-render',
      '@kamiazya/whiteboard-ports',
      '@kamiazya/whiteboard-loro-adapter',
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-plugin-visual',
      '@kamiazya/whiteboard-search',
      '@kamiazya/whiteboard-reference-graph',
    ],
    allowedThirdParty: ['hono', 'zod', 'loro-crdt'],
  },
  // The facet system's React half: a LIBRARY, and nothing more. It knows
  // the engine and no plugin — `facet-engine` holds the same system's data
  // half and cannot take React, since it runs on Node, in a worker and in
  // the browser. A plugin's own components are the plugin's, which is why
  // nothing here may depend on `plugin-visual` (and why that package
  // depends on this one).
  '@kamiazya/whiteboard-facet-ui': {
    allowedInternalDeps: ['@kamiazya/whiteboard-facet-engine'],
    // lucide-react: the icon set the editor already draws from, pure SVG
    // components with no DOM or `node:*` reach — it holds wherever React
    // does. `react-dom` is deliberately absent: this package renders
    // elements and never mounts them.
    allowedThirdParty: ['lucide-react', 'react'],
    exemptBoundaryFiles: {
      'catalog-popover.tsx': {
        kinds: ['dom-global'],
        reason:
          'positions and dismisses a popover against the viewport (`window`, `document`, ' +
          '`HTMLElement.showPopover`); every other file here renders elements and touches no DOM',
      },
    },
  },
  // The bundled `visual` plugin, as an ORDINARY plugin package. The engine
  // does not import it and nothing here is privileged; "bundled" means only
  // that this repo ships it. Its data half runs wherever a document is read
  // (default entry, react-free) and its React half behind `/ui` — the split
  // is the plugin's, and it is the shape a third party copies.
  //
  // It owns the vendored icon geometry because `visual.symbol`'s schema is
  // what enumerates those names; the renderer draws from the same table, so
  // `canvas-render` depends on this package rather than the other way round.
  // That geometry is also REGISTERED as an `assets.icons` bundle, which is
  // how a declared picker draws it without anyone importing a component.
  //
  // `lucide-react` is deliberately gone. This package vendors the geometry
  // (see `src/icons/README.md`) and its last importer was the hand-written
  // symbol editor, retired when the picker vocabulary could express that
  // facet. Nothing here renders a lucide COMPONENT any more.
  '@kamiazya/whiteboard-plugin-visual': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-facet-ui',
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-scene',
    ],
    // No `dom-global` exemption: its default entry and `/render` run in Node
    // and the layout worker (canvas-render imports them), and it has no use
    // of a DOM global to excuse.
    allowedThirdParty: ['react', 'zod'],
  },
  '@kamiazya/whiteboard-canvas-viewer': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-canvas-render',
    ],
    allowedThirdParty: ['@modelcontextprotocol/ext-apps', 'react', 'react-dom', 'zod'],
    exemptBoundaryViolationKinds: ['dom-global'],
    exemptBoundaryFiles: {
      'widget/build-fonts-module.ts': {
        kinds: ['node-ambient-global'],
        reason:
          'runs at build time in Node to base64-encode font bytes (`Buffer`); the module it ' +
          'generates is what ships, never this file',
      },
    },
  },
  // The daemon's browser-safe client half (extracted from mcp-server's
  // src/shared, where it was held browser-safe only by a convention scan):
  // the /api Zod contracts the web app parses, the fetch/SSE document
  // backends, the api-client wrapper, and the shared backend contract test
  // suites. Being in THIS table is the point of the extraction — the
  // browser-safety property is now structural (no node:*, scanned like any
  // shared package) instead of positional. It is scanned strictly: it holds no
  // `dom-global` exemption, so a read of `window` or `document` here fails,
  // unlike canvas-viewer's, whose job is the DOM.
  // server-core: the version-entry and operator contracts the /api routes
  // publish are defined beside the routes' own logic and re-exported here.
  '@kamiazya/whiteboard-daemon-client': {
    allowedInternalDeps: ['@kamiazya/whiteboard-model', '@kamiazya/whiteboard-server-core'],
    // @opentelemetry/api alone: the no-op propagation surface api-client
    // injects trace headers through when the embedding page registers a real
    // SDK. The SDK packages themselves were deleted with the dead
    // enableBrowserTracing half (zero production callers).
    // multiformats: the reference implementation of multibase + multicodec,
    // which is what a `did:key` IS. Pure JS, zero dependencies, no DOM and no
    // `node:*` — verified before adopting, so it holds in Node, the browser
    // and a worker alike. Adopted over a hand-written base58 because that
    // version's leading-zero branches are unreachable from this package's one
    // call site and so could never be covered by a test here.
    allowedThirdParty: ['zod', '@opentelemetry/api', 'multiformats'],
    exemptBoundaryFiles: {
      'api-client.ts': {
        kinds: ['dom-global'],
        reason:
          "reads the embedding page's `window` (its origin and injected runtime config) through a " +
          'structural type, so the file compiles with or without the DOM lib; nothing else in the ' +
          'package reaches a DOM global',
      },
    },
  },
  // Composition root (Node CLI/daemon), never a runtime dependency of any
  // shared-layer package. Registered here so direction-check.ts flags the
  // reverse import if a shared package ever adds it as a dependency; its own
  // source is NOT scanned by repo-coverage.test.ts (it is allowed
  // node:*/inversify — see architecture-map.md rule 2).
  //
  // The set is every workspace package its manifest declares, which is all
  // under `devDependencies`: tsdown's `noExternal` inlines them into the
  // published dist, so they are runtime couplings that merely are not
  // installed by a consumer. `repo-coverage.test.ts` therefore direction-
  // checks a composition root's devDependencies too, and holds this list equal
  // to what the manifest declares. Composition roots under `apps/` are
  // deliberately absent: a root depending on the other is what this entry
  // exists to flag.
  '@kamiazya/whiteboard-mcp': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-canvas-render',
      '@kamiazya/whiteboard-canvas-viewer',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-daemon-client',
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-history',
      '@kamiazya/whiteboard-loro-adapter',
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-plugin-visual',
      '@kamiazya/whiteboard-ports',
      '@kamiazya/whiteboard-server-core',
      '@kamiazya/whiteboard-workspace-index',
    ],
    allowedThirdParty: [],
  },
  // The browser extension (ADR-0050): a composition root for the extension
  // runtime, relaying the hosted app to the native host. It reads only the
  // names the browser checks from daemon-client, and is registered so a
  // shared package that took a dependency on it would be flagged.
  //
  // Its source IS boundary-scanned (`BOUNDARY_SCANNED_ROOTS`): it runs in the
  // browser and a service worker, so a `node:*` import is as much a defect here
  // as in a shared package. Only the content script touches `window`.
  '@kamiazya/whiteboard-extension': {
    allowedInternalDeps: ['@kamiazya/whiteboard-daemon-client'],
    allowedThirdParty: [],
    exemptBoundaryFiles: {
      'content.ts': {
        kinds: ['dom-global'],
        reason:
          'the content script runs in the page and hands its `window` to the relay; ' +
          'the background service worker has no DOM, so a read there is a defect',
      },
    },
  },
  // The OTHER composition root (browser). Registered for the same reason
  // `@kamiazya/whiteboard-mcp` is — being in this table is what makes
  // direction-check.ts flag a shared package that takes a dependency on it —
  // and, unlike that one, with its real allowed set, because apps/web's own
  // manifest is direction-checked (see repo-coverage.test.ts's
  // COMPOSITION_ROOTS).
  //
  // The daemon's browser-safe client half is `@kamiazya/whiteboard-daemon-client`
  // (a shared-layer package this tool scans structurally); apps/web reads it
  // directly, and `@kamiazya/whiteboard-mcp` deliberately left this list when
  // the subpath re-export shims retired — a composition root depending on the
  // other composition root is exactly what this entry exists to flag.
  '@kamiazya/whiteboard-web': {
    allowedInternalDeps: [
      '@kamiazya/whiteboard-model',
      '@kamiazya/whiteboard-codec',
      '@kamiazya/whiteboard-canvas-render',
      '@kamiazya/whiteboard-loro-adapter',
      '@kamiazya/whiteboard-canvas-viewer',
      '@kamiazya/whiteboard-facet-ui',
      '@kamiazya/whiteboard-plugin-visual',
      '@kamiazya/whiteboard-daemon-client',
      '@kamiazya/whiteboard-ports',
      '@kamiazya/whiteboard-facet-engine',
      '@kamiazya/whiteboard-search',
      '@kamiazya/whiteboard-workspace-index',
      // history: the checkpoint and retention mechanics the browser keeper
      // runs, the same ones the daemon does — so the rules for changing one
      // live in a package below both rather than in either root.
      '@kamiazya/whiteboard-history',
      // reference-graph: the browser keeper answers "what links here" from
      // the same facts, aggregate and cache the daemon does — its Connections
      // panel — so it reads the package rather than a copy of it.
      '@kamiazya/whiteboard-reference-graph',
    ],
    allowedThirdParty: [],
  },
}
