import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { serveStatic } from '@hono/node-server/serve-static'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR, DIST_APP_DIR } from './config.js'
import { definedProps } from './defined-props.js'
import { createCanvasRouter } from './routes/canvas.js'
import { createFilesRouter } from './routes/files.js'
import { createExportRouter, resolveExportRequest } from './routes/export.js'
import { createViewportRouter, resolveViewportRequest } from './routes/viewport.js'
import { createDebugRouter } from './routes/debug.js'
import { createStatusRouter } from './routes/status.js'
import { createLibrariesRouter } from './routes/libraries.js'
import { createRuntimeRouter, type RuntimeRouterOptions } from './routes/runtime.js'
import { createBranchesRouter } from './routes/branches.js'
import { createPaletteRouter } from './routes/palette.js'
import { createDaemonMutationAuthMiddleware } from './routes/auth.js'
import {
  broadcastLoroUpdate,
  sendHeadChanged,
  setResolveExportFn,
  setResolveViewportFn,
} from './routes/ws.js'
import { FileVersionStore } from './store/version-store.js'
import { getDoc, peekDoc } from './store/doc-cache.js'
import { canvasExists, saveCanvas } from './store/canvas-store.js'
import { reconcileElementsOnDoc } from '../shared/reconcile-elements.js'
import { quarantineLegacyVersionMeta } from './store/legacy-quarantine.js'
import { detectMergeBadges } from '../shared/merge-engine.js'
import {
  BranchNotFoundError,
  deleteBranch,
  loadCanvasBranches,
  setHead as setHeadPersist,
  updateBranchTip,
} from './store/branches-store.js'
import { LoroDoc, decodeFrontiers, encodeFrontiers } from 'loro-crdt'
import { corruptStoredData, isCorruptStoredDataError } from './store/corrupt-stored-data.js'
import { createExcalidrawMcpServer } from './mcp/index.js'
import {
  createMcpHttpAuthMiddleware,
  createMcpHttpOriginMiddleware,
} from './security/mcp-http.js'
import {
  buildMcpProtectedResourceMetadata,
  createLocalTokenMcpHttpAuthStrategy,
} from './security/mcp-auth.js'

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'unknown error'
}

function shouldLogMcpHttpDebug(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCP_HTTP_DEBUG === '1'
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setBaselineSecurityHeaders(headers: Headers): void {
  headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  headers.set('X-Frame-Options', 'DENY')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
}

function extractInitializeDebugPayload(parsedBody: unknown) {
  if (!isJsonObject(parsedBody) || parsedBody.method !== 'initialize') {
    return null
  }
  const params = isJsonObject(parsedBody.params) ? parsedBody.params : {}
  const capabilities = isJsonObject(params.capabilities) ? params.capabilities : {}
  const clientInfo = isJsonObject(params.clientInfo) ? params.clientInfo : {}
  return {
    requestId: parsedBody.id ?? null,
    protocolVersion: params.protocolVersion ?? null,
    clientInfo: {
      name: clientInfo.name ?? null,
      version: clientInfo.version ?? null,
    },
    capabilities,
  }
}

function decodeBranchTipOrThrow(
  sessionId: string,
  slug: string,
  branchName: string,
  tipFrontiersBase64: string,
) {
  try {
    return decodeFrontiers(new Uint8Array(Buffer.from(tipFrontiersBase64, 'base64')))
  } catch (error) {
    throw corruptStoredData(
      `${sessionId}/branches/${slug}.json#${branchName}.tipFrontiers`,
      `tipFrontiers could not be decoded (${errorMessage(error)})`,
    )
  }
}

function checkoutCloneOrThrow(
  doc: LoroDoc,
  target: ReturnType<typeof decodeFrontiers>,
  location: string,
  detail: string,
): LoroDoc {
  const clone = LoroDoc.fromSnapshot(doc.export({ mode: 'snapshot' }))
  try {
    clone.checkout(target)
  } catch (error) {
    throw corruptStoredData(location, `${detail} (${errorMessage(error)})`)
  }
  return clone
}

setResolveExportFn(resolveExportRequest)
setResolveViewportFn(resolveViewportRequest)

export function createApp(runtimeOptions: RuntimeRouterOptions) {
  const app = new Hono()
  const mcpAuth =
    runtimeOptions.mcpAuth ??
    createLocalTokenMcpHttpAuthStrategy(definedProps({ token: runtimeOptions.token }))

  // On startup, quarantine legacy version metadata that is missing frontiers by moving it
  // to `.legacy-bak`. Leaving it in place causes FileVersionStore.list to throw
  // corrupt_stored_data and blocks BranchTabs / VersionTimeline rendering.
  // Run this as fire-and-forget best effort so startup is not blocked.
  void quarantineLegacyVersionMeta(DATA_DIR).then((r) => {
    if (r.movedCount > 0) {
      console.info(
        `[legacy-quarantine] moved ${r.movedCount} legacy version meta to .legacy-bak across ${r.scannedSessions} session(s)`,
      )
    }
  })

  app.use('*', async (_c, next) => {
    runtimeOptions.touch()
    await next()
  })

  app.use('*', async (c, next) => {
    await next()
    setBaselineSecurityHeaders(c.res.headers)
  })

  app.use('/api/*', createDaemonMutationAuthMiddleware(runtimeOptions.token))

  app.get('/.well-known/oauth-protected-resource', (c) => {
    const metadata = buildMcpProtectedResourceMetadata(mcpAuth, c.req.url)
    if (!metadata) {
      return c.notFound()
    }
    return c.json(metadata)
  })

  app.get('/.well-known/oauth-protected-resource/mcp', (c) => {
    const metadata = buildMcpProtectedResourceMetadata(mcpAuth, c.req.url)
    if (!metadata) {
      return c.notFound()
    }
    return c.json(metadata)
  })

  // /mcp middleware:
  // - origin policy: allow only loopback host / loopback origin to prevent DNS rebinding
  // - auth: require the daemon token even on local HTTP, matching the /api/* trust boundary
  // - bodyLimit: prevent OOM from oversized JSON-RPC payloads; typical MCP requests are
  //   tens of KB, so 4 MiB leaves comfortable headroom
  app.use('/mcp', createMcpHttpOriginMiddleware())
  app.use('/mcp', createMcpHttpAuthMiddleware(mcpAuth))
  app.use(
    '/mcp',
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            jsonrpc: '2.0',
            error: { code: -32600, message: 'Request body too large (max 4 MiB)' },
            id: null,
          },
          413,
        ),
    }),
  )

  app.all('/mcp', async (c) => {
    const startedAt = Date.now()
    const debug = shouldLogMcpHttpDebug()
    let parsedBody: unknown = undefined
    if (
      c.req.method.toUpperCase() === 'POST' &&
      c.req.header('content-type')?.toLowerCase().includes('application/json')
    ) {
      try {
        parsedBody = await c.req.raw.clone().json()
      } catch {
        parsedBody = undefined
      }
    }
    if (debug) {
      const initializeDebug = extractInitializeDebugPayload(parsedBody)
      if (initializeDebug) {
        console.info('[mcp-http:init]', initializeDebug)
      }
    }
    // The MCP SDK throws 'Already connected' if a single Server is connected to
    // more than one transport, so build a fresh per-request server. The heavy
    // workspace-id file IO is memoized inside createExcalidrawMcpServer to keep
    // concurrent /mcp requests cheap and race-free.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    })
    let response: Response | undefined
    try {
      const constructStartedAt = debug ? Date.now() : 0
      const server = await createExcalidrawMcpServer()
      if (debug) {
        console.info('[mcp-http:construct]', {
          durationMs: Date.now() - constructStartedAt,
        })
      }
      await server.connect(transport)
      response = await transport.handleRequest(c.req.raw, { parsedBody })
      if (debug) {
        const body = isJsonObject(parsedBody) ? parsedBody : {}
        console.info('[mcp-http]', {
          httpMethod: c.req.method.toUpperCase(),
          path: c.req.path,
          jsonrpcMethod: body.method ?? null,
          requestId: body.id ?? null,
          status: response.status,
          durationMs: Date.now() - startedAt,
        })
      }
      return response
    } finally {
      // Skip transport.close() when the response is an SSE stream
      // (Content-Type: text/event-stream). For SSE the response body is a still
      // open ReadableStream and closing the transport here would cancel it
      // before the client receives any events. JSON-mode responses, by
      // contrast, are fully buffered before handleRequest resolves so close()
      // is safe and useful for cleanup.
      const isSseResponse = response?.headers
        .get('content-type')
        ?.toLowerCase()
        .includes('text/event-stream')
      if (isSseResponse) {
        if (debug) {
          console.info('[mcp-http:destruct-skipped]', {
            reason: 'sse-stream-active',
          })
        }
      } else {
        const destructStartedAt = debug ? Date.now() : 0
        try {
          await transport.close()
        } catch (error) {
          // Closing failures from a finished request should not leak into the
          // response path. Log only when MCP_HTTP_DEBUG=1 for visibility.
          if (debug) {
            console.info('[mcp-http:destruct-error]', {
              message: errorMessage(error),
            })
          }
        }
        if (debug) {
          console.info('[mcp-http:destruct]', {
            durationMs: Date.now() - destructStartedAt,
          })
        }
      }
    }
  })

  app.route(
    '/',
    createCanvasRouter({
      // Attach the current HEAD branch name to saved versions when available.
      getHeadBranch: async (sid, slug) => {
        try {
          const state = await loadCanvasBranches(sid, slug)
          return state.head
        } catch (error) {
          if (isCorruptStoredDataError(error)) {
            throw error
          }
          return null
        }
      },
    }),
  )
  app.route('/', createFilesRouter())
  app.route('/', createExportRouter())
  app.route('/', createViewportRouter())
  app.route('/', createDebugRouter(definedProps({ token: runtimeOptions.token })))
  app.route('/', createStatusRouter())
  app.route('/', createLibrariesRouter())
  app.route('/', createPaletteRouter())
  app.route('/', createRuntimeRouter(runtimeOptions))
  // Branches router: branch metadata plus checkout / broadcast integration.
  {
    const versionStore = new FileVersionStore()
    app.route(
      '/',
      createBranchesRouter({
        // Resolve fromVersionId to its saved frontiers (base64).
        resolveFromVersionFrontiers: (sid, vid) => versionStore.getFrontiersBase64(sid, vid),
        // Return the live document frontiers as base64 so the previous HEAD can keep
        // its current position before a branch switch.
        getCurrentFrontiers: async (sid, slug) => {
          const cached = peekDoc(sid, slug)
          if (!cached && !(await canvasExists(sid, slug))) {
            return null
          }
          const doc = cached ?? (await getDoc(sid, slug))
          const bytes = encodeFrontiers(doc.frontiers())
          return Buffer.from(bytes).toString('base64')
        },
        // Reconcile the live document to the new HEAD tipFrontiers, then commit, save, and broadcast.
        checkoutTo: async (sid, slug, tipFrontiersBase64) => {
          const doc = await getDoc(sid, slug)
          const targetFrontiers = decodeBranchTipOrThrow(
            sid,
            slug,
            'checkout-target',
            tipFrontiersBase64,
          )
          const clone = checkoutCloneOrThrow(
            doc,
            targetFrontiers,
            `${sid}/branches/${slug}.json#checkout-target.tipFrontiers`,
            'tipFrontiers could not be checked out against the live document',
          )
          const prevVV = doc.version()
          reconcileElementsOnDoc(doc, clone)
          doc.commit()
          await saveCanvas(sid, slug, doc, { overwrite: true })
          const update = doc.export({ mode: 'update', from: prevVV }) as Uint8Array
          if (update.byteLength > 0) {
            broadcastLoroUpdate(sid, slug, update)
          }
        },
        // Notify all peers when the HEAD switch is complete.
        notifyHeadChanged: (sid, slug, head) => sendHeadChanged(sid, slug, head),
        // Keep version metadata branchName values in sync during branch rename.
        renameInVersions: (sid, slug, oldName, newName) =>
          versionStore.renameBranchInVersions(sid, slug, oldName, newName),
        // Count the actual unmerged commits returned by DELETE /branches/:name.
        countVersionsOnBranch: async (sid, slug, branchName) => {
          const list = await versionStore.list(sid, slug)
          return list.filter((v) => (v.branchName ?? 'main') === branchName).length
        },
        // Merge source into target.
        // (1) clone the live snapshot
        // (2) build a preview checked out to the target tipFrontiers
        // (3) detect LWW edge cases with detectMergeBadges
        // (4) on commit, update target tipFrontiers to source and, if target is HEAD,
        //     reconcile the live doc to the preview and broadcast the change
        performMerge: async (sid, slug, { source, into, dryRun }) => {
          const state = await loadCanvasBranches(sid, slug)
          const sourceBranch = state.branches.find((b) => b.name === source)
          const intoBranch = state.branches.find((b) => b.name === into)
          if (!sourceBranch) {
            throw new BranchNotFoundError(`Branch "${source}" not found on ${sid}/${slug}`)
          }
          if (!intoBranch) {
            throw new BranchNotFoundError(`Branch "${into}" not found on ${sid}/${slug}`)
          }

          const sourceTip = sourceBranch.tipFrontiers
          const intoTip = intoBranch.tipFrontiers
          const liveDoc = await getDoc(sid, slug)

          const cloneAt = (branchName: string, tipBase64: string): LoroDoc => {
            if (tipBase64.length === 0) {
              return LoroDoc.fromSnapshot(liveDoc.export({ mode: 'snapshot' }))
            }
            const frontiers = decodeBranchTipOrThrow(sid, slug, branchName, tipBase64)
            return checkoutCloneOrThrow(
              liveDoc,
              frontiers,
              `${sid}/branches/${slug}.json#${branchName}.tipFrontiers`,
              `branch "${branchName}" tipFrontiers could not be checked out against the live document`,
            )
          }

          const targetDoc = cloneAt(into, intoTip ?? '')
          const sourceDoc = cloneAt(source, sourceTip ?? '')
          // Use sourceDoc as the preview representation. Building a fully merged preview
          // safely would require a snapshot containing the full op-log after combining
          // target and source frontiers. In practice, sourceDoc closely matches the merge
          // result for the current "source wins" flow, and detectMergeBadges only needs a
          // stable target/source/preview triple to surface LWW differences.
          const previewDoc = sourceDoc
          const badges = detectMergeBadges({
            target: targetDoc,
            source: sourceDoc,
            preview: previewDoc,
          })

          const countAlive = (doc: LoroDoc): number => {
            try {
              const list = doc.getMovableList('elements').toJSON() as Array<{
                isDeleted?: boolean
              }>
              return list.filter((e) => !e.isDeleted).length
            } catch {
              return 0
            }
          }
          const previewElementCount = countAlive(previewDoc)
          const targetElementCount = countAlive(targetDoc)
          const sourceElementCount = countAlive(sourceDoc)

          // Diff alive elements between target and preview so the UI can highlight
          // new / changed / conflict elements after commit.
          const aliveMap = (doc: LoroDoc): Map<string, Record<string, unknown>> => {
            try {
              const list = doc.getMovableList('elements').toJSON() as Array<
                Record<string, unknown> & { id?: unknown; isDeleted?: unknown }
              >
              const out = new Map<string, Record<string, unknown>>()
              for (const el of list) {
                if (el.isDeleted) continue
                if (typeof el.id !== 'string') continue
                out.set(el.id, el)
              }
              return out
            } catch {
              return new Map()
            }
          }
          const tMap = aliveMap(targetDoc)
          const pMap = aliveMap(previewDoc)
          const newElementIds: string[] = []
          const changedElementIds: string[] = []
          for (const [id, pEl] of pMap) {
            const tEl = tMap.get(id)
            if (!tEl) {
              newElementIds.push(id)
            } else if (JSON.stringify(pEl) !== JSON.stringify(tEl)) {
              changedElementIds.push(id)
            }
          }
          const conflictElementIds = Array.from(
            new Set(
              (badges as Array<Record<string, unknown>>)
                .map((b) => (typeof b.elementId === 'string' ? b.elementId : ''))
                .filter((v) => v.length > 0),
            ),
          )

          if (dryRun) {
            // For dry runs, return only alive elements so MergeDialog can render a
            // read-only Excalidraw preview without duplicating tombstoned elements.
            const previewElements = (() => {
              try {
                const list = previewDoc.getMovableList('elements').toJSON() as Array<{
                  isDeleted?: boolean
                }>
                return list.filter((e) => !e.isDeleted)
              } catch {
                return []
              }
            })()
            return {
              previewElementCount,
              targetElementCount,
              sourceElementCount,
              badges,
              committed: false,
              previewElements,
            }
          }

          // Capture a "before merge" version so the UI can offer undo by restoring it.
          // This is most useful when HEAD points at the target, but saving it uniformly
          // keeps the UI behavior consistent.
          let preMergeVersionId: string | undefined
          try {
            const beforeVersion = await versionStore.save(sid, slug, liveDoc, {
              auto: true,
              label: `before merge: ${source} → ${into}`,
              branchName: into,
              operator: {
                kind: 'system',
                peerId: liveDoc.peerIdStr,
                displayName: 'merge',
              },
            })
            preMergeVersionId = beforeVersion.id
          } catch (err) {
            // Snapshot failure should not block the merge itself.
            console.warn(
              `[merge] pre-merge snapshot failed for ${sid}/${slug}: ${(err as Error).message}`,
            )
          }

          // Commit by moving the target tipFrontiers to the source tip, unless the source
          // branch is still uninitialized.
          if (typeof sourceTip === 'string' && sourceTip.length > 0) {
            await updateBranchTip(sid, slug, into, sourceTip)
          }

          // If the target is HEAD, reconcile and broadcast the live doc. Otherwise only
          // rewrite the stored tip.
          const latest = await loadCanvasBranches(sid, slug)
          if (latest.head === into && sourceTip && sourceTip.length > 0) {
            const prevVV = liveDoc.version()
            reconcileElementsOnDoc(liveDoc, previewDoc)
            liveDoc.commit()
            await saveCanvas(sid, slug, liveDoc, { overwrite: true })
            const update = liveDoc.export({ mode: 'update', from: prevVV }) as Uint8Array
            if (update.byteLength > 0) {
              broadcastLoroUpdate(sid, slug, update)
            }
            sendHeadChanged(sid, slug, into)
          }

          // Post-merge cleanup:
          // 1) if HEAD still points at source, move it to target so the user sees the result
          // 2) delete the source branch unless it is main or the same as target
          // Cleanup failures only produce warnings; the merge still succeeds.
          let switchedHead: { from: string; to: string } | undefined
          let deletedSource: string | undefined
          try {
            const afterCommit = await loadCanvasBranches(sid, slug)
            if (afterCommit.head === source && source !== into) {
              await setHeadPersist(sid, slug, into)
              switchedHead = { from: source, to: into }
              sendHeadChanged(sid, slug, into)
              // Reconcile and broadcast the live doc to match the target preview.
              // This is already done when HEAD===target, but HEAD===source needs it here.
              const prevVV = liveDoc.version()
              reconcileElementsOnDoc(liveDoc, previewDoc)
              liveDoc.commit()
              await saveCanvas(sid, slug, liveDoc, { overwrite: true })
              const update = liveDoc.export({ mode: 'update', from: prevVV }) as Uint8Array
              if (update.byteLength > 0) {
                broadcastLoroUpdate(sid, slug, update)
              }
            }
          } catch (err) {
            console.warn(
              `[merge] post-merge head switch failed for ${sid}/${slug}: ${(err as Error).message}`,
            )
          }
          if (source !== 'main' && source !== into) {
            try {
              await deleteBranch(sid, slug, source)
              deletedSource = source
            } catch (err) {
              // For example: still HEAD, already deleted, and similar cleanup races.
              console.warn(
                `[merge] post-merge delete source failed for ${sid}/${slug}: ${(err as Error).message}`,
              )
            }
          }

          return {
            previewElementCount,
            targetElementCount,
            sourceElementCount,
            badges,
            committed: true,
            newElementIds,
            changedElementIds,
            conflictElementIds,
            ...definedProps({
              preMergeVersionId,
              switchedHead,
              deletedSource,
            }),
          }
        },
      }),
    )
  }

  app.use('/fonts/*', serveStatic({ root: DIST_APP_DIR }))
  app.use('/assets/*', serveStatic({ root: DIST_APP_DIR }))

  app.get('*', async (c) => {
    try {
      const html = await readFile(join(DIST_APP_DIR, 'index.html'), 'utf-8')
      // When inlining JSON into `<script>`, escape `<` so strings such as `</script>`
      // cannot terminate the tag. The current token is generated with nanoid and is not
      // dangerous, but this keeps runtime config safe if user-controlled values are added later.
      // Details: https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
      const runtimeConfigJson = JSON.stringify({
        daemonToken: runtimeOptions.token ?? null,
      }).replace(/</g, '\\u003c')
      const runtimeConfigScript = `<script>window.__WHITEBOARD_RUNTIME_CONFIG__ = ${runtimeConfigJson}</script>`
      const withRuntimeConfig = html.includes('</head>')
        ? html.replace('</head>', `${runtimeConfigScript}</head>`)
        : `${runtimeConfigScript}${html}`
      return c.html(withRuntimeConfig)
    } catch {
      return c.text('Not found. Run `pnpm build` first.', 404)
    }
  })

  return app
}
