/**
 * The judged corpus behind the search quality scoreboard.
 *
 * Written to look like this product's real content — bilingual technical
 * notes and canvases whose meaning lives partly in edge labels — rather
 * than like a benchmark. Every `relevant` set is a hand judgement: what a
 * person asking that query would want returned, INDEPENDENT of whether
 * lexical retrieval can find it. That independence is the whole point: the
 * queries stage 0 cannot answer are the measurement stage 2 exists to move.
 *
 * PATHS FOLLOW ADR-0008, and that is load-bearing here rather than cosmetic.
 * A non-Latin title collapses to an ASCII `untitled-N` path, so a
 * Japanese-titled document carries no English words in its address. The
 * first draft of this corpus gave those documents descriptive English
 * paths, and the scoreboard duly reported a cross-lingual "hit" that was
 * really the PATH matching the query's English words — an instrument
 * flattering the thing it exists to measure. `search-quality.test.ts`
 * guards the rule now: no paraphrase/cross-lingual query may share a term
 * with its judged document's path or name.
 */

import type { Judgments } from './eval.js'

export interface CorpusDocument {
  readonly path: string
  readonly name: string
  readonly kind: 'markdown' | 'spatial'
  /** Markdown body, or the text/label content of a canvas. */
  readonly body?: string
  readonly nodes?: readonly { id: string; text: string }[]
  readonly groups?: readonly { id: string; label: string }[]
  readonly edges?: readonly { id: string; from: string; to: string; label: string }[]
  readonly tags?: readonly string[]
}

/**
 * What kind of retrieval a query demands. The split is the scoreboard's
 * reason to exist:
 *
 * - `lexical` — the query's own words appear in the wanted document.
 *   Stage 0 should answer these; a miss here is a BUG in tokenisation or
 *   scoring, not a missing capability.
 * - `bigram` — Japanese where the wanted term is not space-delimited, so
 *   the answer depends on the CJK bigram scheme specifically.
 * - `paraphrase` — the wanted document says the same thing in other words,
 *   sharing NO token with the query. Structurally out of lexical reach.
 * - `cross-lingual` — a Japanese query for an English document (or the
 *   reverse). Structurally out of lexical reach, and the capability the
 *   research measured an embedding model actually delivering.
 */
export type QueryCategory = 'lexical' | 'bigram' | 'paraphrase' | 'cross-lingual'

export interface JudgedQuery {
  readonly query: string
  readonly category: QueryCategory
  /**
   * documentPath -> how badly a person asking this wants that document.
   * Anything absent is not relevant.
   *
   * GRADED rather than binary, on the scale nDCG is defined over:
   *
   * - `3` — what the asker was looking for; returning anything else first
   *   is a worse answer.
   * - `2` — genuinely answers the question, but is not the one document
   *   the query was reaching for.
   * - `1` — worth showing, and a reader would not call it a mistake, but
   *   they would keep scrolling.
   *
   * Every judgement below is a `3`, because each query was written against
   * one document. The scale is here so that the corpus can grow into
   * queries with several partial answers without a second migration — and
   * because a metric that CAN read grades reports a flat corpus honestly,
   * where one that cannot would hide the flatness.
   */
  readonly relevant: Judgments
}

export const CORPUS_DOCUMENTS: readonly CorpusDocument[] = [
  {
    path: 'notes/untitled-1',
    name: '同期設計メモ',
    kind: 'markdown',
    tags: ['design'],
    body: [
      '# 同期設計メモ',
      '',
      'WebSocket が切断されたときの再接続手順をまとめる。指数バックオフで再試行し、',
      'フロンティアを送って差分だけを受け取る。スナップショットの再送は最後の手段。',
    ].join('\n'),
  },
  {
    path: 'notes/reconnect-runbook',
    name: 'Reconnect runbook',
    kind: 'markdown',
    tags: ['ops'],
    body: [
      '# Reconnect runbook',
      '',
      'When a client drops the socket, retry with exponential backoff and resume',
      'from the last frontier. A full snapshot resend is the fallback of last resort.',
    ].join('\n'),
  },
  {
    path: 'notes/storage-budget',
    name: 'Storage budget',
    kind: 'markdown',
    tags: ['design'],
    body: [
      '# Storage budget',
      '',
      'IndexedDB holds the browser-local documents. Quota pressure shows up as',
      'QuotaExceededError on save, long before the browser evicts anything.',
    ].join('\n'),
  },
  {
    path: 'notes/untitled-2',
    name: '埋め込みモデル調査',
    kind: 'markdown',
    tags: ['research'],
    body: [
      '# 埋め込みモデル調査',
      '',
      '多言語モデルの初回ダウンロードは最小でも約120MBある。語彙テーブルが支配的で、',
      'パラメータ数を削っても下がらない。全走査の計算コストは論点にならない。',
    ].join('\n'),
  },
  {
    path: 'plans/untitled-3',
    name: 'Q3 infra board',
    kind: 'spatial',
    nodes: [
      { id: 'n1', text: 'キャッシュ層をどこに置くか' },
      { id: 'n2', text: 'Session store' },
      { id: 'n3', text: 'Edge worker' },
    ],
    groups: [{ id: 'g1', label: 'インフラ構成' }],
    edges: [{ id: 'e1', from: 'n2', to: 'n3', label: 'depends on redis' }],
  },
  {
    path: 'plans/onboarding-flow',
    name: 'Onboarding flow',
    kind: 'spatial',
    nodes: [
      { id: 'm1', text: 'Sign in' },
      { id: 'm2', text: 'First canvas' },
    ],
    edges: [{ id: 'f1', from: 'm1', to: 'm2', label: 'creates a starter document' }],
  },
]

export const JUDGED_QUERIES: readonly JudgedQuery[] = [
  // --- lexical: the words are right there ---
  { query: 'exponential backoff', category: 'lexical', relevant: { 'notes/reconnect-runbook': 3 } },
  { query: 'QuotaExceededError', category: 'lexical', relevant: { 'notes/storage-budget': 3 } },
  { query: 'redis', category: 'lexical', relevant: { 'plans/untitled-3': 3 } },

  // --- bigram: Japanese, no spaces, no dictionary ---
  { query: '再接続', category: 'bigram', relevant: { 'notes/untitled-1': 3 } },
  { query: 'インフラ構成', category: 'bigram', relevant: { 'plans/untitled-3': 3 } },
  { query: '初回ダウンロード', category: 'bigram', relevant: { 'notes/untitled-2': 3 } },

  // --- paraphrase: same meaning, NO shared token with the target ---
  // Zero overlap is the definition here, not a nicety: a query sharing a
  // token is answerable lexically, so crediting its hit to "paraphrase"
  // would measure stage 0 against itself. The corpus guard enforces it.
  {
    query: '通信が不安定な場合の復旧',
    category: 'paraphrase',
    relevant: { 'notes/untitled-1': 3 },
  },
  {
    query: '回線トラブル時の対処',
    category: 'paraphrase',
    relevant: { 'notes/untitled-1': 3 },
  },
  {
    query: '新規ユーザーが最初に通る画面',
    category: 'paraphrase',
    relevant: { 'plans/onboarding-flow': 3 },
  },

  // --- cross-lingual: JA query, EN document (and the reverse) ---
  {
    query: '再接続の手順書',
    category: 'cross-lingual',
    relevant: { 'notes/reconnect-runbook': 3 },
  },
  {
    query: 'ストレージ容量の見積もり',
    category: 'cross-lingual',
    relevant: { 'notes/storage-budget': 3 },
  },
  {
    query: 'embedding model download size',
    category: 'cross-lingual',
    relevant: { 'notes/untitled-2': 3 },
  },
]
