import { describe, test, expect } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireRouterLock, releaseRouterLock } from './router-lock'

describe('router singleton lock', () => {
  test('only one live owner can acquire the lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'feishu-router-lock-'))
    const lock = join(root, 'router.lock')
    try {
      expect(acquireRouterLock(lock, 111, pid => pid === 111)).toBe(true)
      expect(acquireRouterLock(lock, 222, pid => pid === 111)).toBe(false)
    } finally {
      releaseRouterLock(lock)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('reclaims a stale owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'feishu-router-lock-'))
    const lock = join(root, 'router.lock')
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'pid'), '111\n')
      expect(acquireRouterLock(lock, 222, () => false)).toBe(true)
    } finally {
      releaseRouterLock(lock)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── Pure function extractions for testing ──────────────────────────────────
// These mirror logic in server.ts / router.ts without importing the full
// modules (which have side-effects: WebSocket, MCP transport, process exit).

// ---------- chunkText ----------

function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []; let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

describe('chunkText', () => {
  test('short text returns single chunk', () => {
    expect(chunkText('hello', 100)).toEqual(['hello'])
  })

  test('empty text returns single chunk', () => {
    expect(chunkText('', 100)).toEqual([''])
  })

  test('splits on paragraph boundary', () => {
    const text = 'first paragraph\n\nsecond paragraph'
    const chunks = chunkText(text, 20)
    expect(chunks[0]).toBe('first paragraph')
    expect(chunks.length).toBe(2)
  })

  test('splits on line boundary when no paragraph break', () => {
    const text = 'line one\nline two\nline three'
    const chunks = chunkText(text, 15)
    expect(chunks[0]).toBe('line one')
    expect(chunks.length).toBeGreaterThan(1)
  })

  test('splits on space when no line break', () => {
    const text = 'word1 word2 word3 word4 word5'
    const chunks = chunkText(text, 12)
    expect(chunks.every(c => c.length <= 12)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('word1')
  })

  test('hard splits when no break points', () => {
    const text = 'a'.repeat(30)
    const chunks = chunkText(text, 10)
    expect(chunks.every(c => c.length <= 10)).toBe(true)
    expect(chunks.join('')).toBe(text)
  })
})

// ---------- gate logic ----------

type PendingEntry = { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number }
type GroupPolicy = { requireMention: boolean; allowFrom: string[] }
type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  p2pChats: Record<string, string>
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  ackReaction?: string
  textChunkLimit?: number
}

function gate(a: Access, senderId: string, chatId: string, chatType: string, mentioned: boolean):
  { action: 'deliver' } | { action: 'drop' } | { action: 'pair'; code: string; isResend: boolean } {
  if (a.dmPolicy === 'disabled') return { action: 'drop' }
  if (chatType === 'p2p') {
    if (a.allowFrom.includes(senderId)) return { action: 'deliver' }
    if (a.dmPolicy === 'allowlist') return { action: 'drop' }
    for (const [code, p] of Object.entries(a.pending)) {
      if (p.senderId === senderId) {
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        return { action: 'pair', code, isResend: true }
      }
    }
    if (Object.keys(a.pending).length >= 3) return { action: 'drop' }
    return { action: 'pair', code: 'test-code', isResend: false }
  }
  const policy = a.groups[chatId]
  if (!policy) return { action: 'drop' }
  if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(senderId)) return { action: 'drop' }
  if ((policy.requireMention ?? true) && !mentioned) return { action: 'drop' }
  return { action: 'deliver' }
}

function baseAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], p2pChats: {}, groups: {}, pending: {}, ackReaction: 'Get' }
}

describe('gate — DM policies', () => {
  test('disabled policy drops all', () => {
    const a = { ...baseAccess(), dmPolicy: 'disabled' as const }
    expect(gate(a, 'ou_user', 'oc_chat', 'p2p', false).action).toBe('drop')
  })

  test('allowed user delivers', () => {
    const a = { ...baseAccess(), allowFrom: ['ou_user'] }
    expect(gate(a, 'ou_user', 'oc_chat', 'p2p', false).action).toBe('deliver')
  })

  test('unknown user in allowlist mode drops', () => {
    const a = { ...baseAccess(), dmPolicy: 'allowlist' as const }
    expect(gate(a, 'ou_unknown', 'oc_chat', 'p2p', false).action).toBe('drop')
  })

  test('unknown user in pairing mode gets code', () => {
    const a = baseAccess()
    const result = gate(a, 'ou_unknown', 'oc_chat', 'p2p', false)
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.isResend).toBe(false)
    }
  })

  test('pending user gets resend', () => {
    const a = { ...baseAccess(), pending: { abc123: { senderId: 'ou_user', chatId: 'oc_chat', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 1 } } }
    const result = gate(a, 'ou_user', 'oc_chat', 'p2p', false)
    expect(result.action).toBe('pair')
    if (result.action === 'pair') {
      expect(result.isResend).toBe(true)
      expect(result.code).toBe('abc123')
    }
  })

  test('pending user with 2+ replies gets dropped', () => {
    const a = { ...baseAccess(), pending: { abc123: { senderId: 'ou_user', chatId: 'oc_chat', createdAt: Date.now(), expiresAt: Date.now() + 3600000, replies: 2 } } }
    expect(gate(a, 'ou_user', 'oc_chat', 'p2p', false).action).toBe('drop')
  })

  test('too many pending drops new users', () => {
    const now = Date.now()
    const pending: Record<string, PendingEntry> = {
      a: { senderId: 'ou_1', chatId: 'oc_1', createdAt: now, expiresAt: now + 3600000, replies: 1 },
      b: { senderId: 'ou_2', chatId: 'oc_2', createdAt: now, expiresAt: now + 3600000, replies: 1 },
      c: { senderId: 'ou_3', chatId: 'oc_3', createdAt: now, expiresAt: now + 3600000, replies: 1 },
    }
    const a = { ...baseAccess(), pending }
    expect(gate(a, 'ou_new', 'oc_new', 'p2p', false).action).toBe('drop')
  })
})

describe('gate — group policies', () => {
  test('unconfigured group drops', () => {
    const a = baseAccess()
    expect(gate(a, 'ou_user', 'oc_group', 'group', true).action).toBe('drop')
  })

  test('configured group without mention drops when requireMention', () => {
    const a = { ...baseAccess(), groups: { oc_group: { requireMention: true, allowFrom: [] } } }
    expect(gate(a, 'ou_user', 'oc_group', 'group', false).action).toBe('drop')
  })

  test('configured group with mention delivers', () => {
    const a = { ...baseAccess(), groups: { oc_group: { requireMention: true, allowFrom: [] } } }
    expect(gate(a, 'ou_user', 'oc_group', 'group', true).action).toBe('deliver')
  })

  test('group with allowFrom restricts users', () => {
    const a = { ...baseAccess(), groups: { oc_group: { requireMention: false, allowFrom: ['ou_allowed'] } } }
    expect(gate(a, 'ou_other', 'oc_group', 'group', false).action).toBe('drop')
    expect(gate(a, 'ou_allowed', 'oc_group', 'group', false).action).toBe('deliver')
  })

  test('group without requireMention delivers any message', () => {
    const a = { ...baseAccess(), groups: { oc_group: { requireMention: false, allowFrom: [] } } }
    expect(gate(a, 'ou_user', 'oc_group', 'group', false).action).toBe('deliver')
  })
})

// ---------- checkMention ----------

function checkMention(mentions: any[], text: string, botId: string | null, extra?: string[]): boolean {
  for (const m of mentions) {
    if (m.mentioned_type === 'bot') return true
    if (botId && m.id?.open_id === botId) return true
  }
  for (const p of extra ?? []) { try { if (new RegExp(p, 'i').test(text)) return true } catch {} }
  return false
}

describe('checkMention', () => {
  test('bot mention type returns true', () => {
    expect(checkMention([{ mentioned_type: 'bot' }], '', null)).toBe(true)
  })

  test('matching botOpenId returns true', () => {
    expect(checkMention([{ id: { open_id: 'ou_bot' } }], '', 'ou_bot')).toBe(true)
  })

  test('no match returns false', () => {
    expect(checkMention([{ mentioned_type: 'user' }], 'hello', null)).toBe(false)
  })

  test('custom pattern match', () => {
    expect(checkMention([], '@claude help', null, ['@claude'])).toBe(true)
  })

  test('custom pattern case insensitive', () => {
    expect(checkMention([], '@CLAUDE help', null, ['@claude'])).toBe(true)
  })

  test('invalid regex pattern is skipped', () => {
    expect(checkMention([], 'hello', null, ['[invalid'])).toBe(false)
  })
})

// ---------- PERMISSION_REPLY_RE ----------

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

describe('PERMISSION_REPLY_RE', () => {
  test('y + 5-char code matches', () => {
    const m = PERMISSION_REPLY_RE.exec('y abcde')
    expect(m).not.toBeNull()
    expect(m![1]).toBe('y')
    expect(m![2]).toBe('abcde')
  })

  test('YES + code matches', () => {
    expect(PERMISSION_REPLY_RE.test('YES abcde')).toBe(true)
  })

  test('no + code matches', () => {
    expect(PERMISSION_REPLY_RE.test('no abcde')).toBe(true)
  })

  test('rejects code with l', () => {
    expect(PERMISSION_REPLY_RE.test('y abcle')).toBe(false)
  })

  test('rejects short code', () => {
    expect(PERMISSION_REPLY_RE.test('y abc')).toBe(false)
  })

  test('rejects extra text', () => {
    expect(PERMISSION_REPLY_RE.test('y abcde extra')).toBe(false)
  })
})

// ---------- genConfirmCode ----------

const CONFIRM_CHARS = 'abcdefghijkmnopqrstuvwxyz'

function genConfirmCode(): string {
  const bytes = new Uint8Array(5)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => CONFIRM_CHARS[b % CONFIRM_CHARS.length]).join('')
}

describe('genConfirmCode', () => {
  test('generates 5-char code', () => {
    expect(genConfirmCode().length).toBe(5)
  })

  test('code never contains l', () => {
    for (let i = 0; i < 100; i++) {
      expect(genConfirmCode()).not.toContain('l')
    }
  })

  test('code matches permission regex', () => {
    for (let i = 0; i < 50; i++) {
      const code = genConfirmCode()
      expect(PERMISSION_REPLY_RE.test(`y ${code}`)).toBe(true)
    }
  })
})

// ---------- assertAllowedChat ----------

function assertAllowedChat(chatId: string, a: Access) {
  const oid = a.p2pChats[chatId]
  if (oid !== undefined && a.allowFrom.includes(oid)) return
  if (a.allowFrom.includes(chatId)) return
  if (chatId in a.groups) return
  throw new Error(`chat ${chatId} is not allowlisted`)
}

describe('assertAllowedChat', () => {
  test('p2p chat with allowed user passes', () => {
    const a = { ...baseAccess(), p2pChats: { oc_chat: 'ou_user' }, allowFrom: ['ou_user'] }
    expect(() => assertAllowedChat('oc_chat', a)).not.toThrow()
  })

  test('group chat passes', () => {
    const a = { ...baseAccess(), groups: { oc_group: { requireMention: true, allowFrom: [] } } }
    expect(() => assertAllowedChat('oc_group', a)).not.toThrow()
  })

  test('unknown chat throws', () => {
    expect(() => assertAllowedChat('oc_unknown', baseAccess())).toThrow('not allowlisted')
  })

  test('p2p chat with removed user throws', () => {
    const a = { ...baseAccess(), p2pChats: { oc_chat: 'ou_user' }, allowFrom: [] }
    expect(() => assertAllowedChat('oc_chat', a)).toThrow('not allowlisted')
  })
})

// ---------- router: resolveWorkdir ----------

type RouterAccess = {
  groups: Record<string, { workdir?: string }>
  defaultWorkdir?: string
}

function resolveWorkdir(access: RouterAccess, chatId: string, chatType: string): string | undefined {
  if (chatType === 'group') {
    const wd = access.groups[chatId]?.workdir
    if (wd) return wd
  }
  return access.defaultWorkdir
}

describe('resolveWorkdir', () => {
  const access: RouterAccess = {
    groups: {
      oc_groupA: { workdir: '/path/to/project-a' },
      oc_groupB: {},
    },
    defaultWorkdir: '/path/to/default',
  }

  test('group with workdir returns workdir', () => {
    expect(resolveWorkdir(access, 'oc_groupA', 'group')).toBe('/path/to/project-a')
  })

  test('group without workdir falls back to default', () => {
    expect(resolveWorkdir(access, 'oc_groupB', 'group')).toBe('/path/to/default')
  })

  test('unknown group falls back to default', () => {
    expect(resolveWorkdir(access, 'oc_unknown', 'group')).toBe('/path/to/default')
  })

  test('p2p always returns default', () => {
    expect(resolveWorkdir(access, 'oc_groupA', 'p2p')).toBe('/path/to/default')
  })

  test('no defaultWorkdir returns undefined', () => {
    const a: RouterAccess = { groups: {} }
    expect(resolveWorkdir(a, 'oc_any', 'p2p')).toBeUndefined()
  })
})
