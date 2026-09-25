// guard-orchestrator.mjs as a black box: hook JSON on stdin, exit 2 = blocked, 0 = allowed.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const GUARD = fileURLToPath(new URL('../bin/guard-orchestrator.mjs', import.meta.url))
// A real tree beside the tests, outside the temp dir (which the guard allows on its own):
// the data home is handed to the guard through a symlink, so every check runs on realpaths.
const ROOT = mkdtempSync(fileURLToPath(new URL('.guard-fixture-', import.meta.url)))
after(() => rmSync(ROOT, { recursive: true, force: true }))
const HOME_REAL = join(ROOT, 'home-real'), HOME = join(ROOT, 'home'), PLUGIN = join(ROOT, 'plugin'), REPO = join(ROOT, 'repo')
const WT = `${REPO}-worktrees/feat-x`, CLAUDE = join(ROOT, 'claude', 'projects', '-home'), SID = 'b0e02800-a572-4804-94ed-4b85a81732a7'
const SPILL = join(CLAUDE, SID, 'tool-results')
const file = (p, s = 'x') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s) }
file(join(HOME_REAL, 'identity.md')); file(join(HOME_REAL, 'projects', 'api', 'project.md'))
file(join(PLUGIN, 'BRIEF.md')); file(join(REPO, 'src', 'index.ts'))
file(join(WT, 'JEEVES_REPORT.md')); file(join(REPO, 'JEEVES_REPORT.md'))
file(join(SPILL, 'mcp-searchJiraIssuesUsingJql-1.txt')); file(join(CLAUDE, 'other-session', 'tool-results', 'x.txt'))
symlinkSync(HOME_REAL, HOME)
symlinkSync(REPO, join(HOME_REAL, 'escape')) // a link out of the data home
symlinkSync(join(REPO, 'src', 'index.ts'), join(SPILL, 'leak.txt')) // a link out of the spill folder
mkdirSync(join(WT, 'evil')); symlinkSync(join(REPO, 'src', 'index.ts'), join(WT, 'evil', 'JEEVES_REPORT.md')) // a report that's really code

function run(stdin, args = [HOME, PLUGIN]) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [GUARD, ...args], { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => res({ code, err }))
    p.stdin.end(stdin)
  })
}
const call = (tool_name, tool_input, cwd = HOME) => run(JSON.stringify({ tool_name, tool_input, cwd, session_id: SID, transcript_path: join(CLAUDE, `${SID}.jsonl`) }))

const ALLOW = 0, BLOCK = 2
const cases = [
  // Edit / Write: the data home only, never a ledger
  ['Edit a project ledger', 'Edit', { file_path: `${HOME}/projects/api/state.md` }, BLOCK, 'write_state\\(\\{ project: "api"'],
  ['Edit a ledger by its real path', 'Edit', { file_path: `${HOME_REAL}/projects/api/state.md` }, BLOCK, 'write_state'],
  ['Write reminders.md', 'Write', { file_path: `${HOME}/reminders.md` }, BLOCK, 'write_state\\(\\{ file: "reminders"'],
  ['Edit project.md in the data home', 'Edit', { file_path: `${HOME}/projects/api/project.md` }, ALLOW],
  ['Write identity.md by its real path', 'Write', { file_path: `${HOME_REAL}/identity.md` }, ALLOW],
  ['Write daily.md relative to the data home', 'Write', { file_path: 'daily.md' }, ALLOW],
  ['Write a state.md nested deeper', 'Write', { file_path: `${HOME}/projects/api/notes/state.md` }, ALLOW],
  ['Edit a repo file', 'Edit', { file_path: `${REPO}/src/index.ts` }, BLOCK, 'dispatch'],
  ['Edit through a data-home symlink into a repo', 'Edit', { file_path: `${HOME}/escape/src/index.ts` }, BLOCK, 'dispatch'],
  ['Write a relative path from a repo cwd', 'Write', { file_path: 'src/a.ts' }, BLOCK, 'dispatch', REPO],
  ['Write to the temp dir', 'Write', { file_path: join(tmpdir(), 'jeeves-note.md') }, BLOCK, 'data home'],
  ['Write with no file_path', 'Write', {}, BLOCK, 'file_path'],
  // Read / Grep / Glob: own files only
  ['Read own file', 'Read', { file_path: `${HOME}/identity.md` }, ALLOW],
  ['Read own file by its real path', 'Read', { file_path: `${HOME_REAL}/identity.md` }, ALLOW],
  ['Read a plugin file', 'Read', { file_path: `${PLUGIN}/BRIEF.md` }, ALLOW],
  ['Read the temp dir', 'Read', { file_path: join(tmpdir(), 'x.txt') }, ALLOW],
  ['Read /tmp', 'Read', { file_path: '/tmp/x.txt' }, ALLOW],
  ['Read a repo file', 'Read', { file_path: `${REPO}/src/index.ts` }, BLOCK, 'investigator'],
  ['Read through a data-home symlink into a repo', 'Read', { file_path: `${HOME}/escape/src/index.ts` }, BLOCK, 'dispatch'],
  ['Read a worker report in a worktree', 'Read', { file_path: `${WT}/JEEVES_REPORT.md` }, ALLOW],
  ['Read a JEEVES_REPORT.md outside any worktree', 'Read', { file_path: `${REPO}/JEEVES_REPORT.md` }, BLOCK, 'dispatch'],
  ['Read a JEEVES_REPORT.md that links to code', 'Read', { file_path: `${WT}/evil/JEEVES_REPORT.md` }, BLOCK, 'dispatch'],
  ['Read its own spilled tool result', 'Read', { file_path: `${SPILL}/mcp-searchJiraIssuesUsingJql-1.txt` }, ALLOW],
  ['Read a spill that links to code', 'Read', { file_path: `${SPILL}/leak.txt` }, BLOCK, 'dispatch'],
  ['Read another session\'s spill', 'Read', { file_path: `${CLAUDE}/other-session/tool-results/x.txt` }, BLOCK, 'dispatch'],
  ['Read out of the spill folder with ..', 'Read', { file_path: `${SPILL}/../../../../repo/src/index.ts` }, BLOCK, 'dispatch'],
  ['Grep with no path from the data home', 'Grep', { pattern: 'a..b' }, ALLOW],
  ['Grep with no path from a repo cwd', 'Grep', { pattern: 'x' }, BLOCK, 'dispatch', REPO],
  ['Grep a repo', 'Grep', { pattern: 'x', path: `${REPO}/src` }, BLOCK, 'dispatch'],
  ['Grep own files with a relative glob', 'Grep', { pattern: 'x', path: HOME, glob: '*.md' }, ALLOW],
  ['Grep own files with an absolute glob into a repo', 'Grep', { pattern: 'x', path: HOME, glob: `${REPO}/**/*.ts` }, BLOCK, 'dispatch'],
  ['Grep own files with a glob that climbs out', 'Grep', { pattern: 'x', path: HOME, glob: '../repo/**' }, BLOCK, '\\.\\.'],
  ['Glob own files', 'Glob', { pattern: '*.md', path: `${HOME}/projects` }, ALLOW],
  ['Glob own files by an absolute pattern', 'Glob', { pattern: `${HOME}/projects/*/project.md` }, ALLOW],
  ['Glob a repo', 'Glob', { pattern: '**/*.ts', path: REPO }, BLOCK, 'dispatch'],
  ['Glob an absolute pattern into a repo', 'Glob', { pattern: `${REPO}/**/*.ts`, path: HOME }, BLOCK, 'dispatch'],
  ['Glob a pattern that climbs out', 'Glob', { pattern: '../repo/**/*.ts' }, BLOCK, '\\.\\.'],
  // Skill: loop only
  ['Skill loop', 'Skill', { skill: 'loop', args: 'Jeeves tick' }, ALLOW],
  ['Skill /loop', 'Skill', { skill: '/loop' }, ALLOW],
  ['Skill jeeves:status', 'Skill', { skill: 'jeeves:status' }, BLOCK, 'no skill but `loop`'],
  ['Skill jeeves:setup', 'Skill', { skill: 'jeeves:setup', args: '--scan' }, BLOCK, 'add_tab\\(\\{ space: "scratch"'],
  ['Skill acme:submit-review', 'Skill', { skill: 'acme:submit-review', args: '42 comment' }, BLOCK, 'reviewer'],
  ['Skill acme:code-review', 'Skill', { skill: 'acme:code-review' }, BLOCK, 'dispatch'],
  // Built-ins: the named few run, every other one is refused
  ...['ToolSearch', 'ScheduleWakeup', 'SendMessage', 'ListAgents', 'PushNotification'].map((t) => [t, t, {}, ALLOW]),
  ['Bash, even a harmless one', 'Bash', { command: 'date' }, BLOCK, 'no shell'],
  ['Bash gh', 'Bash', { command: 'gh pr view 12 --json title' }, BLOCK, 'github_read'],
  ['Agent', 'Agent', { prompt: 'do it' }, BLOCK, 'mcp__cockpit__dispatch'],
  ['Task', 'Task', { prompt: 'do it' }, BLOCK, 'mcp__cockpit__dispatch'],
  ['AskUserQuestion', 'AskUserQuestion', { questions: [] }, BLOCK, 'NEEDS YOU'],
  ...['TaskStop', 'Workflow', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Monitor', 'CronCreate', 'EnterWorktree', 'SomeNewTool']
    .map((t) => [t, t, { notebook_path: `${HOME}/nb.ipynb`, url: 'https://example.com' }, BLOCK, 'dispatch']),
  // MCP: the cockpit's, and a fixed Atlassian set on whichever server name carries it
  ['a cockpit tool', 'mcp__cockpit__dispatch', { agent: 'investigator' }, ALLOW],
  ['a cockpit read', 'mcp__cockpit__tick_snapshot', {}, ALLOW],
  ...['getJiraIssue', 'searchJiraIssuesUsingJql', 'createConfluencePage', 'addCommentToJiraIssue', 'transitionJiraIssue', 'addTeamworkGraphContext', 'createConfluenceInlineComment', 'createConfluenceFooterComment', 'getConfluenceCommentChildren'].flatMap((s) => [
    [`Atlassian Rovo ${s}`, `mcp__claude_ai_Atlassian_Rovo__${s}`, {}, ALLOW],
    [`Jira ${s}`, `mcp__claude_ai_Jira__${s}`, {}, ALLOW],
  ]),
  ...['editJiraIssue', 'createJiraIssue', 'createIssueLink', 'addWorklogToJiraIssue'].flatMap((s) => [
    [`Atlassian Rovo ${s}`, `mcp__claude_ai_Atlassian_Rovo__${s}`, {}, BLOCK, 'Jira/Confluence'],
    [`Jira ${s}`, `mcp__claude_ai_Jira__${s}`, {}, BLOCK, 'Jira/Confluence'],
  ]),
  ['Slack send', 'mcp__claude_ai_Slack__slack_send_message', { text: 'hi' }, BLOCK, 'NEEDS YOU'],
  ['Slack read', 'mcp__claude_ai_Slack__slack_read_channel', {}, BLOCK, 'NEEDS YOU'],
  ['Gmail', 'mcp__claude_ai_Gmail__authenticate', {}, BLOCK, 'NEEDS YOU'],
  ['Claude Docs', 'mcp__claude_ai_Claude_Docs__batch', {}, BLOCK, 'NEEDS YOU'],
  ['an Atlassian tool name on another server', 'mcp__claude_ai_Slack__search', {}, BLOCK, 'NEEDS YOU'],
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
    const r = await call('Read', { file_path: '/a'.repeat(8000) }) // a path this deep overflows the stack resolving it
    assert.equal(r.code, 2)
    assert.match(r.err, /guard failed/)
  }))
  runs.push(t.test('no session info means no spill folder', async () => {
    const r = await run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: `${SPILL}/mcp-searchJiraIssuesUsingJql-1.txt` }, cwd: HOME }))
    assert.equal(r.code, BLOCK)
  }))
  runs.push(t.test('stdin written slowly is still read in full', async () => {
    const r = await new Promise((res) => {
      const p = spawn(process.execPath, [GUARD, HOME, PLUGIN], { stdio: ['pipe', 'ignore', 'pipe'] })
      let err = ''; p.stderr.on('data', (d) => { err += d }); p.on('close', (code) => res({ code, err }))
      const s = JSON.stringify({ tool_name: 'ToolSearch', tool_input: { query: 'x'.repeat(200) }, cwd: HOME })
      p.stdin.write(s.slice(0, 10)); setTimeout(() => p.stdin.end(s.slice(10)), 800)
    })
    assert.equal(r.code, ALLOW, r.err)
  }))
  await Promise.all(runs)
})

// On macOS /tmp is a symlink to /private/tmp: both spellings are the temp dir.
test('/tmp and /private/tmp are the same temp dir', { skip: process.platform !== 'darwin' }, async () => {
  assert.equal((await call('Read', { file_path: '/private/tmp/jeeves-guard.txt' })).code, ALLOW)
  assert.equal((await call('Glob', { pattern: '/tmp/jeeves-*/**' })).code, ALLOW)
})

test('a data home under the temp dir still keeps its ledgers behind write_state', async () => {
  const th = mkdtempSync(join(tmpdir(), 'jeeves-guard-home-'))
  try {
    const at = (file_path) => run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path }, cwd: th }), [th, PLUGIN])
    assert.equal((await at(`${th}/projects/web/state.md`)).code, BLOCK)
    assert.equal((await at(`${th}/reminders.md`)).code, BLOCK)
    assert.equal((await at(`${th}/daily.md`)).code, ALLOW)
  } finally { rmSync(th, { recursive: true, force: true }) }
})
