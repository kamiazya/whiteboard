# Changelog

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
