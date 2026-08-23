import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { Judgments, QueryCategory } from '@kamiazya/whiteboard-server-core'

/**
 * The measurement corpus: this project's own `docs/` tree, read from disk.
 *
 * Separate from `search-corpus.ts`, and the split is deliberate. That one is
 * six hand-written documents pinned EXACTLY by a test in `pnpm test`: its
 * job is to fail when tokenisation or scoring changes, so it has to be
 * small, hermetic and frozen. This one's job is the opposite — to say
 * whether one ranking is better than another — and for that it has to be
 * big enough that a cut of ten means something and realistic enough that
 * the vocabulary is not one person's idea of what documents look like.
 *
 * Real documents buy the half of the bias problem that can be bought.
 * Nobody wrote them to make a retriever look good; they were written to
 * explain the product. The queries below are still authored by someone who
 * knows the corpus, which is ordinary for a test collection (TREC topics
 * are authored too) but is the part a reader should stay sceptical about.
 *
 * There is no `bigram` category here: the documents are English by project
 * policy, so there is no Japanese prose to match a Japanese query
 * character-by-character. That category stays with the synthetic corpus.
 * What this corpus DOES have is the real situation — English documentation
 * and a Japanese-speaking author — so `cross-lingual` is not a contrived
 * case here, it is the daily one.
 */
export interface DocsCorpusDocument {
  readonly path: string
  readonly name: string
  readonly body: string
}

/** Reads `docs/**\/*.md` beneath `repoRoot`, sorted for a stable corpus. */
export function loadDocsCorpus(repoRoot: string): DocsCorpusDocument[] {
  const root = resolve(repoRoot, 'docs')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md')) files.push(full)
    }
  }
  walk(root)
  // Sorted GLOBALLY by relative path, by code point, after the walk — and
  // both halves of that matter to `corpusDigest`, which hashes documents in
  // array order and so makes the order part of the experiment identifier.
  //
  // `localeCompare` would read the runtime's default locale and ICU data,
  // so the same tree could digest differently on another machine. And
  // sorting per directory during a depth-first walk is not a path sort: a
  // directory `guide/` beside a file `guide.md` comes out in the opposite
  // order, which would also quietly falsify the "sorted" invariant the
  // test asserts.
  files.sort((a, b) => (relativePath(root, a) < relativePath(root, b) ? -1 : 1))
  return files.map((file) => {
    const body = readFileSync(file, 'utf8')
    const path = relativePath(root, file)
    return { path, name: firstHeading(body) ?? path, body }
  })
}

/** Extension-stripped path relative to the docs root, the corpus's id. */
function relativePath(root: string, file: string): string {
  return relative(root, file).replace(/\.md$/, '')
}

function firstHeading(markdown: string): string | undefined {
  for (const line of markdown.split('\n')) {
    if (line.startsWith('# ')) return line.slice(2).trim()
  }
  return undefined
}

/**
 * A short fingerprint of exactly what was measured.
 *
 * This corpus is READ FROM THE LIVE TREE, so two runs a month apart are two
 * different experiments and nothing in the output would say so. A number
 * quoted from a run nobody can identify is not a measurement, it is an
 * anecdote — and the whole point of the scoreboard is that a claim about
 * ranking has to name the evidence behind it.
 *
 * Kept separate from `queryDigest` on purpose: when a reported figure
 * moves, the first question is whether the documents changed or the
 * judgements did, and one combined hash cannot answer it.
 */
export function corpusDigest(documents: readonly DocsCorpusDocument[]): string {
  const hash = createHash('sha256')
  for (const doc of documents) hash.update(`${doc.path}\u0000${doc.name}\u0000${doc.body}\u0000`)
  return hash.digest('hex').slice(0, 12)
}

export interface DocsJudgedQuery {
  readonly query: string
  readonly category: Exclude<QueryCategory, 'bigram'>
  readonly relevant: Judgments
}

/**
 * Judged queries over the docs tree.
 *
 * Written as information NEEDS first and judged afterwards, in that order,
 * so a query is not a paraphrase of the sentence it is meant to find.
 *
 * Judgements are INCOMPLETE by construction: each names the documents its
 * author could identify, not every document in the tree that might answer.
 * An unjudged document counts as irrelevant, which penalises a system for
 * returning something genuinely useful that nobody has judged yet. The
 * measurement script prints the unjudged documents both systems rank
 * highly — that pool is where the next round of judgements comes from, and
 * it is the standard way a test collection is grown.
 */
export const DOCS_JUDGED_QUERIES: readonly DocsJudgedQuery[] = [
  // ---------------- lexical: the words are in the document ----------------
  { query: 'pairing code', category: 'lexical', relevant: { 'how-to/connect-to-local-daemon': 3 } },
  {
    query: 'keyboard shortcuts',
    category: 'lexical',
    relevant: { 'reference/keyboard-shortcuts': 3 },
  },
  { query: 'OpenTelemetry', category: 'lexical', relevant: { 'contributing/observability': 3 } },
  {
    query: 'Cloudflare Pages',
    category: 'lexical',
    relevant: { 'contributing/deployment/cloudflare-pages': 3 },
  },
  {
    query: 'docker compose self host',
    category: 'lexical',
    relevant: { 'how-to/self-host-with-docker': 3 },
  },
  { query: 'export formats', category: 'lexical', relevant: { 'reference/export-formats': 3 } },
  { query: 'release publishing', category: 'lexical', relevant: { 'contributing/releasing': 3 } },
  {
    query: 'wire protocol',
    category: 'lexical',
    relevant: { 'contributing/architecture/wire-protocol': 3 },
  },
  {
    query: 'pull request review checklist',
    category: 'lexical',
    relevant: { 'contributing/review-checklist': 3 },
  },
  { query: 'testing strategy', category: 'lexical', relevant: { 'contributing/testing': 3 } },
  { query: 'security model', category: 'lexical', relevant: { 'explanation/security-model': 3 } },
  { query: 'domain model', category: 'lexical', relevant: { 'explanation/domain-model': 3 } },
  { query: 'getting started', category: 'lexical', relevant: { 'tutorials/getting-started': 3 } },
  { query: 'configuration', category: 'lexical', relevant: { 'reference/configuration': 3 } },
  {
    query: 'facet system plugins',
    category: 'lexical',
    relevant: { 'contributing/adr/0013-facet-system': 3 },
  },
  { query: 'mcp debugging', category: 'lexical', relevant: { 'contributing/mcp-debugging': 3 } },

  // ------- paraphrase: English, same need, different words than the doc ----
  {
    query: 'my picture exports show squares where the letters should be',
    category: 'paraphrase',
    relevant: {
      'how-to/install-fonts-for-export': 3,
      'contributing/adr/0011-font-distribution': 1,
    },
  },
  {
    query: 'what do I do first after installing',
    category: 'paraphrase',
    relevant: { 'tutorials/getting-started': 3 },
  },
  {
    query: 'see which notes point at this one',
    category: 'paraphrase',
    relevant: { 'how-to/link-documents': 3, 'contributing/adr/0014-reference-index': 1 },
  },
  {
    query: 'group my notes by subject without folders',
    category: 'paraphrase',
    relevant: { 'how-to/organize-with-tags': 3 },
  },
  {
    query: 'run everything on my own machine behind my own firewall',
    category: 'paraphrase',
    relevant: { 'how-to/self-host-with-docker': 3 },
  },
  {
    query: 'let a page on the internet talk to software on my computer',
    category: 'paraphrase',
    relevant: {
      'contributing/adr/0005-hosted-origin-authorization': 3,
      'how-to/connect-to-local-daemon': 2,
    },
  },
  {
    query: 'the agent cannot reach the tools and I need to find out why',
    category: 'paraphrase',
    relevant: { 'contributing/mcp-debugging': 3 },
  },
  {
    query: 'which package is allowed to depend on which',
    category: 'paraphrase',
    relevant: { 'explanation/architecture': 3 },
  },
  {
    query: 'how do I look at a drawing without leaving the conversation',
    category: 'paraphrase',
    relevant: { 'how-to/view-canvas-in-chat': 3 },
  },
  {
    query: 'find a note when I cannot remember its title',
    category: 'paraphrase',
    relevant: { 'how-to/find-documents-from-chat': 3 },
  },
  {
    query: 'what gets recorded when something goes wrong in production',
    category: 'paraphrase',
    relevant: { 'contributing/observability': 3 },
  },
  {
    query: 'who can read my drawings and what stops them',
    category: 'paraphrase',
    relevant: { 'explanation/security-model': 3 },
  },

  // ---- cross-lingual: Japanese query, English document. The daily case. ----
  {
    query: 'エクスポートした画像の文字が四角になる',
    category: 'cross-lingual',
    relevant: {
      'how-to/install-fonts-for-export': 3,
      'contributing/adr/0011-font-distribution': 1,
    },
  },
  {
    query: 'ブラウザからローカルのデーモンに接続したい',
    category: 'cross-lingual',
    relevant: { 'how-to/connect-to-local-daemon': 3 },
  },
  {
    query: 'タグで文書を整理する方法',
    category: 'cross-lingual',
    relevant: { 'how-to/organize-with-tags': 3 },
  },
  {
    query: '被リンクを確認したい',
    category: 'cross-lingual',
    relevant: { 'how-to/link-documents': 3, 'contributing/adr/0014-reference-index': 1 },
  },
  {
    query: '自分のサーバーで動かす手順',
    category: 'cross-lingual',
    relevant: { 'how-to/self-host-with-docker': 3 },
  },
  {
    query: 'キーボード操作の一覧',
    category: 'cross-lingual',
    relevant: { 'reference/keyboard-shortcuts': 3 },
  },
  {
    query: '環境変数の設定項目',
    category: 'cross-lingual',
    relevant: { 'reference/configuration': 3 },
  },
  {
    query: '初めて使うときの手引き',
    category: 'cross-lingual',
    relevant: { 'tutorials/getting-started': 3 },
  },
  {
    query: 'テストはどの層に書くべきか',
    category: 'cross-lingual',
    relevant: { 'contributing/testing': 3 },
  },
  {
    query: 'リリースの出し方',
    category: 'cross-lingual',
    relevant: { 'contributing/releasing': 3 },
  },
  {
    query: '脅威モデルと信頼境界',
    category: 'cross-lingual',
    relevant: { 'explanation/security-model': 3 },
  },
  {
    query: 'パッケージの依存の向き',
    category: 'cross-lingual',
    relevant: { 'explanation/architecture': 3 },
  },
  {
    query: '同期メッセージの仕様',
    category: 'cross-lingual',
    relevant: { 'contributing/architecture/wire-protocol': 3 },
  },
  {
    query: 'チャットの中で図を表示する',
    category: 'cross-lingual',
    relevant: { 'how-to/view-canvas-in-chat': 3 },
  },
  {
    query: '文書の中身から探したい',
    category: 'cross-lingual',
    relevant: { 'how-to/find-documents-from-chat': 3 },
  },
  {
    query: '監視とログの取り方',
    category: 'cross-lingual',
    relevant: { 'contributing/observability': 3 },
  },
  {
    query: 'レビューで見るべき観点',
    category: 'cross-lingual',
    relevant: { 'contributing/review-checklist': 3 },
  },
  {
    query: '書き出せる形式は何があるか',
    category: 'cross-lingual',
    relevant: { 'reference/export-formats': 3 },
  },
  {
    query: 'プラグインで属性を追加する仕組み',
    category: 'cross-lingual',
    relevant: { 'contributing/adr/0013-facet-system': 3 },
  },
  {
    query: 'ツール名の付け方の決まり',
    category: 'cross-lingual',
    relevant: { 'contributing/adr/0009-mcp-tool-naming': 3 },
  },
  {
    query: 'フォントを同梱しない理由',
    category: 'cross-lingual',
    relevant: {
      'contributing/adr/0011-font-distribution': 3,
      'contributing/adr/0012-user-installed-fonts': 1,
    },
  },
  {
    query: '開発環境の立ち上げ方',
    category: 'cross-lingual',
    relevant: { 'contributing/development': 3 },
  },
]

/**
 * Fingerprint of the query set INCLUDING its judgements, so re-grading a
 * single document is as visible as adding a query. A judgement change with
 * an unchanged digest would be the worst kind of silent drift: the same
 * corpus, the same questions, and a different answer key.
 */
export function queryDigest(queries: readonly DocsJudgedQuery[]): string {
  const hash = createHash('sha256')
  for (const judged of queries) {
    hash.update(`${judged.query}\u0000${judged.category}\u0000`)
    for (const path of Object.keys(judged.relevant).sort()) {
      hash.update(`${path}=${judged.relevant[path]}\u0000`)
    }
  }
  return hash.digest('hex').slice(0, 12)
}
