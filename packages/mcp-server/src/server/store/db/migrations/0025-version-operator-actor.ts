import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// A version row's operator identifier becomes an OKF §7 actor — the same
// vocabulary the trust family's `generated.by` uses — so provenance and
// history name a party one way instead of two (ADR-0035).
//
// The stored VALUES do not survive, and that is the point. `operatorPeerId`
// held whatever its call site had to hand: a Loro peer id (a fresh random
// number on every load of the same document), a per-process nanoid, or the
// literal `browser`. None is an actor, and carrying them across would put a
// value under a field documented as one that it is not. Nothing ever read
// the column, so nothing loses an answer it was using.
//
// The emptiness of the old column also carried a SECOND meaning — "this row
// records no operator", which is what `rowToEntry` tested — and the actor is
// optional now, so that meaning moves onto the kind before the rename takes
// the column it lived in.
export const migration: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await sql`update versions set operatorKind = '' where operatorPeerId = ''`.execute(db)
    await sql`alter table versions rename column operatorPeerId to operatorActor`.execute(db)
    await sql`update versions set operatorActor = ''`.execute(db)
  },
}
