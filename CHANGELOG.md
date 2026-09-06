# Changelog

## [0.1.0](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.19...whiteboard-plugin-v0.1.0) (2026-09-06)


### ⚠ BREAKING CHANGES

* **server-core:** wb_body_edit's default mode is now propose. A caller that omitted mode got a refusal before (the field was required) and now gets a proposal, so nothing silently changes meaning; a caller passing mode:'apply' is unaffected.
* **server-core:** `wb_canvas_edit` no longer changes a spatial document by default. A batch of node/edge content is stored as a proposal for a person to adopt; pass mode:"apply" to write it. Batches carrying comments, locks, tidy or region.set are unaffected.
* retire display names from reference resolution — path + id only, names label links at render time ([#1280](https://github.com/kamiazya/whiteboard/issues/1280))
* **mcp:** withdraw comment.remove — resolving is the only way to close a comment ([#1246](https://github.com/kamiazya/whiteboard/issues/1246))
* collapse the dual document plane — the workspace tree becomes the address book ([#1084](https://github.com/kamiazya/whiteboard/issues/1084))
* **web:** drop Copy link — a keeper that cannot be reached cannot be linked to ([#1034](https://github.com/kamiazya/whiteboard/issues/1034))
* **web:** re-cut the document header — retire the pencil and the in-editor document switcher ([#1004](https://github.com/kamiazya/whiteboard/issues/1004))
* **web:** facet UI rides contribution points — plugins get a displayName, core surfaces stop naming domains ([#990](https://github.com/kamiazya/whiteboard/issues/990))
* **web:** edge display settings live in the visual.edges facet ([#968](https://github.com/kamiazya/whiteboard/issues/968))
* **model:** facet keys become {namespace}.{name}/v{n} (ADR-0013) ([#965](https://github.com/kamiazya/whiteboard/issues/965))
* **web:** put the browser's Loro persistence behind the DocumentStore port ([#948](https://github.com/kamiazya/whiteboard/issues/948))

### Features

* a facet declares its editor instead of shipping one ([#1013](https://github.com/kamiazya/whiteboard/issues/1013)) ([221b169](https://github.com/kamiazya/whiteboard/commit/221b169b002a43ad18cdd3b04230bf28d2297cb2))
* **annotations:** a daemon-kept document's conversations reach a rail too ([#1309](https://github.com/kamiazya/whiteboard/issues/1309)) ([8539467](https://github.com/kamiazya/whiteboard/commit/8539467b805f39148bc66172a54802a411d8b30a))
* **annotations:** a note can say which of its conversations lost their place ([#1313](https://github.com/kamiazya/whiteboard/issues/1313)) ([ca2e40f](https://github.com/kamiazya/whiteboard/commit/ca2e40f05f0dba704adf5fe8e7ce17a976d6ef5e))
* **annotations:** a note's conversations are drawn where they point ([#1330](https://github.com/kamiazya/whiteboard/issues/1330)) ([61f6c48](https://github.com/kamiazya/whiteboard/commit/61f6c481864492d48ae43b6290d568416eb6af05))
* **annotations:** a note's conversations reach its rail, and answer back ([#1285](https://github.com/kamiazya/whiteboard/issues/1285)) ([6b225d2](https://github.com/kamiazya/whiteboard/commit/6b225d21a32491a338d45993c39af8d96736cc39))
* **annotations:** comment on every place a reader points at, drawn where it is, on a phone and in the widget ([#1384](https://github.com/kamiazya/whiteboard/issues/1384)) ([153f127](https://github.com/kamiazya/whiteboard/commit/153f1275278849a1b84e479bf000b269e80dfd2b))
* **annotations:** focus handoff, message counts, icon-first verbs and resolve motion ([#1448](https://github.com/kamiazya/whiteboard/issues/1448)) ([1de4d48](https://github.com/kamiazya/whiteboard/commit/1de4d48561734d698705d0d9ad87e5eb5ef4e8e3))
* **annotations:** open a comment into a card that answers back ([#1279](https://github.com/kamiazya/whiteboard/issues/1279)) ([f24fa8c](https://github.com/kamiazya/whiteboard/commit/f24fa8c9966bcbe282d842b11e139ff725a1e9a0))
* **annotations:** publish the layer on its own channel, and list it in a panel ([#1269](https://github.com/kamiazya/whiteboard/issues/1269)) ([c600580](https://github.com/kamiazya/whiteboard/commit/c6005800983bd926f738b6c7fd0839d53872f8a3))
* **annotations:** read the layer without a canvas, and hand it to the renderer ([#1267](https://github.com/kamiazya/whiteboard/issues/1267)) ([19bd46a](https://github.com/kamiazya/whiteboard/commit/19bd46a0d63aa80762dd882fba8ac14b940991c4))
* **annotations:** resolving a conversation ramps its canvas chrome out instead of cutting ([#1453](https://github.com/kamiazya/whiteboard/issues/1453)) ([6665824](https://github.com/kamiazya/whiteboard/commit/6665824febc5624094080bb1b4a8bb6441c56d98))
* **annotations:** the hand tool's right-click and touch long-press open the annotation verbs, and nothing else ([#1388](https://github.com/kamiazya/whiteboard/issues/1388)) ([a921f52](https://github.com/kamiazya/whiteboard/commit/a921f525fb6afefef4e8248f0d40a27e126a28f5))
* **annotations:** the markdown markers cross to the resolved look instead of cutting ([#1459](https://github.com/kamiazya/whiteboard/issues/1459)) ([98ccecd](https://github.com/kamiazya/whiteboard/commit/98ccecd3a285bd69830e5e77f7b09eea12e88dcb))
* **annotations:** the rail resolves and corrects a conversation, is a sheet on a phone, and the preview marks its passages; a surface-parity matrix keeps the verbs equal ([#1387](https://github.com/kamiazya/whiteboard/issues/1387)) ([37ef30d](https://github.com/kamiazya/whiteboard/commit/37ef30dad15626d303e2a43917a584241848a751))
* **arch-lint:** an adapter may not reach a mechanic, with a list that only shrinks ([#1065](https://github.com/kamiazya/whiteboard/issues/1065)) ([aa05202](https://github.com/kamiazya/whiteboard/commit/aa05202b3dad336d674b5738f468519b90b8f1d0))
* **arch:** extract the daemon's browser-safe client half into packages/daemon-client ([#1359](https://github.com/kamiazya/whiteboard/issues/1359)) ([f7a391b](https://github.com/kamiazya/whiteboard/commit/f7a391b8bc3e63d7983fe5f23771d846599194da))
* **canvas-render:** a plugin can contribute a node silhouette, under a namespaced id ([#1052](https://github.com/kamiazya/whiteboard/issues/1052)) ([a304955](https://github.com/kamiazya/whiteboard/commit/a304955cca2c9f1199b863a6b477f77058a2918f))
* **canvas-render:** a plugin's rendering contribution is one object, and the renderer holds no facet key ([#1078](https://github.com/kamiazya/whiteboard/issues/1078)) ([1b6835a](https://github.com/kamiazya/whiteboard/commit/1b6835a740eca629a079ceb8c78ba71424b26cf2))
* **canvas-render:** addressable comment chrome ids, showResolved and sceneDigest exclusion (ADR-0025 [#4](https://github.com/kamiazya/whiteboard/issues/4)/[#5](https://github.com/kamiazya/whiteboard/issues/5)) ([#1237](https://github.com/kamiazya/whiteboard/issues/1237)) ([e330d3e](https://github.com/kamiazya/whiteboard/commit/e330d3ef3eb878511798c7aa28927291079e67d9))
* **canvas-render:** draw the comment annotation layer as pins and floating bubbles ([#1205](https://github.com/kamiazya/whiteboard/issues/1205)) ([165e2b8](https://github.com/kamiazya/whiteboard/commit/165e2b89567ca8a52eb2a9d216ff2edb76e1b7ce))
* **canvas-render:** dress the comment layer as floating chrome, not a content node ([#1212](https://github.com/kamiazya/whiteboard/issues/1212)) ([ec1b341](https://github.com/kamiazya/whiteboard/commit/ec1b341e8a2be188b44e71929282529d29483d9c))
* **canvas-render:** node silhouettes, icon glyphs and outline-aware edge ends for the facet display layer ([#953](https://github.com/kamiazya/whiteboard/issues/953)) ([839eda9](https://github.com/kamiazya/whiteboard/commit/839eda99bd48f115f658880c6fe5c21f230a15ea))
* **canvas-render:** tie comment pin to bubble with a dashed leader line ([#1209](https://github.com/kamiazya/whiteboard/issues/1209)) ([2eb6de1](https://github.com/kamiazya/whiteboard/commit/2eb6de1fc99218a58ce728550cda7965d2e1e741))
* **canvas-render:** windowed grid route search — fallback routing now reaches large canvases ([#987](https://github.com/kamiazya/whiteboard/issues/987)) ([7607625](https://github.com/kamiazya/whiteboard/commit/7607625915f24617ff78541c6fe48a6891400959))
* **canvas-viewer:** restore the widget's sticky-note append via wb_canvas_edit ([#1200](https://github.com/kamiazya/whiteboard/issues/1200)) ([de6b636](https://github.com/kamiazya/whiteboard/commit/de6b636f6a78ec957c5710b25b04105f6f20b4f5))
* **canvas-viewer:** turn the widget's sticky note into a comment — click to anchor, deliver to the model ([#1207](https://github.com/kamiazya/whiteboard/issues/1207)) ([ea8e261](https://github.com/kamiazya/whiteboard/commit/ea8e261b19c312c45517eded347718f33797fc75))
* collapse the dual document plane — the workspace tree becomes the address book ([#1084](https://github.com/kamiazya/whiteboard/issues/1084)) ([627fde0](https://github.com/kamiazya/whiteboard/commit/627fde009d861e5a1b479e9886ba67ab9e27e6e4))
* derive a facet editor from its schema, so an agent's write is never invisible ([#1008](https://github.com/kamiazya/whiteboard/issues/1008)) ([d866f67](https://github.com/kamiazya/whiteboard/commit/d866f67790a74b8e3ffff1467dab99b1cbc02c1e))
* **dev-flow:** report open issues whose sources moved, using git and nothing new ([#1073](https://github.com/kamiazya/whiteboard/issues/1073)) ([895c291](https://github.com/kamiazya/whiteboard/commit/895c291bf8e259594351065adeaf1dda29bd00c0))
* **dev-flow:** the second-occurrence rule gets a watcher, from annotations CI already emits ([#1284](https://github.com/kamiazya/whiteboard/issues/1284)) ([e166016](https://github.com/kamiazya/whiteboard/commit/e166016c10dd2071077748397f774a454e16bd1a))
* **dev:** autonomous maintenance signals — actionable flake-watch, audit-cadence nudge ([#1302](https://github.com/kamiazya/whiteboard/issues/1302)) ([85e5c51](https://github.com/kamiazya/whiteboard/commit/85e5c51101f6951e5bb18a06744d543ef501a445))
* **dev:** proactive flake prevention — lint rules, bounded quarantine, PR-time stress runs ([#1301](https://github.com/kamiazya/whiteboard/issues/1301)) ([2b69559](https://github.com/kamiazya/whiteboard/commit/2b695591c2fc2cf4976ae6f649d5310d04eee3f0))
* **facet-engine:** the facet engine — plugin registry, validation layers, compat chains, canvas facet slot ([#967](https://github.com/kamiazya/whiteboard/issues/967)) ([42e607f](https://github.com/kamiazya/whiteboard/commit/42e607fbc36d11e8dd6aae1ab613d931fd433057))
* **facet-ui:** a plugin owns how its facets are edited ([#1031](https://github.com/kamiazya/whiteboard/issues/1031)) ([bd87f6e](https://github.com/kamiazya/whiteboard/commit/bd87f6ee6f95e720299723865af0e8ac4208ed7b))
* **history:** a document's branches live on the workspace record, on a plane that merges ([#1423](https://github.com/kamiazya/whiteboard/issues/1423)) ([76e5c91](https://github.com/kamiazya/whiteboard/commit/76e5c91bfa5c7b241145d01043f21a3b65d91bab))
* **lint:** catch the two ways a test file quietly stops running ([#1321](https://github.com/kamiazya/whiteboard/issues/1321)) ([0d8b2e6](https://github.com/kamiazya/whiteboard/commit/0d8b2e6d23e647d94eb4f92282b40152d80d13ac))
* **lint:** salvage two more catalogue flake shapes into the GritQL plugin ([#1303](https://github.com/kamiazya/whiteboard/issues/1303)) ([596cf77](https://github.com/kamiazya/whiteboard/commit/596cf772a52281078c1cd21c4da75cc0440ff422))
* **lint:** turn three silent logging and coverage failures into loud ones ([#1306](https://github.com/kamiazya/whiteboard/issues/1306)) ([e8e7147](https://github.com/kamiazya/whiteboard/commit/e8e71473cace8f8f8a098d3a6f1110c76d865bd7))
* **loro-adapter:** a comment lives in the threads plane, and the canvas projects it back ([#1257](https://github.com/kamiazya/whiteboard/issues/1257)) ([e3a718d](https://github.com/kamiazya/whiteboard/commit/e3a718dbfe6b8a24c5fda5100f2e1a4d43127d49))
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
* **mcp:** withdraw comment.remove — resolving is the only way to close a comment ([#1246](https://github.com/kamiazya/whiteboard/issues/1246)) ([d71d922](https://github.com/kamiazya/whiteboard/commit/d71d922184eeecb85fac41e86972127b2904e077))
* **measure:** check the embedding pipeline against a published number ([#1038](https://github.com/kamiazya/whiteboard/issues/1038)) ([39238dd](https://github.com/kamiazya/whiteboard/commit/39238dd7489578ae217451a175277ff6866a0b4b))
* **model,loro-adapter:** add the canvas comment annotation layer (ADR-0024) ([#1204](https://github.com/kamiazya/whiteboard/issues/1204)) ([041c5f5](https://github.com/kamiazya/whiteboard/commit/041c5f5c6d360df5a041c126f9299fc5d8bb6f8e))
* **model:** add workspace canonical-id/segment/displayName schemas ([#1099](https://github.com/kamiazya/whiteboard/issues/1099)) ([7a88ff8](https://github.com/kamiazya/whiteboard/commit/7a88ff8c544614049852248b8f5f64b9235da837))
* **model:** facet keys become {namespace}.{name}/v{n} (ADR-0013) ([#965](https://github.com/kamiazya/whiteboard/issues/965)) ([131e8a3](https://github.com/kamiazya/whiteboard/commit/131e8a3f9a491298c83014b8fbb5fbab428ecd3d))
* **model:** the annotation layer's data shape — threads, selector anchors, per-message merge ([#1254](https://github.com/kamiazya/whiteboard/issues/1254)) ([1388091](https://github.com/kamiazya/whiteboard/commit/13880912db55adb19dca5a1591d42d011bf6de07))
* **model:** the proposal layer's data shape — anchored changes, decided one at a time ([#1445](https://github.com/kamiazya/whiteboard/issues/1445)) ([84d0c7a](https://github.com/kamiazya/whiteboard/commit/84d0c7a28ffa1e0645c2eef0227b51552bf287ca))
* **model:** what adopting a proposed passage means, and whether it still fits ([#1456](https://github.com/kamiazya/whiteboard/issues/1456)) ([1878a30](https://github.com/kamiazya/whiteboard/commit/1878a305b832dc20916331d6873d01b7c55701cc))
* name and size the workspace, and give the daemon its write surface ([#1129](https://github.com/kamiazya/whiteboard/issues/1129)) ([e68f9c8](https://github.com/kamiazya/whiteboard/commit/e68f9c851af96cac68e4b06fba8cb7969859f11e))
* **okf:** adopt OKF v0.2 — nothing is dropped, and the trust pair is modelled ([#1051](https://github.com/kamiazya/whiteboard/issues/1051)) ([66ae491](https://github.com/kamiazya/whiteboard/commit/66ae491b8e02083c4ae27e5871d86dfa93677003))
* **plugin-visual:** the badge moves to the plugin, behind a decoration contribution ([#1061](https://github.com/kamiazya/whiteboard/issues/1061)) ([125fa0a](https://github.com/kamiazya/whiteboard/commit/125fa0a20e5f4f6da481d6d8cbf882413ca43ea5))
* **ports:** DocumentEntry carries updatedAt, and the HTTP list becomes an adapter ([#1079](https://github.com/kamiazya/whiteboard/issues/1079)) ([c663bc4](https://github.com/kamiazya/whiteboard/commit/c663bc464f79dc5aa711b30104a11df3b7da1906))
* **ports:** DocumentIndex answers listWorkspaces, clearing the last store reach ([#1080](https://github.com/kamiazya/whiteboard/issues/1080)) ([18ce5de](https://github.com/kamiazya/whiteboard/commit/18ce5dec9092de4959b6df6d81c4aeacee5fe5b6))
* **ports:** resolve a workspace by segment first, canonical id second ([#1108](https://github.com/kamiazya/whiteboard/issues/1108)) ([ffb95df](https://github.com/kamiazya/whiteboard/commit/ffb95df1dac8fbee19f3510e641a5bba3588dca0))
* **ports:** widen listWorkspaces/createWorkspace with optional segment + displayName ([#1100](https://github.com/kamiazya/whiteboard/issues/1100)) ([8d13bc5](https://github.com/kamiazya/whiteboard/commit/8d13bc5ff787c920beca3a1230b4eb96905f5832))
* promotion slice 3 — referenced image bytes travel with the record ([#1090](https://github.com/kamiazya/whiteboard/issues/1090)) ([cdadeb5](https://github.com/kamiazya/whiteboard/commit/cdadeb558cb90c3416fcc637f1fd2d7ee9f0af39))
* promotion slice 4 — the promote-workspace library function ([#1089](https://github.com/kamiazya/whiteboard/issues/1089)) ([57d4779](https://github.com/kamiazya/whiteboard/commit/57d4779c7619b639c981896371c3ddd7d087cdb6))
* promotion slice 5a — split the connection chip state into keeper and session-health axes ([#1091](https://github.com/kamiazya/whiteboard/issues/1091)) ([5c68eec](https://github.com/kamiazya/whiteboard/commit/5c68eec82cddb72b609ec020ff7b5e472662643b))
* promotion slice 8 — disclose a moved workspace in the browser popover ([#1094](https://github.com/kamiazya/whiteboard/issues/1094)) ([4d9c3b2](https://github.com/kamiazya/whiteboard/commit/4d9c3b24ea01fd0656f834d98682d0748e0f7255))
* promotion slices 5b+6 — move the browser workspace to a daemon from Settings, with a narrated reload ([#1092](https://github.com/kamiazya/whiteboard/issues/1092)) ([b0f30b6](https://github.com/kamiazya/whiteboard/commit/b0f30b67bf3fdeee98f7528cf3f3913ef9386198))
* references follow a document's move, in both keepers ([#1249](https://github.com/kamiazya/whiteboard/issues/1249)) ([1b8c0ab](https://github.com/kamiazya/whiteboard/commit/1b8c0abb34d77e8d9301de983f84a377fd3e0d91))
* **references:** embed a canvas with ![[path]], and name a heading or group with #fragment ([#1373](https://github.com/kamiazya/whiteboard/issues/1373)) ([106a313](https://github.com/kamiazya/whiteboard/commit/106a313698d3a2735910f7ae4ada8714efd8e9bb))
* **render:** the layout worker takes references as data, so a text node's `![[note]]` draws on both threads ([#1390](https://github.com/kamiazya/whiteboard/issues/1390)) ([431acd5](https://github.com/kamiazya/whiteboard/commit/431acd5a5cfb14b07dd88dcfdd634fb6ff979a99))
* retire display names from reference resolution — path + id only, names label links at render time ([#1280](https://github.com/kamiazya/whiteboard/issues/1280)) ([41ed541](https://github.com/kamiazya/whiteboard/commit/41ed541d20f9fea599f39db4c2fc3272ac5dddd0))
* retire the per-document import panel — whole-workspace move supersedes it ([#1093](https://github.com/kamiazya/whiteboard/issues/1093)) ([0755021](https://github.com/kamiazya/whiteboard/commit/0755021ffbd81eb97b12b6782e80be11797d381a))
* search by meaning, opt-in — measured against the judged corpus ([#1012](https://github.com/kamiazya/whiteboard/issues/1012)) ([4fece27](https://github.com/kamiazya/whiteboard/commit/4fece2728000b56a82a64c4e0ba7ce167b5f085f))
* **search:** a retrieval evaluation instrument that states its own resolution ([#1016](https://github.com/kamiazya/whiteboard/issues/1016)) ([4a63308](https://github.com/kamiazya/whiteboard/commit/4a63308ec5d865e551e10dd2dc713b70e8eab8ee))
* **search:** let the reader choose the embedding precision, and stop mixing vector spaces ([#1039](https://github.com/kamiazya/whiteboard/issues/1039)) ([781dad2](https://github.com/kamiazya/whiteboard/commit/781dad274f339281aa28484400f443eb7872afe4))
* **server-core:** a document create reports the workspace it wrote to ([#1112](https://github.com/kamiazya/whiteboard/issues/1112)) ([15c86d4](https://github.com/kamiazya/whiteboard/commit/15c86d481142da3b13c2b4231b10877c653da8e9))
* **server-core:** add wb_canvas_edit comment ops and stop batches wiping the canvas extension ([#1206](https://github.com/kamiazya/whiteboard/issues/1206)) ([cdc814f](https://github.com/kamiazya/whiteboard/commit/cdc814fcbb27a3c8231bbe05031e2bfacdcd5e65))
* **server-core:** an agent proposes a passage by default ([#1460](https://github.com/kamiazya/whiteboard/issues/1460)) ([c2f5306](https://github.com/kamiazya/whiteboard/commit/c2f53060a927d8f314d12528d3208a49241ca8b6))
* **server-core:** an agent proposes content by default ([#1454](https://github.com/kamiazya/whiteboard/issues/1454)) ([1e3e0be](https://github.com/kamiazya/whiteboard/commit/1e3e0bede6f0553f5f0f593abe9c4f7e57d508e0))
* **server-core:** declare the version-history seam an operation reads ([#1216](https://github.com/kamiazya/whiteboard/issues/1216)) ([3cc4c9e](https://github.com/kamiazya/whiteboard/commit/3cc4c9ef39d29e022bdefa30f44ee7e21300433d))
* **server-core:** resolve the workspace handle once at the request boundary ([#1109](https://github.com/kamiazya/whiteboard/issues/1109)) ([cc763e5](https://github.com/kamiazya/whiteboard/commit/cc763e5521a1cbffcc690f678e25edf9ef247fd5))
* **server-core:** the server mints a workspace id and the caller's string becomes its segment ([#1113](https://github.com/kamiazya/whiteboard/issues/1113)) ([8d7ce97](https://github.com/kamiazya/whiteboard/commit/8d7ce97156127e7005c1027278b3aa048244167e))
* **server-core:** wb_body_edit — a document's body edited by the passage ([#1458](https://github.com/kamiazya/whiteboard/issues/1458)) ([3cea93d](https://github.com/kamiazya/whiteboard/commit/3cea93d3d8eaf2e9dee421703a398b7c7d95f516))
* **server-core:** wb_canvas_edit can propose a batch instead of applying it ([#1446](https://github.com/kamiazya/whiteboard/issues/1446)) ([1291a1a](https://github.com/kamiazya/whiteboard/commit/1291a1aee2f8d5f7d5ebf67be82a322c3c5218df))
* **server:** sweep unreferenced uploads in server mode, and unblock the loop while it runs ([#1130](https://github.com/kamiazya/whiteboard/issues/1130)) ([bd19b9d](https://github.com/kamiazya/whiteboard/commit/bd19b9d8d5ce2f2a92c7e623f925c77d285ecc74))
* **spatial-editor:** the facet inspector follows the selection instead of being a dialog ([#1030](https://github.com/kamiazya/whiteboard/issues/1030)) ([0f8c3d1](https://github.com/kamiazya/whiteboard/commit/0f8c3d13e60d8d95cae3b7749dce11138de5ada3))
* **store:** back up without stopping the server, and answer per store ([#1118](https://github.com/kamiazya/whiteboard/issues/1118)) ([1bd73f6](https://github.com/kamiazya/whiteboard/commit/1bd73f6f5a855b38bf85299aa711e467a3d3f571))
* **store:** keep one copy of each blob across backups, and collect it when no backup needs it ([#1126](https://github.com/kamiazya/whiteboard/issues/1126)) ([92e7145](https://github.com/kamiazya/whiteboard/commit/92e71450ffde1fe45a4752a966bdd5145f38b649))
* **store:** make a backup appear only once every store has finished ([#1127](https://github.com/kamiazya/whiteboard/issues/1127)) ([3c22dce](https://github.com/kamiazya/whiteboard/commit/3c22dce92015369adf46371807f5d9629413d5de))
* **store:** make multi-instance operation correct, and provable ([#1106](https://github.com/kamiazya/whiteboard/issues/1106)) ([28078e7](https://github.com/kamiazya/whiteboard/commit/28078e7d56e8239b54d15eeef78d35f4b8a6b0df))
* **store:** run scheduled backups on a cron, from one instance, in their own process ([#1124](https://github.com/kamiazya/whiteboard/issues/1124)) ([bbb722b](https://github.com/kamiazya/whiteboard/commit/bbb722b379d0a52391488b868f02a96c71c9017b))
* surface the trash — list what deletes evacuated, restore in place ([#1086](https://github.com/kamiazya/whiteboard/issues/1086)) ([01fa9c5](https://github.com/kamiazya/whiteboard/commit/01fa9c5a6cddb24f443e8df61e1c06625b2711e3))
* **test:** upgrade to Vitest 5 and add the testing-techniques skill ([#1334](https://github.com/kamiazya/whiteboard/issues/1334)) ([fbee5e2](https://github.com/kamiazya/whiteboard/commit/fbee5e28d5ccd502312394b0bb76dc78d393dbed))
* **tooling:** catch cross-package dependency cycles in arch-lint ([#1219](https://github.com/kamiazya/whiteboard/issues/1219)) ([d54ece6](https://github.com/kamiazya/whiteboard/commit/d54ece675e69292cb99a8aaf7489f38c584296ff))
* visual.shape/v0 — node silhouettes as the first node-target facet ([#974](https://github.com/kamiazya/whiteboard/issues/974)) ([1c881b6](https://github.com/kamiazya/whiteboard/commit/1c881b61ead2623c22a170f94e655bdc87b1f2aa))
* visual.symbol/v0 — node badges, contributed without touching a core surface ([#998](https://github.com/kamiazya/whiteboard/issues/998)) ([73fbacb](https://github.com/kamiazya/whiteboard/commit/73fbacbf76c1c1db31d6cb3297edda75575d5cf9))
* visual.text/v0 — text placement as a facet, contributed with no vessel change ([#1015](https://github.com/kamiazya/whiteboard/issues/1015)) ([3dcd314](https://github.com/kamiazya/whiteboard/commit/3dcd3142a8083ca2e3ea526eca8c4771daec9dcb))
* wb_facet_list — an agent can discover a facet instead of guessing it ([#1009](https://github.com/kamiazya/whiteboard/issues/1009)) ([50bccf5](https://github.com/kamiazya/whiteboard/commit/50bccf5cf07aca1763424788b34551a85961cb42))
* **web:** [[ inline completion in the markdown editor ([#972](https://github.com/kamiazya/whiteboard/issues/972)) ([cdeac4b](https://github.com/kamiazya/whiteboard/commit/cdeac4bb823d565f13936dc1df638734a49f655e))
* **web:** a card says when its content moved since this device opened it ([#1406](https://github.com/kamiazya/whiteboard/issues/1406)) ([b615e9f](https://github.com/kamiazya/whiteboard/commit/b615e9f9e6f09f0beb4b9985c9d85b7616fcb8dd))
* **web:** a document card's actions open at the card — right-click context menu ([#989](https://github.com/kamiazya/whiteboard/issues/989)) ([4b75caf](https://github.com/kamiazya/whiteboard/commit/4b75caf7fb1ef15372f9d42a354e255f70974e59))
* **web:** a hit no keyword produced is shown without a highlight ([#1025](https://github.com/kamiazya/whiteboard/issues/1025)) ([3a12fed](https://github.com/kamiazya/whiteboard/commit/3a12fed993d1dc8fabf9eefac027cd5e7d6966a0))
* **web:** a link typed into the node editor resolves in its preview before the commit ([#1402](https://github.com/kamiazya/whiteboard/issues/1402)) ([f3cf2bf](https://github.com/kamiazya/whiteboard/commit/f3cf2bfed2a881e827ba34d63abbd41eac42364b))
* **web:** a markdown note reaches its own history ([#1438](https://github.com/kamiazya/whiteboard/issues/1438)) ([9cfd81c](https://github.com/kamiazya/whiteboard/commit/9cfd81c0b64bfcb778a196abb0ca37be8f61c1c8))
* **web:** a merge Undo that undoes, a badge that keeps its type, and a result that says why ([#1439](https://github.com/kamiazya/whiteboard/issues/1439)) ([eefaf2e](https://github.com/kamiazya/whiteboard/commit/eefaf2ee89075da8036c153dd51f22e7e1316552))
* **web:** a non-default variation is addressable as a read-only ?v= preview (ADR-0022) ([#1316](https://github.com/kamiazya/whiteboard/issues/1316)) ([1b9b17d](https://github.com/kamiazya/whiteboard/commit/1b9b17d7c6467e3e2045a536d44b701844463877))
* **web:** a person adopts a proposal from the bubble it is drawn on ([#1450](https://github.com/kamiazya/whiteboard/issues/1450)) ([a1f3294](https://github.com/kamiazya/whiteboard/commit/a1f32945a0bc174f47bc26a436cf85db276e3cf1))
* **web:** a proposal can be decided one change at a time ([#1451](https://github.com/kamiazya/whiteboard/issues/1451)) ([dcf517a](https://github.com/kamiazya/whiteboard/commit/dcf517a4de6a9ba2be383e2e17d3a8be8cf8b111))
* **web:** a replica takes markdown edits offline and ships them when the daemon returns (ADR-0023) ([#1297](https://github.com/kamiazya/whiteboard/issues/1297)) ([7328d64](https://github.com/kamiazya/whiteboard/commit/7328d64dba4b9591ecaa7e9656d70ce2c1d269bc))
* **web:** a replica's age re-arms its refresh, and the notice states it ([#1290](https://github.com/kamiazya/whiteboard/issues/1290)) ([2af9f82](https://github.com/kamiazya/whiteboard/commit/2af9f82335c80480c67b834745d4ac42429d47c2))
* **web:** a tap opens a document, and long-press reaches its actions ([#1304](https://github.com/kamiazya/whiteboard/issues/1304)) ([0ad749b](https://github.com/kamiazya/whiteboard/commit/0ad749b4e73827bf78596c2b05a9dc076e79bbad))
* **web:** a verified move deletes the browser copy — demote completes promote (ADR-0023) ([#1283](https://github.com/kamiazya/whiteboard/issues/1283)) ([242f647](https://github.com/kamiazya/whiteboard/commit/242f647316c02418a228819a3661f6d01d2e7fe2))
* **web:** a workspace can be renamed, and the mark is the switcher ([#1121](https://github.com/kamiazya/whiteboard/issues/1121)) ([96507e6](https://github.com/kamiazya/whiteboard/commit/96507e61a7a2a400d9e97d5709101c7f18a37945))
* **web:** anchor a markdown comment to a Loro rich-text mark ([#1363](https://github.com/kamiazya/whiteboard/issues/1363)) ([553bd1d](https://github.com/kamiazya/whiteboard/commit/553bd1dd662b7c2034e92a0fa5146034d010444b))
* **web:** backlinks — Connections chip on an event-capable reference aggregate ([#970](https://github.com/kamiazya/whiteboard/issues/970)) ([531fccf](https://github.com/kamiazya/whiteboard/commit/531fccf9daf3273d7275d8962969e70a973a1abb))
* **web:** choose a document kind by name, and keep the folder you are in ([#1002](https://github.com/kamiazya/whiteboard/issues/1002)) ([6055eb8](https://github.com/kamiazya/whiteboard/commit/6055eb800b81d2866ed7ebc3516952cd1a9528c0))
* **web:** close the inspector on deselect, and drop its Done control ([#1157](https://github.com/kamiazya/whiteboard/issues/1157)) ([b717bbc](https://github.com/kamiazya/whiteboard/commit/b717bbc2978cd5e0449148fee8ad669418af3bb0))
* **web:** count the browser keeper's workspaces when the switcher opens ([#1145](https://github.com/kamiazya/whiteboard/issues/1145)) ([89b2918](https://github.com/kamiazya/whiteboard/commit/89b2918318aacab0a9ce4ba1c8eea2f558e32269))
* **web:** create a comment from the context menu with an inline compose bubble (ADR-0025 [#1](https://github.com/kamiazya/whiteboard/issues/1)) ([#1234](https://github.com/kamiazya/whiteboard/issues/1234)) ([f29e82f](https://github.com/kamiazya/whiteboard/commit/f29e82f22aa2b516f2a0dd8f69c941ca1153d9dd))
* **web:** cross the state dot between tones instead of cutting ([#1175](https://github.com/kamiazya/whiteboard/issues/1175)) ([c474f10](https://github.com/kamiazya/whiteboard/commit/c474f10e07f04303adb1e4a332846af3899fed99))
* **web:** decide a proposed passage in the body ([#1461](https://github.com/kamiazya/whiteboard/issues/1461)) ([c94f27a](https://github.com/kamiazya/whiteboard/commit/c94f27a37a4e2550f59541f72c749bc9f80777f6))
* **web:** document cards speak in pictures — kind icon, pin glyph, bigger thumbnails ([#1312](https://github.com/kamiazya/whiteboard/issues/1312)) ([037a7b6](https://github.com/kamiazya/whiteboard/commit/037a7b6ac0c6b663f6ba1ada86f369e1ce3baede))
* **web:** drag a comment's pin to move its anchor, and edit its text in place (ADR-0025) ([#1238](https://github.com/kamiazya/whiteboard/issues/1238)) ([d1f2725](https://github.com/kamiazya/whiteboard/commit/d1f2725be53c0c3c0b157d83a3a15424e856616d))
* **web:** edge display settings live in the visual.edges facet ([#968](https://github.com/kamiazya/whiteboard/issues/968)) ([e87ddf2](https://github.com/kamiazya/whiteboard/commit/e87ddf22c7e9a7882fc1634f80f54d4312a01fe9))
* **web:** Escape restores the name the title field held before the edit ([#1006](https://github.com/kamiazya/whiteboard/issues/1006)) ([6e2c602](https://github.com/kamiazya/whiteboard/commit/6e2c6022fac7dc4dabf12c0b578adb63372af043))
* **web:** finish single-line edits on Enter without breaking IME, and say the editors' exit chords ([#1199](https://github.com/kamiazya/whiteboard/issues/1199)) ([942c98a](https://github.com/kamiazya/whiteboard/commit/942c98afc5f64f4d51bbe78b3d42d91a17676eb1))
* **web:** fullscreen belongs to the shell, and its subject is the whole app ([#1410](https://github.com/kamiazya/whiteboard/issues/1410)) ([757ab99](https://github.com/kamiazya/whiteboard/commit/757ab996d330b2d4aa6c70a296e44a3daea6a36d))
* **web:** give diagnostics a Developer section, and let Back speak in glyphs ([#1173](https://github.com/kamiazya/whiteboard/issues/1173)) ([53d90fb](https://github.com/kamiazya/whiteboard/commit/53d90fbad7caeaebff2c606e4672f4f1c2d9e570))
* **web:** hold both keepers to one version history, and make a difference a decision ([#1276](https://github.com/kamiazya/whiteboard/issues/1276)) ([0e77c49](https://github.com/kamiazya/whiteboard/commit/0e77c491de81b1e89e0af4e730eb3a11e9580940))
* **web:** keyboard-docked formatting bar on touch, with the verbs the editor's syntax supports ([#1239](https://github.com/kamiazya/whiteboard/issues/1239)) ([a1a0069](https://github.com/kamiazya/whiteboard/commit/a1a00692f1158b727fde0328a95b40efcb42b855))
* **web:** lay the markdown preview out as a page, not as a node ([#950](https://github.com/kamiazya/whiteboard/issues/950)) ([59c974c](https://github.com/kamiazya/whiteboard/commit/59c974c661b9b6134849f0dbb34f7aff49f14f2f))
* **web:** let each setup-journey step carry its own storage evidence ([#1176](https://github.com/kamiazya/whiteboard/issues/1176)) ([bf5cc78](https://github.com/kamiazya/whiteboard/commit/bf5cc7849e7e3ff9f77a9ae309ae71bf114cea5f))
* **web:** Link it — one server-side operation turns a mention into a real link ([#988](https://github.com/kamiazya/whiteboard/issues/988)) ([f54fd71](https://github.com/kamiazya/whiteboard/commit/f54fd71056278a50087536b0f0027d60acbf1c54))
* **web:** model the editor's navigation gestures as a pure reducer ([#1160](https://github.com/kamiazya/whiteboard/issues/1160)) ([e7b4a62](https://github.com/kamiazya/whiteboard/commit/e7b4a621d18f38b7c8f144953b2a46f59c7a2601))
* **web:** one document browser for both modes, with match highlighting ([#966](https://github.com/kamiazya/whiteboard/issues/966)) ([308334c](https://github.com/kamiazya/whiteboard/commit/308334cdab5a2a058632fc5e51bd69ae12e6e4d2))
* **web:** one inspector slot beside the editor, so History and Comments are exclusive ([#1398](https://github.com/kamiazya/whiteboard/issues/1398)) ([3cb32ed](https://github.com/kamiazya/whiteboard/commit/3cb32edede7270947bfc0bade5d175609ca9706b))
* **web:** one Rename dialog for a document's name and its path ([#996](https://github.com/kamiazya/whiteboard/issues/996)) ([8b563f1](https://github.com/kamiazya/whiteboard/commit/8b563f1fbf245051fa886d1b1605a74d3b254c3d))
* **web:** one version history for both keepers — bookmarks, checkpoints at a pause, preview-then-restore and restore lineage ([#1245](https://github.com/kamiazya/whiteboard/issues/1245)) ([8eef114](https://github.com/kamiazya/whiteboard/commit/8eef1145cdb2b82bb878afdccbd2d16960c3c169))
* **web:** one workspace address grammar, and the URL names what it shows ([#1117](https://github.com/kamiazya/whiteboard/issues/1117)) ([b53014b](https://github.com/kamiazya/whiteboard/commit/b53014bc15d06fc12d67a58a5028ef4cb172ab8c))
* **web:** open a browser-kept variation from the address ([#1437](https://github.com/kamiazya/whiteboard/issues/1437)) ([62aede2](https://github.com/kamiazya/whiteboard/commit/62aede261b2b4d206c40b1f942e1356e97e4fcad))
* **web:** open a conversation from a markdown selection ([#1341](https://github.com/kamiazya/whiteboard/issues/1341)) ([b235fc2](https://github.com/kamiazya/whiteboard/commit/b235fc2ef966925f8ab691cb9fb849c7de9cdfff))
* **web:** peek — look at a document on touch without opening it ([#1317](https://github.com/kamiazya/whiteboard/issues/1317)) ([409d19d](https://github.com/kamiazya/whiteboard/commit/409d19d84d48f7bff4c781e0de85715a44003e9f))
* **web:** place comment bubbles clear of nodes and settle a dropped pin without a flight back ([#1244](https://github.com/kamiazya/whiteboard/issues/1244)) ([be1f696](https://github.com/kamiazya/whiteboard/commit/be1f6966654f6ad84056e99d1f40b2da0d2e4fd8))
* **web:** promote selector shows workspace display names, id only as the unnamed fallback ([#1105](https://github.com/kamiazya/whiteboard/issues/1105)) ([300fd6e](https://github.com/kamiazya/whiteboard/commit/300fd6e745d7d2fad845b85b7475226a34756d2d))
* **web:** Properties and Connections join the inspector slot as tabs ([#1401](https://github.com/kamiazya/whiteboard/issues/1401)) ([5ac9856](https://github.com/kamiazya/whiteboard/commit/5ac98566f723dc577ce752ac39c0af722d38f7ad))
* **web:** put the browser's Loro persistence behind the DocumentStore port ([#948](https://github.com/kamiazya/whiteboard/issues/948)) ([8bcf1ba](https://github.com/kamiazya/whiteboard/commit/8bcf1ba41b4ff9945e87e83bb568a1bc0f9ed324))
* **web:** put the last two surfaces behind the render broker, and make a new kind fail the build ([#1293](https://github.com/kamiazya/whiteboard/issues/1293)) ([91d8fc5](https://github.com/kamiazya/whiteboard/commit/91d8fc5fc273f381c378b27939626df92bccdfd8))
* **web:** re-cut the document header — retire the pencil and the in-editor document switcher ([#1004](https://github.com/kamiazya/whiteboard/issues/1004)) ([2106e5b](https://github.com/kamiazya/whiteboard/commit/2106e5ba2f8c3cea1416796fefa0d020c204634c))
* **web:** record every gesture decision, so a phone can hand over the crash ([#1171](https://github.com/kamiazya/whiteboard/issues/1171)) ([617d651](https://github.com/kamiazya/whiteboard/commit/617d651d56a8cdd3545633ba7da6e34eb078d404))
* **web:** resolve and reopen comments from the editor, with a show-resolved toggle ([#1247](https://github.com/kamiazya/whiteboard/issues/1247)) ([db300b5](https://github.com/kamiazya/whiteboard/commit/db300b5389789aaa4f6909a952b04ba0bc302808))
* **web:** retire the document grid; the three-pane browser is the only index surface ([#969](https://github.com/kamiazya/whiteboard/issues/969)) ([4dd66e8](https://github.com/kamiazya/whiteboard/commit/4dd66e80a242334ce925137348b4e77483ba789f))
* **web:** route every rendered picture through one broker, and cache it ([#1274](https://github.com/kamiazya/whiteboard/issues/1274)) ([82585d9](https://github.com/kamiazya/whiteboard/commit/82585d9aee2984850aacdeeb3e908d3a04005bce))
* **web:** serve a daemon workspace read-only from its replica when the daemon is unreachable ([#1182](https://github.com/kamiazya/whiteboard/issues/1182)) ([64e2f5d](https://github.com/kamiazya/whiteboard/commit/64e2f5da5a4e578d829e77515a1de5434580bcb4))
* **web:** show a document path as the URL fragment it becomes ([#1136](https://github.com/kamiazya/whiteboard/issues/1136)) ([f1e0e65](https://github.com/kamiazya/whiteboard/commit/f1e0e650d813fb9db74e15e13fba2addb1b08208))
* **web:** show every variation's lane in the version timeline ([#1132](https://github.com/kamiazya/whiteboard/issues/1132)) ([8f48095](https://github.com/kamiazya/whiteboard/commit/8f48095f7a689a073b577e6c6d4ae1d72d4bc169))
* **web:** show the editing verbs where a wide screen has room, on both editing surfaces ([#1268](https://github.com/kamiazya/whiteboard/issues/1268)) ([95823aa](https://github.com/kamiazya/whiteboard/commit/95823aa75534870ca5fd9309f00b114d09a1430b))
* **web:** tags become functional — searchable and filterable in the document browser ([#975](https://github.com/kamiazya/whiteboard/issues/975)) ([93fce2f](https://github.com/kamiazya/whiteboard/commit/93fce2fdc9c08f9824fc5d1b5bf4326fcf3bb30e))
* **web:** tappable ✓/✕ exit pill on touch instead of keyboard chords, and enterkeyhint on finish-on-Enter inputs ([#1230](https://github.com/kamiazya/whiteboard/issues/1230)) ([9b20f61](https://github.com/kamiazya/whiteboard/commit/9b20f619c507a38f6223a8432642b4be00461bfc))
* **web:** the browser keeper commits a merge, by adopting the source tip ([#1426](https://github.com/kamiazya/whiteboard/issues/1426)) ([266836e](https://github.com/kamiazya/whiteboard/commit/266836e49c1d1be60e2935589229511bbfd9d077))
* **web:** the browser keeper has variations, and `branches` stops being a capability ([#1425](https://github.com/kamiazya/whiteboard/issues/1425)) ([9414aee](https://github.com/kamiazya/whiteboard/commit/9414aeeb5773650b313d8a411fe871b9a6f13157))
* **web:** the browser keeper takes automatic checkpoints ([#1431](https://github.com/kamiazya/whiteboard/issues/1431)) ([abc07d4](https://github.com/kamiazya/whiteboard/commit/abc07d470007d41cf9d70042dbb8effa27455d82))
* **web:** the browser keeps a replica of daemon workspaces it touches ([#1181](https://github.com/kamiazya/whiteboard/issues/1181)) ([5f988f8](https://github.com/kamiazya/whiteboard/commit/5f988f898c386f3db2d36b7c24de8cb17d30388b))
* **web:** the comment compose bubble is the settled bubble, not a label editor (ADR-0025) ([#1241](https://github.com/kamiazya/whiteboard/issues/1241)) ([4fd63e7](https://github.com/kamiazya/whiteboard/commit/4fd63e74ed10ec656dec6e9670059b9eff9d1842))
* **web:** the Connections panel surfaces unlinked mentions ([#986](https://github.com/kamiazya/whiteboard/issues/986)) ([06a9367](https://github.com/kamiazya/whiteboard/commit/06a93674824e87efcba833d4775c2b0c82034527))
* **web:** the document browser searches what documents say, not only what they are called ([#1023](https://github.com/kamiazya/whiteboard/issues/1023)) ([b69a7cf](https://github.com/kamiazya/whiteboard/commit/b69a7cfeb70c073396accb4997d9b6c2348e7d1a))
* **web:** the document browser's icon controls reveal their names ([#982](https://github.com/kamiazya/whiteboard/issues/982)) ([c140c65](https://github.com/kamiazya/whiteboard/commit/c140c656e8845d5f2417b801f8bdcc0d6d6f7cac))
* **web:** the document's ⋯ carries display, export and bookmark ([#1417](https://github.com/kamiazya/whiteboard/issues/1417)) ([ea4688a](https://github.com/kamiazya/whiteboard/commit/ea4688abfc8cb9dba66f8ee412d0aba9adabff4f))
* **web:** the empty workspace asks what you'll make first ([#971](https://github.com/kamiazya/whiteboard/issues/971)) ([bcb10e1](https://github.com/kamiazya/whiteboard/commit/bcb10e15f602c506050e42b92b55edc07e4b7511))
* **web:** the four ways to look at a document are one segment ([#1436](https://github.com/kamiazya/whiteboard/issues/1436)) ([ea0bd6a](https://github.com/kamiazya/whiteboard/commit/ea0bd6a1d60ff48148f7f29c0eb0a97305246d89))
* **web:** the offline replica takes spatial edits too — ADR-0023 decision 3 complete ([#1305](https://github.com/kamiazya/whiteboard/issues/1305)) ([b0932ab](https://github.com/kamiazya/whiteboard/commit/b0932abed6e0ca3f762ee4efc5f837c45bd0a6a8))
* **web:** the picker gets a selection mode, whose one verb is bulk delete ([#1400](https://github.com/kamiazya/whiteboard/issues/1400)) ([9175e5e](https://github.com/kamiazya/whiteboard/commit/9175e5e098b5f80b6e5e43cdfac5f27402b92740))
* **web:** the picker keeps a lane of what this device opened recently ([#1392](https://github.com/kamiazya/whiteboard/issues/1392)) ([09721b3](https://github.com/kamiazya/whiteboard/commit/09721b33ddb7705e8f4a17c701911110e016cea4))
* **web:** the render broker keeps what cost more than keeping it does ([#1322](https://github.com/kamiazya/whiteboard/issues/1322)) ([cf720e9](https://github.com/kamiazya/whiteboard/commit/cf720e9e0f18b1585b2749f8fb66be4eb9e4f18c))
* **web:** the routine save state is not shown; the shell mark speaks only for a condition ([#1365](https://github.com/kamiazya/whiteboard/issues/1365)) ([7d223dd](https://github.com/kamiazya/whiteboard/commit/7d223dd6fde28332ba0c68dc3233809d8c7c0479))
* **web:** the signature mark carries the session, and the connection chip is gone ([#1115](https://github.com/kamiazya/whiteboard/issues/1115)) ([199439a](https://github.com/kamiazya/whiteboard/commit/199439a04a92dba31b05a9fb2842b40161a1b626))
* **web:** the variation chip is identity, so it sits beside the name ([#1440](https://github.com/kamiazya/whiteboard/issues/1440)) ([f6d3460](https://github.com/kamiazya/whiteboard/commit/f6d34609331f141b04d33f0f267f7764aa2a4363))
* **web:** user copy names the object — note, canvas, or document, never the container "canvas" ([#978](https://github.com/kamiazya/whiteboard/issues/978)) ([d9b6f22](https://github.com/kamiazya/whiteboard/commit/d9b6f22159c52ca394081f8b916408f25f5bd5a1))


### Bug Fixes

* a dead MCP tool, an unlocked write, and two gates that ran less than they claimed ([#1028](https://github.com/kamiazya/whiteboard/issues/1028)) ([de8bdb3](https://github.com/kamiazya/whiteboard/commit/de8bdb344af1e51f44eeaaaa79c7133ba1f17a39))
* **annotations:** a thread write goes through the reducer, and the gutter marker stops being the only way to reach a conversation ([#1434](https://github.com/kamiazya/whiteboard/issues/1434)) ([f7a81fa](https://github.com/kamiazya/whiteboard/commit/f7a81fa131d16a7bdecc5eb85703e921be630d4c))
* **annotations:** the note's comment gutter paints nothing, and a phone reaches the layer from the toolbar the docked bar makes redundant ([#1415](https://github.com/kamiazya/whiteboard/issues/1415)) ([1bba6ff](https://github.com/kamiazya/whiteboard/commit/1bba6ff910954654825149d54fbb9b41f6b77bdf))
* **arch-lint:** catch the dynamic import at module scope, not only in a body ([#1262](https://github.com/kamiazya/whiteboard/issues/1262)) ([31de539](https://github.com/kamiazya/whiteboard/commit/31de53951c0a4530b79b30f5583a968874d579d3))
* **arch-lint:** follow @/ path aliases, then put apps/web in the cycle scan ([#1047](https://github.com/kamiazya/whiteboard/issues/1047)) ([56a7f81](https://github.com/kamiazya/whiteboard/commit/56a7f81db0c0c5b5996ecdf865cc98fc65b7dd49))
* **arch-lint:** scan the retired vocabulary once, in the collection phase ([#1259](https://github.com/kamiazya/whiteboard/issues/1259)) ([36d9f8c](https://github.com/kamiazya/whiteboard/commit/36d9f8c3eb664ad35939f32ce1fa5e8f300a6797))
* **arch-lint:** the ADR-0018 guard can see mechanics nested under store/db ([#1083](https://github.com/kamiazya/whiteboard/issues/1083)) ([55d1933](https://github.com/kamiazya/whiteboard/commit/55d1933e03b2fe8f44e969e698f25f6c6946dae4))
* **canvas-render:** a contributed icon carries its own coordinate space and paint ([#1064](https://github.com/kamiazya/whiteboard/issues/1064)) ([a670170](https://github.com/kamiazya/whiteboard/commit/a6701703535f6d5d7dd6ad653b690af78c585dd4))
* **canvas-render:** cut a node label between characters a reader sees as one ([#1277](https://github.com/kamiazya/whiteboard/issues/1277)) ([dd89f59](https://github.com/kamiazya/whiteboard/commit/dd89f59ae4963b6f11e1d14b6685c75a4369cf1d))
* **ci:** run the docker image CI builds, and fix the six defects that surfaced ([#1395](https://github.com/kamiazya/whiteboard/issues/1395)) ([3dd7ba5](https://github.com/kamiazya/whiteboard/commit/3dd7ba51e85ce389ec68751ad6b863ac30218b33))
* **ci:** scope the mutation lane to a merge-base range, not a moving one ([#1296](https://github.com/kamiazya/whiteboard/issues/1296)) ([26f1d12](https://github.com/kamiazya/whiteboard/commit/26f1d12103a68dd60aa340e3acbf108c85a40632))
* **daemon-client:** the exports map lists each consumed subpath — and knip immediately found a dead barrel ([#1409](https://github.com/kamiazya/whiteboard/issues/1409)) ([68c5177](https://github.com/kamiazya/whiteboard/commit/68c51778b7bb2ef4a808e9b95aa36a753649f0a8))
* **daemon:** a fresh daemon holds a workspace, and the browser stops dead-ending when it does not ([#1082](https://github.com/kamiazya/whiteboard/issues/1082)) ([7f8bdc6](https://github.com/kamiazya/whiteboard/commit/7f8bdc6f76ed716188010fcd843e8ee66d684bf4))
* **deps:** pin body-parser to 2.3.0 (GHSA-v422-hmwv-36x6) ([#1059](https://github.com/kamiazya/whiteboard/issues/1059)) ([a119665](https://github.com/kamiazya/whiteboard/commit/a119665895153e16e91a71e5b9e45c44be8c2c57))
* **deps:** qs 6.16.0 and browserslist 4.28.7+ clear the five open Dependabot alerts ([#1391](https://github.com/kamiazya/whiteboard/issues/1391)) ([dd2241a](https://github.com/kamiazya/whiteboard/commit/dd2241aa0d64ed69c5d5b1d80b09c51534674add))
* **deps:** raise the fast-uri override past four new high advisories, and bound browser trace retention ([#1251](https://github.com/kamiazya/whiteboard/issues/1251)) ([1f3c0c8](https://github.com/kamiazya/whiteboard/commit/1f3c0c888213a5b16325455e42026948d53b62d3))
* **deps:** raise the fast-uri override to the patched range ([#1253](https://github.com/kamiazya/whiteboard/issues/1253)) ([50e7623](https://github.com/kamiazya/whiteboard/commit/50e762330c066804215e8cf67000b55463176105))
* **dev-rules:** the always-on total is 88, crossed by two merges neither CI saw ([#1287](https://github.com/kamiazya/whiteboard/issues/1287)) ([c23a96e](https://github.com/kamiazya/whiteboard/commit/c23a96e5f7ada638fb9f27b0cd27ab7a34e260d3))
* **devx:** worktree-aware Codex MCP override via the stdio proxy, and working contributor setup docs ([#1347](https://github.com/kamiazya/whiteboard/issues/1347)) ([61c9d41](https://github.com/kamiazya/whiteboard/commit/61c9d4171f1c162e1ce721e904e76442067f8787))
* **docker:** refuse the layer cache on measurement, and fix the cache-mount trap it exposed ([#1449](https://github.com/kamiazya/whiteboard/issues/1449)) ([37672c5](https://github.com/kamiazya/whiteboard/commit/37672c51c249011728c24bd487a766efc914391c))
* **facet-engine:** a facet names itself, and the panel picks shapes by shape ([#1022](https://github.com/kamiazya/whiteboard/issues/1022)) ([626898d](https://github.com/kamiazya/whiteboard/commit/626898de88b7ad0b6ddb3df1531116dd4a53106e))
* **loro-adapter:** two replicas opening one thread container no longer lose a side ([#1382](https://github.com/kamiazya/whiteboard/issues/1382)) ([9b6f95f](https://github.com/kamiazya/whiteboard/commit/9b6f95f6d5cd5a45bf7456fa84d080d45216f9d8))
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
* **search:** a canvas is findable by the url of a link node it holds ([#1258](https://github.com/kamiazya/whiteboard/issues/1258)) ([995b106](https://github.com/kamiazya/whiteboard/commit/995b10699d6bf4c9e8c01adaf56733a1702f529c))
* **search:** cut snippets between grapheme clusters, not code points ([#1331](https://github.com/kamiazya/whiteboard/issues/1331)) ([6633af1](https://github.com/kamiazya/whiteboard/commit/6633af1dc9961e88f0fd2bcb3a3d692f62980d60))
* **search:** find a document by the first character typed, and stop the row vanishing ([#1278](https://github.com/kamiazya/whiteboard/issues/1278)) ([ff086bc](https://github.com/kamiazya/whiteboard/commit/ff086bc9cf046307286f03154f813cf43d2ebf5c))
* **search:** stop snippets cutting a character in half ([#1273](https://github.com/kamiazya/whiteboard/issues/1273)) ([14e20d3](https://github.com/kamiazya/whiteboard/commit/14e20d34808fa8160adaa41fab3412d49bce5f13))
* **security:** declare /api/v1 scopes, and let the guard see the routes at all ([#1069](https://github.com/kamiazya/whiteboard/issues/1069)) ([9ae4170](https://github.com/kamiazya/whiteboard/commit/9ae41709add057cbfaae9c07149c82c136f8f372))
* **server-core:** a blank name on create means no name, not a name the port forbids ([#1074](https://github.com/kamiazya/whiteboard/issues/1074)) ([95605cf](https://github.com/kamiazya/whiteboard/commit/95605cf7dad86a337e8f555e92aab0291601e75c))
* **server-core:** facts cache scopes eviction per workspace and stamps the kind ([#993](https://github.com/kamiazya/whiteboard/issues/993)) ([c4c31bd](https://github.com/kamiazya/whiteboard/commit/c4c31bd7cac525860d2a3e22c9bca9a9a1805572))
* **server-core:** tell the composition root about agent writes, so they compact ([#1046](https://github.com/kamiazya/whiteboard/issues/1046)) ([6a0c8c4](https://github.com/kamiazya/whiteboard/commit/6a0c8c4436fd14b6d36737830f03fe50f0a07c99))
* **server-core:** the teardown seam brackets the delete, so the capture is under the lock ([#1066](https://github.com/kamiazya/whiteboard/issues/1066)) ([1983f3e](https://github.com/kamiazya/whiteboard/commit/1983f3ee82d2b74cdf4e55225242eb1fe3b1d863))
* **server:** calibrate the loop sampler, and make a declared stall ceiling something a test asserts ([#1142](https://github.com/kamiazya/whiteboard/issues/1142)) ([7c88a53](https://github.com/kamiazya/whiteboard/commit/7c88a53598f65dc4b51f46e94d5c1214e2d610e8))
* **server:** canvas_view names what a canvas's own text nodes embed ([#1421](https://github.com/kamiazya/whiteboard/issues/1421)) ([dd1f460](https://github.com/kamiazya/whiteboard/commit/dd1f460b63de85d7494ec69c7b525e1600948a7d))
* **server:** mint a canonical ULID for the workspace a fresh daemon bootstraps ([#1135](https://github.com/kamiazya/whiteboard/issues/1135)) ([1887b76](https://github.com/kamiazya/whiteboard/commit/1887b764535ee7895d093764a90b5965b33895af))
* **server:** server mode mounts the /api/v1 surface — the self-hosted daemon stops 404ing on half its API ([#1405](https://github.com/kamiazya/whiteboard/issues/1405)) ([a446b59](https://github.com/kamiazya/whiteboard/commit/a446b5940ec08601f1765fa0c871b4a0aa9dcd34))
* **spatial-editor:** an options row wraps instead of pushing options off the phone ([#1018](https://github.com/kamiazya/whiteboard/issues/1018)) ([d4da003](https://github.com/kamiazya/whiteboard/commit/d4da003616e01ba2fae9ec47f07492df472f420d))
* **spatial-editor:** facet contributions get their own fenced region in the node menu ([#1021](https://github.com/kamiazya/whiteboard/issues/1021)) ([19bf1cb](https://github.com/kamiazya/whiteboard/commit/19bf1cb3876d3145f33aed0286b5c5075d58d866))
* **spatial-editor:** the node menu carries a doorway to facets, not their values ([#1027](https://github.com/kamiazya/whiteboard/issues/1027)) ([6c98160](https://github.com/kamiazya/whiteboard/commit/6c981600ef5c0aee41795d97f4dc7c29715beca5))
* **store:** re-take the workspace tail's loop cost against a real store ([#1134](https://github.com/kamiazya/whiteboard/issues/1134)) ([b959e85](https://github.com/kamiazya/whiteboard/commit/b959e85810451a7ae56afd30718a9574b3a06ca9))
* **store:** stop backup and the GC grace window losing data silently, and record the durability boundary ([#1114](https://github.com/kamiazya/whiteboard/issues/1114)) ([1d545c4](https://github.com/kamiazya/whiteboard/commit/1d545c4a488b2b01078f49286c1ac9b3553d344d))
* **test:** one definition for deleting a test database, and it waits ([#1368](https://github.com/kamiazya/whiteboard/issues/1368)) ([27bb970](https://github.com/kamiazya/whiteboard/commit/27bb9706e2c92eff3d2e3792cf693b83db8f055b))
* **test:** the reference property applies its canvas edits, and always makes one ([#1457](https://github.com/kamiazya/whiteboard/issues/1457)) ([066a0b4](https://github.com/kamiazya/whiteboard/commit/066a0b4565ed3eb16ae5c0a4605e55b5884449f6))
* **web:** [[ completion accepts at the mapped position and dresses like the app ([#980](https://github.com/kamiazya/whiteboard/issues/980)) ([0db12bb](https://github.com/kamiazya/whiteboard/commit/0db12bbc57fd6b9846fe3c9e3e9599b5f18b69f8))
* **web:** [[ completion no longer races acceptCompletion's interaction guard ([#973](https://github.com/kamiazya/whiteboard/issues/973)) ([a6c13e9](https://github.com/kamiazya/whiteboard/commit/a6c13e90c240435ea19fb9c7dad69e01879122c8))
* **web:** a browser document opened on a variation says so, and both keepers show its chrome ([#1435](https://github.com/kamiazya/whiteboard/issues/1435)) ([2a441c1](https://github.com/kamiazya/whiteboard/commit/2a441c187184ef585f84741fad8e6ec53a6838bb))
* **web:** a document already standing at the target path is not corruption ([#1332](https://github.com/kamiazya/whiteboard/issues/1332)) ([183d190](https://github.com/kamiazya/whiteboard/commit/183d1905ee9c56d0484c9ef357e8e677e5971529))
* **web:** a markdown bookmark carries a picture of its body, not a 1x1 blank ([#1307](https://github.com/kamiazya/whiteboard/issues/1307)) ([9c65c79](https://github.com/kamiazya/whiteboard/commit/9c65c793621f25d195d468e7315aa3927774239b))
* **web:** a read that did not complete stops claiming the document is damaged ([#1300](https://github.com/kamiazya/whiteboard/issues/1300)) ([577843e](https://github.com/kamiazya/whiteboard/commit/577843ee72063bfbfa2acce952c120f21a200020))
* **web:** a saved-bookmark badge no longer outlives its document — useVersionSaveFlow owns its scope reset ([#1354](https://github.com/kamiazya/whiteboard/issues/1354)) ([d711299](https://github.com/kamiazya/whiteboard/commit/d711299e0dfbed44c05109086e47da36d441e241))
* **web:** a tap on a completion option commits it ([#981](https://github.com/kamiazya/whiteboard/issues/981)) ([6ed2a9c](https://github.com/kamiazya/whiteboard/commit/6ed2a9ce6398b055c0caeabe4945d8b3604dc99e))
* **web:** a workspace switch stops jolting the layout ([#1356](https://github.com/kamiazya/whiteboard/issues/1356)) ([0f96dae](https://github.com/kamiazya/whiteboard/commit/0f96dae732276a5d351ceec7ccafa623370c27ef))
* **web:** assert the hand-pan invariant to the pixel, not to hundredths at 8x ([#1263](https://github.com/kamiazya/whiteboard/issues/1263)) ([51ea10e](https://github.com/kamiazya/whiteboard/commit/51ea10eecba1178a28c0b76f944bd5a33484a6ef))
* **web:** Back after the first create no longer shows onboarding over a non-empty store ([#1325](https://github.com/kamiazya/whiteboard/issues/1325)) ([43b5438](https://github.com/kamiazya/whiteboard/commit/43b5438c507bde7c2263b367f8b429617eb7c201))
* **web:** Back during the editor chunk's load no longer resurrects onboarding ([#1324](https://github.com/kamiazya/whiteboard/issues/1324)) ([48bfa89](https://github.com/kamiazya/whiteboard/commit/48bfa89cee28506801ab49aa8404c0154e9a5946))
* **web:** budget the wait on typed text like the ten waits around it ([#1261](https://github.com/kamiazya/whiteboard/issues/1261)) ([18c70c8](https://github.com/kamiazya/whiteboard/commit/18c70c8893c3282df9a2d4211a083a451a127eb8))
* **web:** close the body surface when the document under it changes ([#1155](https://github.com/kamiazya/whiteboard/issues/1155)) ([7678bf7](https://github.com/kamiazya/whiteboard/commit/7678bf7c86daa4346acd2cbd776689a6256ba157))
* **web:** daemon page passes threads to the spatial pane; annotation parity gains its feature-level guard ([#1318](https://github.com/kamiazya/whiteboard/issues/1318)) ([8f744d9](https://github.com/kamiazya/whiteboard/commit/8f744d9184f6fb996038ff2abb14f7b32cc17a42))
* **web:** declare destructive confirmation copy once, and stop it calling a note a canvas ([#1133](https://github.com/kamiazya/whiteboard/issues/1133)) ([62022f6](https://github.com/kamiazya/whiteboard/commit/62022f661130f0684571a35d6e27984816d7ec5a))
* **web:** declare the text editor's save key in the shortcut catalog ([#1123](https://github.com/kamiazya/whiteboard/issues/1123)) ([3c3b4ca](https://github.com/kamiazya/whiteboard/commit/3c3b4ca3ed8f15efedc5cf368b86017b639fcc03))
* **web:** disclose a move only on the workspace that was actually moved ([#1180](https://github.com/kamiazya/whiteboard/issues/1180)) ([102e032](https://github.com/kamiazya/whiteboard/commit/102e032e9631d3a080994862b0877e568180c05a))
* **web:** docs-snapshot fixtures follow the two seams they fell behind; regenerate docs/assets ([#1326](https://github.com/kamiazya/whiteboard/issues/1326)) ([5ec04e4](https://github.com/kamiazya/whiteboard/commit/5ec04e462c18de1cd1757010fd2326531233cd5d))
* **web:** empty-doc caret lands at the line start; link targets exclude the open document ([#985](https://github.com/kamiazya/whiteboard/issues/985)) ([da4e36a](https://github.com/kamiazya/whiteboard/commit/da4e36a4049d6eb52b773fb8e094dc288ffc06e0))
* **web:** flush the debounced write when the page goes away ([#1361](https://github.com/kamiazya/whiteboard/issues/1361)) ([ef5d089](https://github.com/kamiazya/whiteboard/commit/ef5d0897cd7685eefb2f09fd837dfa32d2995f94))
* **web:** give /settings a workspace source so the mark opens onto something ([#1148](https://github.com/kamiazya/whiteboard/issues/1148)) ([f946298](https://github.com/kamiazya/whiteboard/commit/f9462989ab73baaf9b521e4b5f2b4b04604fd3bb))
* **web:** give the daemon page the canvas settings gear the browser page has ([#1166](https://github.com/kamiazya/whiteboard/issues/1166)) ([5477bb1](https://github.com/kamiazya/whiteboard/commit/5477bb11144198b07811f27da2473242af78082a))
* **web:** give the LCP gate a bounded grace instead of a fixed bet ([#1179](https://github.com/kamiazya/whiteboard/issues/1179)) ([191051f](https://github.com/kamiazya/whiteboard/commit/191051f240cf5a263728c352cdfc986477c17e80))
* **web:** hydrate IndexedDB document-index rows through documentEntrySchema ([#1217](https://github.com/kamiazya/whiteboard/issues/1217)) ([e51b0f8](https://github.com/kamiazya/whiteboard/commit/e51b0f86b3f8e9c49267ce9ab6e5291dfc4fd2fa))
* **web:** keep a shaped node's silhouette on screen while its text is edited ([#1213](https://github.com/kamiazya/whiteboard/issues/1213)) ([00980cc](https://github.com/kamiazya/whiteboard/commit/00980cc4faeb289afdbb4b61fe8f455490fa9c4f))
* **web:** key a list row's picture by its content, not by the write's clock ([#1336](https://github.com/kamiazya/whiteboard/issues/1336)) ([0d74526](https://github.com/kamiazya/whiteboard/commit/0d745264264c62216349807a9df3039d7c2cdc29))
* **web:** let the hand tool pan from a link node's embed, found by a property ([#1158](https://github.com/kamiazya/whiteboard/issues/1158)) ([e09d594](https://github.com/kamiazya/whiteboard/commit/e09d5945c7a5d34e3a191f28efa704180098463b))
* **web:** make `spatial-editor-container` mean the same thing on both pages ([#1170](https://github.com/kamiazya/whiteboard/issues/1170)) ([05ac4e2](https://github.com/kamiazya/whiteboard/commit/05ac4e23a194992a02fb6ba83dcb21c487722936))
* **web:** make FoldingBrowserIndex.createWorkspace write both registry and tree ([#1218](https://github.com/kamiazya/whiteboard/issues/1218)) ([857d638](https://github.com/kamiazya/whiteboard/commit/857d6385dadaa782a8131da2dcc6540cb6200474))
* **web:** make the error screen's Reload able to change the bundle ([#1272](https://github.com/kamiazya/whiteboard/issues/1272)) ([6622622](https://github.com/kamiazya/whiteboard/commit/662262259a6a22b11b87a63bb9ad390715efcc4f))
* **web:** one identity for a document on every surface — the open document keys by its content digest too ([#1343](https://github.com/kamiazya/whiteboard/issues/1343)) ([a45db21](https://github.com/kamiazya/whiteboard/commit/a45db21a69b064695009988718aa4a291e8e3fe4))
* **web:** pan the canvas so a node being edited stays above the virtual keyboard ([#1225](https://github.com/kamiazya/whiteboard/issues/1225)) ([92da271](https://github.com/kamiazya/whiteboard/commit/92da271b8f78222feac47a4d99c12331824a50bf))
* **web:** pin shaped-node-editing test's font and fixture width ([#1323](https://github.com/kamiazya/whiteboard/issues/1323)) ([15282bd](https://github.com/kamiazya/whiteboard/commit/15282bd7bfcdd0c8db5a4d98713c70dcfb33f236))
* **web:** re-list workspaces when the selected one has been deleted ([#1081](https://github.com/kamiazya/whiteboard/issues/1081)) ([bf29835](https://github.com/kamiazya/whiteboard/commit/bf2983573eaac2e6a7c43344a59857fb4fe0fcf5))
* **web:** retire two silent browser/daemon divergences — legacy path refs resolve, version-refresh is identity-scoped ([#1358](https://github.com/kamiazya/whiteboard/issues/1358)) ([fd24080](https://github.com/kamiazya/whiteboard/commit/fd240806c61e2e7f200ec73dec70d1fced89668d))
* **web:** route comment EditorCommands through the fine-grained Loro write path ([#1233](https://github.com/kamiazya/whiteboard/issues/1233)) ([1191971](https://github.com/kamiazya/whiteboard/commit/11919713dca0efe1b916a39d3ef0d1f283257d70))
* **web:** run the startup fold before the promote dialog counts documents ([#1097](https://github.com/kamiazya/whiteboard/issues/1097)) ([57e55a6](https://github.com/kamiazya/whiteboard/commit/57e55a60176c026b4aca701577551958705a8353))
* **web:** say a document is unreadable instead of opening it empty ([#964](https://github.com/kamiazya/whiteboard/issues/964)) ([d83e740](https://github.com/kamiazya/whiteboard/commit/d83e7405adaab976786a9a153d96cc5462401a21))
* **web:** say so when a pin is refused instead of swallowing it ([#1011](https://github.com/kamiazya/whiteboard/issues/1011)) ([71aac46](https://github.com/kamiazya/whiteboard/commit/71aac46fc5fc246ddeaa53a55c761cf42681772a))
* **web:** stop a delete confirmed after a switch taking the document that arrived ([#1150](https://github.com/kamiazya/whiteboard/issues/1150)) ([85f39db](https://github.com/kamiazya/whiteboard/commit/85f39db1df9eeddbff2536db70c6eada5345d160))
* **web:** stop a dialog left open across a workspace switch writing into the wrong workspace ([#1140](https://github.com/kamiazya/whiteboard/issues/1140)) ([a209148](https://github.com/kamiazya/whiteboard/commit/a209148d9c1fdd6f93df93e6d7e9c88470a89adf))
* **web:** stop a failed duplicate reporting under the document that arrived ([#1152](https://github.com/kamiazya/whiteboard/issues/1152)) ([1848bfd](https://github.com/kamiazya/whiteboard/commit/1848bfd7d831fc35b9c54506537c9b1cec252f85))
* **web:** stop a keystroke during a document load being written into the document that left ([#1144](https://github.com/kamiazya/whiteboard/issues/1144)) ([74f61d3](https://github.com/kamiazya/whiteboard/commit/74f61d316ef825fe135dbd7bd08d6f2fa735a6e7))
* **web:** stop a previous gesture deciding whether the hand tool pans ([#1159](https://github.com/kamiazya/whiteboard/issues/1159)) ([cbe7832](https://github.com/kamiazya/whiteboard/commit/cbe78323566b2317877da52d94eaa4e20f643bc5))
* **web:** stop a read overtaking a name write the page has queued but not issued ([#1289](https://github.com/kamiazya/whiteboard/issues/1289)) ([a93e516](https://github.com/kamiazya/whiteboard/commit/a93e5166207c9ed884d612d3ea17dbc4f38acef8))
* **web:** stop a variation dialog left open across a document switch acting on the new document ([#1143](https://github.com/kamiazya/whiteboard/issues/1143)) ([d2b1470](https://github.com/kamiazya/whiteboard/commit/d2b14701698a2c0906bf2c22bb68991068eb7d28))
* **web:** stop BrowserLocalDocumentPage jsdom suites racing the lazy WorkspaceTopBar chunk ([#977](https://github.com/kamiazya/whiteboard/issues/977)) ([5d42a05](https://github.com/kamiazya/whiteboard/commit/5d42a05463f8f83e20e24eb8fedc919b47ec57e8))
* **web:** stop editor state outliving the nodes it names, found by a command-based model ([#1119](https://github.com/kamiazya/whiteboard/issues/1119)) ([5ceac72](https://github.com/kamiazya/whiteboard/commit/5ceac722d4cd0ad8f4d147a73f3ca5b432706ee3))
* **web:** stop reading the editor's own capture transfer as a capture loss ([#1172](https://github.com/kamiazya/whiteboard/issues/1172)) ([1548465](https://github.com/kamiazya/whiteboard/commit/1548465f0f6b02dc4515dad12935949140ba5606))
* **web:** stop the departed document's save report landing on the one on screen ([#1147](https://github.com/kamiazya/whiteboard/issues/1147)) ([913aa9e](https://github.com/kamiazya/whiteboard/commit/913aa9e9c14cf10c8dfb1006d4e2cfcebf7929de))
* **web:** stop the save indicator reporting "saved" over an unwritten edit ([#1131](https://github.com/kamiazya/whiteboard/issues/1131)) ([882cc8b](https://github.com/kamiazya/whiteboard/commit/882cc8bf7172a3fea6611113572986ae95c4c58d))
* **web:** stop the save indicator reporting "Saved" over unwritten markdown ([#1116](https://github.com/kamiazya/whiteboard/issues/1116)) ([bd54e4b](https://github.com/kamiazya/whiteboard/commit/bd54e4b8880f0dfe5e0cdabc4a734bb65f2ff5f1))
* **web:** stop the Storage tab calling a deleted route and rendering a category the daemon cannot report ([#1161](https://github.com/kamiazya/whiteboard/issues/1161)) ([63e416e](https://github.com/kamiazya/whiteboard/commit/63e416eaf5dc670f3420a9752b60b6cfc9024101))
* **web:** tell the truth about deleting, and name a note after its own title ([#1128](https://github.com/kamiazya/whiteboard/issues/1128)) ([13bcbc3](https://github.com/kamiazya/whiteboard/commit/13bcbc3f8c8d272e8c6053e1cf4137a292de367a))
* **web:** the browser keeper's version rows carry `auto` and the variation, and cap the checkpoints ([#1428](https://github.com/kamiazya/whiteboard/issues/1428)) ([d219071](https://github.com/kamiazya/whiteboard/commit/d219071b8a7adb203af127530dd6372433463c57))
* **web:** the card list follows a browser workspace switch ([#1351](https://github.com/kamiazya/whiteboard/issues/1351)) ([fce6e9f](https://github.com/kamiazya/whiteboard/commit/fce6e9f9681a853fe6e7699755010f97725a239b))
* **web:** the changed dot is a hue, not ink ([#1416](https://github.com/kamiazya/whiteboard/issues/1416)) ([ff42959](https://github.com/kamiazya/whiteboard/commit/ff4295971670023e645e2e4008360809bc21a880))
* **web:** the changed dot joins the badge blue the app already had ([#1432](https://github.com/kamiazya/whiteboard/issues/1432)) ([281d90a](https://github.com/kamiazya/whiteboard/commit/281d90a08df00366bacde3172a3d2be756783f69))
* **web:** the exit-fullscreen control moves to the one edge no camera reaches ([#1404](https://github.com/kamiazya/whiteboard/issues/1404)) ([20dfe35](https://github.com/kamiazya/whiteboard/commit/20dfe355df531dde8cf8910f37c0dba3391391a8))
* **web:** the exit-fullscreen control takes the corner where the width allows ([#1418](https://github.com/kamiazya/whiteboard/issues/1418)) ([10cc5f5](https://github.com/kamiazya/whiteboard/commit/10cc5f5c0fb10998a8cfcba30714419d6d6db829))
* **web:** the facet inspector takes its own column instead of covering the canvas ([#1045](https://github.com/kamiazya/whiteboard/issues/1045)) ([4680b47](https://github.com/kamiazya/whiteboard/commit/4680b47f24612c42d338cd5cf2cc6b9e6ec9b84f))
* **web:** the fake files source stops contradicting its own listing ([#1043](https://github.com/kamiazya/whiteboard/issues/1043)) ([2d4d9ba](https://github.com/kamiazya/whiteboard/commit/2d4d9baee9b8f2f63d1161f14786e15191bf0305))
* **web:** the legacy per-document read gets the same discrimination the workspace read got ([#1308](https://github.com/kamiazya/whiteboard/issues/1308)) ([f0acba1](https://github.com/kamiazya/whiteboard/commit/f0acba14b9a62646ca2c217a6b68c9c409b26194))
* **web:** the offline replica page resolves its own references ([#1430](https://github.com/kamiazya/whiteboard/issues/1430)) ([5eb2da1](https://github.com/kamiazya/whiteboard/commit/5eb2da11757c7781a5bfb89e2ca1e4237e1f240d))
* **web:** the thumbnail's render cross-fades in instead of cutting ([#1364](https://github.com/kamiazya/whiteboard/issues/1364)) ([77286fe](https://github.com/kamiazya/whiteboard/commit/77286fe1f5fafec40db64786161905a3159c90c7))
* **web:** the WebMCP toggle claims exactly what the tool returns ([#1411](https://github.com/kamiazya/whiteboard/issues/1411)) ([68c7dec](https://github.com/kamiazya/whiteboard/commit/68c7decc06536d04a624045d3244f49ea83aa6bd))
* **web:** titleFromMarkdownBody strips every trailing marker run, making derivation idempotent ([#1366](https://github.com/kamiazya/whiteboard/issues/1366)) ([1a96a41](https://github.com/kamiazya/whiteboard/commit/1a96a413f384be44c4b02000eb8411fe2be882fe))
* **web:** use-keyboard-avoidance tests run in jsdom again — main was red ([#1386](https://github.com/kamiazya/whiteboard/issues/1386)) ([cb13a65](https://github.com/kamiazya/whiteboard/commit/cb13a657c854cb2383027747a71e4319978f540d))
* **workspace-index:** read a record's snapshot and log as one consistent read ([#1339](https://github.com/kamiazya/whiteboard/issues/1339)) ([fd0dd28](https://github.com/kamiazya/whiteboard/commit/fd0dd28bd75597c427355158eeadecf7d92b842b))


### Performance Improvements

* **canvas-render:** allocation-free segment test and in-place trial cost sums (−11–17% layout time) ([#992](https://github.com/kamiazya/whiteboard/issues/992)) ([874ec71](https://github.com/kamiazya/whiteboard/commit/874ec7171a4131ded4029616dfef726504092ed5))
* **canvas-render:** cut side-choice search time 24-32% by removing work it repeated per trial ([#984](https://github.com/kamiazya/whiteboard/issues/984)) ([5a64050](https://github.com/kamiazya/whiteboard/commit/5a64050211ccdddc1cf2a16d99b3f723f5947cd8))
* **canvas-render:** grid route search buckets obstacles per line and uses dense tables (−8% on clustered canvases) ([#994](https://github.com/kamiazya/whiteboard/issues/994)) ([b8960b4](https://github.com/kamiazya/whiteboard/commit/b8960b407b71c55d6785ccb6b774d1c21be1d548))
* **canvas-render:** prune the obstacle set to what a route can actually reach ([#1005](https://github.com/kamiazya/whiteboard/issues/1005)) ([379178e](https://github.com/kamiazya/whiteboard/commit/379178e88c2ec76cee5915b19e906c874b7407af))
* **canvas-render:** search the route grid with A*, and pin its optimality against an independent Dijkstra ([#1003](https://github.com/kamiazya/whiteboard/issues/1003)) ([3dd7423](https://github.com/kamiazya/whiteboard/commit/3dd74238865f0b9a690355f3cddcc03efbb0b958))
* **canvas-render:** share one routed-path cache across a region's two search runs ([#1001](https://github.com/kamiazya/whiteboard/issues/1001)) ([fe3c650](https://github.com/kamiazya/whiteboard/commit/fe3c65034ea2631bf4be818b60515b5be094dff2))
* **canvas-render:** take the two CPU costs decision [#10](https://github.com/kamiazya/whiteboard/issues/10) named, after re-measuring which they are ([#1000](https://github.com/kamiazya/whiteboard/issues/1000)) ([1e6bb8f](https://github.com/kamiazya/whiteboard/commit/1e6bb8f7cbd3974c7e9a6dbc07ab6a2f6f4418e2))
* **ci:** let a version bump skip the image build it cannot affect ([#1452](https://github.com/kamiazya/whiteboard/issues/1452)) ([647d68e](https://github.com/kamiazya/whiteboard/commit/647d68e32903a61fd29b1c2a0a89563424c8f9b2))
* **test:** stop a browser run writing 23GB of trace scratch ([#1266](https://github.com/kamiazya/whiteboard/issues/1266)) ([c37efac](https://github.com/kamiazya/whiteboard/commit/c37efac7db4b797c6765377212aae567c825d680))
* **web:** apply react-best-practices audit fixes across seven hot paths ([#1295](https://github.com/kamiazya/whiteboard/issues/1295)) ([31a4388](https://github.com/kamiazya/whiteboard/commit/31a43889d5d5d9866c46fe73d2708cc39325b2be))
* **web:** hand the worker a snapshot instead of a canvas it can decode itself ([#1275](https://github.com/kamiazya/whiteboard/issues/1275)) ([b52e20c](https://github.com/kamiazya/whiteboard/commit/b52e20ca38f4ac7b5c2b4ddf38b204f642cd6669))
* **web:** run DOM-free jsdom tests in a node environment, and record the vitest features measured against this repo ([#1360](https://github.com/kamiazya/whiteboard/issues/1360)) ([5aa74fd](https://github.com/kamiazya/whiteboard/commit/5aa74fd188f9fa1c72eff34f10f3362e22d3222f))


### Code Refactoring

* **web:** drop Copy link — a keeper that cannot be reached cannot be linked to ([#1034](https://github.com/kamiazya/whiteboard/issues/1034)) ([0d669f4](https://github.com/kamiazya/whiteboard/commit/0d669f4d79e3ac00f33b3e702b61e15a8fdf6cc6))
* **web:** facet UI rides contribution points — plugins get a displayName, core surfaces stop naming domains ([#990](https://github.com/kamiazya/whiteboard/issues/990)) ([ef73229](https://github.com/kamiazya/whiteboard/commit/ef73229b0f28cbbb253b325273af851932d6e375))

## [0.0.19](https://github.com/kamiazya/whiteboard/compare/whiteboard-plugin-v0.0.18...whiteboard-plugin-v0.0.19) (2026-07-17)


### Bug Fixes

* **release:** keep npm pack --json parseable when prepack prints its gate message ([#254](https://github.com/kamiazya/whiteboard/issues/254)) ([3513039](https://github.com/kamiazya/whiteboard/commit/35130395a66a35c399c65e72468908f8d1733829))

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
