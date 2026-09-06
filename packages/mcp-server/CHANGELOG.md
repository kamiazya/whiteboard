# Changelog

## [0.1.0](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.19...mcp-server-v0.1.0) (2026-09-06)


### ⚠ BREAKING CHANGES

* **server-core:** wb_body_edit's default mode is now propose. A caller that omitted mode got a refusal before (the field was required) and now gets a proposal, so nothing silently changes meaning; a caller passing mode:'apply' is unaffected.
* **server-core:** `wb_canvas_edit` no longer changes a spatial document by default. A batch of node/edge content is stored as a proposal for a person to adopt; pass mode:"apply" to write it. Batches carrying comments, locks, tidy or region.set are unaffected.
* collapse the dual document plane — the workspace tree becomes the address book ([#1084](https://github.com/kamiazya/whiteboard/issues/1084))
* **model:** facet keys become {namespace}.{name}/v{n} (ADR-0013) ([#965](https://github.com/kamiazya/whiteboard/issues/965))
* **web:** put the browser's Loro persistence behind the DocumentStore port ([#948](https://github.com/kamiazya/whiteboard/issues/948))

### Features

* **annotations:** comment on every place a reader points at, drawn where it is, on a phone and in the widget ([#1384](https://github.com/kamiazya/whiteboard/issues/1384)) ([153f127](https://github.com/kamiazya/whiteboard/commit/153f1275278849a1b84e479bf000b269e80dfd2b))
* **annotations:** focus handoff, message counts, icon-first verbs and resolve motion ([#1448](https://github.com/kamiazya/whiteboard/issues/1448)) ([1de4d48](https://github.com/kamiazya/whiteboard/commit/1de4d48561734d698705d0d9ad87e5eb5ef4e8e3))
* **annotations:** resolving a conversation ramps its canvas chrome out instead of cutting ([#1453](https://github.com/kamiazya/whiteboard/issues/1453)) ([6665824](https://github.com/kamiazya/whiteboard/commit/6665824febc5624094080bb1b4a8bb6441c56d98))
* **annotations:** the markdown markers cross to the resolved look instead of cutting ([#1459](https://github.com/kamiazya/whiteboard/issues/1459)) ([98ccecd](https://github.com/kamiazya/whiteboard/commit/98ccecd3a285bd69830e5e77f7b09eea12e88dcb))
* **arch:** extract the daemon's browser-safe client half into packages/daemon-client ([#1359](https://github.com/kamiazya/whiteboard/issues/1359)) ([f7a391b](https://github.com/kamiazya/whiteboard/commit/f7a391b8bc3e63d7983fe5f23771d846599194da))
* **canvas-render:** dress the comment layer as floating chrome, not a content node ([#1212](https://github.com/kamiazya/whiteboard/issues/1212)) ([ec1b341](https://github.com/kamiazya/whiteboard/commit/ec1b341e8a2be188b44e71929282529d29483d9c))
* **canvas-viewer:** restore the widget's sticky-note append via wb_canvas_edit ([#1200](https://github.com/kamiazya/whiteboard/issues/1200)) ([de6b636](https://github.com/kamiazya/whiteboard/commit/de6b636f6a78ec957c5710b25b04105f6f20b4f5))
* collapse the dual document plane — the workspace tree becomes the address book ([#1084](https://github.com/kamiazya/whiteboard/issues/1084)) ([627fde0](https://github.com/kamiazya/whiteboard/commit/627fde009d861e5a1b479e9886ba67ab9e27e6e4))
* **dev-flow:** the second-occurrence rule gets a watcher, from annotations CI already emits ([#1284](https://github.com/kamiazya/whiteboard/issues/1284)) ([e166016](https://github.com/kamiazya/whiteboard/commit/e166016c10dd2071077748397f774a454e16bd1a))
* **facet-engine:** the facet engine — plugin registry, validation layers, compat chains, canvas facet slot ([#967](https://github.com/kamiazya/whiteboard/issues/967)) ([42e607f](https://github.com/kamiazya/whiteboard/commit/42e607fbc36d11e8dd6aae1ab613d931fd433057))
* **facet-ui:** a plugin owns how its facets are edited ([#1031](https://github.com/kamiazya/whiteboard/issues/1031)) ([bd87f6e](https://github.com/kamiazya/whiteboard/commit/bd87f6ee6f95e720299723865af0e8ac4208ed7b))
* **history:** a document's branches live on the workspace record, on a plane that merges ([#1423](https://github.com/kamiazya/whiteboard/issues/1423)) ([76e5c91](https://github.com/kamiazya/whiteboard/commit/76e5c91bfa5c7b241145d01043f21a3b65d91bab))
* **lint:** turn three silent logging and coverage failures into loud ones ([#1306](https://github.com/kamiazya/whiteboard/issues/1306)) ([e8e7147](https://github.com/kamiazya/whiteboard/commit/e8e71473cace8f8f8a098d3a6f1110c76d865bd7))
* **mcp-server:** re-key every daemon workspace onto a canonical ULID ([#1111](https://github.com/kamiazya/whiteboard/issues/1111)) ([8b8d937](https://github.com/kamiazya/whiteboard/commit/8b8d937691104700e43bef031aa42c064f3cf5f2))
* **mcp-server:** resolve the workspace handle on the daemon's own surfaces ([#1110](https://github.com/kamiazya/whiteboard/issues/1110)) ([4c5cc1e](https://github.com/kamiazya/whiteboard/commit/4c5cc1eb7de7e20317b153fad505ce746558b685))
* **mcp-server:** restore the pairing-link MCP tool as wb_pairing_link_create ([#1102](https://github.com/kamiazya/whiteboard/issues/1102)) ([2a26203](https://github.com/kamiazya/whiteboard/commit/2a262031a63b5a84bc247fc55f0beb1ec6d979ee))
* **mcp-server:** store and serve workspace segment + displayName through the published contract ([#1104](https://github.com/kamiazya/whiteboard/issues/1104)) ([498f12e](https://github.com/kamiazya/whiteboard/commit/498f12e71dd40d5afa9ed666e12eea801c8c46fd))
* **mcp-server:** the daemon keeps a branch on the workspace record, not in a row ([#1424](https://github.com/kamiazya/whiteboard/issues/1424)) ([94dc813](https://github.com/kamiazya/whiteboard/commit/94dc813648d206f22b93a30742f52b8b8e47e019))
* **mcp:** comment on any document through wb_thread_edit ([#1270](https://github.com/kamiazya/whiteboard/issues/1270)) ([49f1748](https://github.com/kamiazya/whiteboard/commit/49f174833b5836995305f30e766b87fb07234f97))
* **mcp:** give wb_version_restore the targetPath and subtree modes ([#1242](https://github.com/kamiazya/whiteboard/issues/1242)) ([8250b5e](https://github.com/kamiazya/whiteboard/commit/8250b5e1101fbb35bae9e3a11d7a4adf5314c118))
* **mcp:** ship semantic search to installed users and unify document teardown ([#1035](https://github.com/kamiazya/whiteboard/issues/1035)) ([0e68391](https://github.com/kamiazya/whiteboard/commit/0e68391c3de3aefde661aafecdc713f87a0c1588))
* **mcp:** wb_document_create takes the body, so a note is one call ([#1041](https://github.com/kamiazya/whiteboard/issues/1041)) ([538024b](https://github.com/kamiazya/whiteboard/commit/538024b706dec39bd8bc0990ade9e2348866baeb))
* **mcp:** wb_document_search — full-text search over bodies, canvas text, names and paths ([#976](https://github.com/kamiazya/whiteboard/issues/976)) ([bc0fef8](https://github.com/kamiazya/whiteboard/commit/bc0fef836bb65297f19110e99e311de15b2759aa))
* **mcp:** wb_scene_render renders markdown documents, embeds, and one `fragment` ([#1381](https://github.com/kamiazya/whiteboard/issues/1381)) ([0c0eba0](https://github.com/kamiazya/whiteboard/commit/0c0eba00bc85b0713edf3b6aadfa32b90614562a))
* **mcp:** wb_workspace_edit — one call for a batch of document operations ([#1044](https://github.com/kamiazya/whiteboard/issues/1044)) ([47c8581](https://github.com/kamiazya/whiteboard/commit/47c8581a6f99ea77a3a9d0f52739f61577ff2429))
* **measure:** check the embedding pipeline against a published number ([#1038](https://github.com/kamiazya/whiteboard/issues/1038)) ([39238dd](https://github.com/kamiazya/whiteboard/commit/39238dd7489578ae217451a175277ff6866a0b4b))
* **model:** facet keys become {namespace}.{name}/v{n} (ADR-0013) ([#965](https://github.com/kamiazya/whiteboard/issues/965)) ([131e8a3](https://github.com/kamiazya/whiteboard/commit/131e8a3f9a491298c83014b8fbb5fbab428ecd3d))
* **model:** the proposal layer's data shape — anchored changes, decided one at a time ([#1445](https://github.com/kamiazya/whiteboard/issues/1445)) ([84d0c7a](https://github.com/kamiazya/whiteboard/commit/84d0c7a28ffa1e0645c2eef0227b51552bf287ca))
* name and size the workspace, and give the daemon its write surface ([#1129](https://github.com/kamiazya/whiteboard/issues/1129)) ([e68f9c8](https://github.com/kamiazya/whiteboard/commit/e68f9c851af96cac68e4b06fba8cb7969859f11e))
* **okf:** adopt OKF v0.2 — nothing is dropped, and the trust pair is modelled ([#1051](https://github.com/kamiazya/whiteboard/issues/1051)) ([66ae491](https://github.com/kamiazya/whiteboard/commit/66ae491b8e02083c4ae27e5871d86dfa93677003))
* **ports:** DocumentEntry carries updatedAt, and the HTTP list becomes an adapter ([#1079](https://github.com/kamiazya/whiteboard/issues/1079)) ([c663bc4](https://github.com/kamiazya/whiteboard/commit/c663bc464f79dc5aa711b30104a11df3b7da1906))
* **ports:** DocumentIndex answers listWorkspaces, clearing the last store reach ([#1080](https://github.com/kamiazya/whiteboard/issues/1080)) ([18ce5de](https://github.com/kamiazya/whiteboard/commit/18ce5dec9092de4959b6df6d81c4aeacee5fe5b6))
* references follow a document's move, in both keepers ([#1249](https://github.com/kamiazya/whiteboard/issues/1249)) ([1b8c0ab](https://github.com/kamiazya/whiteboard/commit/1b8c0abb34d77e8d9301de983f84a377fd3e0d91))
* search by meaning, opt-in — measured against the judged corpus ([#1012](https://github.com/kamiazya/whiteboard/issues/1012)) ([4fece27](https://github.com/kamiazya/whiteboard/commit/4fece2728000b56a82a64c4e0ba7ce167b5f085f))
* **search:** a retrieval evaluation instrument that states its own resolution ([#1016](https://github.com/kamiazya/whiteboard/issues/1016)) ([4a63308](https://github.com/kamiazya/whiteboard/commit/4a63308ec5d865e551e10dd2dc713b70e8eab8ee))
* **search:** let the reader choose the embedding precision, and stop mixing vector spaces ([#1039](https://github.com/kamiazya/whiteboard/issues/1039)) ([781dad2](https://github.com/kamiazya/whiteboard/commit/781dad274f339281aa28484400f443eb7872afe4))
* **server-core:** a document create reports the workspace it wrote to ([#1112](https://github.com/kamiazya/whiteboard/issues/1112)) ([15c86d4](https://github.com/kamiazya/whiteboard/commit/15c86d481142da3b13c2b4231b10877c653da8e9))
* **server-core:** add wb_canvas_edit comment ops and stop batches wiping the canvas extension ([#1206](https://github.com/kamiazya/whiteboard/issues/1206)) ([cdc814f](https://github.com/kamiazya/whiteboard/commit/cdc814fcbb27a3c8231bbe05031e2bfacdcd5e65))
* **server-core:** an agent proposes a passage by default ([#1460](https://github.com/kamiazya/whiteboard/issues/1460)) ([c2f5306](https://github.com/kamiazya/whiteboard/commit/c2f53060a927d8f314d12528d3208a49241ca8b6))
* **server-core:** an agent proposes content by default ([#1454](https://github.com/kamiazya/whiteboard/issues/1454)) ([1e3e0be](https://github.com/kamiazya/whiteboard/commit/1e3e0bede6f0553f5f0f593abe9c4f7e57d508e0))
* **server-core:** declare the version-history seam an operation reads ([#1216](https://github.com/kamiazya/whiteboard/issues/1216)) ([3cc4c9e](https://github.com/kamiazya/whiteboard/commit/3cc4c9ef39d29e022bdefa30f44ee7e21300433d))
* **server-core:** the server mints a workspace id and the caller's string becomes its segment ([#1113](https://github.com/kamiazya/whiteboard/issues/1113)) ([8d7ce97](https://github.com/kamiazya/whiteboard/commit/8d7ce97156127e7005c1027278b3aa048244167e))
* **server-core:** wb_body_edit — a document's body edited by the passage ([#1458](https://github.com/kamiazya/whiteboard/issues/1458)) ([3cea93d](https://github.com/kamiazya/whiteboard/commit/3cea93d3d8eaf2e9dee421703a398b7c7d95f516))
* **server-core:** wb_canvas_edit can propose a batch instead of applying it ([#1446](https://github.com/kamiazya/whiteboard/issues/1446)) ([1291a1a](https://github.com/kamiazya/whiteboard/commit/1291a1aee2f8d5f7d5ebf67be82a322c3c5218df))
* **server:** sweep unreferenced uploads in server mode, and unblock the loop while it runs ([#1130](https://github.com/kamiazya/whiteboard/issues/1130)) ([bd19b9d](https://github.com/kamiazya/whiteboard/commit/bd19b9d8d5ce2f2a92c7e623f925c77d285ecc74))
* **store:** back up without stopping the server, and answer per store ([#1118](https://github.com/kamiazya/whiteboard/issues/1118)) ([1bd73f6](https://github.com/kamiazya/whiteboard/commit/1bd73f6f5a855b38bf85299aa711e467a3d3f571))
* **store:** keep one copy of each blob across backups, and collect it when no backup needs it ([#1126](https://github.com/kamiazya/whiteboard/issues/1126)) ([92e7145](https://github.com/kamiazya/whiteboard/commit/92e71450ffde1fe45a4752a966bdd5145f38b649))
* **store:** make a backup appear only once every store has finished ([#1127](https://github.com/kamiazya/whiteboard/issues/1127)) ([3c22dce](https://github.com/kamiazya/whiteboard/commit/3c22dce92015369adf46371807f5d9629413d5de))
* **store:** make multi-instance operation correct, and provable ([#1106](https://github.com/kamiazya/whiteboard/issues/1106)) ([28078e7](https://github.com/kamiazya/whiteboard/commit/28078e7d56e8239b54d15eeef78d35f4b8a6b0df))
* **store:** run scheduled backups on a cron, from one instance, in their own process ([#1124](https://github.com/kamiazya/whiteboard/issues/1124)) ([bbb722b](https://github.com/kamiazya/whiteboard/commit/bbb722b379d0a52391488b868f02a96c71c9017b))
* surface the trash — list what deletes evacuated, restore in place ([#1086](https://github.com/kamiazya/whiteboard/issues/1086)) ([01fa9c5](https://github.com/kamiazya/whiteboard/commit/01fa9c5a6cddb24f443e8df61e1c06625b2711e3))
* **test:** upgrade to Vitest 5 and add the testing-techniques skill ([#1334](https://github.com/kamiazya/whiteboard/issues/1334)) ([fbee5e2](https://github.com/kamiazya/whiteboard/commit/fbee5e28d5ccd502312394b0bb76dc78d393dbed))
* visual.shape/v0 — node silhouettes as the first node-target facet ([#974](https://github.com/kamiazya/whiteboard/issues/974)) ([1c881b6](https://github.com/kamiazya/whiteboard/commit/1c881b61ead2623c22a170f94e655bdc87b1f2aa))
* visual.symbol/v0 — node badges, contributed without touching a core surface ([#998](https://github.com/kamiazya/whiteboard/issues/998)) ([73fbacb](https://github.com/kamiazya/whiteboard/commit/73fbacbf76c1c1db31d6cb3297edda75575d5cf9))
* wb_facet_list — an agent can discover a facet instead of guessing it ([#1009](https://github.com/kamiazya/whiteboard/issues/1009)) ([50bccf5](https://github.com/kamiazya/whiteboard/commit/50bccf5cf07aca1763424788b34551a85961cb42))
* **web:** a markdown note reaches its own history ([#1438](https://github.com/kamiazya/whiteboard/issues/1438)) ([9cfd81c](https://github.com/kamiazya/whiteboard/commit/9cfd81c0b64bfcb778a196abb0ca37be8f61c1c8))
* **web:** a merge Undo that undoes, a badge that keeps its type, and a result that says why ([#1439](https://github.com/kamiazya/whiteboard/issues/1439)) ([eefaf2e](https://github.com/kamiazya/whiteboard/commit/eefaf2ee89075da8036c153dd51f22e7e1316552))
* **web:** a non-default variation is addressable as a read-only ?v= preview (ADR-0022) ([#1316](https://github.com/kamiazya/whiteboard/issues/1316)) ([1b9b17d](https://github.com/kamiazya/whiteboard/commit/1b9b17d7c6467e3e2045a536d44b701844463877))
* **web:** a person adopts a proposal from the bubble it is drawn on ([#1450](https://github.com/kamiazya/whiteboard/issues/1450)) ([a1f3294](https://github.com/kamiazya/whiteboard/commit/a1f32945a0bc174f47bc26a436cf85db276e3cf1))
* **web:** a proposal can be decided one change at a time ([#1451](https://github.com/kamiazya/whiteboard/issues/1451)) ([dcf517a](https://github.com/kamiazya/whiteboard/commit/dcf517a4de6a9ba2be383e2e17d3a8be8cf8b111))
* **web:** a workspace can be renamed, and the mark is the switcher ([#1121](https://github.com/kamiazya/whiteboard/issues/1121)) ([96507e6](https://github.com/kamiazya/whiteboard/commit/96507e61a7a2a400d9e97d5709101c7f18a37945))
* **web:** backlinks — Connections chip on an event-capable reference aggregate ([#970](https://github.com/kamiazya/whiteboard/issues/970)) ([531fccf](https://github.com/kamiazya/whiteboard/commit/531fccf9daf3273d7275d8962969e70a973a1abb))
* **web:** choose a document kind by name, and keep the folder you are in ([#1002](https://github.com/kamiazya/whiteboard/issues/1002)) ([6055eb8](https://github.com/kamiazya/whiteboard/commit/6055eb800b81d2866ed7ebc3516952cd1a9528c0))
* **web:** decide a proposed passage in the body ([#1461](https://github.com/kamiazya/whiteboard/issues/1461)) ([c94f27a](https://github.com/kamiazya/whiteboard/commit/c94f27a37a4e2550f59541f72c749bc9f80777f6))
* **web:** hold both keepers to one version history, and make a difference a decision ([#1276](https://github.com/kamiazya/whiteboard/issues/1276)) ([0e77c49](https://github.com/kamiazya/whiteboard/commit/0e77c491de81b1e89e0af4e730eb3a11e9580940))
* **web:** Link it — one server-side operation turns a mention into a real link ([#988](https://github.com/kamiazya/whiteboard/issues/988)) ([f54fd71](https://github.com/kamiazya/whiteboard/commit/f54fd71056278a50087536b0f0027d60acbf1c54))
* **web:** one version history for both keepers — bookmarks, checkpoints at a pause, preview-then-restore and restore lineage ([#1245](https://github.com/kamiazya/whiteboard/issues/1245)) ([8eef114](https://github.com/kamiazya/whiteboard/commit/8eef1145cdb2b82bb878afdccbd2d16960c3c169))
* **web:** open a browser-kept variation from the address ([#1437](https://github.com/kamiazya/whiteboard/issues/1437)) ([62aede2](https://github.com/kamiazya/whiteboard/commit/62aede261b2b4d206c40b1f942e1356e97e4fcad))
* **web:** put the browser's Loro persistence behind the DocumentStore port ([#948](https://github.com/kamiazya/whiteboard/issues/948)) ([8bcf1ba](https://github.com/kamiazya/whiteboard/commit/8bcf1ba41b4ff9945e87e83bb568a1bc0f9ed324))
* **web:** retire the document grid; the three-pane browser is the only index surface ([#969](https://github.com/kamiazya/whiteboard/issues/969)) ([4dd66e8](https://github.com/kamiazya/whiteboard/commit/4dd66e80a242334ce925137348b4e77483ba789f))
* **web:** tags become functional — searchable and filterable in the document browser ([#975](https://github.com/kamiazya/whiteboard/issues/975)) ([93fce2f](https://github.com/kamiazya/whiteboard/commit/93fce2fdc9c08f9824fc5d1b5bf4326fcf3bb30e))
* **web:** the browser keeper commits a merge, by adopting the source tip ([#1426](https://github.com/kamiazya/whiteboard/issues/1426)) ([266836e](https://github.com/kamiazya/whiteboard/commit/266836e49c1d1be60e2935589229511bbfd9d077))
* **web:** the browser keeper takes automatic checkpoints ([#1431](https://github.com/kamiazya/whiteboard/issues/1431)) ([abc07d4](https://github.com/kamiazya/whiteboard/commit/abc07d470007d41cf9d70042dbb8effa27455d82))
* **web:** the document browser searches what documents say, not only what they are called ([#1023](https://github.com/kamiazya/whiteboard/issues/1023)) ([b69a7cf](https://github.com/kamiazya/whiteboard/commit/b69a7cfeb70c073396accb4997d9b6c2348e7d1a))


### Bug Fixes

* a dead MCP tool, an unlocked write, and two gates that ran less than they claimed ([#1028](https://github.com/kamiazya/whiteboard/issues/1028)) ([de8bdb3](https://github.com/kamiazya/whiteboard/commit/de8bdb344af1e51f44eeaaaa79c7133ba1f17a39))
* **annotations:** a thread write goes through the reducer, and the gutter marker stops being the only way to reach a conversation ([#1434](https://github.com/kamiazya/whiteboard/issues/1434)) ([f7a81fa](https://github.com/kamiazya/whiteboard/commit/f7a81fa131d16a7bdecc5eb85703e921be630d4c))
* **annotations:** the note's comment gutter paints nothing, and a phone reaches the layer from the toolbar the docked bar makes redundant ([#1415](https://github.com/kamiazya/whiteboard/issues/1415)) ([1bba6ff](https://github.com/kamiazya/whiteboard/commit/1bba6ff910954654825149d54fbb9b41f6b77bdf))
* **arch-lint:** catch the dynamic import at module scope, not only in a body ([#1262](https://github.com/kamiazya/whiteboard/issues/1262)) ([31de539](https://github.com/kamiazya/whiteboard/commit/31de53951c0a4530b79b30f5583a968874d579d3))
* **arch-lint:** the ADR-0018 guard can see mechanics nested under store/db ([#1083](https://github.com/kamiazya/whiteboard/issues/1083)) ([55d1933](https://github.com/kamiazya/whiteboard/commit/55d1933e03b2fe8f44e969e698f25f6c6946dae4))
* **canvas-render:** cut a node label between characters a reader sees as one ([#1277](https://github.com/kamiazya/whiteboard/issues/1277)) ([dd89f59](https://github.com/kamiazya/whiteboard/commit/dd89f59ae4963b6f11e1d14b6685c75a4369cf1d))
* **ci:** run the docker image CI builds, and fix the six defects that surfaced ([#1395](https://github.com/kamiazya/whiteboard/issues/1395)) ([3dd7ba5](https://github.com/kamiazya/whiteboard/commit/3dd7ba51e85ce389ec68751ad6b863ac30218b33))
* **daemon:** a fresh daemon holds a workspace, and the browser stops dead-ending when it does not ([#1082](https://github.com/kamiazya/whiteboard/issues/1082)) ([7f8bdc6](https://github.com/kamiazya/whiteboard/commit/7f8bdc6f76ed716188010fcd843e8ee66d684bf4))
* **dev-rules:** the always-on total is 88, crossed by two merges neither CI saw ([#1287](https://github.com/kamiazya/whiteboard/issues/1287)) ([c23a96e](https://github.com/kamiazya/whiteboard/commit/c23a96e5f7ada638fb9f27b0cd27ab7a34e260d3))
* **devx:** worktree-aware Codex MCP override via the stdio proxy, and working contributor setup docs ([#1347](https://github.com/kamiazya/whiteboard/issues/1347)) ([61c9d41](https://github.com/kamiazya/whiteboard/commit/61c9d4171f1c162e1ce721e904e76442067f8787))
* **docker:** refuse the layer cache on measurement, and fix the cache-mount trap it exposed ([#1449](https://github.com/kamiazya/whiteboard/issues/1449)) ([37672c5](https://github.com/kamiazya/whiteboard/commit/37672c51c249011728c24bd487a766efc914391c))
* **mcp-server:** back up into a mounted volume, found by promoting the docker smoke ([#1433](https://github.com/kamiazya/whiteboard/issues/1433)) ([25e5794](https://github.com/kamiazya/whiteboard/commit/25e57948ef2068d50bf1728d8faf298593fbf21b))
* **mcp-server:** delegated-plane readSnapshotManifest reports the real generation — found by running the store conformance suite against the production router ([#1353](https://github.com/kamiazya/whiteboard/issues/1353)) ([6ba4804](https://github.com/kamiazya/whiteboard/commit/6ba4804c10698e762e470d1b762ddce87be78ce3))
* **mcp-server:** grow the snapshot fixture until blocking outweighs the setup ([#1260](https://github.com/kamiazya/whiteboard/issues/1260)) ([c2e28e3](https://github.com/kamiazya/whiteboard/commit/c2e28e3f8510f97733e9daf1be2af3bb77e698a1))
* **mcp-server:** moveDocument must evict the doc cache for every path it touches ([#1072](https://github.com/kamiazya/whiteboard/issues/1072)) ([0400693](https://github.com/kamiazya/whiteboard/commit/0400693bd13b4479f1fcebbc6e75f7ab8ddf4c35))
* **mcp-server:** register the auto-version signal synchronously, not through a dangling import ([#1298](https://github.com/kamiazya/whiteboard/issues/1298)) ([6c5d360](https://github.com/kamiazya/whiteboard/commit/6c5d360105a0c090d631e3f5f036884b02492431))
* **mcp-server:** resolve one libsql stack, and the 409 that was quietly becoming a 500 ([#1429](https://github.com/kamiazya/whiteboard/issues/1429)) ([ab59c95](https://github.com/kamiazya/whiteboard/commit/ab59c95449f414a8e5a41772a01b27ebaa21c674))
* **mcp-server:** zod-back the CLI --json wire contracts and reuse the branches contract types ([#1350](https://github.com/kamiazya/whiteboard/issues/1350)) ([6981074](https://github.com/kamiazya/whiteboard/commit/69810743d581bd1ea7c83404852200b9ac316be3))
* **mcp:** run the wb_version_* tools over the daemon's one version history ([#1235](https://github.com/kamiazya/whiteboard/issues/1235)) ([f449d80](https://github.com/kamiazya/whiteboard/commit/f449d80b73718dae8d2652987c07942f6846d08b))
* **release:** stop biome and release-please reformatting the same files, and unbreak main's typecheck ([#1049](https://github.com/kamiazya/whiteboard/issues/1049)) ([5d5ea3d](https://github.com/kamiazya/whiteboard/commit/5d5ea3d5b3f2e27ac9ecbbaf4fcf9570e0b65032))
* **repo:** make the repo's claims about its gates, prerequisites, and tools true ([#1149](https://github.com/kamiazya/whiteboard/issues/1149)) ([1fabcb4](https://github.com/kamiazya/whiteboard/commit/1fabcb4ee74de68acf133afb105718af47a689eb))
* **security:** declare /api/v1 scopes, and let the guard see the routes at all ([#1069](https://github.com/kamiazya/whiteboard/issues/1069)) ([9ae4170](https://github.com/kamiazya/whiteboard/commit/9ae41709add057cbfaae9c07149c82c136f8f372))
* **server-core:** tell the composition root about agent writes, so they compact ([#1046](https://github.com/kamiazya/whiteboard/issues/1046)) ([6a0c8c4](https://github.com/kamiazya/whiteboard/commit/6a0c8c4436fd14b6d36737830f03fe50f0a07c99))
* **server-core:** the teardown seam brackets the delete, so the capture is under the lock ([#1066](https://github.com/kamiazya/whiteboard/issues/1066)) ([1983f3e](https://github.com/kamiazya/whiteboard/commit/1983f3ee82d2b74cdf4e55225242eb1fe3b1d863))
* **server:** calibrate the loop sampler, and make a declared stall ceiling something a test asserts ([#1142](https://github.com/kamiazya/whiteboard/issues/1142)) ([7c88a53](https://github.com/kamiazya/whiteboard/commit/7c88a53598f65dc4b51f46e94d5c1214e2d610e8))
* **server:** mint a canonical ULID for the workspace a fresh daemon bootstraps ([#1135](https://github.com/kamiazya/whiteboard/issues/1135)) ([1887b76](https://github.com/kamiazya/whiteboard/commit/1887b764535ee7895d093764a90b5965b33895af))
* **server:** server mode mounts the /api/v1 surface — the self-hosted daemon stops 404ing on half its API ([#1405](https://github.com/kamiazya/whiteboard/issues/1405)) ([a446b59](https://github.com/kamiazya/whiteboard/commit/a446b5940ec08601f1765fa0c871b4a0aa9dcd34))
* **store:** re-take the workspace tail's loop cost against a real store ([#1134](https://github.com/kamiazya/whiteboard/issues/1134)) ([b959e85](https://github.com/kamiazya/whiteboard/commit/b959e85810451a7ae56afd30718a9574b3a06ca9))
* **store:** stop backup and the GC grace window losing data silently, and record the durability boundary ([#1114](https://github.com/kamiazya/whiteboard/issues/1114)) ([1d545c4](https://github.com/kamiazya/whiteboard/commit/1d545c4a488b2b01078f49286c1ac9b3553d344d))
* **web:** a browser document opened on a variation says so, and both keepers show its chrome ([#1435](https://github.com/kamiazya/whiteboard/issues/1435)) ([2a441c1](https://github.com/kamiazya/whiteboard/commit/2a441c187184ef585f84741fad8e6ec53a6838bb))
* **web:** a read that did not complete stops claiming the document is damaged ([#1300](https://github.com/kamiazya/whiteboard/issues/1300)) ([577843e](https://github.com/kamiazya/whiteboard/commit/577843ee72063bfbfa2acce952c120f21a200020))
* **web:** declare destructive confirmation copy once, and stop it calling a note a canvas ([#1133](https://github.com/kamiazya/whiteboard/issues/1133)) ([62022f6](https://github.com/kamiazya/whiteboard/commit/62022f661130f0684571a35d6e27984816d7ec5a))
* **web:** key a list row's picture by its content, not by the write's clock ([#1336](https://github.com/kamiazya/whiteboard/issues/1336)) ([0d74526](https://github.com/kamiazya/whiteboard/commit/0d745264264c62216349807a9df3039d7c2cdc29))
* **web:** re-list workspaces when the selected one has been deleted ([#1081](https://github.com/kamiazya/whiteboard/issues/1081)) ([bf29835](https://github.com/kamiazya/whiteboard/commit/bf2983573eaac2e6a7c43344a59857fb4fe0fcf5))
* **web:** stop the Storage tab calling a deleted route and rendering a category the daemon cannot report ([#1161](https://github.com/kamiazya/whiteboard/issues/1161)) ([63e416e](https://github.com/kamiazya/whiteboard/commit/63e416eaf5dc670f3420a9752b60b6cfc9024101))


### Performance Improvements

* **ci:** let a version bump skip the image build it cannot affect ([#1452](https://github.com/kamiazya/whiteboard/issues/1452)) ([647d68e](https://github.com/kamiazya/whiteboard/commit/647d68e32903a61fd29b1c2a0a89563424c8f9b2))
* **test:** stop a browser run writing 23GB of trace scratch ([#1266](https://github.com/kamiazya/whiteboard/issues/1266)) ([c37efac](https://github.com/kamiazya/whiteboard/commit/c37efac7db4b797c6765377212aae567c825d680))
* **web:** hand the worker a snapshot instead of a canvas it can decode itself ([#1275](https://github.com/kamiazya/whiteboard/issues/1275)) ([b52e20c](https://github.com/kamiazya/whiteboard/commit/b52e20ca38f4ac7b5c2b4ddf38b204f642cd6669))

## [0.0.19](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.18...mcp-server-v0.0.19) (2026-07-17)


### Bug Fixes

* **release:** keep npm pack --json parseable when prepack prints its gate message ([#254](https://github.com/kamiazya/whiteboard/issues/254)) ([3513039](https://github.com/kamiazya/whiteboard/commit/35130395a66a35c399c65e72468908f8d1733829))

## [0.0.18](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.17...mcp-server-v0.0.18) (2026-07-17)


### Bug Fixes

* **mcp-server:** make --data-dir govern all persistence, not just the daemon registry ([#251](https://github.com/kamiazya/whiteboard/issues/251)) ([bce72c9](https://github.com/kamiazya/whiteboard/commit/bce72c9d450a7bae078e85245062cc9f38f684c0))

## [0.0.17](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.16...mcp-server-v0.0.17) (2026-07-17)


### Bug Fixes

* **mcp-server:** reject conflicting daemon token sources (env + --token-stdin) ([#249](https://github.com/kamiazya/whiteboard/issues/249)) ([285da81](https://github.com/kamiazya/whiteboard/commit/285da81ba953c634bf9f3e0169d6b75b35e5349d))

## [0.0.16](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.15...mcp-server-v0.0.16) (2026-07-17)


### Features

* **mcp-server:** derive per-worktree dev daemon ports and guard daemon identity ([#246](https://github.com/kamiazya/whiteboard/issues/246)) ([90ea8c9](https://github.com/kamiazya/whiteboard/commit/90ea8c92a1b90cae13e3d419c201b214134d2c0b))

## [0.0.15](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.14...mcp-server-v0.0.15) (2026-07-17)


### Features

* **mcp-server:** isolate dev daemon data under repo-local .dev-data and make DATA_DIR test-injectable ([#243](https://github.com/kamiazya/whiteboard/issues/243)) ([9922f9d](https://github.com/kamiazya/whiteboard/commit/9922f9d98c24ea0f4ae85886235c0d1b09ded0db))

## [0.0.14](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.13...mcp-server-v0.0.14) (2026-07-17)


### Bug Fixes

* **mcp-server:** skip LLM-CLI smokes when the CLI is absent so release gates pass on CI ([#241](https://github.com/kamiazya/whiteboard/issues/241)) ([1e0067f](https://github.com/kamiazya/whiteboard/commit/1e0067fa61d116d58aeb66d7de7a7b8183ba682a))

## [0.0.13](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.12...mcp-server-v0.0.13) (2026-07-17)


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
* **web:** daemon-detection probe, migration CTA banner, and copy-first browser-local import ([#163](https://github.com/kamiazya/whiteboard/issues/163)) ([c2c46e8](https://github.com/kamiazya/whiteboard/commit/c2c46e89850f3d5007677e7c22562cdbc213e0cc))
* **web:** migrate the doc-screenshot pipeline to canonical apps/web components (R4 of MCP-UI retirement) ([#197](https://github.com/kamiazya/whiteboard/issues/197)) ([393de85](https://github.com/kamiazya/whiteboard/commit/393de8559543e0c8f5519938bc50756ee09cfac9))
* **web:** wire DaemonBackend into apps/web via #wb= pairing fragment ([#159](https://github.com/kamiazya/whiteboard/issues/159)) ([6e4c2a1](https://github.com/kamiazya/whiteboard/commit/6e4c2a146ba6d36e87f129c850f8878e60eed8bb))
* **web:** workspace switcher, manual save, authorized thumbnails, and WS auth-loop fix ([#165](https://github.com/kamiazya/whiteboard/issues/165)) ([2c50941](https://github.com/kamiazya/whiteboard/commit/2c50941e18218bdb65ebaa9cee2e80d709092850))


### Bug Fixes

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
* **release:** narrow npm publish gate to publishability, not correctness ([#157](https://github.com/kamiazya/whiteboard/issues/157)) ([dbe61f9](https://github.com/kamiazya/whiteboard/commit/dbe61f9fa1b3cc8d1ab172e7acc7b6222a5e1002))
* **test:** pre-bundle testing-library deps to stop vitest browser dynamic-import flake ([#158](https://github.com/kamiazya/whiteboard/issues/158)) ([e86f298](https://github.com/kamiazya/whiteboard/commit/e86f2984753b04f8aeb56faf06873061610ffce0))

## [0.0.12](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.11...mcp-server-v0.0.12) (2026-07-10)


### Features

* **mcp-server:** expose api-client/api-contracts subpaths, port pure libs to apps/web ([#140](https://github.com/kamiazya/whiteboard/issues/140)) ([ee277e4](https://github.com/kamiazya/whiteboard/commit/ee277e45b11b4f88be519beadc203f300e4f70cd))
* **mcp-server:** harden local-daemon auth surface ([#141](https://github.com/kamiazya/whiteboard/issues/141)) ([dca3863](https://github.com/kamiazya/whiteboard/commit/dca3863dcf5908da4520393efd59911f019269bf))
* **mcp-server:** move daemonToken out of runtime config into a one-shot TokenStore ([#148](https://github.com/kamiazya/whiteboard/issues/148)) ([8f9039f](https://github.com/kamiazya/whiteboard/commit/8f9039f84a10aba1d0e39b4c1aee7c95a3e10763))
* **web:** make useCanvasSync capability-complete for daemon wiring ([#136](https://github.com/kamiazya/whiteboard/issues/136)) ([d231d21](https://github.com/kamiazya/whiteboard/commit/d231d214d401b98e11fa0c40f7e03458ec079463))
* **web:** port pure-logic hooks (theme/dirty-state/fullscreen) to apps/web ([#139](https://github.com/kamiazya/whiteboard/issues/139)) ([57a021f](https://github.com/kamiazya/whiteboard/commit/57a021ff35b3abcaa8aee749707dd82c4a6b96e8))
* **web:** port StorageReportCard with Zod-validated storage responses ([#146](https://github.com/kamiazya/whiteboard/issues/146)) ([9393d78](https://github.com/kamiazya/whiteboard/commit/9393d787348f8292ee0cf5a7a2bdfde4680b901e))


### Bug Fixes

* **release:** honour SMOKE_RPC_TIMEOUT in the tarball smoke path too ([#118](https://github.com/kamiazya/whiteboard/issues/118)) ([f8e5d17](https://github.com/kamiazya/whiteboard/commit/f8e5d17aa4294b4c7760cea1518d9387f0b42fb7))

## [0.0.11](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.10...mcp-server-v0.0.11) (2026-07-05)


### Features

* **shared:** MigrationBundle contract + package export ([#116](https://github.com/kamiazya/whiteboard/issues/116)) ([63fa9a3](https://github.com/kamiazya/whiteboard/commit/63fa9a371c85725b2efef25fb44e5ec26c1d1a7a))


### Bug Fixes

* **ci:** cache Docker dry-run build, reuse mcp-server dist artifact ([#107](https://github.com/kamiazya/whiteboard/issues/107)) ([f7cbfcb](https://github.com/kamiazya/whiteboard/commit/f7cbfcb490656ad9bb13d27aeb57dad8c6693513))
* **mcp:** guard StorageReportCard async setState against post-unmount crashes ([#111](https://github.com/kamiazya/whiteboard/issues/111)) ([da16f36](https://github.com/kamiazya/whiteboard/commit/da16f362ee5db25be552ad92c3fdafa0eea82b45))
* **release:** extend smoke RPC deadline on CI publish jobs ([#110](https://github.com/kamiazya/whiteboard/issues/110)) ([0d28af5](https://github.com/kamiazya/whiteboard/commit/0d28af55af97e793a8a5c9422a1e2075fdb0e438))
* **release:** gate git-based plugin distribution behind releases via stable branch ([#114](https://github.com/kamiazya/whiteboard/issues/114)) ([5ae5deb](https://github.com/kamiazya/whiteboard/commit/5ae5debab2951a9164351e11ea6f2018dc153d0a))

## [0.0.10](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.9...mcp-server-v0.0.10) (2026-07-05)


### Bug Fixes

* **deps:** clear runtime security alerts (dompurify, mermaid, otel core) ([#104](https://github.com/kamiazya/whiteboard/issues/104)) ([51a57da](https://github.com/kamiazya/whiteboard/commit/51a57da1e121ddfb3baaeb0a391b83cb322982a0))
* **release:** extend daemon startup timeout on CI publish jobs ([#108](https://github.com/kamiazya/whiteboard/issues/108)) ([6d661b1](https://github.com/kamiazya/whiteboard/commit/6d661b1987aad3c117b0b24a4c0de3b0243a86ee))

## [0.0.9](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.8...mcp-server-v0.0.9) (2026-07-05)


### Bug Fixes

* **ci:** unbreak publish jobs — validate-step cwd and SBOM generation under pnpm ([#100](https://github.com/kamiazya/whiteboard/issues/100)) ([617eeb9](https://github.com/kamiazya/whiteboard/commit/617eeb92fca5fd1f22b54fcc72eaf03d5b245a5a))
* **web:** address AI review follow-ups from [#100](https://github.com/kamiazya/whiteboard/issues/100) and [#102](https://github.com/kamiazya/whiteboard/issues/102) ([#103](https://github.com/kamiazya/whiteboard/issues/103)) ([583c618](https://github.com/kamiazya/whiteboard/commit/583c618506a5bcb510c0c5056c6bd7f968e1c0ec))

## [0.0.8](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.7...mcp-server-v0.0.8) (2026-07-05)


### Bug Fixes

* **ci:** unbreak release pipeline (wrangler pnpm fallback, invalid action pins) ([#98](https://github.com/kamiazya/whiteboard/issues/98)) ([c412d00](https://github.com/kamiazya/whiteboard/commit/c412d0095e155d56a63a45f1db964b17efef3ce3))

## [0.0.7](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.6...mcp-server-v0.0.7) (2026-07-05)


### Features

* **web:** integrate Excalidraw into BrowserLocalCanvasPage via useCanvasSync ([#70](https://github.com/kamiazya/whiteboard/issues/70)) ([ab0f39a](https://github.com/kamiazya/whiteboard/commit/ab0f39a0fe53cabbe104e3cfd75f17184b1167cb))


### Bug Fixes

* **app:** inject bearer token in Vite dev server and improve 401 error message ([b2ebb04](https://github.com/kamiazya/whiteboard/commit/b2ebb046e898fb104530a739e62155ef1a4433e9))
* **ci:** align vitest ecosystem versions via catalog to fix browser session timeout ([#82](https://github.com/kamiazya/whiteboard/issues/82)) ([dedd961](https://github.com/kamiazya/whiteboard/commit/dedd96149e1cb8ec121798e5e89c691204706006))
* **mcp:** treat text as label alias on arrow annotations in annotate_batch ([86a799e](https://github.com/kamiazya/whiteboard/commit/86a799e9bbc8d1965871542c72802d19e82f7e12))
* stop WebSocket retry loop on auth failure (close code 1008) ([8d36069](https://github.com/kamiazya/whiteboard/commit/8d36069ac03cb0914cecd373866b545c0c209e2e))
* tarball smoke (pnpm pack + tsx/esm + loro-crdt pin) + dogfood findings [#4](https://github.com/kamiazya/whiteboard/issues/4)/[#5](https://github.com/kamiazya/whiteboard/issues/5) ([#56](https://github.com/kamiazya/whiteboard/issues/56)) ([5a9e01c](https://github.com/kamiazya/whiteboard/commit/5a9e01c9c8a5fc2e9e222076cc057eb1f046db21))

## [0.0.6](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.5...mcp-server-v0.0.6) (2026-05-03)


### Features

* **mcp:** dev daemon, versioning, headless export, storage, and tracing ([#45](https://github.com/kamiazya/whiteboard/issues/45)) ([d79c94c](https://github.com/kamiazya/whiteboard/commit/d79c94cfda11a9172d7ac1ed79ab061b1abac3a9))


### Bug Fixes

* **mcp:** close PR [#45](https://github.com/kamiazya/whiteboard/issues/45) review follow-ups (6 issues) ([#47](https://github.com/kamiazya/whiteboard/issues/47)) ([1f792b8](https://github.com/kamiazya/whiteboard/commit/1f792b8ebfc42c350f5ffc032082a62ec95280b3))
* **store:** close file-gc Race C and lock version-store.save ([#48](https://github.com/kamiazya/whiteboard/issues/48)) ([42fcdfd](https://github.com/kamiazya/whiteboard/commit/42fcdfd20ef8dc83fc0c5ecd81144f2e2c7783e6))

## [0.0.5](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.4...mcp-server-v0.0.5) (2026-04-28)


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

## [0.0.4](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.3...mcp-server-v0.0.4) (2026-04-25)


### Bug Fixes

* harden MCP release and dev workflows ([#22](https://github.com/kamiazya/whiteboard/issues/22)) ([acfbcdb](https://github.com/kamiazya/whiteboard/commit/acfbcdb7568d24482482ffbec6ed68eeb65473b4))
* **release-please:** use linked-versions and put server.json at root ([#26](https://github.com/kamiazya/whiteboard/issues/26)) ([14756d4](https://github.com/kamiazya/whiteboard/commit/14756d47129b69738db1836ba6e8a1310f3edd64))

## [0.0.3](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.2...mcp-server-v0.0.3) (2026-04-25)


### Bug Fixes

* **release:** inline node-version (tag checkout predates .node-version) ([#20](https://github.com/kamiazya/whiteboard/issues/20)) ([866395a](https://github.com/kamiazya/whiteboard/commit/866395ac0be7bac1bbcb39e9ef71f0582480724a))
* **release:** use Node 24 + add force_publish_tag dispatch input ([#18](https://github.com/kamiazya/whiteboard/issues/18)) ([1c7bdcf](https://github.com/kamiazya/whiteboard/commit/1c7bdcff049252bc02bba6b03345704e16438a3d))
* **smoke:** pass fake DaemonClient to template tool execute (was port number) ([#21](https://github.com/kamiazya/whiteboard/issues/21)) ([a86a279](https://github.com/kamiazya/whiteboard/commit/a86a279a7421f2bf3757e4c97cb0f772ff187a7d))

## [0.0.2](https://github.com/kamiazya/whiteboard/compare/mcp-server-v0.0.1...mcp-server-v0.0.2) (2026-04-25)


### Features

* initial release of @kamiazya/whiteboard-mcp ([#4](https://github.com/kamiazya/whiteboard/issues/4)) ([d4c1d55](https://github.com/kamiazya/whiteboard/commit/d4c1d55efc4df56748679891f64858dbdbad85d4))


### Bug Fixes

* **release:** force npm upgrade to avoid promise-retry MODULE_NOT_FOUND ([#13](https://github.com/kamiazya/whiteboard/issues/13)) ([f6e736b](https://github.com/kamiazya/whiteboard/commit/f6e736b033788cadef1971ea5e683b0034d59167))

## 0.0.1 (2026-04-25)


### Features

* initial release of @kamiazya/whiteboard-mcp ([#4](https://github.com/kamiazya/whiteboard/issues/4)) ([d4c1d55](https://github.com/kamiazya/whiteboard/commit/d4c1d55efc4df56748679891f64858dbdbad85d4))


### Bug Fixes

* **release:** force npm upgrade to avoid promise-retry MODULE_NOT_FOUND ([#13](https://github.com/kamiazya/whiteboard/issues/13)) ([f6e736b](https://github.com/kamiazya/whiteboard/commit/f6e736b033788cadef1971ea5e683b0034d59167))
