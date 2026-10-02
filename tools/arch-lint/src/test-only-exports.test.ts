/**
 * Exports that only a test uses, and nothing else ships.
 *
 * Knip counts a test's import as a use, so a symbol kept alive only by its own
 * test is invisible to it: wave 7's deletions of `resolveEdgeStyle` and
 * `isOriginAllowedForServerMode` were found by hand, and the class re-accrues
 * with every refactor that leaves its tests behind. The scan is
 * `test-only-exports-scan.ts`; this holds what it finds from both sides.
 *
 * A name a test only mentions is not a test using it: a use is an import
 * binding. What the scan finds is then sorted by what kind of problem it is,
 * because the four kinds have different ways out:
 *
 * - `dead` (`NO_USE_BESIDE_TESTS`): not even its own file uses it. Delete it.
 * - `barrel-only` (`PUBLISHED_WITHOUT_CONSUMER`): a package entry re-exports
 *   it and only a test imports it. Drop the re-export, or give the name a
 *   consumer; this is a package-API decision.
 * - `shape`: a type, a SCREAMING_CASE constant or a `*Schema`, used in its own
 *   file and imported by the sibling test of that file. No list: exporting a
 *   declared shape for the test beside it is what the export is for, and the
 *   class is derived, so a shape that loses its own use becomes `dead` and
 *   one whose test moves away becomes `reached`, either of which is unlisted.
 * - `reached` (`EXPORTED_FOR_ITS_TEST`): an internal a test reaches into — an
 *   extracted helper tested directly, or a symbol a test in another directory
 *   or package imports. The debt, and the part worth working down.
 *
 * Each of the lists has three ways out for an entry: delete the export, drop
 * the `export`, or register it in `INTENTIONAL` with why. Nothing here may
 * grow: a new test-only export fails as unlisted, a listed one that gained a
 * user, went away or changed class fails as stale, and each list's count is
 * pinned by equality so the number keeps saying where the cleanup stands.
 *
 * The method errs toward false negatives: a same-named identifier in any other
 * shipped file counts as production use, and a name a test reaches only
 * through a helper that hides the import is not counted as test use.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, relativeToRepo, walk } from './scan-roots.js'
import {
  findTestOnlyExports,
  isTestFile,
  type ScannedFile,
  type TestOnlyClass,
} from './test-only-exports-scan.js'

/** Dead outright: not even used inside their own file, only imported by a test. */
const NO_USE_BESIDE_TESTS: readonly string[] = [
  'apps/web/src/lib/versions-backend.contract.ts#versionsBackendContract',
]

/**
 * Exported so a test can reach an internal: used in their own file, and
 * imported by a test that is not the sibling of the file that declares them
 * (a test in another directory or package) or by a sibling when the name is a
 * function, class or other value rather than a declared shape.
 */
const EXPORTED_FOR_ITS_TEST: readonly string[] = [
  'apps/extension/src/page-relay.ts#readPageEnvelope',
  'apps/web/src/boot-splash.ts#elapsedSinceFirstPaint',
  'apps/web/src/boot-splash.ts#splashHoldMs',
  'apps/web/src/boot.ts#servedByServerKeeper',
  'apps/web/src/components/ErrorBoundary.tsx#errorBoundaryLog',
  'apps/web/src/components/FontsCard.tsx#formatSize',
  'apps/web/src/components/annotations/ThreadMessage.tsx#THREAD_MESSAGE_ACTION_CLASS',
  'apps/web/src/components/history-cluster/HistoryCluster.tsx#CLUSTER_BUTTON_CLASS',
  'apps/web/src/components/markdown-editor/active-markdown-editor.ts#subscribeActiveMarkdownEditor',
  'apps/web/src/components/spatial-editor/EdgeBendHandles.tsx#ghostPresses',
  'apps/web/src/components/spatial-editor/ToolPalette.tsx#TOOL_BUTTON_CLASS',
  'apps/web/src/components/spatial-editor/context-menu-items/color-row.tsx#presetEntries',
  'apps/web/src/components/spatial-editor/gesture-trace.ts#createGestureTrace',
  'apps/web/src/components/spatial-editor/selection-inspector.tsx#facetWriteCommands',
  'apps/web/src/components/spatial-editor/selection-inspector.tsx#inspectorSubject',
  'apps/web/src/components/spatial-editor/selection-inspector.tsx#tagWriteCommands',
  'apps/web/src/components/spatial-editor/selection-inspector.tsx#writeReachesIds',
  'apps/web/src/components/spatial-editor/shortcuts.ts#findShortcutIn',
  'apps/web/src/components/spatial-editor/use-keyboard-avoidance.ts#EXIT_HINT_ALLOWANCE_PX',
  'apps/web/src/components/spatial-editor/use-keyboard-avoidance.ts#keyboardAvoidanceSubject',
  'apps/web/src/components/spatial-editor/use-keyboard-avoidance.ts#keyboardOccludedBottomPx',
  'apps/web/src/hooks/use-daemon-reconnect.ts#storedDaemonForReconnect',
  'apps/web/src/hooks/use-document-file-seams.ts#toFacetCard',
  'apps/web/src/hooks/use-tag-vocabulary.ts#readTagVocabulary',
  'apps/web/src/lib/block-range-at.ts#blockRangeAt',
  'apps/web/src/lib/browser-idb.ts#DB_VERSION',
  'apps/web/src/lib/browser-workspace-id.ts#getBrowserWorkspaceIdentity',
  'apps/web/src/lib/destructive-copy.ts#DestructiveDescription',
  'apps/web/src/lib/extension-bridge-fetch.ts#createBridgeFetch',
  'apps/web/src/lib/favicon.ts#projectRectsToBoard',
  'apps/web/src/lib/layout-worker-pool.ts#createLayoutWorkerPool',
  'apps/web/src/lib/layout-worker-pool.ts#defaultPoolSize',
  'apps/web/src/lib/loro-codemirror-sync.ts#loroTextSync',
  'apps/web/src/lib/loro-store.ts#LoroLoadResult',
  'apps/web/src/lib/open-proposals.ts#isOpenProposal',
  'apps/web/src/lib/provider.ts#resolveProviderState',
  'apps/web/src/lib/recent-documents.ts#recordRecentId',
  'apps/web/src/lib/replica-unlock.ts#rememberReplicaKey',
  'apps/web/src/lib/sealed-document-store.ts#decodeEnvelope',
  'apps/web/src/lib/sealed-document-store.ts#encodeEnvelope',
  'apps/web/src/lib/seen-documents.ts#recordSeen',
  'apps/web/src/lib/spatial/freehand.ts#simplifyStroke',
  'apps/web/src/lib/spatial/viewport.ts#clampZoom',
  'apps/web/src/lib/theme-fonts.ts#loadedThemeFaces',
  'apps/web/src/lib/theme-fonts.ts#themeFontFamilies',
  'apps/web/src/lib/user-settings-store.ts#defaultUserSettings',
  'apps/web/src/lib/user-settings-store.ts#migrateV1',
  'apps/web/src/lib/user-settings-store.ts#migrateV2',
  'apps/web/src/lib/user-settings-store.ts#migrateV3',
  'apps/web/src/lib/user-settings-store.ts#migrateV4',
  'packages/canvas-render/src/layout/comment-placement.ts#commentBubbleCandidates',
  'packages/canvas-render/src/layout/edges/edge-crossing-sweep.ts#scoreSegmentPair',
  'packages/canvas-render/src/layout/edges/edge-router.ts#DETOUR_REACH_PX',
  'packages/canvas-render/src/layout/edges/edge-router.ts#detourCandidates',
  'packages/canvas-render/src/layout/edges/edge-rules.ts#dominantAxisOrder',
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#routeCacheKey',
  'packages/canvas-render/src/layout/nodes/inline-junction.ts#tailCharacter',
  'packages/canvas-render/src/layout/passage-highlight.ts#passageBoxes',
  'packages/canvas-render/src/quality/polyline-geometry.ts#segmentLength',
  'packages/canvas-render/src/references/targets.ts#REFERENCE_BUDGET',
  'packages/canvas-render/src/tidy-units.ts#mostlyInside',
  'packages/canvas-viewer/src/font-embedding.ts#fontBytesToDataUri',
  'packages/canvas-viewer/src/font-embedding.ts#viewerFontDataUri',
  'packages/canvas-viewer/src/mount.ts#ViewerSceneError',
  'packages/codec/src/spatial/codecs.ts#roundTrip',
  'packages/codec/src/spatial/json-canvas.ts#jsonCanvasNodeSchema',
  'packages/daemon-client/src/api-contracts/document-url.ts#WORKSPACE_DOCUMENT_API_ACTIONS',
  'packages/daemon-client/src/api-contracts/document-url.ts#WorkspaceDocumentApiAction',
  'packages/daemon-client/src/api-contracts/document.ts#storageCategorySchema',
  'packages/daemon-client/src/extension-bridge.ts#extensionHelloSchema',
  'packages/daemon-client/src/extension-bridge.ts#windowFromPageEnvelopeSchema',
  'packages/daemon-client/src/extension-bridge.ts#windowFromPageSchema',
  'packages/daemon-client/src/read-plane.ts#deriveDocumentKeyBytes',
  'packages/daemon-client/src/replica-session-key.ts#sessionKey',
  'packages/daemon-client/src/sse-stream-hub.ts#canvasSnapshotUrl',
  'packages/daemon-client/src/sse-stream-hub.ts#defaultRetryDelayMs',
  'packages/daemon-client/src/sse-stream-hub.ts#documentUpdateUrl',
  'packages/daemon-client/src/sse-stream-hub.ts#parseSseEvent',
  'packages/daemon-client/src/sync-frames.ts#agentActivityMessageSchema',
  'packages/daemon-client/src/sync-sse-contract.ts#syncSubscribeResponseSchema',
  'packages/facet-engine/src/registry.ts#AssetKind',
  'packages/loro-adapter/src/thread-marks.ts#threadStyleKey',
  'packages/mcp-server/src/cli/server-deactivate-user.ts#deactivateUser',
  'packages/mcp-server/src/cli/server-doctor.ts#defaultFetchPing',
  'packages/mcp-server/src/cli/server-grant-admin.ts#grantAdmin',
  'packages/mcp-server/src/cli/server-grant-member.ts#grantMember',
  'packages/mcp-server/src/cli/server-run-args.ts#SERVER_RUN_FLAGS',
  'packages/mcp-server/src/daemon/daemon-socket.ts#clearStaleSocket',
  'packages/mcp-server/src/daemon/daemon-socket.ts#prepareSocketDirectory',
  'packages/mcp-server/src/daemon/native-host/relay.ts#bodyChunks',
  'packages/mcp-server/src/di/store-local.module.ts#createStoreLocalModule',
  'packages/mcp-server/src/server/canvas-client-notifier.ts#createCanvasClientNotifier',
  'packages/mcp-server/src/server/config-file.ts#applyConfigFileToEnv',
  'packages/mcp-server/src/server/export/headless-export.ts#HeadlessCanvasExportOptions',
  'packages/mcp-server/src/server/export/headless-renderer.ts#buildSpatialScene',
  'packages/mcp-server/src/server/export/installed-fonts.ts#FONT_EXTENSIONS',
  'packages/mcp-server/src/server/http-server.ts#StartHttpServerOptions',
  'packages/mcp-server/src/server/index.ts#parseArg',
  'packages/mcp-server/src/server/index.ts#resolveToken',
  'packages/mcp-server/src/server/observability/tracing.ts#StderrSpanExporter',
  'packages/mcp-server/src/server/observability/tracing.ts#tracingEnabled',
  'packages/mcp-server/src/server/release/sbom-artifact-state.ts#SBOM_SIDECAR_REL_PATH',
  'packages/mcp-server/src/server/replica-env.ts#parseReplicaLeaseTtlMs',
  'packages/mcp-server/src/server/replica-env.ts#parseReplicaTier',
  'packages/mcp-server/src/server/routes/auth.ts#grantCoversRoute',
  'packages/mcp-server/src/server/routes/auth.ts#requiresDaemonAuth',
  'packages/mcp-server/src/server/routes/document/path-route.ts#DOCUMENTS_WILDCARD',
  'packages/mcp-server/src/server/routes/document/path-route.ts#DOCUMENT_WILDCARD',
  'packages/mcp-server/src/server/routes/document/path-route.ts#matchDocumentsTail',
  'packages/mcp-server/src/server/security/credential-resolver.ts#CredentialResolverConfig',
  'packages/mcp-server/src/server/security/daemon-identity.ts#buildSignedPayload',
  'packages/mcp-server/src/server/security/macaroon.ts#hmacSha256',
  'packages/mcp-server/src/server/security/macaroon.ts#parseMacaroon',
  'packages/mcp-server/src/server/security/macaroon.ts#serializeMacaroon',
  'packages/mcp-server/src/server/security/mcp-auth.ts#requiresMcpHttpAuth',
  'packages/mcp-server/src/server/security/origin-pattern.ts#formatOriginPatternEntry',
  'packages/mcp-server/src/server/security/sign-in-config.ts#providerAdmissionSchema',
  'packages/mcp-server/src/server/stdio-root.ts#bootStdioRoot',
  'packages/mcp-server/src/server/store/backup-scheduler.ts#BackupSchedulerOptions',
  'packages/mcp-server/src/server/store/backup-subprocess.ts#buildBackupSpawnArgs',
  'packages/mcp-server/src/server/store/db/account-retirement.ts#retireAccountIfUnheld',
  'packages/mcp-server/src/server/store/db/tenant-scope.ts#TENANT_SCOPED_TABLES',
  'packages/mcp-server/src/server/store/document-store.ts#resolveDocumentIdAtPath',
  'packages/mcp-server/src/server/store/file-gc-sweeper.ts#FileGcSweeper',
  'packages/mcp-server/src/server/store/file-gc.ts#IncompleteFileGcScanError',
  'packages/mcp-server/src/server/store/lease.ts#acquireLease',
  'packages/mcp-server/src/server/store/lease.ts#releaseLease',
  'packages/mcp-server/src/server/tenant/data-layout.ts#tenantRoot',
  'packages/mcp-server/src/shared/data-dir-secure.ts#parentIsWritable',
  'packages/mcp-server/src/shared/data-dir-secure.ts#refuseForeignRecordFile',
  'packages/mcp-server/src/shared/diagnostics/redact.ts#redactDiagnosticValue',
  'packages/model/src/mdast/index.ts#mdastPhrasingContentSchema',
  'packages/model/src/mdast/index.ts#mdastTableRowSchema',
  'packages/model/src/trust.ts#isHumanActor',
  'packages/model/src/uint8-array.ts#isUint8ArrayAnyRealm',
  'packages/plugin-visual/src/apply-stencil.ts#VISUAL_STENCIL_KEY',
  'packages/plugin-visual/src/data.ts#VisualShapeFacet',
  'packages/plugin-visual/src/data.ts#visualPlugin',
  'packages/plugin-visual/src/emoji/shortcode.ts#emojiForShortcode',
  'packages/ports/src/document-index.ts#createDocumentInputSchema',
  'packages/ports/src/tokens.ts#defineToken',
  'packages/reference-graph/src/reference-aggregate.ts#ReferenceAggregate',
  'packages/server-core/src/tools/document-set.ts#documentSetInputSchema',
  'packages/server-core/src/tools/facet-set.ts#DocumentHasNoFrontmatterError',
  'packages/server-core/src/tools/facet-set.ts#FacetSetNeedsPayloadError',
  'packages/server-core/src/tools/facet-set.ts#NodeAndCanvasTargetError',
  'packages/server-core/src/tools/facet-set.ts#NodeAndEdgeTargetError',
  'packages/server-core/src/tools/facet-set.ts#NodeTargetNeedsOneDocumentError',
  'packages/server-core/src/tools/version-list.ts#versionListInputSchema',
  'packages/server-core/src/tools/version-list.ts#versionListOutputSchema',
  'packages/server-core/src/tools/version-restore.ts#RestoreTargetExistsError',
  'packages/server-core/src/tools/version-restore.ts#SubtreeNeedsWorkspaceVersionError',
  'packages/server-core/src/tools/version-restore.ts#SubtreeTakesNoTargetError',
  'packages/server-core/src/tools/version-restore.ts#VersionNotFoundError',
  'packages/server-core/src/tools/version-restore.ts#versionRestoreInputSchema',
  'packages/server-core/src/tools/version-save.ts#versionSaveInputSchema',
  'packages/server-core/src/tools/version-save.ts#versionSaveOutputSchema',
]

/**
 * A package entry re-exports these and nothing shipped imports them, so the
 * published surface holds a name with no consumer but a test. Another kind of
 * problem from the list above: the way out is a package-API decision (drop the
 * re-export), not a test reaching into an internal.
 */
const PUBLISHED_WITHOUT_CONSUMER: readonly string[] = [
  'apps/web/src/lib/browser-idb-upgrades.ts#discardPlaintextReplicas',
  'apps/web/src/lib/browser-idb-upgrades.ts#mintBrowserWorkspaceSegment',
  'apps/web/src/lib/browser-idb-upgrades.ts#rekeyBrowserWorkspace',
  'packages/canvas-render/src/layout/comment-placement.ts#COMMENT_BUBBLE_OFFSET_PX',
  'packages/canvas-render/src/layout/comments.ts#COMMENT_PIN_SIZE_PX',
  'packages/canvas-render/src/layout/nodes/node-outline.ts#outlineContains',
  'packages/canvas-render/src/layout/scale-scene.ts#scaleScene',
  'packages/canvas-render/src/measure.ts#isFullWidthCodePoint',
  'packages/canvas-render/src/quality/composition-score.ts#CompositionScore',
  'packages/canvas-render/src/quality/drawing-score.ts#DrawingScore',
  'packages/canvas-render/src/quality/facet-score.ts#FacetScore',
  'packages/canvas-render/src/scene-bounds.ts#MIN_SCENE_EXTENT_PX',
  'packages/codec/src/references/markup.ts#referenceMarkup',
  'packages/codec/src/spatial/census.ts#CensusFacet',
  'packages/codec/src/spatial/census.ts#jsonSchemaLeafPaths',
  'packages/loro-adapter/src/workspace-tree.ts#WORKSPACE_TREE_KEY',
  'packages/mcp-server/src/server/app-types.ts#ServerModeAppOptions',
  'packages/ports/src/stored-document-unreadable-error.ts#StoredDocumentUnreadableCode',
  'packages/scene/src/scene-graph.ts#ShapeId',
  'packages/search/src/full-text.ts#tokenize',
  'packages/search/src/full-text.ts#tokenizeForIndex',
  'packages/server-core/src/tools/canvas-edit-placement.ts#PLACEMENT_COLUMNS',
  'packages/server-core/src/tools/canvas-view.ts#canvasViewInputSchema',
  'packages/server-core/src/tools/canvas-view.ts#canvasViewOutputSchema',
  'packages/server-core/src/tools/stencil-library.ts#STENCIL_LIBRARY_PATH',
  'packages/server-core/src/tools/version-restore.ts#versionRestoreOutputSchema',
]

/** Kept on purpose, each with why. */
const INTENTIONAL: Readonly<Record<string, string>> = {
  'packages/mcp-server/src/server/store/backup-in-progress.ts#DEFAULT_TTL_MS':
    'half of the refresh-to-TTL ratio that keeps a stalled loop from lapsing a live backup’s marker, held by backup-in-progress.defaults.test.ts',
  'packages/mcp-server/src/server/store/backup-in-progress.ts#DEFAULT_REFRESH_MS':
    'the other half of that ratio, asserted at three refreshes per lifetime by the same test',
  'apps/web/src/components/spatial-editor/gesture-trace.ts#replayNavigation':
    'the replay fold that is the reason the flight recorder stores whole events, proven by gesture-trace.test.ts reproducing a recorded run',
  'apps/web/src/components/spatial-editor/navigation.ts#NAVIGATION_MEMORY_KEYS':
    'the declared set of fields allowed to outlive a gesture, over which the idle invariant is stated for the whole state type',
  'apps/web/src/lib/png-embed.ts#extractTextFromPng':
    'the reading half of the PNG-embedded document format, the only way the export tests can prove a shared PNG carries its document',
  'apps/web/src/lib/render-surfaces.ts#RENDER_SURFACES':
    'the render-surface ledger to review against, whose reasons and kind coverage render-surfaces.test.ts holds',
  'packages/codec/src/markdown/normalize.ts#normalizeMdast':
    'the equivalence the markdown round-trip contract is stated modulo, read by the codec and editor round-trip properties and named in package-codec.md',
  'packages/codec/src/markdown/pipeline.ts#stringifyMarkdownBody':
    'the inverse half of parseMarkdownBody that the markdown round-trip properties hold the codec to, documented as the pipeline scope in package-codec.md',
  'packages/codec/src/references/resolve-for-export.ts#resolveReferencesForExport':
    'the export seam ADR-0017 decision 2 holds ready for the bundle export, waiting only on an injected resolver',
  'packages/codec/src/spatial/codecs.ts#foreignRoundTrip':
    'the foreign-reader trip of the codec registry that codecs.property.test.ts checks every projection ledger against',
  'packages/codec/src/spatial/json-schema.ts#xWhiteboardJsonSchema':
    'generates the committed x-whiteboard JSON Schema, which json-schema.test.ts holds equal to the docs artifact',
  'packages/codec/src/spatial/loss-table.ts#jsonCanvasLossTable':
    'generates the published JSON Canvas loss table that loss-table.test.ts holds equal to the committed docs page',
  'packages/codec/src/spatial/loss-table.ts#ocifLossTable':
    'generates the published OCIF loss table that loss-table.test.ts holds equal to the committed docs page',
  'packages/history/src/checkpoints/scheduler.ts#CHECKPOINT_QUIET_MS':
    'the shared checkpoint cadence that keeper tests advance fake timers by, so a retune cannot leave them stale',
  'packages/loro-adapter/src/loro-bridge.ts#deleteCanvasComment':
    'the single-commit form that withSpatialBatch is held byte-identical to, the sequential reference of loro-bridge.property.test.ts',
  'packages/loro-adapter/src/loro-bridge.ts#deleteSpatialEdge':
    'the single-commit form that withSpatialBatch is held byte-identical to, the sequential reference of loro-bridge.property.test.ts',
  'packages/loro-adapter/src/workspace-tree.ts#createWorkspaceDocument':
    'the tree raw create operation the concurrent convergence property drives, while production reaches the tree by path',
  'packages/loro-adapter/src/workspace-tree.ts#deleteWorkspaceDocument':
    'the tree raw delete operation the concurrent convergence property drives, while production reaches the tree by path',
  'packages/loro-adapter/src/workspace-tree.ts#moveWorkspaceDocument':
    'the tree raw move operation the concurrent convergence property drives, while production reaches the tree by path',
  'packages/mcp-server/src/server/mcp/mcp-smoke-coverage.ts#ALL_REGISTERED_TOOLS':
    'the authoritative registered-tool ledger the smoke checkpoint and the naming and structured-content guards hold to reality',
  'packages/mcp-server/src/server/mcp/mcp-smoke-coverage.ts#COVERED_TOOLS':
    'a category of the smoke-coverage ledger that the partition property and the smoke parity guard read',
  'packages/mcp-server/src/server/mcp/mcp-smoke-coverage.ts#DEFERRED_TOOLS':
    'a category of the smoke-coverage ledger that the partition property and the smoke parity guard read',
  'packages/mcp-server/src/server/mcp/mcp-smoke-coverage.ts#UI_LINKED_TOOLS':
    'a category of the smoke-coverage ledger that the partition property and the smoke parity guard read',
  'packages/mcp-server/src/server/mcp/mcp-smoke-coverage.ts#UNIT_ONLY_TOOLS':
    'a category of the smoke-coverage ledger that the partition property and the smoke parity guard read',
  'packages/mcp-server/src/server/release/sbom-artifact-state.ts#evaluateSbomArtifactState':
    'the staleness judgement the SBOM policy guard makes before its content checks, pure so the pre-push gate stays cheap',
  'packages/mcp-server/src/server/security/macaroon.ts#attenuateMacaroon':
    'the other half of that core: attenuation by arithmetic is the property the file exists for',
  'packages/mcp-server/src/server/security/macaroon.ts#mintMacaroon':
    'the tested core of the ADR-0043 act-plane token, kept until a surface mints one',
  'packages/mcp-server/src/server/security/member-profile-store.ts#passkeyBinding':
    'the encoder paired with the passkey subject decoder in the same file, so the subject format lives in one place',
  'packages/mcp-server/src/server/security/route-scope-registry.ts#API_ROUTE_RULE_NAMES':
    'the rule names the shadowing walk and the partition test are asserted over, kept beside the rules',
  'packages/mcp-server/src/server/security/route-scope-registry.ts#GATED_RULE_NAMES':
    'the other half of the membership-gate partition, asserted by route-scope-registry.test.ts against the origin-trusted list',
  'packages/mcp-server/src/server/store/backup-retention.ts#sealableSnapshots':
    'no production caller on purpose: it presumes a mirror running behind the snapshot (see ADR-0021 status note), kept correct by its property test',
  'packages/mcp-server/src/server/store/backup-retention.ts#snapshotIsRestorable':
    'the restorability invariant the retention property tests assert, written once beside the functions it holds to account',
  'packages/mcp-server/src/server/store/db/schema-ledger.ts#LEDGER':
    'the schema the migrations are held to, read by the schema-ledger test',
  'packages/mcp-server/src/server/store/db/schema-ledger.ts#NULLABLE_IN_DATABASE':
    'deliberate NOT-NULL gaps, each with its reason and checked from the other side by the schema-ledger test',
  'packages/mcp-server/src/server/store/inmemory/in-memory-blob-store.ts#InMemoryBlobStore':
    'the in-memory BlobStore double, the differential oracle for the fs blob store; no-production-wiring.test.ts keeps it out of production',
  'packages/model/src/facets.ts#CoreFacets':
    'the published type of coreFacetsSchema on the package export-star surface; types.test.ts pins it equal to z.infer so a hand-written drift fails',
  'packages/model/src/facets.ts#FacetsRaw':
    'the published type of facetsRawSchema on the package export-star surface; types.test.ts pins it equal to z.infer so a hand-written drift fails',
  'packages/model/src/ids.ts#NodeId':
    'the published type of nodeIdSchema on the package export-star surface; types.test.ts pins it equal to z.infer so a hand-written drift fails',
  'packages/model/src/markdown.ts#MarkdownDocument':
    'the published type of markdownDocumentSchema on the package export-star surface; types.test.ts pins it equal to z.infer so a hand-written drift fails',
  'packages/model/src/spatial.ts#NodeEmbed':
    'the published type of nodeEmbedSchema on the package export-star surface; types.test.ts pins it equal to z.infer so a hand-written drift fails',
  'packages/model/src/trust.ts#trustTier':
    'the OKF §5.3 tier rule, kept ahead of its first surface; ADR-0039 and package-model.md name it as a model contract its tests spec',
  'packages/server-core/src/search/search-corpus.ts#CORPUS_DOCUMENTS':
    'the judged corpus kept beside the search it measures; the ranking tests are its reader',
  'packages/server-core/src/search/search-corpus.ts#JUDGED_QUERIES':
    'the judged queries over that corpus; the ranking tests are its reader',
}

/** How many entries the `dead` and `reached` lists hold together, pinned by equality. */
const DEBT_CEILING = 158

/** How many entries the `barrel-only` list holds, pinned by equality. */
const PUBLISHED_CEILING = 26

const DIRS = [
  'apps',
  'packages',
  'tools',
  'tests',
  'scripts',
  '.claude/scripts',
  '.claude/workflows',
  '.claude/skills',
  'skills',
]
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'tmp',
  '.git',
  'worktrees',
  'coverage',
  '.turbo',
  'vitest-traces',
  'migrations',
])

function readRepoFiles(): ScannedFile[] {
  return DIRS.filter((dir) => existsSync(join(REPO_ROOT, dir)))
    .flatMap((dir) =>
      walk(join(REPO_ROOT, dir), {
        include: (path) => /\.(tsx?|mjs|js|cjs)$/.test(path) && !path.endsWith('.d.ts'),
        skip: (_path, name) => SKIPPED_DIRS.has(name),
      }),
    )
    .map((path) => ({ path: relativeToRepo(path), text: readFileSync(path, 'utf8') }))
}

describe('what counts as an export only a test uses, on fixture files', () => {
  const found = (files: Record<string, string>): string[] =>
    findTestOnlyExports(Object.entries(files).map(([path, text]) => ({ path, text }))).map(
      ({ key }) => key,
    )
  const lib = 'packages/a/src/lib.ts'

  it('finds a function, a constant, a class and a type that only a test names', () => {
    expect(
      found({
        [lib]:
          'export function f() {}\nexport const c = 1\nexport class K {}\nexport interface I {}\nexport type T = 1\n',
        'packages/a/src/lib.test.ts':
          "import { f, c, K } from './lib.js'\nimport type { I, T } from './lib.js'\n",
      }).sort(),
    ).toEqual(['f', 'c', 'K', 'I', 'T'].map((name) => `${lib}#${name}`).sort())
  })

  it('counts a use in another shipped file, and does not count a barrel naming it', () => {
    const files = {
      [lib]: 'export const used = 1\nexport const barrelled = 2\n',
      'packages/a/src/other.ts': "import { used } from './lib.js'\nexport const o = used\n",
      'packages/a/src/index.ts': "export { barrelled } from './lib.js'\n",
      'packages/a/src/lib.test.ts': "import { used, barrelled } from './lib.js'\n",
    }
    expect(found(files)).toEqual([`${lib}#barrelled`])
  })

  it('separates a symbol nothing in its own file uses from one exported for its test', () => {
    const result = findTestOnlyExports([
      {
        path: lib,
        text: 'export function dead() {}\nexport function internal() {}\nconst x = internal()\nexport const y = x\n',
      },
      {
        path: 'packages/a/src/lib.test.ts',
        text: "import { dead, internal, y } from './lib.js'\ndead(); internal(); y\n",
      },
    ])
    const own = Object.fromEntries(result.map(({ name, ownUses }) => [name, ownUses]))
    expect(own).toEqual({ dead: 0, internal: 1, y: 0 })
  })

  it('does not flag an export nothing names, a default export, or a test-side definition', () => {
    expect(
      found({
        [lib]: 'export const unused = 1\nexport default function d() {}\n',
        'packages/a/src/helper.test.ts': 'export const fromTest = 1\n',
        'packages/a/src/x.test.ts': "import { fromTest } from './helper.test.js'\n",
      }),
    ).toEqual([])
  })

  it('leaves out names built to be test-only, and the files of the repo-policing tools', () => {
    expect(
      found({
        [lib]:
          'export const resetForTests = 1\nexport const _internal = 2\nexport const SKIPPED_FOR_TESTS = 3\n',
        'tools/arch-lint/src/x.ts': 'export const policed = 1\n',
        'packages/a/src/lib.test.ts': 'resetForTests; _internal; policed; SKIPPED_FOR_TESTS\n',
      }),
    ).toEqual([])
  })

  it('does not read the ledger that lists a name as a test using it', () => {
    // The ledger spells every listed key as `path#name`; counting those words
    // would keep an export reported after its last real test was deleted.
    expect(
      found({
        [lib]: 'export const gone = 1\n',
        'tools/arch-lint/src/test-only-exports.test.ts': `const debt = ['${lib}#gone']\n`,
      }),
    ).toEqual([])
  })

  it('counts a test as using a name only when it binds it, not when it mentions it', () => {
    const lib2 = 'export const f = 1\nexport const g = f\n'
    expect(
      found({
        [lib]: lib2,
        'packages/a/src/lib.test.ts':
          "// f and g are covered by the property below\nit('exercises f', () => 'g')\nconst f = 2\n",
      }),
    ).toEqual([])
    // The ledger spelling path#name, the case that kept a deleted test's export reported.
    expect(
      found({
        [lib]: lib2,
        'tools/arch-lint/src/test-only-exports.test.ts': `const debt = ['${lib}#f']\n`,
      }),
    ).toEqual([])
  })

  it('counts every way a test can bind a name from another module', () => {
    const body = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `export const ${n} = 1`).join('\n')
    const test = [
      "import { a as renamed } from './lib.js'",
      "export { b } from './lib.js'",
      "import * as ns from './lib.js'",
      'ns.c',
      "const { d } = await import('./lib.js')",
      "const mod = await import('./lib.js')",
      'mod.e',
      "const direct = (await import('./lib.js')).f",
      "type T = typeof import('./lib.js').g",
    ].join('\n')
    expect(
      found({
        [lib]: `${body}\nexport const own = [a, b, c, d, e, f, g]\n`,
        'packages/a/src/lib.test.ts': test,
      })
        .map((key) => key.split('#')[1])
        .sort(),
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  })

  describe('class', () => {
    const classes = (files: Record<string, string>): Record<string, TestOnlyClass> =>
      Object.fromEntries(
        findTestOnlyExports(Object.entries(files).map(([path, text]) => ({ path, text }))).map(
          ({ name, class: cls }) => [name, cls],
        ),
      )
    const shapes = [
      'export type Shape = { a: 1 }',
      'export interface Spec { a: 1 }',
      'export const LIMIT_MS = 5',
      'export const optionsSchema = {}',
      'export const helper = () => 1',
      'export function fn() {}',
      'export class Klass {}',
      'export const lowerValue = 1',
    ].join('\n')
    const useAll =
      'export const own = [LIMIT_MS, optionsSchema, helper, fn, lowerValue, new Klass()]\nexport type Own = [Shape, Spec]\n'
    const importAll =
      "import { LIMIT_MS, optionsSchema, helper, fn, lowerValue, Klass } from './lib.js'\nimport type { Shape, Spec } from './lib.js'\n"

    it('is shape for a declared shape its own file uses and its sibling test imports', () => {
      expect(
        classes({ [lib]: `${shapes}\n${useAll}`, 'packages/a/src/lib.test.ts': importAll }),
      ).toMatchObject({
        Shape: 'shape',
        Spec: 'shape',
        LIMIT_MS: 'shape',
        optionsSchema: 'shape',
        helper: 'reached',
        fn: 'reached',
        Klass: 'reached',
        lowerValue: 'reached',
      })
    })

    it('is shape for the sibling of any suffix, and reached from a test elsewhere', () => {
      const source = { [lib]: `${shapes}\n${useAll}` }
      expect(classes({ ...source, 'packages/a/src/lib.property.test.ts': importAll }).Shape).toBe(
        'shape',
      )
      expect(classes({ ...source, 'packages/a/src/lib2.test.ts': importAll }).Shape).toBe('reached')
      expect(classes({ ...source, 'packages/a/src/sub/lib.test.ts': importAll }).Shape).toBe(
        'reached',
      )
    })

    it('is dead for a shape its own file stopped using, so the rule cannot hide it', () => {
      expect(
        classes({
          [lib]: shapes,
          'packages/a/src/lib.test.ts': importAll,
        }),
      ).toMatchObject({ Shape: 'dead', LIMIT_MS: 'dead', optionsSchema: 'dead' })
    })

    it('is barrel-only for a name a package entry re-exports and nothing shipped imports', () => {
      const files = {
        [lib]: 'export const kept = 1\nexport const own = kept\n',
        'packages/a/src/index.ts': "export { kept } from './lib.js'\n",
        'packages/a/src/lib.test.ts': "import { kept } from './lib.js'\n",
      }
      expect(classes(files)).toEqual({ kept: 'barrel-only' })
      // A shipped importer makes it a real use, which is no finding at all.
      expect(
        classes({ ...files, 'packages/a/src/user.ts': "import { kept } from './lib.js'\nkept\n" }),
      ).toEqual({})
    })
  })

  it('reads a path as a test by what it is called and where it sits', () => {
    for (const path of [
      'a/x.test.ts',
      'a/x.spec.tsx',
      'a/test-utils/y.ts',
      'a/testing/y.ts',
      'a/fixtures/y.ts',
      'a/startup.smoke-impl.ts',
      'a/docs-snapshots/_helpers.ts',
      'a/node-editor-test-utils.ts',
    ]) {
      expect(isTestFile(path), path).toBe(true)
    }
    expect(isTestFile('a/src/lib.ts')).toBe(false)
  })
})

describe('exports only a test uses are held from both sides', () => {
  const files = readRepoFiles()
  const found = findTestOnlyExports(files)
  const classOf = new Map(found.map(({ key, class: cls }) => [key, cls]))
  const ownUsesOf = new Map(found.map(({ key, ownUses }) => [key, ownUses]))
  const lists: readonly { name: string; entries: readonly string[]; cls: TestOnlyClass }[] = [
    { name: 'NO_USE_BESIDE_TESTS', entries: NO_USE_BESIDE_TESTS, cls: 'dead' },
    { name: 'EXPORTED_FOR_ITS_TEST', entries: EXPORTED_FOR_ITS_TEST, cls: 'reached' },
    { name: 'PUBLISHED_WITHOUT_CONSUMER', entries: PUBLISHED_WITHOUT_CONSUMER, cls: 'barrel-only' },
  ]
  const listed = lists.flatMap(({ entries }) => entries)
  const debt = [...NO_USE_BESIDE_TESTS, ...EXPORTED_FOR_ITS_TEST]

  it('scans a tree worth scanning', () => {
    // An empty or truncated scan agrees with every ledger below.
    expect(files.length).toBeGreaterThan(2500)
    expect(found.length).toBeGreaterThan(300)
  })

  it('finds every class, so each list below is held against something real', () => {
    for (const cls of ['dead', 'barrel-only', 'shape', 'reached'] as const) {
      expect(found.filter((one) => one.class === cls).length, cls).toBeGreaterThan(10)
    }
    expect(found.filter(({ class: cls }) => cls === 'shape').length).toBeGreaterThan(100)
  })

  it('finds no test-only export outside the ledger', () => {
    const unlisted = found
      .filter(
        ({ key, class: cls }) =>
          cls !== 'shape' &&
          !(key in INTENTIONAL) &&
          !lists.some((list) => list.cls === cls && list.entries.includes(key)),
      )
      .map(({ key, class: cls }) => `${key} (${cls})`)
    expect(
      unlisted,
      'an export that only a test uses: delete it, drop its `export` (a barrel re-export for a barrel-only one), or register it in INTENTIONAL with why. A shape that lost its own use or its sibling test lands here as dead or reached',
    ).toEqual([])
  })

  it('lists no export that has stopped being test-only, or sits in the wrong list', () => {
    for (const { name, entries, cls } of lists) {
      expect(
        entries.filter((key) => classOf.get(key) !== cls),
        `${name}: gone, used by shipped code now, no longer a test import, or now another class (${cls} is what this list holds) — delete or move the entry and lower its ceiling`,
      ).toEqual([])
    }
  })

  it('keeps every dead entry dead and every reached entry used in its own file', () => {
    expect(NO_USE_BESIDE_TESTS.filter((key) => (ownUsesOf.get(key) ?? 0) > 0)).toEqual([])
    expect(EXPORTED_FOR_ITS_TEST.filter((key) => ownUsesOf.get(key) === 0)).toEqual([])
  })

  it('keeps each deliberate one real, reasoned and test-only', () => {
    for (const [key, reason] of Object.entries(INTENTIONAL)) {
      expect(classOf.has(key), `${key} is not a test-only export any more — delete its entry`).toBe(
        true,
      )
      expect(reason.split(/\s+/).length, `${key} needs a reason`).toBeGreaterThan(6)
    }
    expect(listed.filter((key) => key in INTENTIONAL)).toEqual([])
  })

  it('holds each list at its declared ceiling', () => {
    expect(
      debt.length,
      debt.length > DEBT_CEILING
        ? 'a test-only export was added to the debt: delete or un-export it instead'
        : 'a test-only export was cleaned up — lower DEBT_CEILING to match',
    ).toBe(DEBT_CEILING)
    expect(
      PUBLISHED_WITHOUT_CONSUMER.length,
      PUBLISHED_WITHOUT_CONSUMER.length > PUBLISHED_CEILING
        ? 'a re-export with only a test behind it was added: drop the re-export instead'
        : 'a barrel-only export was cleaned up — lower PUBLISHED_CEILING to match',
    ).toBe(PUBLISHED_CEILING)
    expect(new Set(listed).size, 'an entry is listed twice').toBe(listed.length)
  })
})
