// guard-orchestrator.mjs as a black box: hook JSON on stdin, exit 2 = blocked, 0 = allowed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = fileURLToPath(new URL('../bin/guard-orchestrator.mjs', import.meta.url))
// Paths only; the guard never needs them to exist. Neither sits under the temp dir,
// which the guard allows on its own.
const HOME = '/opt/jeeves-test/home'
const PLUGIN = '/opt/jeeves-test/plugin'
const REPO = '/opt/jeeves-test/repo'

function run(stdin, args = [HOME, PLUGIN]) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [GUARD, ...args], { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => res({ code, err }))
    p.stdin.end(stdin)
  })
}
const call = (tool_name, tool_input, cwd = HOME) => run(JSON.stringify({ tool_name, tool_input, cwd }))

const ALLOW = 0, BLOCK = 2
const cases = [
  // Edit / Write / NotebookEdit
  ['Edit a project ledger', 'Edit', { file_path: `${HOME}/projects/api/state.md` }, BLOCK, 'write_state'],
  ['Write reminders.md', 'Write', { file_path: `${HOME}/reminders.md` }, BLOCK, 'write_state'],
  ['Edit project.md in the data home', 'Edit', { file_path: `${HOME}/projects/api/project.md` }, ALLOW],
  ['Write identity.md', 'Write', { file_path: `${HOME}/identity.md` }, ALLOW],
  ['Write a state.md nested deeper', 'Write', { file_path: `${HOME}/projects/api/notes/state.md` }, ALLOW],
  ['Edit a repo file', 'Edit', { file_path: `${REPO}/src/index.ts` }, BLOCK, 'dispatch'],
  ['Write a relative path from a repo cwd', 'Write', { file_path: 'src/a.ts' }, BLOCK, 'dispatch', REPO],
  ['Write to the temp dir', 'Write', { file_path: join(tmpdir(), 'jeeves-note.md') }, ALLOW],
  ['Write to /tmp', 'Write', { file_path: '/tmp/jeeves-note.md' }, ALLOW],
  ['NotebookEdit in a repo', 'NotebookEdit', { notebook_path: `${REPO}/nb.ipynb` }, BLOCK, 'dispatch'],
  ['NotebookEdit in the data home', 'NotebookEdit', { notebook_path: `${HOME}/scratch.ipynb` }, ALLOW],
  // Read / Grep / Glob
  ['Read own file', 'Read', { file_path: `${HOME}/identity.md` }, ALLOW],
  ['Read a plugin file', 'Read', { file_path: `${PLUGIN}/BRIEF.md` }, ALLOW],
  ['Read a repo file', 'Read', { file_path: `${REPO}/src/index.ts` }, BLOCK, 'dispatch'],
  ['Read a worker report in a repo', 'Read', { file_path: `${REPO}-worktrees/feat-x/JEEVES_REPORT.md` }, ALLOW],
  ['Grep with no path from the data home', 'Grep', { pattern: 'x' }, ALLOW],
  ['Grep with no path from a repo cwd', 'Grep', { pattern: 'x' }, BLOCK, 'dispatch', REPO],
  ['Grep a repo', 'Grep', { pattern: 'x', path: `${REPO}/src` }, BLOCK, 'dispatch'],
  ['Glob own files', 'Glob', { pattern: '*.md', path: `${HOME}/projects` }, ALLOW],
  ['Glob a repo', 'Glob', { pattern: '**/*.ts', path: REPO }, BLOCK, 'dispatch'],
  // Agent / Task
  ['Agent', 'Agent', { prompt: 'do it' }, BLOCK, 'dispatch'],
  ['Task', 'Task', { prompt: 'do it' }, BLOCK, 'dispatch'],
]
const bash = [
  // allowed
  [`gh api graphql -f query='query { viewer { login } } | x'`, ALLOW],
  ['gh pr view 12 --repo acme/api --json title', ALLOW],
  ['gh pr checks 12', ALLOW],
  ['git -C /x fetch origin qa', ALLOW],
  ['git log a..b ^origin/qa --oneline', ALLOW],
  ['date', ALLOW],
  [`cd ${HOME}/projects && awk -F'\`' '{print}' */project.md`, ALLOW],
  ['ls ~/Dev', ALLOW],
  [`cat ${HOME}/identity.md`, ALLOW],
  ['for x in 1 2; do gh pr view $x; done', ALLOW],
  ['gh pr view 12 \\\n  --json title \\\n  --jq .title', ALLOW],
  ['gh pr view 12 2>&1 | head -5', ALLOW],
  ['gh pr view 12 >/dev/null 2>&1 && echo ok', ALLOW],
  ["gh pr comment 5 --body-file - <<'EOF'\nrm -rf /\nEOF\ndate", ALLOW],
  ['FOO=1 gh pr list', ALLOW],
  ['git worktree list', ALLOW],
  // blocked
  ['yarn jest', BLOCK],
  ['npm run build', BLOCK],
  ['git merge origin/qa', BLOCK],
  ['git push origin HEAD', BLOCK],
  ['git commit -m x', BLOCK],
  ['git worktree add ../wt feat', BLOCK],
  ['git diff HEAD~1', BLOCK],
  ['git log -p HEAD~1..HEAD', BLOCK],
  ['git branch -D feat', BLOCK],
  ['kill 1', BLOCK],
  ['rm -rf x', BLOCK],
  [`sed -i '' s/a/b/ ${HOME}/identity.md`, BLOCK],
  ['python3 -c "print(1)"', BLOCK],
  ["node -e 'console.log(1)'", BLOCK],
  [`grep -rn foo ${REPO}/src`, BLOCK],
  [`echo x > ${REPO}/file`, BLOCK],
  ['echo $(yarn build)', BLOCK],
  ['gh pr view "$(yarn build)"', BLOCK],
  ['echo `rm -rf x`', BLOCK],
  ["echo 'unterminated", BLOCK],
  ['echo "unterminated', BLOCK],
  ["cat <<'EOF'\nrm -rf /\nEOF\nrm -rf x", BLOCK],
  ['gh repo delete acme/api', BLOCK],
  ['gh pr merge 12', BLOCK],
  [`find ${HOME} -delete`, BLOCK],
  ['open /Applications/Calculator.app', BLOCK],
]

// Node 20 cancels subtests the parent doesn't await, so collect and await them all.
test('guard-orchestrator', { concurrency: true }, async (t) => {
  const runs = []
  for (const [name, tool, input, want, msg, cwd] of cases) {
    runs.push(t.test(`${want ? 'blocks' : 'allows'} ${name}`, async () => {
      const r = await call(tool, input, cwd)
      assert.equal(r.code, want, r.err)
      if (msg) assert.match(r.err, new RegExp(msg))
    }))
  }
  for (const [command, want] of bash) {
    runs.push(t.test(`Bash ${want ? 'blocks' : 'allows'}: ${JSON.stringify(command)}`, async () => {
      const r = await call('Bash', { command })
      assert.equal(r.code, want, r.err)
      if (want === BLOCK) assert.match(r.err, /mcp__cockpit__dispatch/)
    }))
  }
  runs.push(t.test('garbage stdin exits 0', async () => { assert.equal((await run('not json {')).code, 0) }))
  runs.push(t.test('empty stdin exits 0', async () => { assert.equal((await run('')).code, 0) }))
  runs.push(t.test('no data-home arg exits 0', async () => {
    assert.equal((await run(JSON.stringify({ tool_name: 'Agent', tool_input: {} }), [])).code, 0)
  }))
  await Promise.all(runs)
})
