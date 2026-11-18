import { describe, expect, test } from 'bun:test'
import { backgroundWaitAfterStop, pendingBackgroundTaskIds } from './background-tasks'

describe('backgroundWaitAfterStop', () => {
  test('nothing pending and no shells: done', () => {
    expect(backgroundWaitAfterStop(0, 0)).toBe('done')
  })
  test('footer shows running shells: wait (live signal, uncapped)', () => {
    expect(backgroundWaitAfterStop(0, 1)).toBe('wait')
    expect(backgroundWaitAfterStop(2, 1)).toBe('wait')
  })
  test('only the transcript says something is pending: capped wait', () => {
    expect(backgroundWaitAfterStop(1, 0)).toBe('wait-capped')
  })
})

// Line shapes below are copied from real Claude Code transcripts (trimmed to
// the fields the parser reads).
const bashMovedToBackground = (id: string) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `moved to the background (ID: ${id})` }] },
  toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id, timedOutAfterMs: 600000 },
})
const asyncAgentLaunched = (id: string) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${id}` }] }] },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId: id, description: 'Review diff' },
})
const notification = (id: string, status = 'completed') =>
  `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n</task-notification>`
const notificationAsUserMessage = (id: string, status?: string) => JSON.stringify({
  type: 'user', message: { role: 'user', content: notification(id, status) },
})
const notificationAsQueueOperation = (id: string) => JSON.stringify({
  type: 'queue-operation', operation: 'enqueue', content: notification(id),
})
const taskStopped = (id: string) => JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: `{"message":"Successfully stopped task: ${id}"}` }] },
  toolUseResult: { message: `Successfully stopped task: ${id} (sleep 600)`, task_id: id, task_type: 'local_bash' },
})

describe('pendingBackgroundTaskIds', () => {
  test('empty transcript has nothing pending', () => {
    expect(pendingBackgroundTaskIds([])).toEqual(new Set())
  })

  test('a backgrounded bash command is pending until its notification arrives', () => {
    expect(pendingBackgroundTaskIds([bashMovedToBackground('bbycurvg0')])).toEqual(new Set(['bbycurvg0']))
    expect(pendingBackgroundTaskIds([bashMovedToBackground('bbycurvg0'), notificationAsUserMessage('bbycurvg0')])).toEqual(new Set())
  })

  test('an async agent is pending until its notification arrives, even when only recorded as a queue operation', () => {
    expect(pendingBackgroundTaskIds([asyncAgentLaunched('af9bce42fab95c2cd')])).toEqual(new Set(['af9bce42fab95c2cd']))
    expect(pendingBackgroundTaskIds([asyncAgentLaunched('af9bce42fab95c2cd'), notificationAsQueueOperation('af9bce42fab95c2cd')])).toEqual(new Set())
  })

  test('failed and killed notifications also end a task', () => {
    const lines = [bashMovedToBackground('a1'), bashMovedToBackground('a2'), notificationAsUserMessage('a1', 'failed'), notificationAsUserMessage('a2', 'killed')]
    expect(pendingBackgroundTaskIds(lines)).toEqual(new Set())
  })

  test('a task ended with TaskStop is no longer pending (no notification is sent for it)', () => {
    expect(pendingBackgroundTaskIds([bashMovedToBackground('b2k95r14y'), taskStopped('b2k95r14y')])).toEqual(new Set())
  })

  test('the turn that caused the missed Feishu reply: smoke shell + review agent both pending at the first Stop', () => {
    const atFirstStop = [bashMovedToBackground('bbycurvg0'), asyncAgentLaunched('af9bce42fab95c2cd')]
    expect(pendingBackgroundTaskIds(atFirstStop)).toEqual(new Set(['bbycurvg0', 'af9bce42fab95c2cd']))
    const afterSmoke = [...atFirstStop, notificationAsUserMessage('bbycurvg0')]
    expect(pendingBackgroundTaskIds(afterSmoke)).toEqual(new Set(['af9bce42fab95c2cd']))
    const afterReview = [...afterSmoke, notificationAsQueueOperation('af9bce42fab95c2cd')]
    expect(pendingBackgroundTaskIds(afterReview)).toEqual(new Set())
  })

  test('ignores blank, partial and non-JSON lines', () => {
    const lines = ['', '{"type":"user","toolUseResult":{"backgroundTaskId":"tr', 'not json', bashMovedToBackground('ok1')]
    expect(pendingBackgroundTaskIds(lines)).toEqual(new Set(['ok1']))
  })

  test('an agent result without isAsync (a foreground agent) is not counted', () => {
    const line = JSON.stringify({ type: 'user', toolUseResult: { status: 'completed', agentId: 'fg1' } })
    expect(pendingBackgroundTaskIds([line])).toEqual(new Set())
  })

  test('a failed TaskStop does not end the task', () => {
    const line = JSON.stringify({ type: 'user', toolUseResult: { message: 'No task found with ID: z1', task_id: 'z1' } })
    expect(pendingBackgroundTaskIds([bashMovedToBackground('z1'), line])).toEqual(new Set(['z1']))
  })
})
