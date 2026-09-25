// bin/jeeves-install-cli: the bash wrapper everywhere, plus a CRLF jeeves.cmd under Git Bash/MSYS/Cygwin.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const INSTALL = fileURLToPath(new URL('../../bin/jeeves-install-cli', import.meta.url))
const tmp = mkdtempSync(join(tmpdir(), 'jeeves-install-'))
test.after(() => rmSync(tmp, { recursive: true, force: true }))

const install = (dir, env = {}) => new Promise((res, rej) => {
  execFile('bash', [INSTALL, dir], { env: { ...process.env, PATH: process.env.PATH, HOME: tmp, ...env } }, (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout)))
})
const shim = (path, body) => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755) }

test('install-cli', { skip: process.platform === 'win32' && 'needs a POSIX bash' }, async (t) => {
  await t.test('real uname: writes only the bash wrapper', async () => {
    const dir = join(tmp, 'posix')
    const out = await install(dir)
    assert.ok(statSync(join(dir, 'jeeves')).mode & 0o100, 'jeeves is executable')
    assert.match(readFileSync(join(dir, 'jeeves'), 'utf8'), /^#!\/usr\/bin\/env bash\n/)
    assert.ok(!existsSync(join(dir, 'jeeves.cmd')))
    assert.match(out, /installed: \S+\/jeeves {2}\(/)
  })

  await t.test('MINGW uname: also writes a CRLF jeeves.cmd', async () => {
    const shims = join(tmp, 'shims'), dir = join(tmp, 'win')
    mkdirSync(shims)
    shim(join(shims, 'uname'), 'echo MINGW64_NT-10.0')
    shim(join(shims, 'cygpath'), "printf '%s\\n' 'C:\\fake'")
    const out = await install(dir, { PATH: shims + delimiter + process.env.PATH })
    assert.ok(existsSync(join(dir, 'jeeves')))
    const cmd = readFileSync(join(dir, 'jeeves.cmd'), 'utf8')
    assert.match(cmd, /^@echo off\r\n/)
    const lines = cmd.split('\n')
    assert.equal(lines.pop(), '', 'ends with a newline')
    assert.ok(lines.length > 10)
    assert.ok(lines.every((l) => l.endsWith('\r') && !l.endsWith('\r\r')), 'every line ends in exactly one CRLF')
    assert.match(out, /jeeves\.cmd/)
    // The dir isn't on PATH, so it prints the PowerShell hint with cygpath's Windows path.
    assert.match(out, /SetEnvironmentVariable.*C:\\fake/)
  })

  await t.test('replaces a pre-existing symlink rather than writing through it', async () => {
    const dir = join(tmp, 'link'), target = join(tmp, 'victim')
    mkdirSync(dir)
    writeFileSync(target, 'keep me')
    symlinkSync(target, join(dir, 'jeeves'))
    await install(dir)
    assert.equal(readFileSync(target, 'utf8'), 'keep me')
    assert.match(readFileSync(join(dir, 'jeeves'), 'utf8'), /Launch the Jeeves cockpit/)
  })

  await t.test('zsh: writes the PATH export to .zshrc, once', async () => {
    const home = join(tmp, 'home-zsh'), dir = join(tmp, 'not-on-path-zsh')
    mkdirSync(home)
    const line = `export PATH="${dir}:$PATH"`
    const out = await install(dir, { HOME: home, SHELL: '/bin/zsh' })
    assert.ok(readFileSync(join(home, '.zshrc'), 'utf8').includes(line))
    assert.match(out, /added .* to PATH in .*\.zshrc/)
    const again = await install(dir, { HOME: home, SHELL: '/bin/zsh' })
    const rc = readFileSync(join(home, '.zshrc'), 'utf8')
    assert.equal(rc.split(line).length - 1, 1, 'the export line is not duplicated')
    assert.match(again, /already added to PATH in .*\.zshrc/)
  })

  // Both stub uname so the outcome doesn't depend on the host running the tests.
  await t.test('bash on Linux: prefers an existing .bashrc over .bash_profile', async () => {
    const shims = join(tmp, 'shims-linux'), home = join(tmp, 'home-bash'), dir = join(tmp, 'not-on-path-bash')
    mkdirSync(shims)
    mkdirSync(home)
    shim(join(shims, 'uname'), 'echo Linux')
    writeFileSync(join(home, '.bashrc'), '# existing\n')
    await install(dir, { HOME: home, SHELL: '/bin/bash', PATH: shims + delimiter + process.env.PATH })
    assert.ok(readFileSync(join(home, '.bashrc'), 'utf8').includes(`export PATH="${dir}:$PATH"`))
    assert.ok(!existsSync(join(home, '.bash_profile')))
  })

  await t.test('bash on Linux: falls back to .bash_profile when there is no .bashrc', async () => {
    const shims = join(tmp, 'shims-linux2'), home = join(tmp, 'home-bash-noprofile'), dir = join(tmp, 'not-on-path-bash2')
    mkdirSync(shims)
    mkdirSync(home)
    shim(join(shims, 'uname'), 'echo Linux')
    await install(dir, { HOME: home, SHELL: '/bin/bash', PATH: shims + delimiter + process.env.PATH })
    assert.ok(readFileSync(join(home, '.bash_profile'), 'utf8').includes(`export PATH="${dir}:$PATH"`))
  })

  await t.test('bash on macOS: always prefers .bash_profile — Terminal runs login shells, which read it, not .bashrc', async () => {
    const shims = join(tmp, 'shims-darwin'), home = join(tmp, 'home-bash-darwin'), dir = join(tmp, 'not-on-path-bash-darwin')
    mkdirSync(shims)
    mkdirSync(home)
    shim(join(shims, 'uname'), 'echo Darwin')
    writeFileSync(join(home, '.bashrc'), '# existing\n')
    await install(dir, { HOME: home, SHELL: '/bin/bash', PATH: shims + delimiter + process.env.PATH })
    assert.ok(readFileSync(join(home, '.bash_profile'), 'utf8').includes(`export PATH="${dir}:$PATH"`))
    assert.equal(readFileSync(join(home, '.bashrc'), 'utf8'), '# existing\n', '.bashrc is left untouched')
  })

  await t.test('the installed jeeves wrapper resolves the newest cockpit.mjs, skipping jeeves-devlink .bak- backups', async () => {
    const home = join(tmp, 'home-bak'), dir = join(tmp, 'bak-test')
    const real = join(home, '.claude', 'plugins', 'cache', 'jeeves-marketplace', 'jeeves', '1.2.3', 'cockpit', 'bin')
    const bak = join(home, '.claude', 'plugins', 'cache', 'jeeves-marketplace', 'jeeves', '1.2.3.bak-20250101-120000', 'cockpit', 'bin')
    mkdirSync(real, { recursive: true })
    mkdirSync(bak, { recursive: true })
    writeFileSync(join(real, 'cockpit.mjs'), "console.log('real')\n")
    writeFileSync(join(bak, 'cockpit.mjs'), "console.log('bak')\n")
    // The backup is newer, so an unfiltered `ls -t` would rank it first.
    utimesSync(join(bak, 'cockpit.mjs'), new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    await install(dir, { HOME: home })
    const out = await new Promise((res, rej) =>
      execFile(join(dir, 'jeeves'), { env: { ...process.env, HOME: home } }, (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout))))
    assert.equal(out.trim(), 'real')
  })

  await t.test('unrecognised $SHELL: prints instructions, writes no rc file', async () => {
    const home = join(tmp, 'home-fish'), dir = join(tmp, 'not-on-path-fish')
    mkdirSync(home)
    const out = await install(dir, { HOME: home, SHELL: '/usr/local/bin/fish' })
    assert.match(out, /Add it, e\.g\.:/)
    assert.ok(!existsSync(join(home, '.zshrc')))
    assert.ok(!existsSync(join(home, '.bashrc')))
    assert.ok(!existsSync(join(home, '.bash_profile')))
  })
})
