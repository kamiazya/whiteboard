import { Hono } from 'hono'
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
  validateSessionId,
  validateUserLibraryName,
} from '../validators.js'
import { registerWorkspaceAlias } from './workspace-alias.js'

function countLibraryItems(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('content must be an object')
  }
  if ((payload as { type?: string }).type !== 'excalidrawlib') {
    throw new Error('content must be an .excalidrawlib payload')
  }
  const parsed = payload as { library?: unknown; libraryItems?: unknown }
  if (parsed.libraryItems !== undefined) {
    if (!Array.isArray(parsed.libraryItems)) {
      throw new Error('content.libraryItems must be an array')
    }
    return parsed.libraryItems.length
  }
  if (parsed.library !== undefined) {
    if (!Array.isArray(parsed.library)) {
      throw new Error('content.library must be an array')
    }
    return parsed.library.length
  }
  throw new Error('content must include libraryItems[] or library[]')
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isRecordOfNumbers(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'number' && Number.isFinite(item))
  )
}

function isRecordOfStrings(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  )
}

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

  registerWorkspaceAlias(app, 'get', '/api/sessions/:sessionId/libraries', async (c) => {
    const { sessionId } = c.req.param()
    try {
      validateSessionId(sessionId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    try {
      const libs = await loadInstalledLibraries(sessionId)
      return c.json(libs)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  registerWorkspaceAlias(app, 'post', '/api/sessions/:sessionId/libraries', async (c) => {
    const { sessionId } = c.req.param()
    try {
      validateSessionId(sessionId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const body = await c.req.json<{ url?: string }>().catch(() => ({}) as { url?: string })
    if (!body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url (string) is required' }, 400)
    }
    try {
      await validateExternalUrl(body.url)
    } catch (err) {
      const issue = validationErrorBody(err)
      if (issue) return c.json(issue, 400)
      throw err
    }
    try {
      const libs = await addInstalledLibrary(sessionId, body.url)
      return c.json(libs)
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  registerWorkspaceAlias(app, 'delete', '/api/sessions/:sessionId/libraries', async (c) => {
    const { sessionId } = c.req.param()
    try {
      validateSessionId(sessionId)
    } catch (err) {
      const body = validationErrorBody(err)
      if (body) return c.json(body, 400)
      throw err
    }
    const body = await c.req.json<{ url?: string }>().catch(() => ({}) as { url?: string })
    if (!body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url (string) is required' }, 400)
    }
    try {
      const libs = await removeInstalledLibrary(sessionId, body.url)
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
      return c.json({ libraries })
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
    const body = await c.req
      .json<{
        revision?: unknown
        aliases?: unknown
        notes?: unknown
        scales?: unknown
      }>()
      .catch(() => null)
    if (body === null) {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }
    if (typeof body.revision !== 'number' || !Number.isInteger(body.revision) || body.revision < 0) {
      return c.json(
        { error: 'invalid_body', message: 'revision must be a non-negative integer' },
        400,
      )
    }
    if (
      body.aliases === undefined &&
      body.notes === undefined &&
      body.scales === undefined
    ) {
      return c.json(
        { error: 'invalid_body', message: 'at least one of aliases, notes, or scales is required' },
        400,
      )
    }
    if (body.aliases !== undefined && !isRecordOfNumbers(body.aliases)) {
      return c.json({ error: 'invalid_body', message: 'aliases must be a record of numbers' }, 400)
    }
    if (body.notes !== undefined && !isRecordOfStrings(body.notes)) {
      return c.json({ error: 'invalid_body', message: 'notes must be a record of strings' }, 400)
    }
    if (body.scales !== undefined && !isRecordOfNumbers(body.scales)) {
      return c.json({ error: 'invalid_body', message: 'scales must be a record of numbers' }, 400)
    }
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
    const body = await c.req
      .json<{
        revision?: unknown
        aliasKeys?: unknown
        noteKeys?: unknown
        scaleKeys?: unknown
      }>()
      .catch(() => null)
    if (body === null) {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }
    if (typeof body.revision !== 'number' || !Number.isInteger(body.revision) || body.revision < 0) {
      return c.json(
        { error: 'invalid_body', message: 'revision must be a non-negative integer' },
        400,
      )
    }
    if (
      body.aliasKeys === undefined &&
      body.noteKeys === undefined &&
      body.scaleKeys === undefined
    ) {
      return c.json(
        { error: 'invalid_body', message: 'at least one of aliasKeys, noteKeys, or scaleKeys is required' },
        400,
      )
    }
    if (body.aliasKeys !== undefined && !isStringArray(body.aliasKeys)) {
      return c.json({ error: 'invalid_body', message: 'aliasKeys must be a string array' }, 400)
    }
    if (body.noteKeys !== undefined && !isStringArray(body.noteKeys)) {
      return c.json({ error: 'invalid_body', message: 'noteKeys must be a string array' }, 400)
    }
    if (body.scaleKeys !== undefined && !isStringArray(body.scaleKeys)) {
      return c.json({ error: 'invalid_body', message: 'scaleKeys must be a string array' }, 400)
    }
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
    const body = await c.req
      .json<{ content?: unknown }>()
      .catch(() => null)
    if (body === null) {
      return c.json({ error: 'invalid_body', message: 'JSON body required' }, 400)
    }
    if (body.content === undefined) {
      return c.json({ error: 'invalid_body', message: 'content is required' }, 400)
    }
    try {
      const itemCount = countLibraryItems(body.content)
      try {
        await saveUserLibrary(name, body.content)
      } catch (err) {
        const issue = handleCorruptStoredData(err)
        if (issue) return c.json(issue.body, issue.status)
        throw err
      }
      return c.json({ name, itemCount })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid content'
      return c.json({ error: 'invalid_body', message }, 400)
    }
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
      return c.json({ removed: name, remaining: libraries.map((library) => library.name) })
    } catch (err) {
      const issue = handleCorruptStoredData(err)
      if (issue) return c.json(issue.body, issue.status)
      throw err
    }
  })

  return app
}
