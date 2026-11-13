import { describe, expect, test } from 'bun:test'
import { ProgressCard, TextDelivery, safeSummary, splitUnicode } from './presentation'
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const p = (text: string, partId = 'p', messageId = 'm') => ({ text, partId, messageId })

describe('per-part confirmed delivery ledger', () => {
  test('streamed intermediate explanation cannot suppress a different final assistant', async () => {
    const sent: string[] = []
    const ledger = new TextDelivery(async s => { sent.push(s) }, true, 1)
    ledger.snapshot(p('I will check'))
    await sleep(10)
    expect(sent).toEqual(['I will check'])
    const result = await ledger.finalize([p('I will check'), p('Final conclusion', 'p2', 'm2')])
    expect(sent).toEqual(['I will check', 'Final conclusion'])
    expect(result.delivered).toBe(true)
  })
  test('coalesces snapshots, ignores old prefixes, preserves Unicode and whitespace', async () => {
    const sent: string[] = [], ledger = new TextDelivery(async s => { sent.push(s) }, true, 2)
    ledger.snapshot(p('a')); ledger.snapshot(p('a😀')); ledger.snapshot(p('a'))
    await sleep(10)
    await ledger.finalize([p('a😀 \nfinal')])
    expect(sent.join('')).toBe('a😀 \nfinal')
    expect(splitUnicode('a😀b', 2)).toEqual(['a', '😀', 'b'])
  })
  test('non-prefix revisions use explicit final correction rather than guessed suffix', async () => {
    const sent: string[] = [], ledger = new TextDelivery(async s => { sent.push(s) }, true, 1)
    ledger.snapshot(p('old')); await sleep(5)
    ledger.snapshot(p('NEW longer')); await sleep(5)
    expect(sent).toEqual(['old'])
    await ledger.finalize([p('NEW longer')])
    expect(sent).toEqual(['old', '【更新版】\nNEW longer'])
  })
  test('failure never advances delivery; uncertain outcome is explicitly reconciled', async () => {
    const sent: string[] = []; let fails = true
    const ledger = new TextDelivery(async s => { if (fails) throw new Error('lost ack'); sent.push(s) }, true, 1)
    ledger.snapshot(p('answer')); await sleep(5); fails = false
    expect((await ledger.finalize([p('answer')])).delivered).toBe(true)
    expect(sent).toEqual(['【补发：此前发送状态未确认】\nanswer'])
  })
  test('permanent failure is distinct from execution success, and bounded buffer final still sends', async () => {
    const ledger = new TextDelivery(async () => { throw new Error('403') }, true, 1, 2, 1)
    ledger.snapshot(p('large')); ledger.snapshot(p('second', 'p2'))
    expect((await ledger.finalize([p('large'), p('second', 'p2')])).delivered).toBe(false)
  })
  test('slow sender never blocks snapshot ingestion and final waits for acknowledged send', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r }); const sent: string[] = []
    const ledger = new TextDelivery(async s => { await gate; sent.push(s) }, true, 1)
    ledger.snapshot(p('first')); await sleep(5); ledger.snapshot(p('first plus'))
    release(); await ledger.finalize([p('first plus')]); expect(sent.join('')).toBe('first plus')
  })
})

describe('independent serial progress cards', () => {
  test('same-named parallel tools, late running and permission state', async () => {
    const lines: string[] = [], card = new ProgressCard(async s => { lines.push(s) }, 1, 10000)
    const a = { taskId: 't', toolName: 'bash', messageId: 'm', partId: 'a', callId: 'a' }
    card.event({ type: 'tool.started', ...a }); card.event({ type: 'tool.started', ...a, partId: 'b', callId: 'b' })
    await sleep(5); expect(lines.at(-1)).toContain('另有 1')
    card.event({ type: 'tool.completed', ...a }); card.event({ type: 'tool.started', ...a })
    await sleep(5); expect(lines.at(-1)).toContain('🔧'); expect(lines.at(-1)).not.toContain('另有')
    card.event({ type: 'permission.requested', taskId: 't', requestId: 'r', toolName: 'bash', description: 'x' })
    await sleep(5); expect(lines.at(-1)).toContain('等待你的授权')
    card.permissionResolved('r'); await sleep(5); expect(lines.at(-1)).toContain('🔧')
    await card.finalize('done')
  })
  test('in-flight patch completes before terminal; finalize idempotent, late events ignored', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r }), lines: string[] = []
    const card = new ProgressCard(async s => { if (s !== 'done') await gate; lines.push(s) }, 1, 2)
    card.event({ type: 'text.snapshot', taskId: 't', ...p('a') }); await sleep(5)
    const closing = card.finalize('done'); expect(card.finalize('other')).toBe(closing)
    card.event({ type: 'text.snapshot', taskId: 't', ...p('late') }); release(); await closing; await sleep(5)
    expect(lines.at(-1)).toBe('done'); expect(lines.filter(x => x === 'done').length).toBe(1)
  })
  test('summary redaction precedes truncation and commands are not needed', () => {
    expect(safeSummary('Bearer abcsecret token=hello https://u:p@host sk-12345')).not.toMatch(/abcsecret|hello|u:p|12345/)
  })
})
