import type {
  ApplyRowsInput,
  ListBacklinksInput,
  ListBacklinksResult,
  ListCanvasesInput,
  ListCanvasesResult,
  QueryFacetInput,
  QueryFacetResult,
  ResolveAliasHistoryInput,
  ResolveAliasInput,
  ResolveAliasResult,
  WorkspaceIndex,
} from '@kamiazya/whiteboard-canvas-ports'
import type { Kysely } from 'kysely'
import { getLogger } from '../../log.js'
import type { DatabaseSchema } from '../db/schema.js'

const log = getLogger('libsql-workspace-index')

type Db = Kysely<DatabaseSchema>

/** All five WorkspaceIndex-backing tables, used by the delete sweep in applyRows. */
const WORKSPACE_INDEX_TABLES = [
  'workspaceIndexCanvasList',
  'workspaceIndexFacets',
  'workspaceIndexAliases',
  'workspaceIndexBacklinks',
  'workspaceIndexAliasHistory',
] as const

/**
 * libSQL-backed `WorkspaceIndex`. `applyRows` is a full delete-then-insert
 * replace of all five tables for the given `workspaceId`, run inside a
 * single Kysely transaction — matching InMemoryWorkspaceIndex, whose
 * `applyRows` overwrites the entire per-workspace record rather than
 * incrementally patching it.
 *
 * Every row carries a `seq` column recording its position within the array
 * `applyRows` received for that table, and every read method orders by
 * `seq asc`. InMemoryWorkspaceIndex answers reads with `.find()`/`.filter()`
 * over the stored arrays, which preserves that same insertion order — `seq`
 * is what keeps this SQL-backed implementation observationally identical to
 * it (see the parity test).
 */
export class LibsqlWorkspaceIndex implements WorkspaceIndex {
  constructor(private readonly db: Db) {}

  async applyRows(input: ApplyRowsInput): Promise<void> {
    const { workspaceId, canvasList, facets, aliases, backlinks, aliasHistory } = input

    await this.db.transaction().execute(async (trx) => {
      for (const table of WORKSPACE_INDEX_TABLES) {
        await trx.deleteFrom(table).where('workspaceId', '=', workspaceId).execute()
      }

      if (canvasList.length > 0) {
        await trx
          .insertInto('workspaceIndexCanvasList')
          .values(
            canvasList.map((row, seq) => ({
              workspaceId,
              seq,
              canvasId: row.canvasId,
              title: row.title,
              updatedAtMs: row.updatedAtMs,
            })),
          )
          .execute()
      }

      if (facets.length > 0) {
        await trx
          .insertInto('workspaceIndexFacets')
          .values(
            facets.map((row, seq) => ({
              workspaceId,
              seq,
              facet: row.facet,
              value: row.value,
              canvasId: row.canvasId,
            })),
          )
          .execute()
      }

      if (aliases.length > 0) {
        await trx
          .insertInto('workspaceIndexAliases')
          .values(
            aliases.map((row, seq) => ({
              workspaceId,
              seq,
              alias: row.alias,
              canvasId: row.canvasId,
            })),
          )
          .execute()
      }

      if (backlinks.length > 0) {
        await trx
          .insertInto('workspaceIndexBacklinks')
          .values(
            backlinks.map((row, seq) => ({
              workspaceId,
              seq,
              fromCanvasId: row.fromCanvasId,
              toCanvasId: row.toCanvasId,
            })),
          )
          .execute()
      }

      if (aliasHistory.length > 0) {
        await trx
          .insertInto('workspaceIndexAliasHistory')
          .values(
            aliasHistory.map((row, seq) => ({
              workspaceId,
              seq,
              alias: row.alias,
              canvasId: row.canvasId,
              retiredAtMs: row.retiredAtMs,
            })),
          )
          .execute()
      }
    })

    log.debug(
      {
        workspaceId,
        canvasCount: canvasList.length,
        facetCount: facets.length,
        aliasCount: aliases.length,
        backlinkCount: backlinks.length,
        aliasHistoryCount: aliasHistory.length,
      },
      'replaced workspace index rows',
    )
  }

  async resolveAlias(input: ResolveAliasInput): Promise<ResolveAliasResult> {
    return this.findAliasByTable('workspaceIndexAliases', input.workspaceId, input.alias)
  }

  async resolveAliasHistory(input: ResolveAliasHistoryInput): Promise<ResolveAliasResult> {
    return this.findAliasByTable('workspaceIndexAliasHistory', input.workspaceId, input.alias)
  }

  private async findAliasByTable(
    table: 'workspaceIndexAliases' | 'workspaceIndexAliasHistory',
    workspaceId: string,
    alias: string,
  ): Promise<ResolveAliasResult> {
    const row = await this.db
      .selectFrom(table)
      .select('canvasId')
      .where('workspaceId', '=', workspaceId)
      .where('alias', '=', alias)
      .orderBy('seq', 'asc')
      .executeTakeFirst()
    return row ? { canvasId: row.canvasId } : null
  }

  async listCanvases(input: ListCanvasesInput): Promise<ListCanvasesResult> {
    let query = this.db
      .selectFrom('workspaceIndexCanvasList')
      .select(['canvasId', 'title', 'updatedAtMs'])
      .where('workspaceId', '=', input.workspaceId)
      .orderBy('seq', 'asc')

    // SQLite's grammar requires LIMIT whenever OFFSET is present. `-1` is
    // SQLite's own "no limit" sentinel, so an explicit `limit` still wins
    // when both are given.
    if (input.offset !== undefined) {
      query = query.limit(input.limit ?? -1).offset(input.offset)
    } else if (input.limit !== undefined) {
      query = query.limit(input.limit)
    }

    const rows = await query.execute()
    return { rows }
  }

  async queryFacet(input: QueryFacetInput): Promise<QueryFacetResult> {
    const rows = await this.db
      .selectFrom('workspaceIndexFacets')
      .select('canvasId')
      .where('workspaceId', '=', input.workspaceId)
      .where('facet', '=', input.facet)
      .where('value', '=', input.value)
      .orderBy('seq', 'asc')
      .execute()
    return { canvasIds: rows.map((row) => row.canvasId) }
  }

  async listBacklinks(input: ListBacklinksInput): Promise<ListBacklinksResult> {
    const rows = await this.db
      .selectFrom('workspaceIndexBacklinks')
      .select(['fromCanvasId', 'toCanvasId'])
      .where('workspaceId', '=', input.workspaceId)
      .where('toCanvasId', '=', input.toCanvasId)
      .orderBy('seq', 'asc')
      .execute()
    return { rows }
  }
}
