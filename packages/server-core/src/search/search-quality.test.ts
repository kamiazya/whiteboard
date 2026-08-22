// The search quality scoreboard: what stage-0 lexical retrieval actually
// answers on a judged corpus, pinned EXACTLY so an improvement is as loud
// as a regression (same discipline as edge-routing-quality.test.ts).
//
// Its reason to exist is a decision, not a guard. The research report that
// scheduled search deferred stage 2 (embeddings, ~120MB first download)
// with one open question: how far does stage 0 get on its own? Argument
// cannot answer that; this file can.
//
// THE DECISION RULE, stated so a later reader is not left inferring it:
//   - `lexical` and `bigram` are what stage 0 is FOR. Anything below full
//     recall there is a defect in tokenisation or scoring — fix stage 0,
//     do not reach for a model.
//   - `paraphrase` and `cross-lingual` are the DEBT figure. They are
//     structurally out of lexical reach, and the research measured an
//     embedding model answering exactly them (a Japanese query ranked a
//     relevant English passage above an irrelevant Japanese one).
//   - Stage 2 is justified when that debt is BOTH large in this table and
//     confirmed to matter in real usage — the reference-density style of
//     evidence, not a hunch. If the debt is small, the 120MB is not worth
//     paying and stage 0 is the whole feature.
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import { beforeAll, describe, expect, it } from 'vitest'
import { createInMemoryDocumentStore } from '../test-utils/in-memory-document-store.js'
import { createCanvasEditTool } from '../tools/canvas-edit.js'
import { wbDocumentCreate } from '../tools/document-crud.js'
import { createDocumentSearchTool } from '../tools/document-search.js'
import { createDocumentSetTool } from '../tools/document-set.js'
import { CORPUS_DOCUMENTS, JUDGED_QUERIES, type QueryCategory } from './search-corpus.js'

const WS = 'quality'
const K = 5

type Deps = {
  documentStore: ReturnType<typeof createInMemoryDocumentStore>
  blobStore: never
  documentIndex: InMemoryDocumentIndex
}

let deps: Deps
let search: ReturnType<typeof createDocumentSearchTool>

beforeAll(async () => {
  deps = {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {} as never,
    documentIndex: new InMemoryDocumentIndex(),
  }
  const set = createDocumentSetTool(deps)
  const edit = createCanvasEditTool(deps)
  for (const doc of CORPUS_DOCUMENTS) {
    const created = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: doc.path,
      kind: doc.kind,
      name: doc.name,
      createWorkspace: true,
    })
    if (doc.kind === 'markdown') {
      const frontmatter =
        doc.tags === undefined
          ? 'type: note'
          : `type: note\ntags:\n${doc.tags.map((t) => `  - ${t}`).join('\n')}`
      await set.execute({
        workspaceId: WS,
        documentId: created.documentId,
        markdown: `---\n${frontmatter}\n---\n${doc.body ?? ''}`,
      })
      continue
    }
    await edit.execute({
      workspaceId: WS,
      documentId: created.documentId,
      ops: [
        ...(doc.nodes ?? []).map((n) => ({
          op: 'node.add' as const,
          node: { id: n.id, type: 'text' as const, text: n.text },
        })),
        ...(doc.groups ?? []).map((g) => ({
          op: 'node.add' as const,
          node: { id: g.id, type: 'group' as const, label: g.label },
        })),
        ...(doc.edges ?? []).map((e) => ({
          op: 'edge.add' as const,
          edge: { id: e.id, fromNode: e.from, toNode: e.to, label: e.label },
        })),
      ],
    })
  }
  search = createDocumentSearchTool(deps)
})

async function rankedPaths(query: string): Promise<string[]> {
  const out = await search.execute({ workspaceId: WS, query, limit: K })
  return out.results.map((r) => r.path)
}

describe('search corpus', () => {
  it('is non-degenerate: every judged document exists and no query is answerable by its own title alone', async () => {
    const paths = new Set(CORPUS_DOCUMENTS.map((d) => d.path))
    for (const judged of JUDGED_QUERIES) {
      expect(judged.relevant.length, judged.query).toBeGreaterThan(0)
      for (const path of judged.relevant) expect(paths, judged.query).toContain(path)
      // A query that is literally a document's name would measure nothing —
      // the name is part of the indexed text, so it would always hit.
      for (const doc of CORPUS_DOCUMENTS) {
        expect(judged.query, `${judged.query} is a bare title`).not.toBe(doc.name)
      }
      // The guard the first draft of this corpus needed and lacked: a
      // paraphrase/cross-lingual query must not be answerable from the
      // judged document's ADDRESS. Paths and names are indexed text, so a
      // descriptive English path let an English query "succeed
      // cross-lingually" at a Japanese document without any cross-lingual
      // retrieval happening — the instrument flattering itself.
      if (judged.category !== 'lexical' && judged.category !== 'bigram') {
        const terms = judged.query
          .toLowerCase()
          .split(/[^\p{L}\p{N}]+/u)
          .filter((t) => t.length > 2)
        for (const path of judged.relevant) {
          const doc = CORPUS_DOCUMENTS.find((d) => d.path === path)
          const address = `${doc?.path ?? ''} ${doc?.name ?? ''}`.toLowerCase()
          for (const term of terms) {
            expect(address, `"${judged.query}" is answerable from ${path}'s address`).not.toContain(
              term,
            )
          }
        }
      }
    }
  })
})

describe('stage-0 lexical retrieval quality', () => {
  it('scores the judged corpus exactly as pinned', async () => {
    const perCategory = new Map<QueryCategory, { hits: number; total: number; rrSum: number }>()
    const misses: string[] = []

    for (const judged of JUDGED_QUERIES) {
      const ranked = await rankedPaths(judged.query)
      const bucket = perCategory.get(judged.category) ?? { hits: 0, total: 0, rrSum: 0 }
      bucket.total++
      const firstHit = ranked.findIndex((path) => judged.relevant.includes(path))
      if (firstHit === -1) {
        misses.push(`${judged.category}: ${judged.query}`)
      } else {
        bucket.hits++
        bucket.rrSum += 1 / (firstHit + 1)
      }
      perCategory.set(judged.category, bucket)
    }

    const summary = Object.fromEntries(
      [...perCategory.entries()].map(([category, b]) => [
        category,
        { hitAtK: b.hits, of: b.total, mrr: Number((b.rrSum / b.total).toFixed(2)) },
      ]),
    )

    // Pinned exactly. `lexical`/`bigram` at full recall is the contract;
    // `paraphrase`/`cross-lingual` is the debt stage 2 would move.
    expect(summary).toEqual({
      lexical: { hitAtK: 3, of: 3, mrr: 1 },
      bigram: { hitAtK: 3, of: 3, mrr: 1 },
      // The debt. Cross-lingual is a clean ZERO — no lexical scheme can
      // cross the script boundary, and the one apparent hit an earlier
      // draft showed was the corpus leaking English through a path.
      paraphrase: { hitAtK: 2, of: 3, mrr: 0.67 },
      'cross-lingual': { hitAtK: 0, of: 3, mrr: 0 },
    })
    // Named, not just counted: a later reader can see WHICH questions go
    // unanswered without re-deriving them.
    expect(misses.sort()).toEqual([
      'cross-lingual: embedding model download size',
      'cross-lingual: ストレージ容量の見積もり',
      'cross-lingual: 再接続の手順書',
      'paraphrase: 新規ユーザーが最初に通る画面',
    ])
  })
})
