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

### 3b. The measured stage-2 column (2026-08-23)

The number the whole instrument existed to produce. Same corpus, same
queries, same scoring; the only difference is an embedder supplied to
`wb_document_search`, whose ranking is fused with BM25's by rank.

Model: `Xenova/multilingual-e5-small` through transformers.js, q8 weights,
384 dimensions, 113MB downloaded once and then offline.

| category | stage 0 hit@1 | stage 0 hit@5 | stage 0 MRR | stage 2 hit@1 | stage 2 hit@5 | stage 2 MRR |
|---|---|---|---|---|---|---|
| lexical | 3/3 | 3/3 | 1.00 | 3/3 | 3/3 | 1.00 |
| bigram | 3/3 | 3/3 | 1.00 | 3/3 | 3/3 | 1.00 |
| paraphrase | 0/3 | 0/3 | 0.00 | **1/3** | **3/3** | **0.67** |
| cross-lingual | 0/3 | 0/3 | 0.00 | **1/3** | **3/3** | **0.58** |

Two readings, and the second is the honest one:

- **The debt is retired.** Every paraphrase and cross-lingual query that
  stage 0 could not answer at all is now answered within the top 5, and
  nothing that already worked moved. Fusing by rank rather than by score
  is what bought that: the lexical rows are identical, not merely close.
- **hit@5 is the weaker column and should not be read as the headline.**
  With six documents a random ranking scores hit@5 at 5/6. The columns
  that discriminate are hit@1 and MRR, and there the debt rows land at
  1/3 and ~0.6 — a real capability, not a solved problem. Growing the
  corpus is the obvious next improvement to the instrument, and it should
  happen before anyone tunes fusion against these numbers.

Reproduce with `node --import tsx/esm
scripts/measure/search-quality-embedding.mjs` from `packages/mcp-server`.
It is a script rather than a test because it downloads 113MB and `pnpm
test` stays hermetic. The pinned scoreboard test remains the guard; this
is the instrument that decides whether there is anything to guard.

Cost, measured rather than estimated: 113MB of weights, ~14s of first-run
model load, ~1.1s for all 12 queries once warm (documents embed once and
are cached under the same frontier stamp as their content facts, so an
unchanged document is never re-embedded).

### 4. The decision rule

- A `lexical` or `bigram` miss is a **defect in stage 0** — fix
  tokenisation or scoring; never reach for a model to paper over it.
- The debt columns say what stage 0 **cannot** do. They do not say how
  often anyone needs it, and no amount of watching current usage will:
  see the correction below.
- Stage 2 is judged on **the user value it delivers against the cost of
  delivering it** — argued forward from what the capability is worth to a
  reader (human or agent), not inferred backward from behaviour under a
  product that lacks it.
- Those are two separable decisions, and conflating them is what the first
  draft of this rule got wrong:
  - **Building it behind a flag** costs developer time and one local model
    download. The bar is low, because the strongest evidence available —
    running both retrievals over the same real queries and comparing — can
    only be produced by building it.
  - **Shipping it on by default** makes every user pay ~120MB, again per
    origin. The bar is high, and the research already named the resolution:
    stage 2 ships **opt-in**, so the cost lands only on whoever wants the
    capability. Opt-in dissolves most of what a demand gate was protecting.

#### The correction this rule needed

The first draft required the debt to be *"confirmed to matter in real
use"*, and cited the Connections work — a link graph the dev workspace had
almost no data for (24 documents, 1 cross-document reference) — as proof
that a feature can look valuable on paper and sit unused.

That citation was wrong twice over, and the second error is the one that
matters here.

**It stated a cause the observation could not establish.** Four
explanations produce the same empty graph: nothing rewarded links; the
authoring affordance was weak (`[[` completion did not exist yet); the
data was a development environment; and the content was mostly
agent-generated tickets, which have no reason to cross-reference. The
research report said as much in its own limits note — *"n=24, mostly
agent-generated tickets; not evidence about human behaviour"* — and the
caveat was lost when the finding became a precedent here. A weak
observation got promoted to a strong prior by being quoted.

**And the rule it justified was circular.** Absence of a capability
suppresses the behaviour that would demonstrate demand for it. Someone who
learns that rephrasing a query never finds anything stops rephrasing
queries; "nobody searches that way" is then guaranteed, whatever they
would have wanted. Requiring behavioural proof before building is a
standard that no genuinely new capability can ever meet — and refusing to
build on that basis is not caution, it is a loss taken silently.

Evidence that is NOT suppressed by the feature's absence, and is therefore
worth gathering: queries that returned nothing useful (a failed attempt
leaves a trace even when the habit later dies), and side-by-side results
for the same query with and without the model — which requires building it
first, hence the low bar above.

## Consequences

- Search changes now answer to a scoreboard, so a "better ranking" claim
  has to show which cell moved. Stage 2 was the first claim put to it, and
  the table above is the answer: the debt rows moved, the working rows did
  not.
- The instrument earned its keep in an unplanned way as well. The
  measurement's first run named a model id that turned out to be gated,
  and the stage-2 column came back byte-identical to stage 0 — which is
  exactly what the degradation path is supposed to do, verified end to end
  without anyone writing a test for it.
- What the scoreboard is FOR is narrower than it first looked. It measures
  capability, and capability alone: it can say stage 0 answers none of the
  debt, and it cannot say whether anyone needs that answered. Reading a
  capability table as a demand signal is the mistake decision 4 corrects.
- The forward case for stage 2 in THIS product is worth stating, since it
  is what a value judgement weighs rather than something usage data could
  supply: the documentation is written in English by project policy while
  its author works in Japanese, so a cross-lingual query is a structural
  fact of the content, not a hypothetical; and the MCP tools make an agent
  a first-class reader, which reaches for semantic recall without ever
  having formed habits around a lexical index's limits.
- The corpus is small (6 documents, 12 queries) — enough to separate the
  four capabilities, not enough for a ranking-quality claim. Growing it is
  cheap and should happen when a real query disappoints someone. Stage 2's
  column sharpens this: at six documents hit@5 is nearly free, so the
  corpus must grow BEFORE anyone tunes fusion, or the tuning optimises a
  metric that a coin flip already passes.
- The pinned numbers will need updating whenever the corpus grows; that is
  the intended cost of an exact pin.

## Alternatives considered

- **Ship stage 2 and compare informally.** Rejected as a way to decide the
  DEFAULT — that is the argument-instead-of-numbers path. Not rejected as a
  way to decide at all: building it behind a flag and comparing real
  queries side by side is the strongest evidence available, and costs one
  local download rather than every user's.
- **Require behavioural proof of demand before building.** Rejected —
  see decision 4's correction. The absence of the capability suppresses the
  behaviour, so the standard is unmeetable by construction.
- **Measure with an off-the-shelf IR benchmark.** Rejected: none of them
  contain canvases with labelled edges, or the JA/EN mix this product's
  own documents have. The corpus has to look like the content.
- **Judge by ranking metrics only (nDCG).** Rejected as premature: with a
  corpus this size, hit@5 plus MRR per category answers the question being
  asked (can it find it at all) without implying more precision than the
  judgements carry.
