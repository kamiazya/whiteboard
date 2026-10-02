/**
 * Exports that only a test uses, and nothing else ships.
 *
 * Knip counts a test's import as a use, so a symbol kept alive only by its own
 * test is invisible to it: wave 7's deletions of `resolveEdgeStyle` and
 * `isOriginAllowedForServerMode` were found by hand, and the class re-accrues
 * with every refactor that leaves its tests behind. The scan is
 * `test-only-exports-scan.ts`; this holds the debt it finds from both sides.
 *
 * Measured when this landed: 452 exports under `*\/src/` (300 in packages, 152
 * in apps) whose name no other shipped file spells and some test does. For 99
 * of them even their own file never uses them, so they are dead outright; the
 * other 353 are exported so a test can reach an internal. Ten are kept on
 * purpose and carry a reason in `INTENTIONAL`.
 *
 * The other 442 are the debt, and each has three ways out: delete it, drop the
 * `export`, or register it in `INTENTIONAL` with why. Nothing here may grow:
 * a new test-only export fails as unlisted, a listed one that gained a user or
 * went away fails as stale, and the count is pinned by equality so the number
 * keeps saying where the cleanup stands.
 *
 * The method errs toward false negatives: a same-named identifier in any other
 * shipped file counts as production use, and a name a test merely mentions in
 * prose counts as test use, so a listed name is one nothing else shipped even
 * spells.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, relativeToRepo, walk } from './scan-roots.js'
import { findTestOnlyExports, isTestFile, type ScannedFile } from './test-only-exports-scan.js'

/** Dead outright: not even used inside their own file, only by a test. */
const NO_USE_BESIDE_TESTS: readonly string[] = [
  'apps/web/src/components/spatial-editor/gesture-trace.ts#replayNavigation',
  'apps/web/src/components/spatial-editor/navigation.ts#NAVIGATION_MEMORY_KEYS',
  'apps/web/src/components/spatial-editor/node-editor-test-utils.ts#fillNodeEditor',
  'apps/web/src/components/spatial-editor/node-editor-test-utils.ts#nodeEditor',
  'apps/web/src/components/spatial-editor/node-editor-test-utils.ts#nodeEditorText',
  'apps/web/src/components/ui/dock-button.ts#dockControlSizesPx',
  'apps/web/src/components/ui/header-button.ts#headerControlSizesPx',
  'apps/web/src/docs-snapshots/_helpers.ts#captureDocAsset',
  'apps/web/src/docs-snapshots/_helpers.ts#makeFetchMock',
  'apps/web/src/docs-snapshots/_helpers.ts#topBarFetchHandler',
  'apps/web/src/docs-snapshots/_helpers.ts#waitForSnapshotContent',
  'apps/web/src/docs-snapshots/_scenes.ts#ARCHITECTURE_SCENE',
  'apps/web/src/docs-snapshots/_scenes.ts#AUTH_FLOW_SCENE',
  'apps/web/src/docs-snapshots/_top-bar-frame.tsx#TopBarFrame',
  'apps/web/src/lib/document-file-store.ts#dataUrlToBlob',
  'apps/web/src/lib/local-document-summary.ts#InMemoryDefaultDocumentPointer',
  'apps/web/src/lib/png-embed.ts#extractTextFromPng',
  'apps/web/src/lib/provider.ts#resolveProviderStateFromRaw',
  'apps/web/src/lib/render-store.ts#clearRenderStore',
  'apps/web/src/lib/render-surfaces.ts#RENDER_SURFACES',
  'apps/web/src/lib/versions-backend.contract.ts#versionsBackendContract',
  'apps/web/src/runtime-config.ts#EMPTY_RUNTIME_CONFIG',
  'packages/canvas-render/src/layout/edges/edge-label-anchor.ts#edgeLabelAnchor',
  'packages/canvas-render/src/layout/seed.ts#createStyleRandom',
  'packages/canvas-render/src/scene-entry-keys.ts#sceneEntryKeys',
  'packages/canvas-viewer/src/scene.ts#serializeViewerScene',
  'packages/codec/src/markdown/normalize.ts#normalizeMdast',
  'packages/codec/src/markdown/pipeline.ts#stringifyMarkdownBody',
  'packages/codec/src/references/resolve-for-export.ts#resolveReferencesForExport',
  'packages/codec/src/spatial/codecs.ts#foreignRoundTrip',
  'packages/codec/src/spatial/json-schema.ts#xWhiteboardJsonSchema',
  'packages/codec/src/spatial/loss-table.ts#jsonCanvasLossTable',
  'packages/codec/src/spatial/loss-table.ts#ocifLossTable',
  'packages/codec/src/spatial/projection.ts#jsonCanvasLoss',
  'packages/codec/src/spatial/projection.ts#valueLeafPaths',
  'packages/daemon-client/src/api-contracts/document.ts#CreateWorkspaceRequest',
  'packages/daemon-client/src/api-contracts/document.ts#PurgeResult',
  'packages/daemon-client/src/api-contracts/document.ts#RestoreVersionRequest',
  'packages/daemon-client/src/api-contracts/document.ts#SaveVersionRequest',
  'packages/daemon-client/src/api-contracts/document.ts#SetNameRequest',
  'packages/daemon-client/src/api-contracts/document.ts#SetPinnedRequest',
  'packages/daemon-client/src/api-contracts/promotion.ts#PromoteWorkspaceRequest',
  'packages/daemon-client/src/api-contracts/promotion.ts#promotionChallengeInput',
  'packages/daemon-client/src/api-contracts/replica-key.ts#SetReplicaTierRequest',
  'packages/daemon-client/src/replica-session-key.ts#forgetAll',
  'packages/facet-engine/src/theme-tokens.ts#SAMPLE_THEME_TOKENS',
  'packages/facet-ui/src/plugin-ui.ts#createFacetWriter',
  'packages/loro-adapter/src/loro-bridge.ts#deleteCanvasComment',
  'packages/loro-adapter/src/loro-bridge.ts#deleteSpatialEdge',
  'packages/loro-adapter/src/mergeable-containers.ts#openMergeableText',
  'packages/loro-adapter/src/workspace-tree.ts#createWorkspaceDocument',
  'packages/loro-adapter/src/workspace-tree.ts#deleteWorkspaceDocument',
  'packages/loro-adapter/src/workspace-tree.ts#moveWorkspaceDocument',
  'packages/mcp-server/src/server/backup-restore.ts#NEVER_COPIED_FOR_TESTS',
  'packages/mcp-server/src/server/current-workspace.ts#clearWorkspaceIdCache',
  'packages/mcp-server/src/server/mcp/mcp-smoke-coverage.ts#ALL_REGISTERED_TOOLS',
  'packages/mcp-server/src/server/mcp/mcp-smoke-coverage.ts#COVERED_TOOLS',
  'packages/mcp-server/src/server/mcp/mcp-smoke-coverage.ts#DEFERRED_TOOLS',
  'packages/mcp-server/src/server/mcp/mcp-smoke-coverage.ts#UI_LINKED_TOOLS',
  'packages/mcp-server/src/server/mcp/mcp-smoke-coverage.ts#UNIT_ONLY_TOOLS',
  'packages/mcp-server/src/server/observability/tracing.ts#MCP_ATTR',
  'packages/mcp-server/src/server/observability/tracing.ts#resetTracingForTesting',
  'packages/mcp-server/src/server/release/sbom-artifact-state.ts#SBOM_ARTIFACT_REL_PATH',
  'packages/mcp-server/src/server/release/sbom-artifact-state.ts#evaluateSbomArtifactState',
  'packages/mcp-server/src/server/security/member-profile-store.ts#passkeyBinding',
  'packages/mcp-server/src/server/store/auto-checkpoint.ts#uninstallAutoCheckpoint',
  'packages/mcp-server/src/server/store/auto-version.ts#AUTO_VERSION_CEILING_MS',
  'packages/mcp-server/src/server/store/auto-version.ts#AUTO_VERSION_QUIET_MS',
  'packages/mcp-server/src/server/store/backup-retention.ts#snapshotIsRestorable',
  'packages/mcp-server/src/server/store/db/index.ts#clearDbCache',
  'packages/mcp-server/src/server/store/db/schema-ledger.ts#SqlType',
  'packages/mcp-server/src/server/store/doc-cache.ts#clearCache',
  'packages/mcp-server/src/server/store/inmemory/in-memory-blob-store.ts#InMemoryBlobStore',
  'packages/model/src/annotation.ts#ANNOTATION_ANCHOR_KINDS',
  'packages/model/src/facets.ts#CoreFacets',
  'packages/model/src/facets.ts#FacetsRaw',
  'packages/model/src/ids.ts#NodeId',
  'packages/model/src/markdown.ts#MarkdownDocument',
  'packages/model/src/mdast/index.ts#mdastNodeSchema',
  'packages/model/src/spatial.ts#NodeEmbed',
  'packages/model/src/tags.ts#tagsWriteSchema',
  'packages/model/src/trust.ts#trustTier',
  'packages/plugin-visual/src/emoji/catalog-data.ts#EMOJI_VERSION',
  'packages/plugin-visual/src/emoji/catalog-ja.ts#EMOJI_JA_TAG',
  'packages/ports/src/delta.ts#DeltaBatch',
  'packages/ports/src/frontier.ts#protocolVersionSchema',
  'packages/scene/src/scene-graph.ts#Dimensions',
  'packages/server-core/src/tools/errors.ts#PatchValidationError',
]

/** Exported so a test can reach an internal: used in their own file, and by a test. */
const EXPORTED_FOR_ITS_TEST: readonly string[] = [
  'apps/extension/src/page-relay.ts#readPageEnvelope',
  'apps/web/src/boot-splash.ts#SPLASH_FADE_MS',
  'apps/web/src/boot-splash.ts#SPLASH_MIN_VISIBLE_MS',
  'apps/web/src/boot-splash.ts#elapsedSinceFirstPaint',
  'apps/web/src/boot-splash.ts#splashHoldMs',
  'apps/web/src/boot.ts#servedByServerKeeper',
  'apps/web/src/components/ErrorBoundary.tsx#errorBoundaryLog',
  'apps/web/src/components/FontsCard.tsx#formatSize',
  'apps/web/src/components/StorageReportCard.tsx#STATUS_CLEAR_MS',
  'apps/web/src/components/WorkspaceTopBar.tsx#DocumentIdentity',
  'apps/web/src/components/annotations/ThreadMessage.tsx#THREAD_MESSAGE_ACTION_CLASS',
  'apps/web/src/components/history-cluster/HistoryCluster.tsx#CLUSTER_BUTTON_CLASS',
  'apps/web/src/components/markdown-editor/active-markdown-editor.ts#subscribeActiveMarkdownEditor',
  'apps/web/src/components/markdown-editor/editor-verbs.ts#MarkdownVerbSpec',
  'apps/web/src/components/markdown-editor/preview-width.ts#PREVIEW_COLUMN_PADDING_PX',
  'apps/web/src/components/markdown-editor/preview-width.ts#RAIL_MIN_CONTAINER_WIDTH_PX',
  'apps/web/src/components/spatial-editor/EdgeBendHandles.tsx#ghostPresses',
  'apps/web/src/components/spatial-editor/ToolPalette.tsx#TOOL_BUTTON_CLASS',
  'apps/web/src/components/spatial-editor/context-menu-items/color-row.tsx#presetEntries',
  'apps/web/src/components/spatial-editor/context-menu-items/ink-menu-items.tsx#InkMenuItemsInput',
  'apps/web/src/components/spatial-editor/context-menu-items/node-menu-items.tsx#NodeMenuItemsInput',
  'apps/web/src/components/spatial-editor/element-pick.ts#CONTENT_PICK_ORDER',
  'apps/web/src/components/spatial-editor/element-pick.ts#ContentKind',
  'apps/web/src/components/spatial-editor/element-pick.ts#ELEMENT_PICK_ROLE',
  'apps/web/src/components/spatial-editor/element-pick.ts#ElementCollection',
  'apps/web/src/components/spatial-editor/gesture-trace.ts#TraceEntry',
  'apps/web/src/components/spatial-editor/gesture-trace.ts#createGestureTrace',
  'apps/web/src/components/spatial-editor/gesture-view.ts#CARRIED_RESIDE_STEP_PX',
  'apps/web/src/components/spatial-editor/navigation.ts#DOUBLE_PRESS_SLOP_PX',
  'apps/web/src/components/spatial-editor/navigation.ts#NavigationEffect',
  'apps/web/src/components/spatial-editor/navigation.ts#NavigationMode',
  'apps/web/src/components/spatial-editor/navigation.ts#PressContext',
  'apps/web/src/components/spatial-editor/node-editor-test-utils.ts#nodeEditorContent',
  'apps/web/src/components/spatial-editor/selection-inspector.tsx#facetWriteCommands',
  'apps/web/src/components/spatial-editor/selection-inspector.tsx#inspectorSubject',
  'apps/web/src/components/spatial-editor/selection-inspector.tsx#tagWriteCommands',
  'apps/web/src/components/spatial-editor/selection-inspector.tsx#writeReachesIds',
  'apps/web/src/components/spatial-editor/shortcuts.ts#EDITOR_SHORTCUTS',
  'apps/web/src/components/spatial-editor/shortcuts.ts#ShortcutSpec',
  'apps/web/src/components/spatial-editor/shortcuts.ts#findShortcutIn',
  'apps/web/src/components/spatial-editor/use-keyboard-avoidance.ts#EXIT_HINT_ALLOWANCE_PX',
  'apps/web/src/components/spatial-editor/use-keyboard-avoidance.ts#keyboardAvoidanceSubject',
  'apps/web/src/components/spatial-editor/use-keyboard-avoidance.ts#keyboardOccludedBottomPx',
  'apps/web/src/components/ui/dock-button.ts#DOCK_BUTTON_HEIGHT_CLASS',
  'apps/web/src/components/workspace-files/load-row-outline.ts#RowOutlineDeps',
  'apps/web/src/components/workspace-files/load-row-render.ts#RowRenderDeps',
  'apps/web/src/components/workspace-files/use-long-press.ts#LONG_PRESS_MS',
  'apps/web/src/docs-snapshots/_helpers.ts#resolveDocAssetPath',
  'apps/web/src/hooks/use-agent-activity.ts#AGENT_HIGHLIGHT_MS',
  'apps/web/src/hooks/use-agent-activity.ts#AGENT_PRESENCE_MS',
  'apps/web/src/hooks/use-browser-tool-registry.ts#ModelContext',
  'apps/web/src/hooks/use-browser-tool-registry.ts#WebMcpToolDescriptor',
  'apps/web/src/hooks/use-daemon-reconnect.ts#storedDaemonForReconnect',
  'apps/web/src/hooks/use-document-file-seams.ts#toFacetCard',
  'apps/web/src/hooks/use-tag-vocabulary.ts#readTagVocabulary',
  'apps/web/src/hooks/use-workspace-address-sync.ts#WorkspaceAddressInputs',
  'apps/web/src/hooks/useThemeMode.ts#THEME_STORAGE_KEY',
  'apps/web/src/lib/block-range-at.ts#blockRangeAt',
  'apps/web/src/lib/browser-backend.ts#BrowserBackendTarget',
  'apps/web/src/lib/browser-idb-upgrades.ts#discardPlaintextReplicas',
  'apps/web/src/lib/browser-idb-upgrades.ts#mintBrowserWorkspaceSegment',
  'apps/web/src/lib/browser-idb-upgrades.ts#rekeyBrowserWorkspace',
  'apps/web/src/lib/browser-idb.ts#DB_VERSION',
  'apps/web/src/lib/browser-keeper-capacity.ts#DESKTOP_CAPACITY',
  'apps/web/src/lib/browser-keeper-capacity.ts#MOBILE_CAPACITY',
  'apps/web/src/lib/browser-workspace-id.ts#getBrowserWorkspaceIdentity',
  'apps/web/src/lib/commands/types.ts#CommandErrorCode',
  'apps/web/src/lib/destructive-copy.ts#DestructiveDescription',
  'apps/web/src/lib/document-file-store.ts#documentFileRecordSchema',
  'apps/web/src/lib/document-sync-session.ts#COMMIT_DEBOUNCE_MS',
  'apps/web/src/lib/document-sync-session.ts#SessionDeps',
  'apps/web/src/lib/extension-bridge-fetch.ts#createBridgeFetch',
  'apps/web/src/lib/extension-connection.ts#CONNECT_TIMEOUT_MS',
  'apps/web/src/lib/favicon.ts#STATIC_FAVICON_HREF',
  'apps/web/src/lib/favicon.ts#projectRectsToBoard',
  'apps/web/src/lib/layout-worker-pool.ts#PoolWorker',
  'apps/web/src/lib/layout-worker-pool.ts#createLayoutWorkerPool',
  'apps/web/src/lib/layout-worker-pool.ts#defaultPoolSize',
  'apps/web/src/lib/loaded-reference-of.ts#ListedDocument',
  'apps/web/src/lib/loro-codemirror-sync.ts#loroTextSync',
  'apps/web/src/lib/loro-store.ts#LoroLoadResult',
  'apps/web/src/lib/open-proposals.ts#isOpenProposal',
  'apps/web/src/lib/pages-origin-policy.ts#PROVISIONAL_PRODUCTION_ORIGIN',
  'apps/web/src/lib/provider.ts#resolveProviderState',
  'apps/web/src/lib/recent-documents.ts#RECENT_CAP',
  'apps/web/src/lib/recent-documents.ts#recordRecentId',
  'apps/web/src/lib/render-key.ts#RENDERER_BUILD_ID',
  'apps/web/src/lib/render-key.ts#renderKeySchema',
  'apps/web/src/lib/render-store.ts#STORE_FLOOR_MS',
  'apps/web/src/lib/render-surfaces.ts#RenderSurfaceId',
  'apps/web/src/lib/replica-page-state.ts#REPLICA_PAGE_STATES',
  'apps/web/src/lib/replica-unlock.ts#rememberReplicaKey',
  'apps/web/src/lib/sealed-document-store.ts#ENVELOPE_OVERHEAD',
  'apps/web/src/lib/sealed-document-store.ts#decodeEnvelope',
  'apps/web/src/lib/sealed-document-store.ts#encodeEnvelope',
  'apps/web/src/lib/seen-documents.ts#SEEN_CAP',
  'apps/web/src/lib/seen-documents.ts#recordSeen',
  'apps/web/src/lib/spatial/editor-appearance.ts#EDITOR_DARK_PALETTE',
  'apps/web/src/lib/spatial/editor-appearance.ts#EDITOR_LIGHT_PALETTE',
  'apps/web/src/lib/spatial/freehand.ts#FREEHAND_MAX_POINTS',
  'apps/web/src/lib/spatial/freehand.ts#MIN_STROKE_TRAVEL_PX',
  'apps/web/src/lib/spatial/freehand.ts#STROKE_TOLERANCE_PX',
  'apps/web/src/lib/spatial/freehand.ts#simplifyStroke',
  'apps/web/src/lib/spatial/stroke-group.ts#STROKE_GROUP_PAUSE_MS',
  'apps/web/src/lib/spatial/viewport.ts#Bounds',
  'apps/web/src/lib/spatial/viewport.ts#MAX_ZOOM',
  'apps/web/src/lib/spatial/viewport.ts#MIN_ZOOM',
  'apps/web/src/lib/spatial/viewport.ts#PAN_MARGIN_PX',
  'apps/web/src/lib/spatial/viewport.ts#clampZoom',
  'apps/web/src/lib/theme-fonts.ts#loadedThemeFaces',
  'apps/web/src/lib/theme-fonts.ts#themeFontFamilies',
  'apps/web/src/lib/user-settings-store.ts#LEGACY_V1_STORAGE_KEY',
  'apps/web/src/lib/user-settings-store.ts#LEGACY_V2_STORAGE_KEY',
  'apps/web/src/lib/user-settings-store.ts#LEGACY_V3_STORAGE_KEY',
  'apps/web/src/lib/user-settings-store.ts#LEGACY_V4_STORAGE_KEY',
  'apps/web/src/lib/user-settings-store.ts#defaultUserSettings',
  'apps/web/src/lib/user-settings-store.ts#legacyV1SettingsSchema',
  'apps/web/src/lib/user-settings-store.ts#legacyV2SettingsSchema',
  'apps/web/src/lib/user-settings-store.ts#legacyV3SettingsSchema',
  'apps/web/src/lib/user-settings-store.ts#legacyV4SettingsSchema',
  'apps/web/src/lib/user-settings-store.ts#migrateV1',
  'apps/web/src/lib/user-settings-store.ts#migrateV2',
  'apps/web/src/lib/user-settings-store.ts#migrateV3',
  'apps/web/src/lib/user-settings-store.ts#migrateV4',
  'apps/web/src/lib/user-settings-store.ts#userSettingsSchema',
  'apps/web/src/lib/versions-backend.contract.ts#VersionsBackendHarness',
  'apps/web/src/lib/whiteboard-client.ts#documentSnapshotSchema',
  'apps/web/src/pwa/sw-idle-apply.ts#SW_IDLE_SETTLE_MS',
  'apps/web/src/pwa/sw-update-scheduler.ts#SW_UPDATE_CHECK_INTERVAL_MS',
  'apps/web/src/pwa/sw-update-scheduler.ts#SchedulerDocument',
  'packages/canvas-render/src/layout/comment-placement.ts#COMMENT_BUBBLE_OFFSET_PX',
  'packages/canvas-render/src/layout/comment-placement.ts#COMMENT_BUBBLE_RING_REACH_PX',
  'packages/canvas-render/src/layout/comment-placement.ts#commentBubbleCandidates',
  'packages/canvas-render/src/layout/comments.ts#COMMENT_PIN_SIZE_PX',
  'packages/canvas-render/src/layout/edges/bend-route.ts#BendRouteEnds',
  'packages/canvas-render/src/layout/edges/edge-crossing-sweep.ts#scoreSegmentPair',
  'packages/canvas-render/src/layout/edges/edge-router.ts#DETOUR_REACH_PX',
  'packages/canvas-render/src/layout/edges/edge-router.ts#detourCandidates',
  'packages/canvas-render/src/layout/edges/edge-rules.ts#PENALTY_RULES',
  'packages/canvas-render/src/layout/edges/edge-rules.ts#PenaltyRule',
  'packages/canvas-render/src/layout/edges/edge-rules.ts#PreferenceRule',
  'packages/canvas-render/src/layout/edges/edge-rules.ts#PreferenceRuleContext',
  'packages/canvas-render/src/layout/edges/edge-rules.ts#SIDE_PREFERENCE_RULES',
  'packages/canvas-render/src/layout/edges/edge-rules.ts#ZERO_LANE_MIN_OVERLAP_PX',
  'packages/canvas-render/src/layout/edges/edge-rules.ts#dominantAxisOrder',
  'packages/canvas-render/src/layout/edges/spatial-edges.ts#routeCacheKey',
  'packages/canvas-render/src/layout/nodes/inline-junction.ts#tailCharacter',
  'packages/canvas-render/src/layout/nodes/node-outline.ts#BUNDLED_SHAPE_TABLE',
  'packages/canvas-render/src/layout/nodes/node-outline.ts#outlineContains',
  'packages/canvas-render/src/layout/nodes/truncate.ts#FittedText',
  'packages/canvas-render/src/layout/passage-highlight.ts#passageBoxes',
  'packages/canvas-render/src/layout/scale-scene.ts#scaleScene',
  'packages/canvas-render/src/measure.ts#isFullWidthCodePoint',
  'packages/canvas-render/src/quality/composition-score.ts#CompositionScore',
  'packages/canvas-render/src/quality/drawing-score.ts#DrawingScore',
  'packages/canvas-render/src/quality/drawing-score.ts#EVEN_GAP_TOLERANCE_PX',
  'packages/canvas-render/src/quality/drawing-score.ts#NEAR_MISS_PX',
  'packages/canvas-render/src/quality/facet-score.ts#FacetScore',
  'packages/canvas-render/src/quality/polyline-geometry.ts#segmentLength',
  'packages/canvas-render/src/references/targets.ts#REFERENCE_BUDGET',
  'packages/canvas-render/src/scene-bounds.ts#MIN_SCENE_EXTENT_PX',
  'packages/canvas-render/src/svg/transform.ts#OPTIMIZATION_PASSES',
  'packages/canvas-render/src/svg/transform.ts#SvgNodeTransform',
  'packages/canvas-render/src/tidy-units.ts#mostlyInside',
  'packages/canvas-viewer/src/font-embedding.ts#fontBytesToDataUri',
  'packages/canvas-viewer/src/font-embedding.ts#viewerFontDataUri',
  'packages/canvas-viewer/src/font-loading.ts#VIEWER_FONT_LOAD_TIMEOUT_MS',
  'packages/canvas-viewer/src/mount.ts#ViewerSceneError',
  'packages/canvas-viewer/src/widget/comment-control.ts#COMMENT_ANCHOR_TEST_ID',
  'packages/canvas-viewer/src/widget/comment-control.ts#COMMENT_INPUT_TEST_ID',
  'packages/canvas-viewer/src/widget/comment-control.ts#COMMENT_SUBMIT_TEST_ID',
  'packages/codec/src/references/markup.ts#referenceMarkup',
  'packages/codec/src/spatial/census.ts#CensusFacet',
  'packages/codec/src/spatial/census.ts#jsonSchemaLeafPaths',
  'packages/codec/src/spatial/codecs.ts#SPATIAL_CODECS',
  'packages/codec/src/spatial/codecs.ts#SpatialCodec',
  'packages/codec/src/spatial/codecs.ts#roundTrip',
  'packages/codec/src/spatial/json-canvas.ts#jsonCanvasNodeSchema',
  'packages/daemon-client/src/api-contracts/document-url.ts#DOCUMENT_API_ACTIONS',
  'packages/daemon-client/src/api-contracts/document-url.ts#WORKSPACE_DOCUMENT_API_ACTIONS',
  'packages/daemon-client/src/api-contracts/document-url.ts#WorkspaceDocumentApiAction',
  'packages/daemon-client/src/api-contracts/document.ts#documentSummarySchema',
  'packages/daemon-client/src/api-contracts/document.ts#storageCategorySchema',
  'packages/daemon-client/src/api-contracts/files.ts#uploadableImageTypeSchema',
  'packages/daemon-client/src/api-contracts/runtime.ts#daemonIdentitySchema',
  'packages/daemon-client/src/extension-bridge.ts#extensionHelloSchema',
  'packages/daemon-client/src/extension-bridge.ts#hostToPageSchema',
  'packages/daemon-client/src/extension-bridge.ts#windowFromPageEnvelopeSchema',
  'packages/daemon-client/src/extension-bridge.ts#windowFromPageSchema',
  'packages/daemon-client/src/read-plane.ts#deriveDocumentKeyBytes',
  'packages/daemon-client/src/read-plane.ts#epochSchema',
  'packages/daemon-client/src/replica-session-key.ts#sessionKey',
  'packages/daemon-client/src/sse-stream-hub.ts#canvasSnapshotUrl',
  'packages/daemon-client/src/sse-stream-hub.ts#defaultRetryDelayMs',
  'packages/daemon-client/src/sse-stream-hub.ts#documentUpdateUrl',
  'packages/daemon-client/src/sse-stream-hub.ts#parseSseEvent',
  'packages/daemon-client/src/sync-frames.ts#agentActivityMessageSchema',
  'packages/daemon-client/src/sync-frames.ts#versionCreatedMessageSchema',
  'packages/daemon-client/src/sync-sse-contract.ts#syncSubscribeResponseSchema',
  'packages/facet-engine/src/registry.ts#AssetKind',
  'packages/loro-adapter/src/thread-marks.ts#threadStyleKey',
  'packages/loro-adapter/src/workspace-tree.ts#WORKSPACE_TREE_KEY',
  'packages/loro-adapter/src/workspace-tree.ts#workspaceNodeMetaSchema',
  'packages/mcp-server/src/cli/daemon-replica-posture.ts#DaemonRequest',
  'packages/mcp-server/src/cli/server-backup.ts#RunServerBackupOptions',
  'packages/mcp-server/src/cli/server-deactivate-user.ts#deactivateUser',
  'packages/mcp-server/src/cli/server-doctor.ts#SERVER_DOCTOR_CHECK_IDS',
  'packages/mcp-server/src/cli/server-doctor.ts#defaultFetchPing',
  'packages/mcp-server/src/cli/server-grant-admin.ts#grantAdmin',
  'packages/mcp-server/src/cli/server-grant-member.ts#grantMember',
  'packages/mcp-server/src/cli/server-run-args.ts#SERVER_RUN_FLAGS',
  'packages/mcp-server/src/cli/server-run.ts#RunServerRunOptions',
  'packages/mcp-server/src/cli/server-run.ts#StartServerFn',
  'packages/mcp-server/src/cli/server-status.ts#SERVER_STATUS_SCHEMA_VERSION',
  'packages/mcp-server/src/cli/server-stop.ts#SERVER_STOP_SCHEMA_VERSION',
  'packages/mcp-server/src/cli/server-support-bundle.ts#serverSupportBundleRecordSectionSchema',
  'packages/mcp-server/src/cli/server-support-bundle.ts#serverSupportBundleStatusSectionSchema',
  'packages/mcp-server/src/daemon/daemon-socket.ts#clearStaleSocket',
  'packages/mcp-server/src/daemon/daemon-socket.ts#prepareSocketDirectory',
  'packages/mcp-server/src/daemon/native-host/relay.ts#bodyChunks',
  'packages/mcp-server/src/di/store-local.module.ts#createStoreLocalModule',
  'packages/mcp-server/src/server/app-types.ts#ServerModeAppOptions',
  'packages/mcp-server/src/server/canvas-client-notifier.ts#createCanvasClientNotifier',
  'packages/mcp-server/src/server/config-file.ts#WhiteboardConfigFile',
  'packages/mcp-server/src/server/config-file.ts#applyConfigFileToEnv',
  'packages/mcp-server/src/server/config-file.ts#whiteboardConfigFileSchema',
  'packages/mcp-server/src/server/export/headless-export.ts#HeadlessCanvasExportOptions',
  'packages/mcp-server/src/server/export/headless-renderer.ts#buildSpatialScene',
  'packages/mcp-server/src/server/export/install-font.ts#MAX_FONT_BYTES',
  'packages/mcp-server/src/server/export/installed-fonts.ts#FONT_EXTENSIONS',
  'packages/mcp-server/src/server/http-server.ts#RunningServer',
  'packages/mcp-server/src/server/http-server.ts#StartHttpServerOptions',
  'packages/mcp-server/src/server/index.ts#parseArg',
  'packages/mcp-server/src/server/index.ts#resolveToken',
  'packages/mcp-server/src/server/log.ts#CapturedLogsHandle',
  'packages/mcp-server/src/server/mcp/stdio-lifecycle.ts#GRACEFUL_SHUTDOWN_TIMEOUT_MS',
  'packages/mcp-server/src/server/observability/tracing.ts#SERVICE_NAME',
  'packages/mcp-server/src/server/observability/tracing.ts#StderrSpanExporter',
  'packages/mcp-server/src/server/observability/tracing.ts#tracingEnabled',
  'packages/mcp-server/src/server/release/sbom-artifact-state.ts#SBOM_REGENERATE_COMMAND',
  'packages/mcp-server/src/server/release/sbom-artifact-state.ts#SBOM_SIDECAR_REL_PATH',
  'packages/mcp-server/src/server/replica-env.ts#parseReplicaLeaseTtlMs',
  'packages/mcp-server/src/server/replica-env.ts#parseReplicaTier',
  'packages/mcp-server/src/server/routes/auth.ts#grantCoversRoute',
  'packages/mcp-server/src/server/routes/auth.ts#requiresDaemonAuth',
  'packages/mcp-server/src/server/routes/document/path-route.ts#DOCUMENTS_WILDCARD',
  'packages/mcp-server/src/server/routes/document/path-route.ts#DOCUMENT_WILDCARD',
  'packages/mcp-server/src/server/routes/document/path-route.ts#matchDocumentsTail',
  'packages/mcp-server/src/server/routes/mcp.ts#McpRouterDeps',
  'packages/mcp-server/src/server/search/docs-corpus.ts#DocsJudgedQuery',
  'packages/mcp-server/src/server/security/credential-resolver.ts#CredentialResolverConfig',
  'packages/mcp-server/src/server/security/daemon-identity.ts#buildSignedPayload',
  'packages/mcp-server/src/server/security/macaroon.ts#MacaroonCaveat',
  'packages/mcp-server/src/server/security/macaroon.ts#hmacSha256',
  'packages/mcp-server/src/server/security/macaroon.ts#parseMacaroon',
  'packages/mcp-server/src/server/security/macaroon.ts#serializeMacaroon',
  'packages/mcp-server/src/server/security/mcp-auth.ts#requiresMcpHttpAuth',
  'packages/mcp-server/src/server/security/origin-pattern.ts#formatOriginPatternEntry',
  'packages/mcp-server/src/server/security/people-administration.ts#ADMINISTRATION_WINDOW_MS',
  'packages/mcp-server/src/server/security/server-mode-exposure.ts#ServerModeExposureDecision',
  'packages/mcp-server/src/server/security/server-mode-record.ts#serverModeRecordSchema',
  'packages/mcp-server/src/server/security/sign-in-admission.ts#AdmissionInput',
  'packages/mcp-server/src/server/security/sign-in-config.ts#providerAdmissionSchema',
  'packages/mcp-server/src/server/security/workspace-access.ts#OPERATOR_ISSUED_KINDS',
  'packages/mcp-server/src/server/security/workspace-replica-key-store.ts#WorkspaceReplicaKey',
  'packages/mcp-server/src/server/shared-background-work.ts#SharedWorkerFactories',
  'packages/mcp-server/src/server/stdio-root.ts#bootStdioRoot',
  'packages/mcp-server/src/server/store/backup-retention.ts#BackupSnapshot',
  'packages/mcp-server/src/server/store/backup-scheduler.ts#BackupSchedulerOptions',
  'packages/mcp-server/src/server/store/backup-subprocess.ts#buildBackupSpawnArgs',
  'packages/mcp-server/src/server/store/corrupt-stored-data.ts#CorruptStoredDataError',
  'packages/mcp-server/src/server/store/db/account-retirement.ts#retireAccountIfUnheld',
  'packages/mcp-server/src/server/store/db/location.ts#DB_URL_AUTH_TOKEN_ENV',
  'packages/mcp-server/src/server/store/db/tenant-scope.ts#TENANT_SCOPED_TABLES',
  'packages/mcp-server/src/server/store/document-store.ts#resolveDocumentIdAtPath',
  'packages/mcp-server/src/server/store/file-gc-sweeper.ts#FileGcSweeper',
  'packages/mcp-server/src/server/store/file-gc.ts#IncompleteFileGcScanError',
  'packages/mcp-server/src/server/store/lease.ts#acquireLease',
  'packages/mcp-server/src/server/store/lease.ts#releaseLease',
  'packages/mcp-server/src/server/store/workspace-tail.ts#LOCAL_DAEMON_TAIL_INTERVAL_MS',
  'packages/mcp-server/src/server/store/workspace-tail.ts#WORKSPACE_TAIL_INTERVAL_ENV',
  'packages/mcp-server/src/server/tenant/data-layout.ts#tenantRoot',
  'packages/mcp-server/src/shared/data-dir-secure.ts#parentIsWritable',
  'packages/mcp-server/src/shared/data-dir-secure.ts#refuseForeignRecordFile',
  'packages/mcp-server/src/shared/diagnostics/redact.ts#redactDiagnosticValue',
  'packages/model/src/annotation.ts#SpatialAnchor',
  'packages/model/src/markdown.ts#markdownDocumentSchema',
  'packages/model/src/mdast/index.ts#MdastNode',
  'packages/model/src/mdast/index.ts#mdastFlowContentSchema',
  'packages/model/src/mdast/index.ts#mdastPhrasingContentSchema',
  'packages/model/src/mdast/index.ts#mdastTableRowSchema',
  'packages/model/src/tags.ts#SCOPED_TAG_RULE',
  'packages/model/src/trust.ts#isHumanActor',
  'packages/model/src/uint8-array.ts#isUint8ArrayAnyRealm',
  'packages/plugin-visual/src/apply-stencil.ts#VISUAL_STENCIL_KEY',
  'packages/plugin-visual/src/data.ts#VISUAL_TEXT_KEY',
  'packages/plugin-visual/src/data.ts#VisualShapeFacet',
  'packages/plugin-visual/src/data.ts#visualPlugin',
  'packages/plugin-visual/src/data.ts#visualSymbolFacetSchema',
  'packages/plugin-visual/src/emoji/shortcode.ts#emojiForShortcode',
  'packages/plugin-visual/src/stencil-library.ts#VISUAL_STENCILS_KEY',
  'packages/plugin-visual/src/tag-library.ts#VISUAL_TAGS_KEY',
  'packages/ports/src/delta.ts#COMPACT_DELTA_BYTES',
  'packages/ports/src/document-index.ts#createDocumentInputSchema',
  'packages/ports/src/document-store.ts#appendDeltasInputSchema',
  'packages/ports/src/document-store.ts#appendDeltasResultSchema',
  'packages/ports/src/document-store.ts#loadDeltasInputSchema',
  'packages/ports/src/document-store.ts#loadDeltasResultSchema',
  'packages/ports/src/document-store.ts#loadSnapshotInputSchema',
  'packages/ports/src/document-store.ts#loadSnapshotResultSchema',
  'packages/ports/src/document-store.ts#readFrontierInputSchema',
  'packages/ports/src/document-store.ts#readFrontierResultSchema',
  'packages/ports/src/document-store.ts#saveSnapshotInputSchema',
  'packages/ports/src/stored-document-unreadable-error.ts#StoredDocumentUnreadableCode',
  'packages/ports/src/tokens.ts#Token',
  'packages/ports/src/tokens.ts#defineToken',
  'packages/reference-graph/src/reference-aggregate.ts#ReferenceAggregate',
  'packages/scene/src/scene-graph.ts#IconSceneNode',
  'packages/scene/src/scene-graph.ts#ShapeId',
  'packages/search/src/full-text.ts#tokenize',
  'packages/search/src/full-text.ts#tokenizeForIndex',
  'packages/search/src/snippet.ts#CONTEXT_RADIUS',
  'packages/server-core/src/api-errors.ts#apiErrorCodeSchema',
  'packages/server-core/src/operations/restore-version.ts#RestoreVersionResult',
  'packages/server-core/src/tools/body-edit.ts#bodyEditInputSchema',
  'packages/server-core/src/tools/canvas-edit-placement.ts#PLACEMENT_COLUMNS',
  'packages/server-core/src/tools/canvas-render-svg.ts#canvasRenderSvgInputSchema',
  'packages/server-core/src/tools/canvas-snapshot.ts#SNAPSHOT_MAX_EDGES',
  'packages/server-core/src/tools/canvas-snapshot.ts#SNAPSHOT_MAX_NODES',
  'packages/server-core/src/tools/canvas-snapshot.ts#SNAPSHOT_TEXT_MAX_CHARS',
  'packages/server-core/src/tools/canvas-view.ts#canvasViewInputSchema',
  'packages/server-core/src/tools/canvas-view.ts#canvasViewOutputSchema',
  'packages/server-core/src/tools/document-set.ts#documentSetInputSchema',
  'packages/server-core/src/tools/facet-list.ts#facetListOutputSchema',
  'packages/server-core/src/tools/facet-set.ts#DocumentHasNoFrontmatterError',
  'packages/server-core/src/tools/facet-set.ts#FacetSetNeedsPayloadError',
  'packages/server-core/src/tools/facet-set.ts#NodeAndCanvasTargetError',
  'packages/server-core/src/tools/facet-set.ts#NodeAndEdgeTargetError',
  'packages/server-core/src/tools/facet-set.ts#NodeTargetNeedsOneDocumentError',
  'packages/server-core/src/tools/facet-set.ts#facetSetInputSchema',
  'packages/server-core/src/tools/stencil-library.ts#STENCIL_LIBRARY_PATH',
  'packages/server-core/src/tools/version-list.ts#versionListInputSchema',
  'packages/server-core/src/tools/version-list.ts#versionListOutputSchema',
  'packages/server-core/src/tools/version-restore.ts#RestoreTargetExistsError',
  'packages/server-core/src/tools/version-restore.ts#SubtreeNeedsWorkspaceVersionError',
  'packages/server-core/src/tools/version-restore.ts#SubtreeTakesNoTargetError',
  'packages/server-core/src/tools/version-restore.ts#VersionNotFoundError',
  'packages/server-core/src/tools/version-restore.ts#versionRestoreInputSchema',
  'packages/server-core/src/tools/version-restore.ts#versionRestoreOutputSchema',
  'packages/server-core/src/tools/version-save.ts#versionSaveInputSchema',
  'packages/server-core/src/tools/version-save.ts#versionSaveOutputSchema',
  'packages/server-core/src/tools/workspace-edit.ts#workspaceEditInputSchema',
]

/** Kept on purpose, each with why. */
const INTENTIONAL: Readonly<Record<string, string>> = {
  'packages/canvas-render/src/quality/drawing-score.ts#FRAME_CLEARANCE_FLOOR_PX':
    'part of the `scoring` subpath’s published surface, whose name list scoring-subpath.test.ts pins',
  'packages/mcp-server/src/server/security/macaroon.ts#mintMacaroon':
    'the tested core of the ADR-0043 act-plane token, kept until a surface mints one',
  'packages/mcp-server/src/server/security/macaroon.ts#attenuateMacaroon':
    'the other half of that core: attenuation by arithmetic is the property the file exists for',
  'packages/mcp-server/src/server/security/route-scope-registry.ts#API_ROUTE_RULE_NAMES':
    'the rule names the shadowing walk and the partition test are asserted over, kept beside the rules',
  'packages/mcp-server/src/server/security/route-scope-registry.ts#GATED_RULE_NAMES':
    'the other half of the membership-gate partition, asserted by route-scope-registry.test.ts against the origin-trusted list',
  'packages/mcp-server/src/server/store/backup-retention.ts#sealableSnapshots':
    'no production caller on purpose: it presumes a mirror running behind the snapshot (see ADR-0021 status note), kept correct by its property test',
  'packages/mcp-server/src/server/store/db/schema-ledger.ts#LEDGER':
    'the schema the migrations are held to, read by the schema-ledger test',
  'packages/mcp-server/src/server/store/db/schema-ledger.ts#NULLABLE_IN_DATABASE':
    'deliberate NOT-NULL gaps, each with its reason and checked from the other side by the schema-ledger test',
  'packages/server-core/src/search/search-corpus.ts#CORPUS_DOCUMENTS':
    'the judged corpus kept beside the search it measures; the ranking tests are its reader',
  'packages/server-core/src/search/search-corpus.ts#JUDGED_QUERIES':
    'the judged queries over that corpus; the ranking tests are its reader',
}

/** How many entries the two debt lists hold, pinned by equality. */
const DEBT_CEILING = 440

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
      { path: 'packages/a/src/lib.test.ts', text: 'dead(); internal(); y\n' },
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
        [lib]: 'export const resetForTests = 1\nexport const _internal = 2\n',
        'tools/arch-lint/src/x.ts': 'export const policed = 1\n',
        'packages/a/src/lib.test.ts': 'resetForTests; _internal; policed\n',
      }),
    ).toEqual([])
  })

  it('reads a path as a test by what it is called and where it sits', () => {
    for (const path of [
      'a/x.test.ts',
      'a/x.spec.tsx',
      'a/test-utils/y.ts',
      'a/testing/y.ts',
      'a/fixtures/y.ts',
      'a/startup.smoke-impl.ts',
    ]) {
      expect(isTestFile(path), path).toBe(true)
    }
    expect(isTestFile('a/src/lib.ts')).toBe(false)
  })
})

describe('exports only a test uses are held from both sides', () => {
  const files = readRepoFiles()
  const found = findTestOnlyExports(files)
  const keys = new Set(found.map(({ key }) => key))
  const debt = [...NO_USE_BESIDE_TESTS, ...EXPORTED_FOR_ITS_TEST]
  const ownUsesOf = new Map(found.map(({ key, ownUses }) => [key, ownUses]))

  it('scans a tree worth scanning', () => {
    // An empty or truncated scan agrees with every ledger below.
    expect(files.length).toBeGreaterThan(2500)
    expect(found.length).toBeGreaterThan(300)
  })

  it('finds no test-only export outside the ledger', () => {
    const unlisted = found
      .filter(({ key }) => !debt.includes(key) && !(key in INTENTIONAL))
      .map(({ key }) => key)
    expect(
      unlisted,
      'an export that only a test uses: delete it, drop its `export`, or register it in INTENTIONAL with why',
    ).toEqual([])
  })

  it('lists no export that has stopped being test-only', () => {
    expect(
      debt.filter((key) => !keys.has(key)),
      'gone, used by shipped code now, or no longer exported — delete the entry and lower DEBT_CEILING',
    ).toEqual([])
  })

  it('keeps every entry in the list that says what it is', () => {
    expect(NO_USE_BESIDE_TESTS.filter((key) => (ownUsesOf.get(key) ?? 0) > 0)).toEqual([])
    expect(EXPORTED_FOR_ITS_TEST.filter((key) => ownUsesOf.get(key) === 0)).toEqual([])
  })

  it('keeps each deliberate one real, reasoned and test-only', () => {
    for (const [key, reason] of Object.entries(INTENTIONAL)) {
      expect(keys.has(key), `${key} is not a test-only export any more — delete its entry`).toBe(
        true,
      )
      expect(reason.split(/\s+/).length, `${key} needs a reason`).toBeGreaterThan(6)
    }
    expect(debt.filter((key) => key in INTENTIONAL)).toEqual([])
  })

  it('holds the debt at its declared ceiling', () => {
    expect(
      debt.length,
      debt.length > DEBT_CEILING
        ? 'a test-only export was added to the debt: delete or un-export it instead'
        : 'a test-only export was cleaned up — lower DEBT_CEILING to match',
    ).toBe(DEBT_CEILING)
    expect(new Set(debt).size, 'an entry is listed twice').toBe(debt.length)
  })
})
