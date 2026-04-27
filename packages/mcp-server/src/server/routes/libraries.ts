import { Hono } from 'hono'
import {
  type ListUserLibrariesResponse,
  type RemoveUserLibraryResponse,
  type SaveUserLibraryResponse,
  addInstalledLibraryRequestSchema,
  deleteUserLibraryMetadataRequestSchema,
  removeInstalledLibraryRequestSchema,
  saveUserLibraryRequestSchema,
  setUserLibraryMetadataRequestSchema,
  userLibraryContentSchema,
} from '../../shared/api-contracts/libraries.js'
import {
  loadInstalledLibraries,
  addInstalledLibrary,
  removeInstalledLibrary,
} from '../store/library-store.js'
import {
  listUserLibraries,
  loadUserLibrary,
  removeUserLibrary,
  saveUserLibrary,
} from '../store/user-library-store.js'
import {
  deleteUserLibraryMetadata,
  getUserLibraryMetadata,
  removeUserLibraryMetadata,
  setUserLibraryMetadata,
  UserLibraryMetadataConflictError,
} from '../store/user-library-metadata-store.js'
import { corruptStoredDataBody } from '../store/corrupt-stored-data.js'
import {
  validationErrorBody,
  validateExternalUrl,
  validateWorkspaceId,
  validateUserLibraryName,
} from '../validators.js'

// HTTP routes for session-scoped installed libraries (URL lists).
// CanvasPage fetches these on mount to restore the browser-side library panel.

export function createLibrariesRouter() {
  const app = new Hono()
  const handleCorruptStoredData = (
    err: unknown,
  ): { status: 500; body: { error: 'corrupt_stored_data'; message: string } } | null => {
    const body = corruptStoredDataBody(err)
    if (body) return { status: 500, body }
    return null
  }
  const handleConflict = (
    err: unknown,
  ): { status: 409; body: { error: 'conflict'; message: string } } | null => {
    if (err instanceof UserLibraryMetadataConflictError) {
      return { status: 409, body: { error: 'conflict', message: err.message } }
    }
    return null
  }

  app.get('/api/workspaces/:workspaceId/libraries', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const libs = await loadInstalledLibraries(workspaceId)
      return c.json(libs)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.post('/api/workspaces/:workspaceId/libraries', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const parsed = addInstalledLibraryRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    )
    if (!parsed.success) {
      return c.json({ error: 'url (string) is required' }, 400)
    }
    try {
      await validateExternalUrl(parsed.data.url)
    } catch (err) {
      const issue = validationErrorBody(err)
      if (issue) return c.json(issue, 400)
      throw err
    }
    try {
      const libs = await addInstalledLibrary(workspaceId, parsed.data.url)
      return c.json(libs)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.delete('/api/workspaces/:workspaceId/libraries', async (c) => {
    const { workspaceId } = c.req.param()
    try {
      validateWorkspaceId(workspaceId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const parsed = removeInstalledLibraryRequestSchema.safeParse(
      await c.req.json().catch(() => ({})),
    )
    if (!parsed.success) {
      return c.json({ error: 'url (string) is required' }, 400)
    }
    try {
      const libs = await removeInstalledLibrary(workspaceId, parsed.data.url)
      return c.json(libs)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.get('/api/user-libraries', async (c) => {
    try {
      const libraries = await listUserLibraries()
      const response: ListUserLibrariesResponse = { libraries }
      return c.json(response)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.get('/api/user-libraries/:name/metadata', async (c) => {
    const { name } = c.req.param()
    try {
      validateUserLibraryName(name)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      return c.json(await getUserLibraryMetadata(name))
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.post('/api/user-libraries/:name/metadata', async (c) => {
    const { name } = c.req.param()
    try {
      validateUserLibraryName(name)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const parsed = setUserLibraryMetadataRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ??
        'revision must be a non-negative integer; aliases / notes / scales must match record shape'
      return c.json({ error: 'invalid_body', message }, 400)
    }
    const body = parsed.data
    try {
      return c.json(
        await setUserLibraryMetadata(name, body.revision, {
          aliases: body.aliases,
          notes: body.notes,
          scales: body.scales,
        }),
      )
    } catch (err) {
      const conflict = handleConflict(err)
      if (conflict) return c.json(conflict.body, conflict.status)
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.delete('/api/user-libraries/:name/metadata', async (c) => {
    const { name } = c.req.param()
    try {
      validateUserLibraryName(name)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const parsed = deleteUserLibraryMetadataRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    )
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ??
        'revision must be a non-negative integer; aliasKeys / noteKeys / scaleKeys must be string arrays'
      return c.json({ error: 'invalid_body', message }, 400)
    }
    const body = parsed.data
    try {
      return c.json(
        await deleteUserLibraryMetadata(name, body.revision, {
          aliasKeys: body.aliasKeys,
          noteKeys: body.noteKeys,
          scaleKeys: body.scaleKeys,
        }),
      )
    } catch (err) {
      const conflict = handleConflict(err)
      if (conflict) return c.json(conflict.body, conflict.status)
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.get('/api/user-libraries/:name', async (c) => {
    const { name } = c.req.param()
    try {
      validateUserLibraryName(name)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const content = await loadUserLibrary(name)
      if (content === null) {
        return c.json({ error: 'not_found' }, 404)
      }
      return c.json(content)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  app.put('/api/user-libraries/:name', async (c) => {
    const { name } = c.req.param()
    try {
      validateUserLibraryName(name)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const raw = await c.req.json().catch(() => null)
    if (raw === null || typeof raw !== 'object') {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }
    if ((raw as { content?: unknown }).content === undefined) {
      return c.json({ error: 'invalid_body', message: 'content is required' }, 400)
    }
    const parsed = saveUserLibraryRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', message: 'content is required' }, 400)
    }
    const contentParsed = userLibraryContentSchema.safeParse(parsed.data.content)
    if (!contentParsed.success) {
      return c.json(
        { error: 'invalid_body', message: 'content must be an .excalidrawlib payload' },
        400,
      )
    }
    const { libraryItems, library } = contentParsed.data
    if (libraryItems === undefined && library === undefined) {
      return c.json(
        { error: 'invalid_body', message: 'content must include libraryItems[] or library[]' },
        400,
      )
    }
    const itemCount = libraryItems?.length ?? library?.length ?? 0
    try {
      await saveUserLibrary(name, parsed.data.content)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
    const response: SaveUserLibraryResponse = { name, itemCount }
    return c.json(response)
  })

  app.delete('/api/user-libraries/:name', async (c) => {
    const { name } = c.req.param()
    try {
      validateUserLibraryName(name)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      await removeUserLibrary(name)
      await removeUserLibraryMetadata(name)
      const libraries = await listUserLibraries()
      const response: RemoveUserLibraryResponse = {
        removed: name,
        remaining: libraries.map((library) => library.name),
      }
      return c.json(response)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  return app
}
