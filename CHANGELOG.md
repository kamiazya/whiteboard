# Changelog

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
