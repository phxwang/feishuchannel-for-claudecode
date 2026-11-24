import { describe, expect, test } from 'bun:test'
import { buildTmuxDialogCard, createTmuxRouting, handleTmuxDialogChoice, isSessionResetCommand } from './tmux-route'
import type { TmuxCliManager } from './tmux/manager'
import type { TmuxCliProfile } from './tmux/profile'

const buttons = (card: string) => JSON.parse(card).body.elements
  .filter((e: any) => e.tag === 'column_set')
  .map((e: any) => e.columns[0].elements[0])

describe('buildTmuxDialogCard', () => {
  test('cursor dialog marks the row the cursor is on, plus a fixed Esc row', () => {
    const card = buildTmuxDialogCard({ kind: 'cursor', question: 'Switch Model', currentNumber: '2', options: [{ number: '1', label: 'A' }, { number: '2', label: 'B' }] }, 'abc', '❓ Antigravity 需要你选择')
    const b = buttons(card)
    expect(b.map((x: any) => x.text.content)).toEqual(['1. A', '2. B 📍当前', '🚪 Esc'])
    expect(b[1].type).toBe('primary')
    expect(b[0].value).toEqual({ code: 'abc', action: 'tmux_dialog_choice', number: '1' })
    expect(JSON.parse(card).header.title.content).toBe('❓ Antigravity 需要你选择')
  })

  test('numbered dialog highlights option 1 (unchanged Claude behavior)', () => {
    const b = buttons(buildTmuxDialogCard({ kind: 'numbered', question: 'q', options: [{ number: '1', label: 'Yes' }, { number: '2', label: 'No' }] }, 'c', 't'))
    expect(b.map((x: any) => x.type)).toEqual(['primary', 'default', 'danger'])
  })

  test('shows dialog context as plain text so commands cannot break markdown', () => {
    const context = 'Monitor · from the general-purpose agent\n│ echo `whoami` **bold**'
    const els = JSON.parse(buildTmuxDialogCard({ kind: 'numbered', question: 'Do you want to proceed?', context, options: [{ number: '1', label: 'Yes' }] }, 'c', 't')).body.elements
    expect(els[0]).toEqual({ tag: 'markdown', content: 'Do you want to proceed?' })
    expect(els[1]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: context } })
  })

  test('omits the context element when the dialog has none', () => {
    const els = JSON.parse(buildTmuxDialogCard({ kind: 'numbered', question: 'q', options: [{ number: '1', label: 'Yes' }] }, 'c', 't')).body.elements
    expect(els.filter((e: any) => e.tag === 'div')).toEqual([])
  })
})

describe('handleTmuxDialogChoice', () => {
  test('an unknown or stale code is reported as expired', () => {
    expect(handleTmuxDialogChoice('nope', '1')).toEqual({ toast: { type: 'warning', content: '⚠️ 该选择已失效或已处理' } })
  })
})

describe('isSessionResetCommand', () => {
  test.each(['/clear', '/reset', ' /NEW '])('%p resets', (c) => expect(isSessionResetCommand(c)).toBe(true))
  test('other text does not', () => expect(isSessionResetCommand('/clearly not')).toBe(false))
})

/** Fake Feishu client recording created/patched cards and replies. */
function fakeApi() {
  const log: string[] = []
  let n = 0
  return {
    log,
    api: {
      im: {
        message: {
          create: async ({ data }: any) => { const id = `m${++n}`; log.push(`create ${id} ${JSON.parse(data.content).body?.elements?.[0]?.content ?? ''}`); return { data: { message_id: id } } },
          patch: async ({ path, data }: any) => { log.push(`patch ${path.message_id} ${JSON.parse(data.content).body.elements[0].content}`) },
        },
      },
    },
  }
}

function fakeManager(kind: 'claude' | 'agy', behavior: (text: string, opts: any) => Promise<string>, busy = false) {
  const profile = { kind, midTurn: kind === 'agy' ? 'queue' : 'absorb', resumable: kind === 'agy' } as Partial<TmuxCliProfile>
  const calls: string[] = []
  const mgr = {
    profile,
    isBusy: () => busy,
    sendAndAwaitReply: (_w: string, text: string, opts: any) => { calls.push(text); return behavior(text, opts) },
    restartSession: async (_w: string, _s: unknown, fresh: boolean) => { calls.push(`restart fresh=${fresh}`); return 'x' },
    sendEscape: async () => { calls.push('esc') },
    selectOption: async () => true,
  } as unknown as TmuxCliManager
  return { mgr, calls }
}

function routing() {
  const { api, log } = fakeApi()
  const replies: string[] = []
  const r = createTmuxRouting({ api, dbg: () => {}, describeApiError: String, replyText: async (_c, _m, t) => { replies.push(t) }, attachmentDir: '/tmp' })
  return { r, log, replies }
}

const input = (over: Partial<Parameters<ReturnType<typeof createTmuxRouting>['handleTmuxTask']>[1]> = {}) => ({
  workdir: '/w', chatId: 'oc', messageId: 'om', content: 'hi', attachments: [], spawn: {}, fallback: () => null, ...over,
})

describe('handleTmuxTask', () => {
  test('streams text and finalizes the status card', async () => {
    const { r, log, replies } = routing()
    const { mgr } = fakeManager('agy', async (_t, opts) => { opts.onTextChunk('hello'); return 'hello' })
    await r.handleTmuxTask(mgr, input())
    expect(replies).toEqual(['hello'])
    expect(log[0]).toStartWith('create m1 🤔 思考中…')
    expect(log.at(-1)).toBe('patch m1 ✅ 已回复')
  })

  test('agy: a message sent while busy gets a "queued" card that turns into its own reply', async () => {
    const { r, log } = routing()
    const { mgr } = fakeManager('agy', async (_t, opts) => { opts.onTurnStarted(); opts.onTextChunk('second'); return 'second' }, true)
    await r.handleTmuxTask(mgr, input())
    expect(log[0]).toBe('create m1 ⏳ 已排队，将在当前回合结束后处理')
    expect(log.at(-1)).toBe('patch m1 ✅ 已回复')
  })

  test('/restart keeps the agy conversation but starts Claude fresh', async () => {
    const agy = fakeManager('agy', async () => '')
    const claude = fakeManager('claude', async () => '')
    const { r, replies } = routing()
    await r.handleTmuxTask(agy.mgr, input({ content: '/restart' }))
    await r.handleTmuxTask(claude.mgr, input({ content: '/restart' }))
    expect(agy.calls).toEqual(['restart fresh=false'])
    expect(claude.calls).toEqual(['restart fresh=true'])
    expect(replies[0]).toContain('保留会话上下文')
  })

  test('/clear always starts a fresh session', async () => {
    const agy = fakeManager('agy', async () => '')
    const { r } = routing()
    await r.handleTmuxTask(agy.mgr, input({ content: '/clear' }))
    expect(agy.calls).toEqual(['restart fresh=true'])
  })

  test('a pre-delivery failure hands the task to the fallback', async () => {
    const { r, log } = routing()
    const { mgr } = fakeManager('agy', async () => { throw new Error('agy exited during startup') })
    const reasons: string[] = []
    await r.handleTmuxTask(mgr, input({ fallback: (reason) => { reasons.push(reason); return 'OpenCode' } }))
    expect(reasons).toEqual(['agy exited during startup'])
    expect(log.at(-1)).toBe('patch m1 ⚠️ 已切换到 OpenCode 处理')
  })

  test('an unavailable backend never receives the message and goes to fallback', async () => {
    const { r } = routing()
    const { mgr, calls } = fakeManager('agy', async () => 'should not run')
    let fellBack = false
    await r.handleTmuxTask(mgr, input({ unavailableReason: () => 'quota', fallback: () => { fellBack = true; return 'OpenCode' } }))
    expect(calls).toEqual([])
    expect(fellBack).toBe(true)
  })

  test('a dialog becomes a card; clicking it answers the CLI and a later click is stale', async () => {
    const { api, log } = fakeApi()
    const cards: string[] = []
    const origCreate = api.im.message.create
    api.im.message.create = async (args: any) => { cards.push(args.data.content); return origCreate(args) }
    const r = createTmuxRouting({ api, dbg: () => {}, describeApiError: String, replyText: async () => {}, attachmentDir: '/tmp' })
    const choices: number[] = []
    const { mgr } = fakeManager('agy', async (_t, opts) => {
      const chosen = opts.onDialog({ kind: 'numbered', question: 'Run this command?', options: [{ number: '1', label: 'Yes' }, { number: '2', label: 'No' }] })
      // Simulate the user's click on option 2 of the card that was just sent.
      await Bun.sleep(10)
      const dialogCard = cards.find(c => c.includes('tmux_dialog_choice'))!
      const code = buttons(dialogCard)[0].value.code
      const response = handleTmuxDialogChoice(code, '2') as any
      expect(response.toast).toEqual({ type: 'success', content: '已选择第 2 项' })
      expect(response.card.data.header.title.content).toBe('❓ Antigravity 需要你选择 — 已选择第 2 项')
      expect(handleTmuxDialogChoice(code, '1')).toEqual({ toast: { type: 'warning', content: '⚠️ 该选择已失效或已处理' } })
      choices.push(await chosen)
      return ''
    })
    await r.handleTmuxTask(mgr, input())
    expect(choices).toEqual([2])
    expect(log.at(-1)).toBe('patch m1 ⚠️ 未产生文本回复')
  })

  test('/esc cancels a pending dialog card before sending Escape', async () => {
    const { r } = routing()
    let pending: Promise<number> | null = null
    const busyMgr = fakeManager('agy', async (_t, opts) => {
      pending = opts.onDialog({ kind: 'numbered', question: 'q', options: [{ number: '1', label: 'Yes' }] })
      return new Promise(() => {})  // turn never finishes on its own
    })
    void r.handleTmuxTask(busyMgr.mgr, input())
    await Bun.sleep(10)
    const escMgr = fakeManager('agy', async () => '')
    await r.handleTmuxTask(escMgr.mgr, input({ content: '/esc' }))
    expect(escMgr.calls).toEqual(['esc'])
    expect(await pending!).toBe(-2)  // explicit cancellation, not a timeout
  })

  test('a slash command with no text output is shown as executed, not as a missing reply', async () => {
    const { r, log } = routing()
    const { mgr } = fakeManager('agy', async () => '')
    await r.handleTmuxTask(mgr, input({ content: '/model' }))
    expect(log.at(-1)).toBe('patch m1 ✅ 已执行 /model')
  })

  test('without a fallback the failure is reported', async () => {
    const { r, replies, log } = routing()
    const { mgr } = fakeManager('agy', async () => { throw new Error('boom') })
    await r.handleTmuxTask(mgr, input())
    expect(replies).toEqual(['⚠️ Antigravity (tmux) 执行失败：boom'])
    expect(log.at(-1)).toBe('patch m1 ⚠️ 执行失败')
  })
})
