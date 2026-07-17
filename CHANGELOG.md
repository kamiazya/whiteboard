# Changelog

## [0.0.18](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.17...whiteboard-plugin-v0.0.18) (2026-07-17)


### Bug Fixes

* **mcp-server:** align distribution smoke expectations with the shipped auth design and fix smoke-harness bugs ([#253](https://github.com/kamiazya/whiteboard/issues/253)) ([cfc5927](https://github.com/kamiazya/whiteboard/commit/cfc5927bbedd41d14668f9e2656fcc480f1fdcd4))
* **mcp-server:** make --data-dir govern all persistence, not just the daemon registry ([#251](https://github.com/kamiazya/whiteboard/issues/251)) ([bce72c9](https://github.com/kamiazya/whiteboard/commit/bce72c9d450a7bae078e85245062cc9f38f684c0))

## [0.0.17](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.16...whiteboard-plugin-v0.0.17) (2026-07-17)


### Bug Fixes

* **mcp-server:** reject conflicting daemon token sources (env + --token-stdin) ([#249](https://github.com/kamiazya/whiteboard/issues/249)) ([285da81](https://github.com/kamiazya/whiteboard/commit/285da81ba953c634bf9f3e0169d6b75b35e5349d))

## [0.0.16](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.15...whiteboard-plugin-v0.0.16) (2026-07-17)


### Features

* **mcp-server:** derive per-worktree dev daemon ports and guard daemon identity ([#246](https://github.com/kamiazya/whiteboard/issues/246)) ([90ea8c9](https://github.com/kamiazya/whiteboard/commit/90ea8c92a1b90cae13e3d419c201b214134d2c0b))


### Bug Fixes

* **mcp-server:** exempt the legitimate storage.dataDir value from the backup-restore smoke leak check ([#247](https://github.com/kamiazya/whiteboard/issues/247)) ([713ecf9](https://github.com/kamiazya/whiteboard/commit/713ecf91e7178e0527fd48696dfb4dc99a50a7de))

## [0.0.15](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.14...whiteboard-plugin-v0.0.15) (2026-07-17)


### Features

* **mcp-server:** isolate dev daemon data under repo-local .dev-data and make DATA_DIR test-injectable ([#243](https://github.com/kamiazya/whiteboard/issues/243)) ([9922f9d](https://github.com/kamiazya/whiteboard/commit/9922f9d98c24ea0f4ae85886235c0d1b09ded0db))


### Bug Fixes

* **mcp-server:** fix backup-restore smoke daemon registration and scrub WHITEBOARD_DEV from packaged smokes ([#245](https://github.com/kamiazya/whiteboard/issues/245)) ([0f5f1a9](https://github.com/kamiazya/whiteboard/commit/0f5f1a97cc99ea1131ad9ce766a6f64f7d1d296a))

## [0.0.14](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.13...whiteboard-plugin-v0.0.14) (2026-07-17)


### Bug Fixes

* **mcp-server:** skip LLM-CLI smokes when the CLI is absent so release gates pass on CI ([#241](https://github.com/kamiazya/whiteboard/issues/241)) ([1e0067f](https://github.com/kamiazya/whiteboard/commit/1e0067fa61d116d58aeb66d7de7a7b8183ba682a))

## [0.0.13](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.12...whiteboard-plugin-v0.0.13) (2026-07-17)


### Features

* **mcp-server:** add daemon exact-match hosted-origin allowlist (LNA prerequisite) ([#154](https://github.com/kamiazya/whiteboard/issues/154)) ([e1ea156](https://github.com/kamiazya/whiteboard/commit/e1ea156a93edcdc4f8e9a630a7ee07fafd46cf89))
* **mcp-server:** add the /authorize consent screen and approval flow ([#230](https://github.com/kamiazya/whiteboard/issues/230)) ([fb8b4da](https://github.com/kamiazya/whiteboard/commit/fb8b4da5b27737153fb54c2c107905b121fa6b79))
* **mcp-server:** auto-load .whiteboardrc / .whiteboard/config.yaml config files for the local daemon ([#187](https://github.com/kamiazya/whiteboard/issues/187)) ([4b12e6d](https://github.com/kamiazya/whiteboard/commit/4b12e6da7fcfb8a705ccc0337b6770822ba2717b))
* **mcp-server:** auto-open the browser at the daemon's own origin ([#221](https://github.com/kamiazya/whiteboard/issues/221)) ([1df1f3e](https://github.com/kamiazya/whiteboard/commit/1df1f3e2dd122198a30011f7f6b7ef18fdf0281f))
* **mcp-server:** bridge OAuth grants to WebSocket via short-lived connection tickets ([#232](https://github.com/kamiazya/whiteboard/issues/232)) ([f757485](https://github.com/kamiazya/whiteboard/commit/f757485d1ae0a0a6d6f5122a4a6fae989fc0335a))
* **mcp-server:** create_pairing_link tool — mint #wb= daemon-pairing URLs ([#167](https://github.com/kamiazya/whiteboard/issues/167)) ([e3e32b3](https://github.com/kamiazya/whiteboard/commit/e3e32b3ed4cf956dcf97391393e7d4b16c7ea06c))
* **mcp-server:** declare route/WS scopes in one registry, enforce WS scope per message ([#227](https://github.com/kamiazya/whiteboard/issues/227)) ([558b46f](https://github.com/kamiazya/whiteboard/commit/558b46fcbb336fcb305823645d4cfd52fb1f24d4))
* **mcp-server:** delete the legacy src/app UI — apps/web is now the only frontend (ADR 0001 complete) ([#203](https://github.com/kamiazya/whiteboard/issues/203)) ([b0207f9](https://github.com/kamiazya/whiteboard/commit/b0207f9978a2cad4eabeed0e3ed1dfa6372cb162))
* **mcp-server:** enforce approved OAuth grant scopes on /api/* ([#231](https://github.com/kamiazya/whiteboard/issues/231)) ([164fe01](https://github.com/kamiazya/whiteboard/commit/164fe01fa5769e5fabba502db2b0c98f54115904))
* **mcp-server:** OAuth 2.1 authorization-server skeleton for hosted-origin access ([#229](https://github.com/kamiazya/whiteboard/issues/229)) ([0020619](https://github.com/kamiazya/whiteboard/commit/0020619b8e63fc8d950b1c3671bcc50e527ffde5))
* **mcp-server:** serve the built apps/web as the daemon's same-origin canonical UI (R3 of MCP-UI retirement) ([#198](https://github.com/kamiazya/whiteboard/issues/198)) ([efca6d0](https://github.com/kamiazya/whiteboard/commit/efca6d060402ca339438fa672404fac00d5155c8))
* **mcp-server:** support wildcard subdomain patterns in allowed-origin allowlists ([#186](https://github.com/kamiazya/whiteboard/issues/186)) ([d09687f](https://github.com/kamiazya/whiteboard/commit/d09687fffd8f3323a27bbe92486404504c2e7219))
* **mcp-server:** unify canvas export behind export_canvas, add SVG support ([#220](https://github.com/kamiazya/whiteboard/issues/220)) ([372aec7](https://github.com/kamiazya/whiteboard/commit/372aec792c87234db81b252b7dc86d7fa066e6d1))
* **web,mcp-server:** rename branch/merge UI copy to Variation/Combine ([#185](https://github.com/kamiazya/whiteboard/issues/185)) ([12e1d09](https://github.com/kamiazya/whiteboard/commit/12e1d0990039db5b866a9d2648b19b2729489e52))
* **web:** add daemonConnectionPayloadSchema for the #wb= pairing fragment ([#153](https://github.com/kamiazya/whiteboard/issues/153)) ([d613644](https://github.com/kamiazya/whiteboard/commit/d61364420f1709c341898cf9e4a10fec5fa6eef6))
* **web:** add delete confirmation dialog to browser-local canvas page ([#152](https://github.com/kamiazya/whiteboard/issues/152)) ([de6cf6e](https://github.com/kamiazya/whiteboard/commit/de6cf6e264fbd35b71ffeb611373b132900413f4))
* **web:** add Duplicate canvas to the browser-local page and the daemon gallery ([#195](https://github.com/kamiazya/whiteboard/issues/195)) ([3487529](https://github.com/kamiazya/whiteboard/commit/34875294ff70567591f5300459a284b791d7103b))
* **web:** daemon canvas gallery page with Storage tab and working back navigation ([#184](https://github.com/kamiazya/whiteboard/issues/184)) ([088fb67](https://github.com/kamiazya/whiteboard/commit/088fb673cc51bb4846c0b202ec463053ab63ca99))
* **web:** daemon-detection probe, migration CTA banner, and copy-first browser-local import ([#163](https://github.com/kamiazya/whiteboard/issues/163)) ([c2c46e8](https://github.com/kamiazya/whiteboard/commit/c2c46e89850f3d5007677e7c22562cdbc213e0cc))
* **web:** make canvases addressable — history routing, deep links, and Pages SPA fallback ([#204](https://github.com/kamiazya/whiteboard/issues/204)) ([a023244](https://github.com/kamiazya/whiteboard/commit/a0232444875a02ffe4aca515f6716e6cc01fcb12))
* **web:** make the WS-rejected (live sync off) state unmissable on DaemonCanvasPage ([#171](https://github.com/kamiazya/whiteboard/issues/171)) ([f1fe3ed](https://github.com/kamiazya/whiteboard/commit/f1fe3ed50043bb8a406392711dc23bbeeba62458))
* **web:** migrate the doc-screenshot pipeline to canonical apps/web components (R4 of MCP-UI retirement) ([#197](https://github.com/kamiazya/whiteboard/issues/197)) ([393de85](https://github.com/kamiazya/whiteboard/commit/393de8559543e0c8f5519938bc50756ee09cfac9))
* **web:** probe-based capability tiers with an honest tier-2 notice ([#164](https://github.com/kamiazya/whiteboard/issues/164)) ([52e7e6e](https://github.com/kamiazya/whiteboard/commit/52e7e6e65ddbf6357868638927a863a40f835313))
* **web:** PWA — manifest, service worker precache, prompt-based update flow ([#162](https://github.com/kamiazya/whiteboard/issues/162)) ([feff1ff](https://github.com/kamiazya/whiteboard/commit/feff1ff0524338838905efe01f2b80cbfa3b8b7d))
* **web:** render the real daemon editor for the local-daemon provider state ([#181](https://github.com/kamiazya/whiteboard/issues/181)) ([41f2d83](https://github.com/kamiazya/whiteboard/commit/41f2d83eec89bd23f1ec28317b08ffbd12201cac))
* **web:** surface PNG/SVG export from the canvas header ([#217](https://github.com/kamiazya/whiteboard/issues/217)) ([f717cb3](https://github.com/kamiazya/whiteboard/commit/f717cb3dbf06549b43ef45489136949e7362f1fa))
* **web:** unify page chrome on WorkspaceTopBar and wire remaining components ([#168](https://github.com/kamiazya/whiteboard/issues/168)) ([6e0e3b6](https://github.com/kamiazya/whiteboard/commit/6e0e3b69f2fd02f7f070e8139fdc34d6db162580))
* **web:** unify the top-bar skeleton — WorkspaceTopBar local mode adopted by the browser-local page ([#183](https://github.com/kamiazya/whiteboard/issues/183)) ([503316e](https://github.com/kamiazya/whiteboard/commit/503316e0d6241a4082e5da46b348bd71a9730191))
* **web:** wire branch UI and merge into the daemon-paired canvas page ([#161](https://github.com/kamiazya/whiteboard/issues/161)) ([da6bbeb](https://github.com/kamiazya/whiteboard/commit/da6bbeb69d586203438576fd9d135b1f459c62c4))
* **web:** wire DaemonBackend into apps/web via #wb= pairing fragment ([#159](https://github.com/kamiazya/whiteboard/issues/159)) ([6e4c2a1](https://github.com/kamiazya/whiteboard/commit/6e4c2a146ba6d36e87f129c850f8878e60eed8bb))
* **web:** wire version history (list/restore) into the daemon-paired canvas page ([#160](https://github.com/kamiazya/whiteboard/issues/160)) ([ce4f2cb](https://github.com/kamiazya/whiteboard/commit/ce4f2cbd875d03f3d664277a740e1f6b36e9c8ec))
* **web:** workspace switcher, manual save, authorized thumbnails, and WS auth-loop fix ([#165](https://github.com/kamiazya/whiteboard/issues/165)) ([2c50941](https://github.com/kamiazya/whiteboard/commit/2c50941e18218bdb65ebaa9cee2e80d709092850))


### Bug Fixes

* cleanup-worktrees must not delete never-published lanes ([#172](https://github.com/kamiazya/whiteboard/issues/172)) ([1943acc](https://github.com/kamiazya/whiteboard/commit/1943acce5126efe8124c61db8c643cc727dd470b))
* close the open CodeQL alerts (ReDoS + case-insensitive tag matching) ([#210](https://github.com/kamiazya/whiteboard/issues/210)) ([7fed555](https://github.com/kamiazya/whiteboard/commit/7fed555caa2b921e4a6723d67174a98b755e6c75))
* **mcp-server,web:** keep MergeDialog confirm footer reachable below 800px viewports ([#173](https://github.com/kamiazya/whiteboard/issues/173)) ([08a91ae](https://github.com/kamiazya/whiteboard/commit/08a91ae2d5bc6e4f8e5f336c64b26846593b0c86))
* **mcp-server,web:** root-fix the two recurring CI test flakes ([#180](https://github.com/kamiazya/whiteboard/issues/180)) ([07be557](https://github.com/kamiazya/whiteboard/commit/07be55767efcdcc039066100a17039b47d5653d8))
* **mcp-server:** admit cross-name loopback origins on the WS upgrade ([#169](https://github.com/kamiazya/whiteboard/issues/169)) ([5ce6b62](https://github.com/kamiazya/whiteboard/commit/5ce6b620e885e6555bf912f86dcc000b98ae098f))
* **mcp-server:** allow targetless box-snapped arrows in the annotate tool schema ([#190](https://github.com/kamiazya/whiteboard/issues/190)) ([871dc02](https://github.com/kamiazya/whiteboard/commit/871dc022bca2ba2f2bf30538fa5e3f3be9a88611))
* **mcp-server:** clear request-timeout timers on early resolve in viewport/export routes ([#188](https://github.com/kamiazya/whiteboard/issues/188)) ([1808dfe](https://github.com/kamiazya/whiteboard/commit/1808dfe7ca20bd6495286e9e5dadcea537532bc2))
* **mcp-server:** correct box_with_label wrapping and expose frame names in canvas_inspect ([#219](https://github.com/kamiazya/whiteboard/issues/219)) ([81fce7d](https://github.com/kamiazya/whiteboard/commit/81fce7dd0bed6b94c9f091d8b4bf9ceb7edefd72))
* **mcp-server:** document every MCP tool input field and honor annotate_batch per-item groupAs ([#205](https://github.com/kamiazya/whiteboard/issues/205)) ([7987bc2](https://github.com/kamiazya/whiteboard/commit/7987bc28e275ca52ed1117a17b3acabaccd7ac5a))
* **mcp-server:** harden packaged tarball smoke daemon cold-start with opt-in bounded retry ([#156](https://github.com/kamiazya/whiteboard/issues/156)) ([680e076](https://github.com/kamiazya/whiteboard/commit/680e076dd31cc57299f2fdc045fb3fe9381ebb7a))
* **mcp-server:** harden scope enforcement (file-route write verbs, WS close on scope violation) ([#228](https://github.com/kamiazya/whiteboard/issues/228)) ([87145f5](https://github.com/kamiazya/whiteboard/commit/87145f54ad9c350eedc8f67812249cac441ce40c))
* **mcp-server:** harden WS binary import against malformed Loro frames ([#238](https://github.com/kamiazya/whiteboard/issues/238)) ([f404cbe](https://github.com/kamiazya/whiteboard/commit/f404cbea9dd2d8da004e07414f7397196d32f666))
* **mcp-server:** make auto-compact disposal deterministic against mid-disposal reschedules ([#193](https://github.com/kamiazya/whiteboard/issues/193)) ([de3e961](https://github.com/kamiazya/whiteboard/commit/de3e961d50dd7f7b4f61ff0004f62659288139ff))
* **mcp-server:** make export outputPath rejections name the allowed sandbox root ([#189](https://github.com/kamiazya/whiteboard/issues/189)) ([21ea32f](https://github.com/kamiazya/whiteboard/commit/21ea32fb406b566c0f2f0be6079747940154da03))
* **mcp-server:** make restore overwrite reconcile onto the target instead of replacing it ([#209](https://github.com/kamiazya/whiteboard/issues/209)) ([6a862fa](https://github.com/kamiazya/whiteboard/commit/6a862faa55a6214a39e560d631fc6062f14dd27b))
* **mcp-server:** redact secrets in log output ([#211](https://github.com/kamiazya/whiteboard/issues/211)) ([956dbc9](https://github.com/kamiazya/whiteboard/commit/956dbc93504336a3e837df069a25818e10247a12))
* **mcp-server:** reject update_element text patches on arrows instead of lying ok:true ([#215](https://github.com/kamiazya/whiteboard/issues/215)) ([b20f808](https://github.com/kamiazya/whiteboard/commit/b20f808dd1b1faaef868274a9162b2b46c4d7867))
* **mcp-server:** remove the unused create_canvas issueNumber slug prefix ([#202](https://github.com/kamiazya/whiteboard/issues/202)) ([b1a42cd](https://github.com/kamiazya/whiteboard/commit/b1a42cddad362d475e4126ac85c7e74c7bc76c1e))
* **mcp-server:** require bearer auth on canvas/asset GET routes ([#226](https://github.com/kamiazya/whiteboard/issues/226)) ([f0d94ee](https://github.com/kamiazya/whiteboard/commit/f0d94ee83bb082ea90afdc5d2d510b9b89528e4a))
* **mcp-server:** stop the packaged tarball smoke from inheriting WHITEBOARD_DEV ([#240](https://github.com/kamiazya/whiteboard/issues/240)) ([cdd5d6c](https://github.com/kamiazya/whiteboard/commit/cdd5d6caacd4d7c3f698383cfd24ba784847b93c))
* never treat main-ancestry as a fold signal in cleanup-worktrees ([#177](https://github.com/kamiazya/whiteboard/issues/177)) ([9f5bb89](https://github.com/kamiazya/whiteboard/commit/9f5bb89addd4d791301015aece45a34d31ad7707))
* **release:** narrow npm publish gate to publishability, not correctness ([#157](https://github.com/kamiazya/whiteboard/issues/157)) ([dbe61f9](https://github.com/kamiazya/whiteboard/commit/dbe61f9fa1b3cc8d1ab172e7acc7b6222a5e1002))
* **release:** use un-prefixed root outputs so advance-stable actually runs ([#239](https://github.com/kamiazya/whiteboard/issues/239)) ([52c5359](https://github.com/kamiazya/whiteboard/commit/52c5359793c0c91a02cd94b88b695498b7879788))
* **test:** pre-bundle testing-library deps to stop vitest browser dynamic-import flake ([#158](https://github.com/kamiazya/whiteboard/issues/158)) ([e86f298](https://github.com/kamiazya/whiteboard/commit/e86f2984753b04f8aeb56faf06873061610ffce0))
* **web:** apply theme tokens to page root so dark mode text is readable ([#174](https://github.com/kamiazya/whiteboard/issues/174)) ([5053285](https://github.com/kamiazya/whiteboard/commit/50532855e54e83a35ccb9126c77ab16f9ea2e36c))
* **web:** confirm copy-canvas-URL success/failure instead of failing silently ([#216](https://github.com/kamiazya/whiteboard/issues/216)) ([5f4b657](https://github.com/kamiazya/whiteboard/commit/5f4b657d52082c2dcc37461893a4305f1a6f7d40))
* **web:** give unsupported-browser notice an escape hatch to the daemon origin ([#222](https://github.com/kamiazya/whiteboard/issues/222)) ([2dfbb52](https://github.com/kamiazya/whiteboard/commit/2dfbb52d6ee5c1b98139ba264227011579d09343))
* **web:** keep the unsupported-browser notice and its escape hatch on one line ([#223](https://github.com/kamiazya/whiteboard/issues/223)) ([ebc951b](https://github.com/kamiazya/whiteboard/commit/ebc951bd89d7d9990a606a9e801808d27ff350fb))
* **web:** percent-encode workspaceId and slug in the import fetch paths ([#166](https://github.com/kamiazya/whiteboard/issues/166)) ([f92e7a3](https://github.com/kamiazya/whiteboard/commit/f92e7a3d24035b64b2b0800b04974e14b9c83041))
* **web:** polish the variation/combine UI — dark-mode preview panel, clearer hint copy, menu truncation, tooltip dismissal ([#199](https://github.com/kamiazya/whiteboard/issues/199)) ([cd8a658](https://github.com/kamiazya/whiteboard/commit/cd8a658c0903d0976773880119fb882a2a60565b))
* **web:** route apps/web diagnostics through app-logger and guard console with Biome ([#213](https://github.com/kamiazya/whiteboard/issues/213)) ([23c4dc6](https://github.com/kamiazya/whiteboard/commit/23c4dc6801c60e2a132ad6a3512696ff29458a84))


### Performance Improvements

* **web:** cut apps/web critical-path JS from 555KB to 119KB gz and fix the bundle gate to measure it ([#192](https://github.com/kamiazya/whiteboard/issues/192)) ([8dd0a54](https://github.com/kamiazya/whiteboard/commit/8dd0a54ad9821494b23ed7b162b45edd76e0d4b7))
* **web:** drop the loro-crdt manualChunks rule that dragged it into the entry's critical path ([#196](https://github.com/kamiazya/whiteboard/issues/196)) ([3220a8c](https://github.com/kamiazya/whiteboard/commit/3220a8c07918208e24057e913e71be7e41b45b5c))

## [0.0.12](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.11...whiteboard-plugin-v0.0.12) (2026-07-10)


### Features

* **mcp-server:** expose api-client/api-contracts subpaths, port pure libs to apps/web ([#140](https://github.com/kamiazya/whiteboard/issues/140)) ([ee277e4](https://github.com/kamiazya/whiteboard/commit/ee277e45b11b4f88be519beadc203f300e4f70cd))
* **mcp-server:** harden local-daemon auth surface ([#141](https://github.com/kamiazya/whiteboard/issues/141)) ([dca3863](https://github.com/kamiazya/whiteboard/commit/dca3863dcf5908da4520393efd59911f019269bf))
* **mcp-server:** move daemonToken out of runtime config into a one-shot TokenStore ([#148](https://github.com/kamiazya/whiteboard/issues/148)) ([8f9039f](https://github.com/kamiazya/whiteboard/commit/8f9039f84a10aba1d0e39b4c1aee7c95a3e10763))
* **web:** capability-gated daemon-feature teasers in apps/web ([#129](https://github.com/kamiazya/whiteboard/issues/129)) ([54362bf](https://github.com/kamiazya/whiteboard/commit/54362bf691823a3af5271d01c125489325bd3bad))
* **web:** editable canvas title with browser-local persistence ([#120](https://github.com/kamiazya/whiteboard/issues/120)) ([6e7eff4](https://github.com/kamiazya/whiteboard/commit/6e7eff4fa74ef48a1866f84020676b3131adbb61))
* **web:** id-addressed multi-canvas foundation for browser-local storage ([#122](https://github.com/kamiazya/whiteboard/issues/122)) ([0729393](https://github.com/kamiazya/whiteboard/commit/0729393804f35472610c2278875fd0be50aef2c1))
* **web:** make useCanvasSync capability-complete for daemon wiring ([#136](https://github.com/kamiazya/whiteboard/issues/136)) ([d231d21](https://github.com/kamiazya/whiteboard/commit/d231d214d401b98e11fa0c40f7e03458ec079463))
* **web:** multi-canvas UI — canvas switcher and New-canvas control ([#123](https://github.com/kamiazya/whiteboard/issues/123)) ([3646e43](https://github.com/kamiazya/whiteboard/commit/3646e43fe4e3fc7f8ae2521ca9ac277a271f5fc8))
* **web:** port branch UI (HeaderBranchChip / HeaderBranchBanner) ([#147](https://github.com/kamiazya/whiteboard/issues/147)) ([59c862f](https://github.com/kamiazya/whiteboard/commit/59c862f0c32fda46190fb8bb5cc8478776e659d0))
* **web:** port merge UI with a Zod-typed merge_committed event contract ([#144](https://github.com/kamiazya/whiteboard/issues/144)) ([8ea48e1](https://github.com/kamiazya/whiteboard/commit/8ea48e17efcc5625155f5241c6bdfb920aee9e4b))
* **web:** port misc UI components (CanvasThumb/ThemeToggle/ErrorBoundary/HeaderSaveDot) ([#143](https://github.com/kamiazya/whiteboard/issues/143)) ([51c7c77](https://github.com/kamiazya/whiteboard/commit/51c7c77133e789491bce9c92c943d9a56bada942))
* **web:** port pure-logic hooks (theme/dirty-state/fullscreen) to apps/web ([#139](https://github.com/kamiazya/whiteboard/issues/139)) ([57a021f](https://github.com/kamiazya/whiteboard/commit/57a021ff35b3abcaa8aee749707dd82c4a6b96e8))
* **web:** port StorageReportCard with Zod-validated storage responses ([#146](https://github.com/kamiazya/whiteboard/issues/146)) ([9393d78](https://github.com/kamiazya/whiteboard/commit/9393d787348f8292ee0cf5a7a2bdfde4680b901e))
* **web:** port useBranches (callback-based) and VersionTimeline ([#145](https://github.com/kamiazya/whiteboard/issues/145)) ([fb6baa3](https://github.com/kamiazya/whiteboard/commit/fb6baa3961233ed7b5c2d6d048119baf5a78649c))
* **web:** port WorkspaceTopBar aggregation component ([#149](https://github.com/kamiazya/whiteboard/issues/149)) ([29ca30e](https://github.com/kamiazya/whiteboard/commit/29ca30e8d7fcb93fabd08543c7e5df87bb9c5de9))


### Bug Fixes

* **audit-triage:** include skill resources/*.md in ai-assets scope ([10240b6](https://github.com/kamiazya/whiteboard/commit/10240b620f120f57abee089ddb8c46f74316f078))
* **claude:** fail fast on malformed dimension entries in audit/review workflows ([a217efc](https://github.com/kamiazya/whiteboard/commit/a217efc84ed88d0febc637664d0f39eb3c487d61))
* **claude:** give coverage-gap advisories the same dimension field as real findings ([55db21c](https://github.com/kamiazya/whiteboard/commit/55db21c46f8ef75c1bb8fd3189ea1aeda5fdd738))
* **claude:** keep review findings whose verify agent died instead of silently dropping ([fbd5c31](https://github.com/kamiazya/whiteboard/commit/fbd5c3136940a64dc7662c20bbba6398be95fac1))
* **claude:** make failed mandatory review lanes gate instead of silently passing ([336784e](https://github.com/kamiazya/whiteboard/commit/336784ed908081217f09c4853eb41d3d06bc5ffc))
* **release:** honour SMOKE_RPC_TIMEOUT in the tarball smoke path too ([#118](https://github.com/kamiazya/whiteboard/issues/118)) ([f8e5d17](https://github.com/kamiazya/whiteboard/commit/f8e5d17aa4294b4c7760cea1518d9387f0b42fb7))
* **web:** allow browser-local mode on Cloudflare Pages preview origins ([#133](https://github.com/kamiazya/whiteboard/issues/133)) ([f0e8b08](https://github.com/kamiazya/whiteboard/commit/f0e8b08581217a1bc506304f4501a8cce6eaeae6))

## [0.0.11](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.10...whiteboard-plugin-v0.0.11) (2026-07-05)


### Features

* **shared:** MigrationBundle contract + package export ([#116](https://github.com/kamiazya/whiteboard/issues/116)) ([63fa9a3](https://github.com/kamiazya/whiteboard/commit/63fa9a371c85725b2efef25fb44e5ec26c1d1a7a))
* **web:** add UserSettingsStore for non-secret UI prefs ([#112](https://github.com/kamiazya/whiteboard/issues/112)) ([1da4677](https://github.com/kamiazya/whiteboard/commit/1da4677f315ce10a57d572f620eba20b3d46411a))
* **web:** backend configuration chip ([#113](https://github.com/kamiazya/whiteboard/issues/113)) ([74a68ea](https://github.com/kamiazya/whiteboard/commit/74a68ea0311c0462e9a9eb2c8c6ae455e5835c9e))
* **web:** dismissable beta banner ([#115](https://github.com/kamiazya/whiteboard/issues/115)) ([e8a583b](https://github.com/kamiazya/whiteboard/commit/e8a583bb5ec4c936a4f41961761a5971da55c19c))


### Bug Fixes

* **ci:** cache Docker dry-run build, reuse mcp-server dist artifact ([#107](https://github.com/kamiazya/whiteboard/issues/107)) ([f7cbfcb](https://github.com/kamiazya/whiteboard/commit/f7cbfcb490656ad9bb13d27aeb57dad8c6693513))
* **mcp:** guard StorageReportCard async setState against post-unmount crashes ([#111](https://github.com/kamiazya/whiteboard/issues/111)) ([da16f36](https://github.com/kamiazya/whiteboard/commit/da16f362ee5db25be552ad92c3fdafa0eea82b45))
* **release:** extend smoke RPC deadline on CI publish jobs ([#110](https://github.com/kamiazya/whiteboard/issues/110)) ([0d28af5](https://github.com/kamiazya/whiteboard/commit/0d28af55af97e793a8a5c9422a1e2075fdb0e438))
* **release:** gate git-based plugin distribution behind releases via stable branch ([#114](https://github.com/kamiazya/whiteboard/issues/114)) ([5ae5deb](https://github.com/kamiazya/whiteboard/commit/5ae5debab2951a9164351e11ea6f2018dc153d0a))
* **web:** reconnect useCanvasSync on backend swap so reload keeps elements ([#117](https://github.com/kamiazya/whiteboard/issues/117)) ([12e304b](https://github.com/kamiazya/whiteboard/commit/12e304b6f67caeea6cb9d70460681c72f410c11a))

## [0.0.10](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.9...whiteboard-plugin-v0.0.10) (2026-07-05)


### Bug Fixes

* **deps:** clear runtime security alerts (dompurify, mermaid, otel core) ([#104](https://github.com/kamiazya/whiteboard/issues/104)) ([51a57da](https://github.com/kamiazya/whiteboard/commit/51a57da1e121ddfb3baaeb0a391b83cb322982a0))
* **release:** extend daemon startup timeout on CI publish jobs ([#108](https://github.com/kamiazya/whiteboard/issues/108)) ([6d661b1](https://github.com/kamiazya/whiteboard/commit/6d661b1987aad3c117b0b24a4c0de3b0243a86ee))
* **web:** give BrowserLocalCanvasPage a real layout — editor area was 0px ([#106](https://github.com/kamiazya/whiteboard/issues/106)) ([6233da7](https://github.com/kamiazya/whiteboard/commit/6233da74b426430f78a641b9d8b97b8511dbe2e8))

## [0.0.9](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.8...whiteboard-plugin-v0.0.9) (2026-07-05)


### Bug Fixes

* **ci:** unbreak publish jobs — validate-step cwd and SBOM generation under pnpm ([#100](https://github.com/kamiazya/whiteboard/issues/100)) ([617eeb9](https://github.com/kamiazya/whiteboard/commit/617eeb92fca5fd1f22b54fcc72eaf03d5b245a5a))
* **web:** address AI review follow-ups from [#100](https://github.com/kamiazya/whiteboard/issues/100) and [#102](https://github.com/kamiazya/whiteboard/issues/102) ([#103](https://github.com/kamiazya/whiteboard/issues/103)) ([583c618](https://github.com/kamiazya/whiteboard/commit/583c618506a5bcb510c0c5056c6bd7f968e1c0ec))
* **web:** unblank the deployed app — CSP wasm-unsafe-eval + self-hosted Excalidraw fonts ([#102](https://github.com/kamiazya/whiteboard/issues/102)) ([4857bb6](https://github.com/kamiazya/whiteboard/commit/4857bb635637add5b7aa41a23c478fe357e9e78f))

## [0.0.8](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.7...whiteboard-plugin-v0.0.8) (2026-07-05)


### Bug Fixes

* **ci:** unbreak release pipeline (wrangler pnpm fallback, invalid action pins) ([#98](https://github.com/kamiazya/whiteboard/issues/98)) ([c412d00](https://github.com/kamiazya/whiteboard/commit/c412d0095e155d56a63a45f1db964b17efef3ce3))

## [0.0.7](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.6...whiteboard-plugin-v0.0.7) (2026-07-05)


### Features

* **web:** integrate Excalidraw into BrowserLocalCanvasPage via useCanvasSync ([#70](https://github.com/kamiazya/whiteboard/issues/70)) ([ab0f39a](https://github.com/kamiazya/whiteboard/commit/ab0f39a0fe53cabbe104e3cfd75f17184b1167cb))


### Bug Fixes

* **app:** inject bearer token in Vite dev server and improve 401 error message ([b2ebb04](https://github.com/kamiazya/whiteboard/commit/b2ebb046e898fb104530a739e62155ef1a4433e9))
* **ci:** align vitest ecosystem versions via catalog to fix browser session timeout ([#82](https://github.com/kamiazya/whiteboard/issues/82)) ([dedd961](https://github.com/kamiazya/whiteboard/commit/dedd96149e1cb8ec121798e5e89c691204706006))
* **deps:** pin transitive vulns and bump catalog vite/vitest ([#84](https://github.com/kamiazya/whiteboard/issues/84)) ([71dd317](https://github.com/kamiazya/whiteboard/commit/71dd317011eaadf3721ac39931d0f6944d144699))
* **mcp:** treat text as label alias on arrow annotations in annotate_batch ([86a799e](https://github.com/kamiazya/whiteboard/commit/86a799e9bbc8d1965871542c72802d19e82f7e12))
* stop WebSocket retry loop on auth failure (close code 1008) ([8d36069](https://github.com/kamiazya/whiteboard/commit/8d36069ac03cb0914cecd373866b545c0c209e2e))
* tarball smoke (pnpm pack + tsx/esm + loro-crdt pin) + dogfood findings [#4](https://github.com/kamiazya/whiteboard/issues/4)/[#5](https://github.com/kamiazya/whiteboard/issues/5) ([#56](https://github.com/kamiazya/whiteboard/issues/56)) ([5a9e01c](https://github.com/kamiazya/whiteboard/commit/5a9e01c9c8a5fc2e9e222076cc057eb1f046db21))

## [0.0.6](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.5...whiteboard-plugin-v0.0.6) (2026-05-03)


### Features

* **mcp:** dev daemon, versioning, headless export, storage, and tracing ([#45](https://github.com/kamiazya/whiteboard/issues/45)) ([d79c94c](https://github.com/kamiazya/whiteboard/commit/d79c94cfda11a9172d7ac1ed79ab061b1abac3a9))


### Bug Fixes

* **mcp:** close PR [#45](https://github.com/kamiazya/whiteboard/issues/45) review follow-ups (6 issues) ([#47](https://github.com/kamiazya/whiteboard/issues/47)) ([1f792b8](https://github.com/kamiazya/whiteboard/commit/1f792b8ebfc42c350f5ffc032082a62ec95280b3))
* **store:** close file-gc Race C and lock version-store.save ([#48](https://github.com/kamiazya/whiteboard/issues/48)) ([42fcdfd](https://github.com/kamiazya/whiteboard/commit/42fcdfd20ef8dc83fc0c5ecd81144f2e2c7783e6))

## [0.0.5](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.4...whiteboard-plugin-v0.0.5) (2026-04-28)


### Features

* **mcp:** support outputPath and overwrite on export tools ([#32](https://github.com/kamiazya/whiteboard/issues/32)) ([d456517](https://github.com/kamiazya/whiteboard/commit/d4565178fa1d7c9167c58fc2aab0e7db9c332b0c))
* **plugin:** add Claude Code marketplace and restructure README ([#38](https://github.com/kamiazya/whiteboard/issues/38)) ([e0fde71](https://github.com/kamiazya/whiteboard/commit/e0fde7176cae33cf5a34b6a6c4e20fb344ac3b3d))
* **server:** introduce sqlite metadata store (kysely + libsql) ([#35](https://github.com/kamiazya/whiteboard/issues/35)) ([e041240](https://github.com/kamiazya/whiteboard/commit/e041240d39a1d3b347ee5f757b42241e98815651))


### Bug Fixes

* **app:** move onSceneChange debounce out of the render path ([#33](https://github.com/kamiazya/whiteboard/issues/33)) ([dcdb1a5](https://github.com/kamiazya/whiteboard/commit/dcdb1a56d1e3414bac654083a122af09dd4ed50f))
* **mcp:** bind tool handler return type to outputSchema ([#36](https://github.com/kamiazya/whiteboard/issues/36)) ([2298e2e](https://github.com/kamiazya/whiteboard/commit/2298e2e7ba1e2631d635e6c83172181f2f45fa83))
* **mcp:** default box_with_label fillStyle to solid when backgroundColor is themed ([#37](https://github.com/kamiazya/whiteboard/issues/37)) ([373e01f](https://github.com/kamiazya/whiteboard/commit/373e01f53d234d66fc6abce5340a6e860bb3b159))
* **mcp:** dogfood findings, schema-driven contracts, and execute() return types ([#42](https://github.com/kamiazya/whiteboard/issues/42)) ([5c5abda](https://github.com/kamiazya/whiteboard/commit/5c5abda5ac2f6d4b598930d227a06bb141f509f7))
* **mcp:** memoize workspace id and clean up /mcp transport per request ([#28](https://github.com/kamiazya/whiteboard/issues/28)) ([685551d](https://github.com/kamiazya/whiteboard/commit/685551dac880afd2129ceef43de504d2aa1f8a02))

## [0.0.4](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.3...whiteboard-plugin-v0.0.4) (2026-04-25)


### Bug Fixes

* harden MCP release and dev workflows ([#22](https://github.com/kamiazya/whiteboard/issues/22)) ([acfbcdb](https://github.com/kamiazya/whiteboard/commit/acfbcdb7568d24482482ffbec6ed68eeb65473b4))
* **release-please:** use linked-versions and put server.json at root ([#26](https://github.com/kamiazya/whiteboard/issues/26)) ([14756d4](https://github.com/kamiazya/whiteboard/commit/14756d47129b69738db1836ba6e8a1310f3edd64))

## [0.0.3](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.2...whiteboard-plugin-v0.0.3) (2026-04-25)


### Bug Fixes

* **release:** inline node-version (tag checkout predates .node-version) ([#20](https://github.com/kamiazya/whiteboard/issues/20)) ([866395a](https://github.com/kamiazya/whiteboard/commit/866395ac0be7bac1bbcb39e9ef71f0582480724a))
* **release:** use Node 24 + add force_publish_tag dispatch input ([#18](https://github.com/kamiazya/whiteboard/issues/18)) ([1c7bdcf](https://github.com/kamiazya/whiteboard/commit/1c7bdcff049252bc02bba6b03345704e16438a3d))
* **smoke:** pass fake DaemonClient to template tool execute (was port number) ([#21](https://github.com/kamiazya/whiteboard/issues/21)) ([a86a279](https://github.com/kamiazya/whiteboard/commit/a86a279a7421f2bf3757e4c97cb0f772ff187a7d))

## [0.0.2](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.1...whiteboard-plugin-v0.0.2) (2026-04-25)


### Features

* initial release of @kamiazya/whiteboard-mcp ([#4](https://github.com/kamiazya/whiteboard/issues/4)) ([d4c1d55](https://github.com/kamiazya/whiteboard/commit/d4c1d55efc4df56748679891f64858dbdbad85d4))


### Bug Fixes

* **release-please:** pin initial-version to 0.0.1 for both packages ([#9](https://github.com/kamiazya/whiteboard/issues/9)) ([6b35c8b](https://github.com/kamiazya/whiteboard/commit/6b35c8bb911e7e3360569a4aad6f738472bbbc82))
* **release:** force npm upgrade to avoid promise-retry MODULE_NOT_FOUND ([#13](https://github.com/kamiazya/whiteboard/issues/13)) ([f6e736b](https://github.com/kamiazya/whiteboard/commit/f6e736b033788cadef1971ea5e683b0034d59167))

## 0.0.1 (2026-04-25)


### Features

* initial release of @kamiazya/whiteboard-mcp ([#4](https://github.com/kamiazya/whiteboard/issues/4)) ([d4c1d55](https://github.com/kamiazya/whiteboard/commit/d4c1d55efc4df56748679891f64858dbdbad85d4))


### Bug Fixes

* **release-please:** pin initial-version to 0.0.1 for both packages ([#9](https://github.com/kamiazya/whiteboard/issues/9)) ([6b35c8b](https://github.com/kamiazya/whiteboard/commit/6b35c8bb911e7e3360569a4aad6f738472bbbc82))
* **release:** force npm upgrade to avoid promise-retry MODULE_NOT_FOUND ([#13](https://github.com/kamiazya/whiteboard/issues/13)) ([f6e736b](https://github.com/kamiazya/whiteboard/commit/f6e736b033788cadef1971ea5e683b0034d59167))
