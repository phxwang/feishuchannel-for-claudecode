/**
 * Feishu side of the tmux-hosted CLI backends (Claude Code `agent.mode:
 * 'tmux'` and Antigravity `agent.primary: 'agy'`): dialog cards, the live
 * "🤔 思考中…" status card, pane screenshots, session-management commands
 * (/esc /restart /select /clear), streaming replies and pre-delivery
 * fallback. Moved out of router.ts so both CLIs share it; router.ts only
 * wires dependencies and dispatches.
 *
 * Fallback contract: `TmuxCliManager.sendAndAwaitReply` throwing always
 * means the message never reached the CLI, so it's provably safe to hand
 * the task to another backend (see tmux/manager.ts).
 */
import { randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync, writeFileSync } from 'fs'
import { chunkText, MAX_CHUNK } from './chunk-text'
import { sendFeishuFile } from './feishu-attachment'
import { downloadFeishuResource } from './feishu-download'
import { renderPaneScreenshot } from './pane-screenshot'
import { DIALOG_ESCAPE_CHOICE, DIALOG_TIMED_OUT_CHOICE, type TmuxCliManager } from './tmux/manager'
import type { Dialog } from './tmux/dialog'
import type { ProgressEvent, SpawnOptions } from './tmux/profile'

export interface AttachmentRef { fileKey: string; type: 'file' | 'image'; fileName: string }

export interface TmuxRouteDeps {
  api: any
  dbg: (msg: string) => void
  describeApiError: (e: unknown) => string
  replyText: (chatId: string, messageId: string, text: string) => Promise<void>
  attachmentDir: string
}

export interface TmuxTaskInput {
  workdir: string
  chatId: string
  messageId: string
  content: string
  attachments: AttachmentRef[]
  spawn: SpawnOptions
  /**
   * Called only on a pre-delivery failure. Starts the fallback backend and
   * returns its display name, or null when no fallback applies.
   */
  fallback: (reason: string) => string | null
  /** Pre-delivery: true while this backend is known unavailable (e.g. quota exhausted) — goes straight to fallback. */
  unavailableReason?: () => string | null
  /** A turn stopped with an error the CLI reported (agy: quota/spend-cap errors). */
  onStopError?: (error: string) => void
}

/** Human-facing names per CLI kind. */
const NAMES = {
  claude: { short: 'Claude', long: 'Claude Code (tmux)' },
  agy: { short: 'Antigravity', long: 'Antigravity (tmux)' },
} as const

/**
 * `-2`: "explicitly cancelled" (by /esc, /restart …), distinct from
 * DIALOG_TIMED_OUT_CHOICE (-1) so only a genuine timeout makes the manager
 * send an automatic Escape.
 */
const DIALOG_CANCELLED = -2
const DIALOG_TIMEOUT_MS = 30 * 60 * 1000
const STATUS_CARD_PATCH_COOLDOWN_MS = 1_500
/** Re-patch the elapsed time even without new progress, so one long tool call doesn't look stuck. */
const STATUS_CARD_HEARTBEAT_MS = 15_000
const QUEUED_LINE = '⏳ 已排队，将在当前回合结束后处理'
const THINKING_LINE = '🤔 思考中…'
const SESSION_RESET_COMMANDS = new Set(['/clear', '/reset', '/new'])

export function isSessionResetCommand(text: string): boolean {
  return SESSION_RESET_COMMANDS.has(text.trim().toLowerCase())
}

function formatElapsed(startMs: number): string {
  const s = Math.floor((Date.now() - startMs) / 1000)
  if (s < 60) return `${s}秒`
  return `${Math.floor(s / 60)}分${s % 60}秒`
}

/** Pending dialog cards, keyed by card code. `key` is `<kind>:<workdir>` so Claude and agy sessions on the same workdir never cancel each other's cards. */
const PENDING_DIALOGS = new Map<string, { key: string; title: string; resolve: (choice: number) => void }>()

function dialogKey(mgr: TmuxCliManager, workdir: string): string {
  return `${mgr.profile.kind}:${workdir}`
}

function cancelPendingDialogs(key: string) {
  for (const [code, entry] of PENDING_DIALOGS) {
    if (entry.key !== key) continue
    PENDING_DIALOGS.delete(code)
    entry.resolve(DIALOG_CANCELLED)
  }
}

function hasPendingDialogFor(key: string): boolean {
  for (const entry of PENDING_DIALOGS.values()) if (entry.key === key) return true
  return false
}

/**
 * Card click for a tmux dialog (action `tmux_dialog_choice`). Returns the
 * Feishu card-action response.
 */
export function handleTmuxDialogChoice(code: string, rawNumber: unknown): Record<string, unknown> {
  const entry = PENDING_DIALOGS.get(code)
  const number = Number(rawNumber)
  if (!entry || !Number.isFinite(number)) return { toast: { type: 'warning', content: '⚠️ 该选择已失效或已处理' } }
  PENDING_DIALOGS.delete(code)
  entry.resolve(number)
  const label = number === DIALOG_ESCAPE_CHOICE ? '已发送 Esc' : `已选择第 ${rawNumber} 项`
  return {
    toast: { type: 'success', content: label },
    card: {
      type: 'raw',
      data: {
        schema: '2.0', config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: `${entry.title} — ${label}` }, template: 'green' },
        body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${label}**` }] },
      },
    },
  }
}

/**
 * Schema 2.0 card: one full-width button row per option plus a fixed
 * 🚪 Esc row (a best-effort terminal scrape always needs a safe way out).
 * The row marked 📍当前 is the focused tab ('tabs'), the cursor row
 * ('cursor'), or option 1 ('numbered').
 */
export function buildTmuxDialogCard(dialog: Dialog, code: string, title: string): string {
  const isCurrent = (n: string) => dialog.kind === 'numbered' ? n === '1' : n === dialog.currentNumber
  const rows = [
    ...dialog.options.map(o => ({ number: o.number, label: `${o.number}. ${o.label}${isCurrent(o.number) ? ' 📍当前' : ''}`, type: isCurrent(o.number) ? 'primary' : 'default' })),
    { number: String(DIALOG_ESCAPE_CHOICE), label: '🚪 Esc', type: 'danger' },
  ]
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown', content: dialog.question },
        { tag: 'hr' },
        ...rows.map(({ number, label, type }) => ({
          tag: 'column_set',
          columns: [{
            tag: 'column', width: 'weighted', weight: 1,
            elements: [{ tag: 'button', text: { tag: 'plain_text', content: label }, type, value: { code, action: 'tmux_dialog_choice', number }, width: 'fill' }],
          }],
        })),
      ],
    },
  })
}

/** Must carry `config.update_multi: true` or im.message.patch rejects the update. */
function buildStatusCard(title: string, line: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
    body: { elements: [{ tag: 'markdown', content: line }] },
  })
}

export function createTmuxRouting(deps: TmuxRouteDeps) {
  const { api, dbg, describeApiError, replyText } = deps

  function makeDialogHandler(key: string, title: string, chatId: string, messageId: string) {
    return async (dialog: Dialog): Promise<number> => {
      const code = randomBytes(5).toString('hex')
      dbg(`tmux: dialog detected for ${key} ("${dialog.question}"), sending choice card ${code}`)
      try {
        await api.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: buildTmuxDialogCard(dialog, code, title) },
        })
      } catch (e) { dbg(`tmux: dialog card send failed: ${describeApiError(e)}`) }
      // Bounded: an unanswered card would otherwise hold the workdir's reply
      // wait (and this map entry) forever.
      return new Promise<number>(resolve => {
        const timer = setTimeout(() => {
          if (!PENDING_DIALOGS.delete(code)) return
          dbg(`tmux: dialog ${code} for ${key} timed out waiting for a Feishu click`)
          void replyText(chatId, messageId, '⚠️ 等待选择超时，已取消本次操作，可以重新发送消息。')
          resolve(DIALOG_TIMED_OUT_CHOICE)
        }, DIALOG_TIMEOUT_MS)
        PENDING_DIALOGS.set(code, { key, title, resolve: (choice) => { clearTimeout(timer); resolve(choice) } })
      })
    }
  }

  /** Render an ANSI pane capture to PNG and send it; silently skipped without a cached Chromium. */
  async function sendPaneScreenshot(chatId: string, paneAnsiText: string, dbgTag: string): Promise<void> {
    const png = await renderPaneScreenshot(paneAnsiText)
    if (!png) { dbg(`${dbgTag}: screenshot unavailable (no cached Chromium build)`); return }
    const pngPath = join(tmpdir(), `tmux-pane-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
    try {
      writeFileSync(pngPath, png)
      await sendFeishuFile(api, chatId, pngPath, 'cli-session.png')
    } finally {
      try { unlinkSync(pngPath) } catch (e) { dbg(`${dbgTag}: failed to clean up pane screenshot ${pngPath}: ${e}`) }
    }
  }

  async function patchStatusCard(messageId: string, title: string, line: string): Promise<void> {
    try {
      await api.im.message.patch({ path: { message_id: messageId }, data: { content: buildStatusCard(title, line) } })
    } catch (e) { dbg(`tmux: status card patch failed: ${describeApiError(e)}`) }
  }

  /**
   * Live status card: throttled to one patch per 1.5s (always the latest
   * line, never a backlog), 15s heartbeat for elapsed time, and quiet while
   * a dialog card for the same session is pending.
   */
  function makeStatusCard(chatId: string, key: string, title: string, initialLine = THINKING_LINE) {
    let messageId: string | null = null
    let latestLine = initialLine
    let lastPatchMs = 0
    let pendingTimer: ReturnType<typeof setTimeout> | null = null
    let finalized = false
    let startMs = Date.now()

    const ready: Promise<string | null> = (async () => {
      try {
        const r = await api.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: buildStatusCard(title, latestLine) },
        })
        return r?.data?.message_id ?? r?.message_id ?? null
      } catch (e) {
        dbg(`tmux: status card create failed: ${describeApiError(e)}`)
        return null
      }
    })().then(id => { messageId = id; return id })

    async function flush() {
      if (finalized) return
      await ready
      if (!messageId || hasPendingDialogFor(key)) return
      lastPatchMs = Date.now()
      await patchStatusCard(messageId, title, latestLine === QUEUED_LINE ? latestLine : `${latestLine} ⏱ ${formatElapsed(startMs)}`)
    }

    function scheduleFlush() {
      if (pendingTimer || finalized) return
      const wait = Math.max(0, lastPatchMs + STATUS_CARD_PATCH_COOLDOWN_MS - Date.now())
      pendingTimer = setTimeout(() => { pendingTimer = null; void flush() }, wait)
    }

    const heartbeatTimer = setInterval(() => { if (latestLine !== QUEUED_LINE) void flush() }, STATUS_CARD_HEARTBEAT_MS)

    function setLine(line: string) {
      latestLine = line
      if (Date.now() - lastPatchMs >= STATUS_CARD_PATCH_COOLDOWN_MS) void flush()
      else scheduleFlush()
    }

    return {
      onProgress(events: ProgressEvent[]) {
        if (finalized || !events.length || hasPendingDialogFor(key)) return
        const last = events[events.length - 1]
        setLine(last.summary ? `🔧 ${last.tool}: ${last.summary}` : `🔧 ${last.tool}`)
      },
      /** A queued message's own turn has begun: switch from "queued" to "thinking" and restart the clock. */
      turnStarted() {
        if (finalized) return
        startMs = Date.now()
        setLine(THINKING_LINE)
      },
      async finalize(line: string) {
        finalized = true
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
        clearInterval(heartbeatTimer)
        const id = await ready
        if (id) await patchStatusCard(id, title, line)
      },
    }
  }

  async function downloadAttachments(input: TmuxTaskInput, tag: string): Promise<string> {
    if (!input.attachments.length) return input.content
    const notes: string[] = []
    for (const att of input.attachments) {
      try {
        const path = await downloadFeishuResource(api, deps.attachmentDir, input.messageId, att.fileKey, att.type, att.fileName)
        notes.push(`[附件已保存: ${path}]`)
      } catch (e) {
        dbg(`${tag}: attachment download failed (${att.fileKey}): ${e}`)
        notes.push(`[附件下载失败: ${att.fileName}]`)
      }
    }
    return `${input.content}\n\n${notes.join('\n')}`
  }

  /** /esc, /restart, /select <n>, /clear|/reset|/new — handled here, never typed into the CLI as chat. Returns true if handled. */
  async function handleSessionCommand(mgr: TmuxCliManager, input: TmuxTaskInput, key: string): Promise<boolean> {
    const { workdir, chatId, messageId } = input
    const names = NAMES[mgr.profile.kind]
    const trimmed = input.content.trim()
    const selectMatch = trimmed.match(/^\/select\s+(\d+)$/)
    const isReset = isSessionResetCommand(trimmed)
    if (trimmed !== '/esc' && trimmed !== '/restart' && !isReset && !selectMatch) return false
    // Cancel pending cards first: a click after /restart would otherwise hit
    // a brand-new session under the same tmux name.
    cancelPendingDialogs(key)
    if (trimmed === '/esc') {
      await mgr.sendEscape(workdir)
      void replyText(chatId, messageId, '✅ 已发送 Esc')
    } else if (trimmed === '/restart') {
      // A resumable CLI (agy) keeps its conversation across a restart; Claude starts fresh.
      const keep = mgr.profile.resumable
      await mgr.restartSession(workdir, input.spawn, !keep)
      void replyText(chatId, messageId, keep ? `✅ ${names.long} 已重启（保留会话上下文）` : `✅ ${names.long} 已重启`)
    } else if (isReset) {
      // Typed into the CLI these switch transcripts without a stop signal,
      // stranding the reply wait — a fresh session is the same clean slate.
      await mgr.restartSession(workdir, input.spawn, true)
      void replyText(chatId, messageId, `✅ 已开始新会话（${names.long} 已重启）`)
    } else if (selectMatch) {
      const sent = await mgr.selectOption(workdir, selectMatch[1])
      void replyText(chatId, messageId, sent ? `✅ 已选择选项 ${selectMatch[1]}` : '⚠️ 没有存活的会话，未发送')
    }
    return true
  }

  /**
   * Deliver one Feishu message to a tmux-hosted CLI and relay everything
   * back: streamed text, status card, dialog cards, stuck-pane screenshots.
   */
  async function handleTmuxTask(mgr: TmuxCliManager, input: TmuxTaskInput): Promise<void> {
    const { workdir, chatId, messageId } = input
    const kind = mgr.profile.kind
    const names = NAMES[kind]
    const tag = `tmux[${kind}]`
    const key = dialogKey(mgr, workdir)
    dbg(`routing ${chatId} → ${workdir} via ${names.long}`)
    if (await handleSessionCommand(mgr, input, key)) return

    const queueMode = mgr.profile.midTurn === 'queue'
    const busy = mgr.isBusy(workdir)
    // 'absorb' (Claude): a message folded into the in-flight turn gets no
    // card of its own. 'queue' (agy): it gets a card that starts as "queued".
    let statusCard = busy && !queueMode ? null : makeStatusCard(chatId, key, names.short, busy ? QUEUED_LINE : THINKING_LINE)
    const ensureStatusCard = () => statusCard ??= makeStatusCard(chatId, key, names.short)
    let absorbed = false
    let anyTextSent = false
    // Serializes chunk sends so they can't land out of order.
    let sendChain: Promise<void> = Promise.resolve()
    try {
      const unavailable = input.unavailableReason?.()
      if (unavailable) throw new Error(unavailable)
      const effectiveContent = await downloadAttachments(input, tag)
      const reply = await mgr.sendAndAwaitReply(workdir, effectiveContent, {
        ...input.spawn,
        onDialog: makeDialogHandler(key, `❓ ${names.short} 需要你选择`, chatId, messageId),
        onStuckPane: (pane) => sendPaneScreenshot(chatId, pane, `${tag}: stuck-pane`),
        onTabSwitched: (pane) => sendPaneScreenshot(chatId, pane, `${tag}: tab-switched`),
        onProgress: (events) => statusCard?.onProgress(events),
        onAbsorbed: () => { absorbed = true },
        onTurnStarted: () => statusCard?.turnStarted(),
        onStopError: input.onStopError,
        onTextChunk: (text) => {
          anyTextSent = true
          sendChain = sendChain.then(async () => {
            for (const chunk of chunkText(text, MAX_CHUNK)) await replyText(chatId, messageId, chunk)
          }).catch(e => dbg(`${tag}: text-chunk send for ${workdir} failed: ${e}`))
        },
      })
      await sendChain
      if (absorbed) {
        if (statusCard) await statusCard.finalize('↪️ 已并入上一条消息的回复')
        else void replyText(chatId, messageId, '↪️ 已并入上一条消息的回复')
        return
      }
      const card = ensureStatusCard()
      if (anyTextSent || reply) await card.finalize('✅ 已回复')
      // A local slash command (e.g. /model) legitimately produces no reply text.
      else if (input.content.trim().startsWith('/')) await card.finalize(`✅ 已执行 ${input.content.trim().split(/\s+/)[0]}`)
      else {
        await card.finalize('⚠️ 未产生文本回复')
        dbg(`${tag}: ${workdir} produced no text reply for ${messageId}`)
      }
    } catch (e) {
      await sendChain
      if (absorbed) {
        if (statusCard) await statusCard.finalize('↪️ 已并入上一条消息的回复')
        else void replyText(chatId, messageId, '↪️ 已并入上一条消息的回复')
        return
      }
      const card = ensureStatusCard()
      const reason = e instanceof Error ? e.message : String(e)
      // Pre-delivery by contract — safe to hand over to another backend.
      const fallbackName = input.fallback(reason)
      if (fallbackName) {
        dbg(`${tag}: ${workdir} unavailable (${reason}), fell back to ${fallbackName} (pre-delivery, no side effect)`)
        await card.finalize(`⚠️ 已切换到 ${fallbackName} 处理`)
        return
      }
      await card.finalize('⚠️ 执行失败')
      dbg(`${tag}: task for ${workdir} failed: ${reason}`)
      void replyText(chatId, messageId, `⚠️ ${names.long} 执行失败：${reason}`)
    }
  }

  return { handleTmuxTask, handleTmuxDialogChoice }
}

export const TMUX_BACKEND_NAMES = NAMES
