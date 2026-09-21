#!/usr/bin/env node
// Regression coverage for pre-merge-comments-lib.mjs, the decision half of
// hooks/pre-merge-show-comments.mjs. Run with: pnpm test:scripts.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cleanBody, gateMerge, prNumberFrom } from './pre-merge-comments-lib.mjs'

const inline = (author, body) => ({ author, path: 'src/a.ts', line: 12, body })
const top = (author, body) => ({ author, body })

test('an inline review comment blocks, and its BODY is in the message', () => {
  const result = gateMerge({
    pr: 1745,
    review: [inline('coderabbitai[bot]', 'This cast hides a null.')],
    issue: [],
    alreadySeen: false,
  })

  assert.equal(result.block, true)
  // The body, not merely a count: the incident this gate exists for was a
  // count printed in the same breath as the merge, which says nothing about
  // what the comment SAID.
  assert.match(result.message, /This cast hides a null\./)
  assert.match(result.message, /src\/a\.ts:12/)
  assert.match(result.message, /coderabbitai\[bot\]/)
})

test('the same head, once shown, does not block again', () => {
  const args = { pr: 1745, review: [inline('a', 'x')], issue: [], alreadySeen: true }
  assert.equal(gateMerge(args).block, false)
})

test('top-level comments alone do not block, and their authors are enumerated', () => {
  // Every PR in this repo has these. Blocking on them would fire on every
  // merge, which is how a gate stops being read.
  const result = gateMerge({
    pr: 1751,
    review: [],
    issue: [
      top('github-actions[bot]', 'Cloudflare Pages preview: https://example.pages.dev'),
      top('deepsource-io[bot]', 'DeepSource Code Review'),
    ],
    alreadySeen: false,
  })

  assert.equal(result.block, false)
  assert.match(result.message, /deepsource-io\[bot\], github-actions\[bot\]/)
})

test('a PR with no comments at all is silent', () => {
  const result = gateMerge({ pr: 1749, review: [], issue: [], alreadySeen: false })
  assert.equal(result.block, false)
  assert.equal(result.message, '')
})

test('a blocking message carries the top-level comments too', () => {
  const result = gateMerge({
    pr: 1746,
    review: [inline('deepsource-io[bot]', 'unused variable')],
    issue: [top('github-actions[bot]', 'preview link')],
    alreadySeen: false,
  })

  assert.match(result.message, /Top-level comments \(1\)/)
  assert.match(result.message, /preview link/)
})

test('a long body is truncated rather than pasted whole', () => {
  const result = gateMerge({
    pr: 1,
    review: [inline('bot', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'))],
    issue: [],
    alreadySeen: false,
  })

  assert.match(result.message, /line 11/)
  assert.doesNotMatch(result.message, /line 12/)
})

test('the PR number comes from the command when it names one', () => {
  assert.equal(prNumberFrom('gh pr merge 1751 --squash --delete-branch'), 1751)
  assert.equal(prNumberFrom('cd /x && gh pr merge 42 --squash'), 42)
  assert.equal(prNumberFrom('gh pr merge --squash'), null)
  assert.equal(prNumberFrom('gh pr create --title x'), null)
})

test("a bot's HTML badge does not crowd out its finding", () => {
  // Verbatim shape of DeepSource's comments (PR #1746): a tracking comment,
  // then a severity badge built from <picture>/<source>/<img>, then the one
  // sentence that matters. Truncating the raw body at 12 lines showed the
  // badge and cut the sentence.
  const raw = [
    '<!-- DeepSource: id=Q2hlY2tJc3N1ZTph -->',
    '<h3><picture>',
    '<source media="(prefers-color-scheme: dark)" srcset="https://static.deepsource.com/a.svg"/>',
    '<source media="(prefers-color-scheme: light)" srcset="https://static.deepsource.com/b.svg"/>',
    '<img src="https://static.deepsource.com/c.svg" height="14" hspace="8"/>',
    '</picture>Forbidden non-null assertion</h3>',
  ].join('\n')

  const result = gateMerge({
    pr: 1746,
    review: [{ author: 'deepsource-io[bot]', path: 'src/a.ts', line: 253, body: raw }],
    issue: [],
    alreadySeen: false,
  })

  assert.match(result.message, /Forbidden non-null assertion/)
  assert.doesNotMatch(result.message, /prefers-color-scheme/)
  assert.doesNotMatch(result.message, /Q2hlY2tJc3N1ZTph/)
})

test('cleanBody leaves plain prose alone', () => {
  assert.equal(cleanBody('This cast hides a null.\n\nFix it.'), 'This cast hides a null.\nFix it.')
})
