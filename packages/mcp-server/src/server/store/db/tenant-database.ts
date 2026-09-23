import {
  AliasNode,
  BinaryOperationNode,
  ColumnNode,
  type DeleteQueryNode,
  IdentifierNode,
  InsertQueryNode,
  JoinNode,
  type KyselyPlugin,
  OnConflictNode,
  type OperationNode,
  OperationNodeTransformer,
  OperatorNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  PrimitiveValueListNode,
  QueryNode,
  type QueryResult,
  RawNode,
  ReferenceNode,
  type RootOperationNode,
  type SelectQueryNode,
  TableNode,
  type Transaction,
  type UnknownRow,
  type UpdateQueryNode,
  ValueListNode,
  ValueNode,
  ValuesNode,
} from 'kysely'
import type { Database } from './index.js'
import type { DatabaseSchema } from './schema.js'
import { isTenantScoped } from './tenant-scope.js'

declare const tenantBound: unique symbol

/**
 * A database handle that can only see one tenant. Every read, update and
 * delete of a tenant-scoped table is filtered to the tenant, and every insert
 * into one is stamped with it; a statement the handle cannot scope is refused
 * rather than run unscoped. Keeper-wide tables pass through untouched.
 *
 * The brand is what makes this structure rather than convention: a store
 * whose constructor asks for a `TenantDatabase` cannot be handed the raw one.
 */
export type TenantDatabase = Database & { readonly [tenantBound]: string }

export function tenantDatabase(db: Database, tenantId: string): TenantDatabase {
  return db.withPlugin(new TenantScopePlugin(tenantId)) as TenantDatabase
}

/** A transaction opened on a tenant-bound handle; the plugin carries into it. */
export type TenantTransaction = Transaction<DatabaseSchema> & { readonly [tenantBound]: string }

/** Either tenant-bound shape: what a store helper that may run inside a transaction takes. */
export type TenantScoped = TenantDatabase | TenantTransaction

/**
 * `db.transaction().execute` with the brand kept: Kysely hands the callback a
 * plain `Transaction`, which a store helper typed `TenantScoped` refuses, so
 * this is the one way to open a transaction a store can use.
 *
 * Already inside one, it JOINS it rather than opening another (Kysely refuses
 * a nested `transaction()`), so a store method that is atomic on its own is
 * also atomic as one step of a caller's larger transaction.
 */
export function inTenantTransaction<T>(
  db: TenantScoped,
  fn: (trx: TenantTransaction) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) return fn(db as TenantTransaction)
  return db.transaction().execute((trx) => fn(trx as TenantTransaction))
}

class TenantScopePlugin implements KyselyPlugin {
  readonly #transformer: TenantScopeTransformer

  constructor(tenantId: string) {
    this.#transformer = new TenantScopeTransformer(tenantId)
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    // `sql\`...\`.execute(db)` arrives here as one RawNode: text, with no
    // tree to add a filter to. A raw FRAGMENT inside a builder is not the root
    // and is scoped with the query around it.
    if (RawNode.is(args.node)) throw refusal('a raw statement, which it cannot scope')
    return this.#transformer.transformNode(args.node)
  }

  // The column is the handle's business: a `selectAll` above it must read the
  // same row shape the schema type declares, which has no tenantId.
  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const rows = args.result.rows
    if (rows.length === 0 || !('tenantId' in (rows[0] as object))) return args.result
    return {
      ...args.result,
      rows: rows.map(({ tenantId: _tenantId, ...row }) => row),
    }
  }
}

/** The table a FROM/JOIN item names, and the name a condition must qualify it by. */
function scopedTable(node: OperationNode): { table: string; qualifier: string } | null {
  const inner = AliasNode.is(node) ? node.node : node
  if (!TableNode.is(inner)) return null
  const table = inner.table.identifier.name
  if (!isTenantScoped(table)) return null
  const qualifier = AliasNode.is(node) && IdentifierNode.is(node.alias) ? node.alias.name : table
  return { table, qualifier }
}

function refusal(what: string): Error {
  return new Error(`the tenant-bound handle refuses ${what}`)
}

class TenantScopeTransformer extends OperationNodeTransformer {
  readonly #tenantId: string

  constructor(tenantId: string) {
    super()
    this.#tenantId = tenantId
  }

  #belongs(qualifier: string): OperationNode {
    return BinaryOperationNode.create(
      ReferenceNode.create(ColumnNode.create('tenantId'), TableNode.create(qualifier)),
      OperatorNode.create('='),
      ValueNode.create(this.#tenantId),
    )
  }

  /** FROM items are filtered in WHERE; joins in their ON, so a left join stays one. */
  #scope<T extends SelectQueryNode | UpdateQueryNode | DeleteQueryNode>(
    node: T,
    froms: ReadonlyArray<OperationNode>,
  ): T {
    let scoped: T = node
    for (const from of froms) {
      const hit = scopedTable(from)
      if (hit) scoped = QueryNode.cloneWithWhere(scoped, this.#belongs(hit.qualifier))
    }
    if (scoped.joins) {
      const joins = scoped.joins.map((join) => {
        const hit = scopedTable(join.table)
        if (!hit) return join
        return join.on
          ? JoinNode.cloneWithOn(join, this.#belongs(hit.qualifier))
          : JoinNode.createWithOn(join.joinType, join.table, this.#belongs(hit.qualifier))
      })
      scoped = { ...scoped, joins }
    }
    return scoped
  }

  protected override transformSelectQuery(node: SelectQueryNode): SelectQueryNode {
    const inner = super.transformSelectQuery(node)
    return this.#scope(inner, inner.from?.froms ?? [])
  }

  protected override transformUpdateQuery(node: UpdateQueryNode): UpdateQueryNode {
    const inner = super.transformUpdateQuery(node)
    const target = inner.table ? scopedTable(inner.table) : null
    if (
      target &&
      inner.updates?.some((u) => ColumnNode.is(u.column) && u.column.column.name === 'tenantId')
    ) {
      throw refusal('an update that sets tenantId')
    }
    return this.#scope(inner, [...(inner.table ? [inner.table] : []), ...(inner.from?.froms ?? [])])
  }

  protected override transformDeleteQuery(node: DeleteQueryNode): DeleteQueryNode {
    const inner = super.transformDeleteQuery(node)
    return this.#scope(inner, [...inner.from.froms, ...(inner.using?.tables ?? [])])
  }

  protected override transformInsertQuery(node: InsertQueryNode): InsertQueryNode {
    const inner = super.transformInsertQuery(node)
    const target = inner.into ? scopedTable(inner.into) : null
    if (!target) return inner
    // SQLite resolves OR REPLACE by DELETING whichever row holds the key,
    // whoever's it is; no filter the handle adds can reach that delete.
    if (inner.replace || inner.orAction?.action === 'replace') {
      throw refusal(`an INSERT OR REPLACE into ${target.table}`)
    }
    if (inner.columns?.some((c) => c.column.name === 'tenantId')) {
      throw refusal('an insert that names tenantId itself')
    }
    if (!inner.values || !ValuesNode.is(inner.values)) {
      throw refusal(`an insert from a select into ${target.table}`)
    }
    const values = ValuesNode.create(
      inner.values.values.map((row) =>
        PrimitiveValueListNode.is(row)
          ? PrimitiveValueListNode.create([...row.values, this.#tenantId])
          : ValueListNode.create([...row.values, ValueNode.create(this.#tenantId)]),
      ),
    )
    // An upsert's UPDATE half must not land on a row another tenant holds
    // under the same key: it becomes a no-op there instead.
    const onConflict =
      inner.onConflict?.updates && !inner.onConflict.doNothing
        ? OnConflictNode.cloneWithUpdateWhere(inner.onConflict, this.#belongs(target.table))
        : inner.onConflict
    return InsertQueryNode.cloneWith(inner, {
      columns: [...(inner.columns ?? []), ColumnNode.create('tenantId')],
      values,
      ...(onConflict ? { onConflict } : {}),
    })
  }

  protected override transformMergeQuery(): never {
    throw refusal('a MERGE statement')
  }
}
