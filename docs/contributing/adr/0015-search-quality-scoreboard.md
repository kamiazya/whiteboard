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

### 3c. What the instrument reports, and why each part is there (2026-08-23)

3b's table was a set of point estimates with no way to tell a real
improvement from which twelve questions happened to be asked. The metrics
and statistics now follow standard IR practice rather than being invented
here, because a scoreboard's whole value is being comparable to something.
Each choice, with the reason it beat the alternative:

- **nDCG@10 is primary.** BEIR chose it for reasons that apply directly
  here: precision and recall are rank-unaware, and MRR and MAP cannot
  express GRADED relevance. The Japanese benchmarks report the same metric
  (JMTEB, JQaRA at nDCG@10; JaCWIR at MAP@10), so a number produced here
  means what a number produced there means. Recall@k and MRR are reported
  BESIDE it, never instead — each is easier to reason about and wrong to
  optimise alone.
- **Judgements are graded (1–3), not binary.** Every judgement in today's
  corpus is a 3, so nDCG currently reduces to a binary measure; the scale
  exists so the corpus can grow into queries with several partial answers
  without a second migration, and because a metric that CAN read grades
  reports a flat corpus honestly where one that cannot hides the flatness.
- **The difference is tested, not asserted.** A paired sign-flip
  randomization test over per-query differences, chosen on evidence:
  comparing significance tests for IR finds randomization, bootstrap and
  the paired t-test practically indistinguishable, while the Wilcoxon
  signed-rank and sign tests both detect poorly AND report significance
  that is not there. Randomization additionally assumes nothing about the
  distribution of a bounded, skewed, tie-heavy metric like nDCG.
- **A bootstrap confidence interval accompanies every delta.** Queries are
  the sample and retrieval is deterministic, so queries are the only thing
  to resample. The interval answers what a single mean cannot: how much of
  this number is the system and how much is the question set.
- **A random floor accompanies every score.** Without it a number is
  unreadable — and it is what exposed the earlier reading. See below.
- **The permutation FLOOR is printed next to the p-value.** They are easy
  to confuse and the confusion always flatters.
- **Required sample sizes are computed for differences declared in
  ADVANCE.** Feeding it the difference just observed is post-hoc power,
  which is not a second opinion on a result — it is a restatement of the
  p-value, and it always concludes the sample was about big enough.

#### What it says about the stage-2 result

The direction survives: nDCG@10 0.500 → 0.860, delta +0.360, 95% CI
[+0.141, +0.588]. The debt queries move from not-returned-at-all to rank
1–2, five of six.

Three things the earlier table could not say, and all three are cautions:

1. **`p = 0.0325` sits on a floor of `0.0313`.** Only six queries differ
   between the two systems, so `2^(1-6)` is the smallest p the test could
   produce. This is not a comfortable pass — it is the ONLY pass the sample
   could produce, and one query changing its mind erases it.
2. **`recall@10` is meaningless on this corpus.** A cut of 10 over six
   documents admits everything, so the random floor for recall@10 is
   exactly 1.000 — the same score stage 2 earns. The script prints a
   warning whenever k is at least the corpus size.
3. **Detecting a tuning-sized change would need roughly 130 queries, not
   12** (nDCG delta of 0.10, α .05, power .80, at the observed per-query
   spread). So this corpus can detect "unfindable → found" and nothing
   finer. It cannot referee a fusion-weight change, a different model, or
   a rescoring tweak, and must not be used to.

That is the instrument working. A scoreboard that cannot state its own
resolution is one that will eventually be quoted past it.

### 3d. Two corpora, and what the real one said (2026-08-23)

The six-document corpus could not referee anything: its own instrument
reported that detecting a tuning-sized change would need roughly 130
queries. Rather than grow a synthetic corpus, measurement moved to this
project's own `docs/` tree — 45 real documents, 50 judged queries.

**The two corpora now have different jobs, and neither can do the other's.**

| | `search-corpus.ts` (6 synthetic) | `docs-corpus.ts` (45 real) |
|---|---|---|
| runs in | `pnpm test`, pinned exactly | a script, on demand |
| job | fail when tokenisation or scoring changes | say whether one ranking beats another |
| needs | hermetic, frozen, tiny | realistic, large enough for k=10 |
| categories | all four, including `bigram` | no `bigram` — the docs are English |

Real documents buy the half of the bias problem that can be bought: nobody
wrote them to make a retriever look good. The queries are still authored by
someone who knows the corpus, which is ordinary for a test collection but
is the part to stay sceptical about.

#### Four things the synthetic corpus could not show

1. **It was flattering stage 0.** Lexical nDCG@10 is 0.783 on real
   documents, not the 1.000 the synthetic corpus reported. Six short
   documents written around their queries make keyword search look
   perfect.
2. **The paraphrase gain is much smaller than claimed.** 0.222 → 0.343,
   where the synthetic corpus showed 0.000 → 0.754. Real English
   paraphrases share vocabulary with real documents, so stage 0 partly
   works and the model adds proportionally less.
3. **Cross-lingual is where the value actually is**, and now on 22 queries
   rather than 3: 0.045 → 0.603 nDCG@10, MRR 0.045 → 0.545.
4. **Fusion costs something, which was previously invisible.** `pairing
   code` fell from rank 1 to 2; `who can read my drawings and what stops
   them` fell from rank 9 out of the top 10 entirely. A semantic
   neighbour outranking a keyword match is the mechanism working as
   designed, and it is not free.

Overall nDCG@10 0.324 → 0.631, delta +0.307, 95% CI [+0.207, +0.411],
p = 0.0001 against a floor of 2.3e-10 — this time the p-value has room
below it, which the six-document result never did.

#### The finding that changes what to build next

**37 of the 45 documents exceed the model's 512-token input limit.** Mean
length is around 2300 tokens, longest 7800; the embedder therefore reads
about a fifth of the corpus TEXT and silently ignores the rest. Note the
unit: it is not a fifth of the documents — every document is present, most
of them cut short. Every number above is achieved WITHOUT roughly four
fifths of the text.

Stated as a fraction rather than a decimal on purpose. The exact figure
moves whenever `docs/` changes, this ADR included, so a number carried in
prose goes stale by the next commit; the script prints the current value on
every run and that is the copy to trust.

That is not a defect in the measurement, it is the measurement doing its
job — the synthetic corpus had short documents, so nothing there could
ever have surfaced it. Chunking is now the obvious next increment, and
unlike before there is an instrument that can price it. The script reports
the truncated fraction on every run so it cannot quietly return.

#### Every figure above names the experiment that produced it

The corpus is read from the LIVE `docs/` tree, so two runs a month apart
are two different experiments and nothing in a bare table would say so. The
script prints a corpus digest and a query digest on every run — separate,
because when a figure moves the first question is whether the documents
changed or the answer key did, and one combined hash cannot answer it.

The figures in 3d are from the run recorded in PR #1016, against model
`Xenova/multilingual-e5-small`. To reproduce them exactly, check out that
merge commit — the digests printed by a run identify the tree it read.

Note the loop this creates: **this ADR is itself a document in the corpus.**
Editing it changes the corpus and moves the figures a little; writing the
paragraph above moved the truncation figure from 21% to 20% and stage-0
nDCG from 0.324 to 0.328. That is not a bug to fix, and chasing the last
digit here would never terminate. It is why the digest exists: a later
reader finding a small discrepancy should check the digest rather than
assume someone mis-transcribed a number. Update the figures when a FINDING
changes, not when the third decimal drifts.

One more thing the instrument now reports about itself: a p-value printed
as `p < 0.0001` has hit the SAMPLER's resolution (`1 / (1 + trials)`), not
the evidence's limit. The true value is somewhere below and this test
cannot say where. Printed as a bound rather than an equality because
`p = 0.0001` beside an exact floor of `2.3e-10` reads like a result with
room to spare, when it is the sampler running out of digits.

#### What the corpus still cannot do

Detecting a 0.10 nDCG difference needs about 109 queries at the observed
per-query spread; there are 50. So the collection can referee "unfindable
→ found" and large structural changes, and cannot yet referee a fusion
weight, a model swap, or a rescoring tweak.

Judgements are also incomplete: 139 documents appear in some system's top
three without a judgement, and an unjudged document counts as irrelevant,
which penalises a system for returning something genuinely useful. The
script prints that pool precisely so the next round of judgements has
somewhere to start — pooling from the systems under test is how test
collections are normally grown, with the known caveat that a future third
system did not contribute to the pool and is disadvantaged by it.

### 3g. Mining the repository for queries — measured, and abandoned

The corpus's weakest joint is that its questions are AUTHORED: written by
someone who already knew the documents, which is exactly why it is thin in
the categories worth measuring. An obvious-looking fix is to harvest
questions from the repository's own history — pull request titles and
bodies pair an information need with the documents that answer it, and the
judgement would be mechanical rather than someone's opinion.

It does not work, and the reason is structural rather than fixable.

Of the 34 merged pull requests that touched exactly one document under
`docs/`, **33 shared a search token with that document and none did not** —
8 of 10 tokens, 10 of 11, 16 of 16. A second pass looking for bodies that
merely NAME a document without editing it (no edit, so no contamination
from the change itself) yielded 18 pairs, most pointing at README, which is
a navigational hub rather than an answer.

Anyone writing about this repository already speaks its vocabulary. Mining
it therefore produces `lexical` queries — the one category already answered
well (0.783) and the one needing no help. Text from someone who does NOT
know the documents' words is by definition not in the repository.

The same measurement rules out the other obvious source. Session
transcripts hold 961 user turns, 814 of them Japanese, but the ones phrased
as questions are design discussion rather than retrieval: only 48 use
find-or-locate language at all, and reading those shows almost none is
looking for a document. The reason is worth keeping: **in this product the
user does not search — they ask the agent, and the agent reads files
directly.** Absence of a behaviour under the presence of a better
alternative is not evidence about the behaviour's value; it just means the
transcripts are not where it lives.

What follows is that a query worth judging exists only at the moment a
search fails, and only for whoever is doing the searching — which in this
product is increasingly the agent rather than the person.

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
