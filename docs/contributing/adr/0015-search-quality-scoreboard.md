# ADR-0015: A judged corpus decides whether search needs embeddings

**Status:** Accepted

## Context

The semantic-index research staged search deliberately: stage 0 is lexical
(BM25 over dictionary-free tokens — latin words, CJK bigrams, ~0MB), and
stage 2 adds an embedding model whose first download is **~120MB at best**
for any multilingual option. That download is the whole cost of the
feature; everything else the research measured was negligible (a 10k-vector
full scan is 7.9ms, the index itself is 1/200th of the model).

The report closed with one open question, and named it the first thing to
measure: **how far does stage 0 get on its own?** Without an answer, the
120MB is either obviously worth paying or obviously not, depending on who
is arguing. `.claude/rules/dev-flow.md`'s measured-change rule applies
exactly here — a retrieval quality claim is correct-looking work whose
worth is entirely in numbers nobody has taken.

## Decision

### 1. The instrument lands before the decision, and before any tuning

`packages/server-core/src/search/search-corpus.ts` holds bilingual
documents shaped like this product's real content (markdown notes, and
canvases whose meaning lives partly in **edge labels**), plus hand-judged
relevant sets per query. `search-quality.test.ts` runs them through the
REAL search tool and pins the aggregate exactly, the same way
`edge-routing-quality.test.ts` pins routing: an improvement must be as
loud as a regression.

BM25's constants stay untuned. Tuning against a corpus that does not exist
yet is the anti-pattern this ADR exists to avoid.

### 2. Queries are categorised by what retrieval they DEMAND, not by language

- `lexical` — the query's words are in the document. Stage 0 is *for* this.
- `bigram` — Japanese, no spaces, no dictionary; tests the CJK scheme.
- `paraphrase` — same meaning, different words. Out of lexical reach.
- `cross-lingual` — Japanese query, English document (or the reverse). Out
  of lexical reach, and precisely what the research measured an embedding
  model delivering (a Japanese query ranked a relevant English passage
  above an irrelevant Japanese one).

The first two are the **contract**; the last two are the **debt**.

### 3. The measured baseline (2026-08-22)

| category | hit@5 | MRR |
|---|---|---|
| lexical | 3/3 | 1.00 |
| bigram | 3/3 | 1.00 |
| paraphrase | **0/3** | **0.00** |
| cross-lingual | **0/3** | **0.00** |

The debt is total, and getting to that number took two corrections — both
cases of the instrument flattering the thing it measures:

1. The first draft gave Japanese-titled documents descriptive **English
   paths**, so an English query "succeeded cross-lingually" by matching
   the path. Fixed by following ADR-0008 (non-Latin titles collapse to
   `untitled-N`), which is also what the product really does.
2. Review then caught a paraphrase query sharing `手順` and three more
   bigrams with the body it was judged against — a lexical hit credited to
   paraphrase. Fixed by requiring **zero token overlap** for any
   paraphrase/cross-lingual query, enforced by a corpus guard.

Both readings had looked like partial capability. Neither was. The honest
shape is the expected one: no tokenisation scheme crosses a synonym or a
script boundary.

### 4. The decision rule

- A `lexical` or `bigram` miss is a **defect in stage 0** — fix
  tokenisation or scoring; never reach for a model to paper over it.
- Stage 2 is justified when the `paraphrase`/`cross-lingual` debt is both
  large in this table *and* confirmed to matter in real use. The second
  half is not optional: the Connections work already showed a feature that
  looked obviously valuable on paper (a link graph) sitting unused because
  nothing rewarded it, and only measuring the real workspace revealed it.
- If the debt turns out not to matter in practice, **stage 0 is the whole
  feature** and the 120MB is never paid.

## Consequences

- Search changes now answer to a scoreboard, so a "better ranking" claim
  has to show which cell moved.
- The corpus is small (6 documents, 12 queries) — enough to separate the
  four capabilities, not enough for a ranking-quality claim. Growing it is
  cheap and should happen when a real query disappoints someone.
- The pinned numbers will need updating whenever the corpus grows; that is
  the intended cost of an exact pin.

## Alternatives considered

- **Ship stage 2 and compare informally.** Rejected: this is the
  argument-instead-of-numbers path, and it also spends the 120MB before
  learning whether it buys anything.
- **Measure with an off-the-shelf IR benchmark.** Rejected: none of them
  contain canvases with labelled edges, or the JA/EN mix this product's
  own documents have. The corpus has to look like the content.
- **Judge by ranking metrics only (nDCG).** Rejected as premature: with a
  corpus this size, hit@5 plus MRR per category answers the question being
  asked (can it find it at all) without implying more precision than the
  judgements carry.
