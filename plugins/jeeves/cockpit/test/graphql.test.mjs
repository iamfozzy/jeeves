// lib/graphql.mjs: the mutation parser github_read uses to refuse writes in a caller's query.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gqlMutations } from '../lib/graphql.mjs'

const cases = [
  ['a plain query', 'query { viewer { login } }', []],
  ['an anonymous query', '{ repository(owner: "a", name: "b") { id } }', []],
  ['a query whose string mentions a mutation', 'query { search(query: "mutation { mergePullRequest }", type: ISSUE, first: 1) { issueCount } }', []],
  ['a block string is data', 'query { a(x: """ mutation { closePullRequest } """) { id } }', []],
  ['a comment is ignored', 'query { viewer { login } } # mutation { mergePullRequest }', []],
  ['one mutation', 'mutation { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: "T", body: "fixed"}) { comment { id } } }', ['addPullRequestReviewThreadReply']],
  ['a named mutation with variables and an alias', 'mutation M($id: ID!) { r: resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }', ['resolveReviewThread']],
  ['an aliased merge is still a merge', 'mutation { ok: mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }', ['mergePullRequest']],
  ['a mutation after a query', 'query { viewer { login } } mutation { resolveReviewThread(input: {threadId: "x"}) { thread { id } } }', ['resolveReviewThread']],
  ['two fields', 'mutation { resolveReviewThread(input: {threadId: "x"}) { thread { id } } closePullRequest(input: {pullRequestId: "y"}) { clientMutationId } }', ['resolveReviewThread', 'closePullRequest']],
  ['a fragment spread in a mutation counts', 'mutation { ...F } fragment F on Mutation { mergePullRequest(input: {}) { clientMutationId } }', ['F']],
  ['an unterminated string does not parse', 'query { a(x: "oops) { id } }', null],
  ['unbalanced braces do not parse', 'mutation { mergePullRequest(input: {}) { id }', null],
  ['a stray close does not parse', 'query { a } }', null]
]
for (const [name, q, want] of cases) test(name, () => assert.deepEqual(gqlMutations(q), want))
