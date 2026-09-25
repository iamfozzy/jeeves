// guard-orchestrator.mjs as a black box: hook JSON on stdin, exit 2 = blocked, 0 = allowed.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = fileURLToPath(new URL('../bin/guard-orchestrator.mjs', import.meta.url))
// A real tree beside the tests: the data home is handed to the guard through a symlink, so
// every check runs on realpaths.
const ROOT = mkdtempSync(fileURLToPath(new URL('.guard-fixture-', import.meta.url)))
after(() => rmSync(ROOT, { recursive: true, force: true }))
const HOME_REAL = join(ROOT, 'home-real'), HOME = join(ROOT, 'home'), REPO = join(ROOT, 'repo')
// Claude Code's config dir, and the orchestrator's memory in it: projects/<data-home slug>/memory.
const CLAUDE_DIR = join(ROOT, 'claude'), slug = (p) => p.replace(/[^A-Za-z0-9]/g, '-')
const MEMORY = join(CLAUDE_DIR, 'projects', slug(HOME), 'memory'), MEMORY_REAL = join(CLAUDE_DIR, 'projects', slug(HOME_REAL), 'memory')
const file = (p, s = 'x') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s) }
file(join(HOME_REAL, 'identity.md')); file(join(HOME_REAL, 'projects', 'api', 'project.md')); file(join(REPO, 'src', 'index.ts'))
symlinkSync(HOME_REAL, HOME)
symlinkSync(REPO, join(HOME_REAL, 'escape')) // a link out of the data home

function run(stdin, args = [HOME]) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [GUARD, ...args], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE_DIR } })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => res({ code, err }))
    p.stdin.end(stdin)
  })
}
const call = (tool_name, tool_input, cwd = HOME) => run(JSON.stringify({ tool_name, tool_input, cwd }))

const ALLOW = 0, BLOCK = 2
const cases = [
  // Edit / Write: the data home and the orchestrator's memory, never a ledger
  ['Edit a project ledger', 'Edit', { file_path: `${HOME}/projects/api/state.md` }, BLOCK, 'write_state\\(\\{ project: "api"'],
  ['Edit a ledger by its real path', 'Edit', { file_path: `${HOME_REAL}/projects/api/state.md` }, BLOCK, 'write_state'],
  ['Write reminders.md', 'Write', { file_path: `${HOME}/reminders.md` }, BLOCK, 'write_state\\(\\{ file: "reminders"'],
  // Case-insensitive ledger names: APFS and NTFS fold case, so these are the same files.
  ['Edit STATE.md uppercased', 'Edit', { file_path: `${HOME}/projects/api/STATE.md` }, BLOCK, 'write_state'],
  ['Write Reminders.md capitalised', 'Write', { file_path: `${HOME}/Reminders.md` }, BLOCK, 'write_state'],
  ['Edit a ledger under an uppercased projects/', 'Edit', { file_path: `${HOME}/PROJECTS/api/state.md` }, BLOCK, 'write_state'],
  ['Edit project.md in the data home', 'Edit', { file_path: `${HOME}/projects/api/project.md` }, ALLOW],
  ['Write identity.md by its real path', 'Write', { file_path: `${HOME_REAL}/identity.md` }, ALLOW],
  ['Write daily.md relative to the data home', 'Write', { file_path: 'daily.md' }, ALLOW],
  ['Write a state.md nested deeper', 'Write', { file_path: `${HOME}/projects/api/notes/state.md` }, ALLOW],
  ['Write the cockpit workers', 'Write', { file_path: `${HOME}/.cockpit/workers.json` }, BLOCK, "cockpit's own state"],
  ['Write its memory', 'Write', { file_path: `${MEMORY}/feedback-merges.md` }, ALLOW],
  ['Edit its memory index', 'Edit', { file_path: `${MEMORY}/MEMORY.md` }, ALLOW],
  ['Write its memory under the real data-home slug', 'Write', { file_path: `${MEMORY_REAL}/x.md` }, ALLOW],
  ['Write another project\'s memory', 'Write', { file_path: join(CLAUDE_DIR, 'projects', slug(REPO), 'memory', 'x.md') }, BLOCK, 'dispatch'],
  ['Write beside its memory', 'Write', { file_path: join(CLAUDE_DIR, 'projects', slug(HOME), 'x.jsonl') }, BLOCK, 'dispatch'],
  ['Edit a repo file', 'Edit', { file_path: `${REPO}/src/index.ts` }, BLOCK, 'dispatch'],
  ['Edit through a data-home symlink into a repo', 'Edit', { file_path: `${HOME}/escape/src/index.ts` }, BLOCK, 'dispatch'],
  ['Write a relative path from a repo cwd', 'Write', { file_path: 'src/a.ts' }, BLOCK, 'dispatch', REPO],
  ['Write to the temp dir', 'Write', { file_path: join(tmpdir(), 'jeeves-note.md') }, BLOCK, 'data home'],
  ['NotebookEdit in a repo', 'NotebookEdit', { notebook_path: `${REPO}/nb.ipynb` }, BLOCK, 'dispatch'],
  ['NotebookEdit in the data home', 'NotebookEdit', { notebook_path: `${HOME}/nb.ipynb` }, ALLOW],
  ['Write with no file_path', 'Write', {}, BLOCK, 'file_path'],
  // Read / Grep / Glob: anywhere
  ['Read own file', 'Read', { file_path: `${HOME}/identity.md` }, ALLOW],
  ['Read a repo file', 'Read', { file_path: `${REPO}/src/index.ts` }, ALLOW],
  ['Read the cockpit token', 'Read', { file_path: `${HOME}/.cockpit/token` }, ALLOW],
  ['Grep a repo', 'Grep', { pattern: 'x', path: `${REPO}/src` }, ALLOW],
  ['Glob a pattern that climbs out', 'Glob', { pattern: '../repo/**/*.ts' }, ALLOW],
  // Bash: not parsed
  ...['date', 'git -C ../repo worktree prune', 'gh pr view 12 --json title | jq .title', 'npm test'].map((command) => [`Bash ${command}`, 'Bash', { command }, ALLOW]),
  // Agents run through dispatch
  ['Agent', 'Agent', { prompt: 'do it' }, BLOCK, 'mcp__cockpit__dispatch'],
  ['Task', 'Task', { prompt: 'do it' }, BLOCK, 'mcp__cockpit__dispatch'],
  ['Workflow', 'Workflow', { script: 'x' }, BLOCK, 'mcp__cockpit__dispatch'],
  ['AskUserQuestion', 'AskUserQuestion', { questions: [] }, BLOCK, 'NEEDS YOU'],
  // Skill: anything but a worker's job
  ['Skill loop', 'Skill', { skill: 'loop', args: 'Jeeves tick' }, ALLOW],
  ['Skill /loop', 'Skill', { skill: '/loop' }, ALLOW],
  ['Skill jeeves:status', 'Skill', { skill: 'jeeves:status' }, ALLOW],
  ['Skill schedule', 'Skill', { skill: 'schedule' }, ALLOW],
  ['Skill jeeves:setup', 'Skill', { skill: 'jeeves:setup', args: '--scan' }, BLOCK, 'add_tab\\(\\{ space: "scratch"'],
  ...['acme:submit-review', 'acme:code-review', 'code-review', '/code-review high', 'security-review', 'simplify', 'acme:create-pr'].map((skill) => [`Skill ${skill}`, 'Skill', { skill }, BLOCK, 'reviewer']),
  // Other built-ins run
  ...['ToolSearch', 'ScheduleWakeup', 'SendMessage', 'ListAgents', 'PushNotification', 'WebFetch', 'WebSearch', 'Monitor', 'SomeNewTool'].map((t) => [t, t, {}, ALLOW]),
  // MCP: every server
  ['a cockpit tool', 'mcp__cockpit__dispatch', { agent: 'investigator' }, ALLOW],
  ...['getJiraIssue', 'editJiraIssue', 'createJiraIssue', 'createIssueLink', 'getTeamworkGraphContext'].map((s) => [`Atlassian Rovo ${s}`, `mcp__claude_ai_Atlassian_Rovo__${s}`, {}, ALLOW]),
  ['another Jira server', 'mcp__claude_ai_Jira__getJiraIssue', {}, ALLOW],
  ['Slack read', 'mcp__claude_ai_Slack__slack_read_channel', {}, ALLOW],
  ['Claude Docs', 'mcp__claude_ai_Claude_Docs__batch', {}, ALLOW],
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
  // It fails closed: Claude Code takes any exit but 2 as "allow".
  runs.push(t.test('garbage stdin refuses', async () => { const r = await run('not json {'); assert.equal(r.code, 2); assert.match(r.err, /not JSON/) }))
  runs.push(t.test('empty stdin refuses', async () => { assert.equal((await run('')).code, 2) }))
  runs.push(t.test('JSON without a tool refuses', async () => { assert.equal((await run('null')).code, 2) }))
  runs.push(t.test('no data-home arg refuses', async () => {
    assert.equal((await run(JSON.stringify({ tool_name: 'ToolSearch', tool_input: {} }), [])).code, 2)
  }))
  runs.push(t.test('an internal error refuses (exit 2, not 1)', async () => {
    const r = await call('Write', { file_path: '/a'.repeat(8000) }) // a path this deep overflows the stack resolving it
    assert.equal(r.code, 2)
    assert.match(r.err, /guard failed/)
  }))
  runs.push(t.test('stdin written slowly is still read in full', async () => {
    const r = await new Promise((res) => {
      const p = spawn(process.execPath, [GUARD, HOME], { stdio: ['pipe', 'ignore', 'pipe'] })
      let err = ''; p.stderr.on('data', (d) => { err += d }); p.on('close', (code) => res({ code, err }))
      const s = JSON.stringify({ tool_name: 'ToolSearch', tool_input: { query: 'x'.repeat(200) }, cwd: HOME })
      p.stdin.write(s.slice(0, 10)); setTimeout(() => p.stdin.end(s.slice(10)), 800)
    })
    assert.equal(r.code, ALLOW, r.err)
  }))
  await Promise.all(runs)
})

test('a data home under the temp dir still keeps its ledgers behind write_state', async () => {
  const th = mkdtempSync(join(tmpdir(), 'jeeves-guard-home-'))
  try {
    const at = (file_path) => run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path }, cwd: th }), [th])
    assert.equal((await at(`${th}/projects/web/state.md`)).code, BLOCK)
    assert.equal((await at(`${th}/reminders.md`)).code, BLOCK)
    assert.equal((await at(`${th}/daily.md`)).code, ALLOW)
  } finally { rmSync(th, { recursive: true, force: true }) }
})
