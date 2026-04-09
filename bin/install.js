#!/usr/bin/env node
/**
 * One-command installer for Feishu Channel for Claude Code.
 * Usage: npx feishuchannel-for-claudecode
 */

const { execSync } = require('child_process')
const { existsSync, mkdirSync } = require('fs')
const { join } = require('path')
const { homedir } = require('os')

const REPO = 'https://github.com/phxwang/feishuchannel-for-claudecode.git'
const INSTALL_DIR = join(homedir(), '.local', 'share', 'feishuchannel-for-claudecode')

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

function checkBin(cmd, hint) {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' })
    return true
  } catch {
    console.error(`\x1b[31mError:\x1b[0m ${cmd} not found. ${hint}`)
    return false
  }
}

// ── Prerequisites ──────────────────────────────────────────────────────────

let ok = true
if (!checkBin('bun', 'Install: https://bun.sh')) ok = false
if (!checkBin('claude', 'Install: https://docs.anthropic.com/en/docs/claude-code')) ok = false
if (!ok) process.exit(1)

console.log('\nInstalling Feishu Channel for Claude Code...\n')

// ── Clone or update ────────────────────────────────────────────────────────

if (existsSync(join(INSTALL_DIR, '.git'))) {
  console.log('Updating existing installation...')
  run('git pull', { cwd: INSTALL_DIR })
} else {
  mkdirSync(join(homedir(), '.local', 'share'), { recursive: true })
  run(`git clone "${REPO}" "${INSTALL_DIR}"`)
}

// ── Install dependencies + create claude-feishu shortcut ───────────────────

run('bun install', { cwd: INSTALL_DIR })

// ── Register plugin ────────────────────────────────────────────────────────

try {
  run(`claude plugin marketplace add "${INSTALL_DIR}"`)
} catch {
  // marketplace already registered — continue
}

try {
  run('claude plugin install feishu@feishu-local')
} catch {
  // plugin already installed — continue
}

// ── Done ───────────────────────────────────────────────────────────────────

console.log(`
\x1b[32mDone!\x1b[0m Next steps:

  1. Start Claude with Feishu channel:
     $ claude-feishu

  2. Configure credentials (in Claude Code terminal):
     /feishu:auth <app_id> <app_secret>

  3. Pair your Feishu account — send a message to the bot, then:
     /feishu:access pair <code>
`)
