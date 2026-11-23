#!/usr/bin/env bun
/**
 * Feishu Router — central message hub for multiple Claude Code instances.
 *
 * Maintains the single Feishu WebSocket connection. Workers (server.ts in each
 * Claude Code instance) connect via a Unix socket and register their cwd.
 * Messages are routed by:  chat_id → workdir (access.json) → registered worker.
 *
 * Usage:  bun router.ts
 * Config: ~/.claude/channels/feishu/access.json  (groups.<chatId>.workdir, defaultWorkdir)
 */
import * as lark from '@larksuiteoapi/node-sdk'
import { createServer, type Socket } from 'net'
import { randomBytes } from 'crypto'
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, unlinkSync, existsSync, readdirSync, statSync,
} from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'
import { acquireRouterLock, releaseRouterLock } from './router-lock'
import {
  deleteTmuxSessionId, getTmuxSessionId, markEventProcessed, openDb, PermissionRegistry,
  pruneProcessedEvents, setTmuxSessionId, SqliteBindingStore, wasEventProcessed,
} from './routing/storage'
import { loadRouterConfig, resolveAgySpawnOptions, resolveOpenCodeConfig, RouterConfigError } from './routing/config'
import { resolveRoute } from './routing/resolver'
import { conversationKey } from './routing/bindings'
import { evictMissingOpenCodeBinding } from './routing/opencode-recovery'
import type { AgentKind, AgentPolicy, OpenCodeAgentConfig, RouterConfig } from './routing/types'
import { V2SessionCoordinator, coordinatorKey, nativeInputId, v2Request, type ModelSelection } from './adapters/opencode/v2-coordinator'
import { ProgressCard, TextDelivery, safeSummary, type TextPartSnapshot } from './adapters/opencode/presentation'
import { OpenCodeAdapter } from './adapters/opencode/opencode-adapter'
import type { AgentEvent } from './adapters/agent-adapter'
import { createBinding } from './routing/bindings'
import { chunkText, MAX_CHUNK } from './chunk-text'
import { DegradedTracker } from './routing/degraded'
import { chooseFallback } from './routing/fallback'
import { MAX_ATTACHMENT_BYTES, sendFeishuFile } from './feishu-attachment'
import { downloadFeishuResource } from './feishu-download'
import { renderPaneScreenshot } from './pane-screenshot'
import { decodeBase64DataUri } from './data-uri'
import { TmuxClaudeManager } from './claude-tmux-worker'
import { TmuxCliManager } from './tmux/manager'
import { createAgyProfile } from './tmux/profiles/agy'
import { createCodexProfile } from './tmux/profiles/codex'
import { resolveBin } from './tmux/profile'
import { AGY_QUOTA_COOLDOWN_MS, isAgyQuotaError } from './tmux/agy-errors'
import { createTmuxRouting, TMUX_BACKEND_NAMES, type AttachmentRef } from './tmux-route'
import { startTaskService, type RunningTaskService } from './task-service'
import { createTaskBackends } from './task-service/backends/factory'
import { claudeAuthCheck } from './task-service/backends/claude-auth'
import { explicitModel } from './task-service/schema/primitives'
import { teardownTaskScopedWorkdir } from './task-service/workdir-teardown'

// ── Config ──────────────────────────────────────────────────────────────────

const STATE_DIR = process.env.FEISHU_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'feishu')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const DEBUG_LOG = join(STATE_DIR, 'router-debug.log')
const SOCK_PATH = join(STATE_DIR, 'router.sock')
const LOCK_DIR = join(STATE_DIR, 'router.lock')
const DB_PATH = join(STATE_DIR, 'router.db')
const AGENTS_YAML_PATH = join(STATE_DIR, 'agents.yaml')
const AGENTS_ALLOWED_ROOTS = [process.env.FEISHU_PROJECTS_ROOT ?? join(homedir(), 'Projects')]

function dbg(msg: string) {
  const line = `${new Date().toISOString()} [router] ${msg}\n`
  process.stderr.write(line)
  try { appendFileSync(DEBUG_LOG, line) } catch {}
}

/** Axios (used by the Feishu SDK) hides the actual API error body behind `e.message`, which is just "Request failed with status code 400". Surfaces `e.response.data` too so a failed Feishu API call is debuggable from the log instead of needing to be reproduced by hand. */
function describeApiError(e: unknown): string {
  const data = (e as any)?.response?.data
  return data ? `${e} — ${JSON.stringify(data)}` : String(e)
}

// Load .env
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const APP_ID = process.env.FEISHU_APP_ID
const APP_SECRET = process.env.FEISHU_APP_SECRET
const ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY ?? ''

if (!APP_ID || !APP_SECRET) {
  process.stderr.write(`feishu router: FEISHU_APP_ID and FEISHU_APP_SECRET required\n  set in ${ENV_FILE}\n`)
  process.exit(1)
}

// agents.yaml is the backend/infra config (routing/config.ts RouterConfig) — see
// docs/multi-agent-router-design.md §5. Missing file = legacy Claude-only mode
// (infraConfig stays null, zero behavior change). A *present but invalid* file
// must fail closed: refuse to start rather than run with a partially-valid config.
let infraConfig: RouterConfig | null = null
try {
  infraConfig = loadRouterConfig(AGENTS_YAML_PATH, AGENTS_ALLOWED_ROOTS)
} catch (e) {
  const msg = e instanceof RouterConfigError ? e.message : String(e)
  process.stderr.write(`feishu router: agents.yaml is invalid, refusing to start:\n  ${msg}\n`)
  process.exit(1)
}

const openCodeCfg = infraConfig?.agents.opencode
const openCodeAdapter = openCodeCfg
  ? new OpenCodeAdapter({
      baseUrl: openCodeCfg.baseUrl,
      requestTimeoutSeconds: openCodeCfg.requestTimeoutSeconds,
      taskTimeoutSeconds: openCodeCfg.taskTimeoutSeconds,
      taskHardCapSeconds: openCodeCfg.taskHardCapSeconds,
      passwordEnv: openCodeCfg.passwordEnv,
      onWarn: dbg,
    })
  : null

// ── SQLite state (opened early: tmuxClaude below needs it for session-id persistence) ──
mkdirSync(STATE_DIR, { recursive: true })
const db = openDb(DB_PATH)
const permissionRegistry = new PermissionRegistry(db)
const openCodeBindings = new SqliteBindingStore(db)

/**
 * workdir -> tmux --session-id, persisted so a router restart can reattach
 * to an already-running tmux session's exact transcript file instead of
 * guessing by "most recently modified .jsonl in this workdir" (ambiguous if
 * the user ever has another Claude Code session open in the same
 * directory outside this tmux session). The tmux session itself survives a
 * router restart untouched — tmux is a separate daemon — only this
 * router-side bookkeeping is lost from memory, which is what this
 * persists.
 */
const tmuxSessionStore = {
  get: (workdir: string) => getTmuxSessionId(db, workdir),
  set: (workdir: string, sessionId: string) => setTmuxSessionId(db, workdir, sessionId, new Date().toISOString()),
  delete: (workdir: string) => deleteTmuxSessionId(db, workdir),
}
const tmuxClaude = new TmuxClaudeManager({ dbg, persistence: tmuxSessionStore })

/**
 * Antigravity (agy) via tmux — agent.primary: 'agy'. Same tmux_sessions
 * table, keys prefixed so a Claude-tmux and an agy session on one workdir
 * never share an id. agy reuses the persisted conversation id on respawn
 * (`--conversation`), so an idle-killed session keeps its context.
 */
const AGY_SESSION_KEY_PREFIX = 'agy:'
const tmuxAgy = new TmuxCliManager(createAgyProfile({ bin: infraConfig?.agents.agy?.bin }), {
  dbg,
  persistence: {
    get: (workdir: string) => getTmuxSessionId(db, AGY_SESSION_KEY_PREFIX + workdir),
    set: (workdir: string, sessionId: string) => setTmuxSessionId(db, AGY_SESSION_KEY_PREFIX + workdir, sessionId, new Date().toISOString()),
    delete: (workdir: string) => deleteTmuxSessionId(db, AGY_SESSION_KEY_PREFIX + workdir),
  },
})

/**
 * Codex via tmux (tmux/profiles/codex.ts): same manager and per-workdir
 * session model as agy, with the same tmux_sessions persistence (key prefix
 * `codex:`) so a restart resumes the exact Codex thread. Used by the task MCP.
 */
const CODEX_SESSION_KEY_PREFIX = 'codex:'
const tmuxCodex = new TmuxCliManager(createCodexProfile({ bin: infraConfig?.taskService?.backends?.codex?.bin ?? undefined }), {
  dbg,
  persistence: {
    get: (workdir: string) => getTmuxSessionId(db, CODEX_SESSION_KEY_PREFIX + workdir),
    set: (workdir: string, sessionId: string) => setTmuxSessionId(db, CODEX_SESSION_KEY_PREFIX + workdir, sessionId, new Date().toISOString()),
    delete: (workdir: string) => deleteTmuxSessionId(db, CODEX_SESSION_KEY_PREFIX + workdir),
  },
})

// ── Access control ──────────────────────────────────────────────────────────

type GroupPolicy = { requireMention: boolean; allowFrom: string[]; workdir?: string; agent?: AgentPolicy }
type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  p2pChats: Record<string, string>
  groups: Record<string, GroupPolicy>
  pending: Record<string, unknown>
  mentionPatterns?: string[]
  ackReaction?: string
  defaultWorkdir?: string
  defaultAgent?: AgentPolicy
}

function readAccess(): Access {
  try {
    const p = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      dmPolicy: p.dmPolicy ?? 'pairing',
      allowFrom: p.allowFrom ?? [],
      p2pChats: p.p2pChats ?? {},
      groups: p.groups ?? {},
      pending: p.pending ?? {},
      mentionPatterns: p.mentionPatterns,
      ackReaction: p.ackReaction ?? 'Get',
      defaultWorkdir: p.defaultWorkdir,
      defaultAgent: p.defaultAgent,
    }
  } catch {
    return { dmPolicy: 'pairing', allowFrom: [], p2pChats: {}, groups: {}, pending: {}, ackReaction: 'Get' }
  }
}

// ── Feishu API ──────────────────────────────────────────────────────────────

const apiClient = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: lark.LoggerLevel.warn })
let botOpenId: string | null = null
async function fetchBotOpenId() {
  try {
    const r = await (apiClient as any).bot.botInfo.get()
    botOpenId = r?.bot?.open_id ?? r?.data?.bot?.open_id ?? null
    if (botOpenId) dbg(`bot open_id = ${botOpenId}`)
  } catch (e) { dbg(`could not fetch bot open_id: ${e}`) }
}

/** Fetch the parent message's text so replies keep context when forwarded. */
async function fetchParentQuote(parentId: string): Promise<string> {
  try {
    const r = await (apiClient as any).im.message.get({ path: { message_id: parentId } })
    const items: any[] = r?.items ?? r?.data?.items ?? []
    if (!items.length) return ''
    const m = items[0]
    const raw: string = m.body?.content ?? m.content ?? ''
    let txt = raw
    try { txt = JSON.parse(raw).text ?? raw } catch {}
    const mtype: string = m.msg_type ?? m.message_type ?? ''
    const who: string = m.sender?.id ?? m.sender?.sender_id ?? ''
    const preview = (txt || `[${mtype}]`).replace(/\s+/g, ' ').trim().slice(0, 500)
    return `> [replying to ${who}]: ${preview}\n\n`
  } catch (e) { dbg(`fetchParentQuote failed: ${e}`); return '' }
}

function checkMention(mentions: any[], text: string, patterns?: string[]): boolean {
  for (const m of mentions) {
    if (m.mentioned_type === 'bot') return true
    if (botOpenId && m.id?.open_id === botOpenId) return true
  }
  for (const p of patterns ?? []) { try { if (new RegExp(p, 'i').test(text)) return true } catch {} }
  return false
}

// ── Worker registry (Unix socket) ───────────────────────────────────────────

type Worker = {
  socket: Socket
  workdir: string
  buf: string
  workerId?: string
  capabilities?: string[]
  protocolVersion?: number
}

const workers = new Map<Socket, Worker>()
/** Workdirs whose Claude Code worker just reported itself rate-limited (see worker-link.ts sendDegraded). */
const degraded = new DegradedTracker()

/** Find worker whose workdir matches the target. */
function findWorker(workdir: string): Worker | undefined {
  const target = resolve(workdir)
  for (const w of workers.values()) {
    if (resolve(w.workdir) === target) return w
  }
  return undefined
}

function sendToWorker(w: Worker, payload: Record<string, unknown>) {
  try { w.socket.write(JSON.stringify(payload) + '\n') } catch (e) { dbg(`send failed: ${e}`) }
}

/** Route a payload to the worker matching the given workdir. Returns true if delivered. */
function routeToWorkdir(workdir: string, payload: Record<string, unknown>): boolean {
  const w = findWorker(workdir)
  if (!w) { dbg(`no worker for workdir ${workdir}`); return false }
  sendToWorker(w, payload)
  return true
}

/** Shut down router if no workers remain after a grace period. */
let idleTimer: ReturnType<typeof setTimeout> | null = null
const IDLE_GRACE_MS = 10_000  // wait 10s before shutting down

/** True when the last worker left while tasks were still live; re-checked when a task closes. */
let idleShutdownDeferred = false
function scheduleIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer)
  // Machine tasks (task MCP) are live work too: an unplanned exit would turn them UNKNOWN.
  idleShutdownDeferred = workers.size === 0 && !!taskService?.hasLiveWork()
  if (workers.size > 0 || idleShutdownDeferred) return
  idleTimer = setTimeout(() => {
    if (workers.size === 0 && !taskService?.hasLiveWork()) {
      dbg('all workers disconnected, shutting down')
      shutdown()
    }
  }, IDLE_GRACE_MS)
}

const sockServer = createServer((socket) => {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  const w: Worker = { socket, workdir: '', buf: '' }
  workers.set(socket, w)
  dbg(`worker connected (${workers.size} total)`)

  socket.on('data', (chunk) => {
    w.buf += chunk.toString()
    let idx: number
    while ((idx = w.buf.indexOf('\n')) !== -1) {
      const line = w.buf.slice(0, idx)
      w.buf = w.buf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'register' && typeof msg.workdir === 'string') {
          w.workdir = resolve(msg.workdir)
          w.workerId = typeof msg.workerId === 'string' ? msg.workerId : undefined
          w.capabilities = Array.isArray(msg.capabilities) ? msg.capabilities : undefined
          w.protocolVersion = typeof msg.protocolVersion === 'number' ? msg.protocolVersion : undefined
          dbg(`worker registered: ${w.workdir}${w.workerId ? ` (id=${w.workerId}, v${w.protocolVersion ?? '?'})` : ''}`)
        } else if (msg.type === 'callback_registered' && typeof msg.code === 'string' && typeof msg.workdir === 'string') {
          permissionRegistry.register(msg.code, resolve(msg.workdir), typeof msg.taskId === 'string' ? msg.taskId : null, new Date().toISOString())
        } else if (msg.type === 'degraded' && typeof msg.until === 'number') {
          if (w.workdir) {
            degraded.markDegraded(w.workdir, msg.until)
            dbg(`worker degraded: ${w.workdir} until ${new Date(msg.until).toISOString()} (${typeof msg.reason === 'string' ? msg.reason : 'unknown'})`)
          }
        }
      } catch (e) { dbg(`bad message from worker: ${e}`) }
    }
  })

  socket.on('close', () => {
    workers.delete(socket)
    dbg(`worker disconnected: ${w.workdir} (${workers.size} remaining)`)
    scheduleIdleShutdown()
  })

  socket.on('error', (e) => {
    dbg(`worker socket error: ${e}`)
    workers.delete(socket)
    scheduleIdleShutdown()
  })
})

// ── Message routing ─────────────────────────────────────────────────────────

function resolveWorkdir(chatId: string, chatType: string): string | undefined {
  const access = readAccess()
  if (chatType === 'group') {
    const wd = access.groups[chatId]?.workdir
    if (wd) return wd
  }
  return access.defaultWorkdir
}

async function replyText(chatId: string, messageId: string, text: string) {
  try {
    await (apiClient as any).im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: false },
    })
  } catch (e) { dbg(`reply failed: ${e}`) }
}

// ── OpenCode task execution ─────────────────────────────────────────────────
// Route-level primary:opencode dispatch, plus the design doc §7 pre-execution
// fallback case: if routeToWorkdir() finds no connected Claude worker at all
// (task never delivered, so no side effect to reconcile), and the route
// declares agent.fallback:'opencode' with agents.yaml's fallback.enabled:true,
// the task is handed to OpenCode instead (see handleInbound below). The richer
// "Claude accepted then failed mid-task" case from the design doc is not
// implemented — that needs real task-state tracking (routing/task-machine.ts
// exists for this but isn't wired in).

// conversationKey -> OpenCode sessionId is persisted in SQLite (openCodeBindings,
// routing/storage.ts SqliteBindingStore) so a session survives a router restart
// instead of living in a bare in-memory Map. `inFlightSessionCreations` is a
// separate, process-local lock: two messages for the same conversation arriving
// close together would otherwise both see no binding yet and both create a
// session, orphaning one — this makes the second one await the first's result.
const inFlightSessionCreations = new Map<string, Promise<string>>()
/** Permission request ids currently awaiting a card response, issued by OpenCode (not a Claude worker). */
const openCodePermissionCodes = new Set<string>()

async function getOrCreateOpenCodeSession(key: string, route: NonNullable<ReturnType<typeof resolveRoute>>): Promise<string> {
  const existing = openCodeBindings.get(key)
  if (existing) return existing.agentSessionId

  const inFlight = inFlightSessionCreations.get(key)
  if (inFlight) return inFlight

  const creation = (async () => {
    const session = await openCodeAdapter!.createSession({ conversationKey: key, projectId: route.project, workdir: route.workdir })
    openCodeBindings.put(createBinding(key, route.project, 'opencode', null, session.sessionId, '1', new Date().toISOString()))
    dbg(`opencode: created session ${session.sessionId} for ${key}`)
    return session.sessionId
  })()
  inFlightSessionCreations.set(key, creation)
  try {
    return await creation
  } finally {
    inFlightSessionCreations.delete(key)
  }
}

function buildOpenCodePermCard(toolName: string, description: string, code: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔐 OpenCode Permission Request' }, template: 'orange' },
    body: {
      elements: [
        { tag: 'markdown', content: `**Tool:** ${toolName}\n${description}` },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            { tag: 'button', text: { tag: 'plain_text', content: '✅ Allow' }, type: 'primary', value: { code, action: 'perm_allow' } },
            { tag: 'button', text: { tag: 'plain_text', content: '❌ Deny' }, type: 'danger', value: { code, action: 'perm_deny' } },
          ],
        },
      ],
    },
  })
}

// Extension used for the temp file we write before handing it to sendFeishuFile
// (which branches image-vs-file by extension, via feishu-attachment.ts's
// IMAGE_EXTS/FEISHU_FTYPES) — only needs to cover mime types OpenCode tools
// actually produce; falls back to the mime subtype for anything else.
const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf',
}

/** Decode a tool-produced `data:` attachment (e.g. a screenshot) and send it to Feishu as an image or file message. */
async function sendOpenCodeAttachment(chatId: string, mime: string, dataUrl: string, filename: string | undefined, dbgTag: string, client = apiClient) {
  const decoded = decodeBase64DataUri(dataUrl, MAX_ATTACHMENT_BYTES)
  if (!decoded.ok) {
    dbg(decoded.reason === 'too_large'
      ? `${dbgTag}: attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes, skipping`
      : `${dbgTag}: attachment data URI isn't base64-encoded, skipping (unsupported for now)`)
    return
  }
  const ext = MIME_EXT[mime] ?? mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'bin'
  const tmpPath = join(tmpdir(), `oc-attach-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`)
  try {
    writeFileSync(tmpPath, decoded.buf)
    await sendFeishuFile(client, chatId, tmpPath, filename)
  } catch (e) {
    dbg(`${dbgTag}: attachment upload failed: ${e}`)
  } finally {
    try { unlinkSync(tmpPath) } catch (e) { dbg(`${dbgTag}: failed to clean up temp attachment file ${tmpPath}: ${e}`) }
  }
}

async function handleOpenCodePermission(event: Extract<AgentEvent, { type: 'permission.requested' }>, chatId: string) {
  openCodePermissionCodes.add(event.requestId)
  dbg(`opencode: permission requested (${event.toolName}), sending card for ${event.requestId}`)
  try {
    await (apiClient as any).im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: buildOpenCodePermCard(event.toolName, event.description, event.requestId) },
    })
  } catch (e) { dbg(`opencode: permission card send failed: ${e}`) }
}

async function handleOpenCodeTask(route: NonNullable<ReturnType<typeof resolveRoute>>, chatId: string, messageId: string, chatType: 'p2p' | 'group', content: string) {
  if (!openCodeAdapter) {
    dbg(`route wants opencode but agents.opencode is not configured, dropping`)
    void replyText(chatId, messageId, '⚠️ OpenCode 未配置，无法处理该消息。')
    return
  }

  const routeCfg = resolveOpenCodeConfig(infraConfig, route.workdir)
  if (routeCfg?.nativeV2) return handleNativeOpenCodeTask(route, chatId, messageId, chatType, content, routeCfg)

  const key = conversationKey(
    chatType === 'group' ? { kind: 'group', chatId, projectId: route.project } : { kind: 'p2p', userOpenId: chatId, projectId: route.project },
  )
  let sessionId: string
  try {
    sessionId = await getOrCreateOpenCodeSession(key, route)
  } catch (e) {
    dbg(`opencode: createSession failed: ${e}`)
    void replyText(chatId, messageId, `⚠️ OpenCode 会话创建失败：${e}`)
    return
  }

  const taskId = `oc-${messageId}`
  const controller = new AbortController()
  let finalText = ''
  const attachments: Extract<AgentEvent, { type: 'attachment.completed' }>[] = []
  // A tool can produce an attachment (e.g. a screenshot) in an earlier step of the
  // same turn that later fails/aborts — that capture is still real and worth
  // sending, so every early-return path flushes whatever was collected so far
  // instead of silently dropping it.
  const flushAttachments = () => Promise.all(
    attachments.map(att => sendOpenCodeAttachment(chatId, att.mime, att.dataUrl, att.filename, `opencode: task ${taskId}`)),
  )
  try {
    for await (const event of openCodeAdapter.send({ taskId, sessionId, prompt: content, directory: route.workdir }, controller.signal)) {
      if (event.type === 'permission.requested') {
        void handleOpenCodePermission(event, chatId)
      } else if (event.type === 'text.completed') {
        finalText = event.text
      } else if (event.type === 'attachment.completed') {
        attachments.push(event)
      } else if (event.type === 'task.failed') {
        dbg(`opencode: task ${taskId} failed: ${event.reason}${event.detail ? ` (${event.detail})` : ''}`)
        // Transport/provider/deadline failures do not invalidate a session.
        // Only delete the binding we used, and only on proven session absence.
        evictMissingOpenCodeBinding(openCodeBindings, key, sessionId, event.reason)
        const timedOut = event.reason === 'task_timeout' || event.reason === 'task_timeout_no_event_stream'
        void replyText(chatId, messageId, timedOut
          ? `⏱️ OpenCode 任务超时${event.detail ? `：${event.detail}` : ''}`
          : `⚠️ OpenCode 执行失败：${event.reason}${event.detail ? `（${event.detail}）` : ''}`)
        await flushAttachments()
        return
      } else if (event.type === 'task.aborted') {
        void replyText(chatId, messageId, `⚠️ OpenCode 任务被中断`)
        await flushAttachments()
        return
      }
    }
  } catch (e) {
    dbg(`opencode: send() threw: ${e}`)
    // Unexpected observer errors do not prove session absence; keep context.
    void replyText(chatId, messageId, `⚠️ OpenCode 执行出错：${e}`)
    await flushAttachments()
    return
  }

  if (finalText) {
    for (const chunk of chunkText(finalText, MAX_CHUNK)) await replyText(chatId, messageId, chunk)
  } else if (attachments.length === 0) {
    dbg(`opencode: task ${taskId} completed with no text output`)
  }
  await flushAttachments()
}

// Native v2 is deliberately opt-in and uses separate persistent bindings: changing
// the flag never silently migrates legacy session/history/model/permission semantics.
const nativeCoordinators = new Map<string, V2SessionCoordinator>()
const nativePermissionOwners = new Map<string, { coordinator: V2SessionCoordinator; groupId: string; card?: ProgressCard; chatId: string }>()
const nativeRoots = new Map<string, { chatId: string; messageId: string }>()
let nativeApiClient: lark.Client | undefined
function boundedNativeApi(): lark.Client {
  if (nativeApiClient) return nativeApiClient
  // Bound token acquisition as well as message/upload calls. Do not mutate the
  // shared SDK HTTP instance used by mature tmux/socket paths.
  const request = (options: any) => lark.defaultHttpInstance.request({ ...options, timeout: 5000 })
  const http = { request } as lark.HttpInstance
  for (const method of ['get', 'delete', 'head', 'options', 'post', 'put', 'patch'] as const) {
    ;(http as any)[method] = (url: string, dataOrOptions?: any, options?: any) => ['post', 'put', 'patch'].includes(method)
      ? request({ ...options, url, data: dataOrOptions, method }) : request({ ...dataOrOptions, url, method })
  }
  // SDK error objects may contain request credentials; log only our safe diagnostics.
  nativeApiClient = new lark.Client({ appId: APP_ID!, appSecret: APP_SECRET!, httpInstance: http,
    logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } })
  return nativeApiClient
}

/** Unlike replyText, this path checks both transport AND Feishu acknowledgement.
 * No automatic retry after a timeout: the response could have been accepted. */
async function nativeFeishu(path: string, method: string, data: unknown): Promise<any> {
  const response = await boundedNativeApi().request({ url: `open-apis/im/v1/${path}`, method, data, timeout: 5000 })
  if (response?.code !== 0) throw new Error('Feishu rejected native OpenCode delivery')
  return response.data
}
function nativeCard(line: string) {
  return JSON.stringify({ schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: 'OpenCode' }, template: 'blue' },
    body: { elements: [{ tag: 'markdown', content: line }] } })
}

/** `providerID/modelID`, e.g. `deepseek/deepseek-flash`. */
function parseNativeModel(value?: string): { id: string; providerID: string } | undefined {
  if (!value) return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) throw new Error(`model "${value}" 格式无效；需要 providerID/modelID`)
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) }
}

async function handleNativeOpenCodeTask(route: NonNullable<ReturnType<typeof resolveRoute>>, chatId: string, messageId: string,
  chatType: 'p2p' | 'group', content: string, cfg: OpenCodeAgentConfig) {
  const config = { baseUrl: cfg.baseUrl, requestTimeoutMs: cfg.requestTimeoutSeconds * 1000, passwordEnv: cfg.passwordEnv }
  const source = conversationKey(chatType === 'group' ? { kind: 'group', chatId, projectId: route.project }
    : { kind: 'p2p', userOpenId: chatId, projectId: route.project })
  const bindingKey = `${source}:native-v2`
  let pendingInputId: string | undefined
  try {
    // Per-chat overrides win over the project-level default. Variant is the
    // thinking effort (e.g. deepseek-flash low/high/max), applied when idle.
    const selection: ModelSelection = {}
    const model = parseNativeModel(route.agent.model) ?? parseNativeModel(cfg.model)
    if (model) selection.model = model
    const variant = route.agent.variant?.trim()
    if (variant) selection.variant = variant
    let sessionId = openCodeBindings.get(bindingKey)?.agentSessionId
    if (!sessionId) {
      let creation = inFlightSessionCreations.get(bindingKey)
      if (!creation) {
        creation = (async () => {
          const createBody: Record<string, unknown> = { location: { directory: route.workdir } }
          if (selection.model) createBody.model = { ...selection.model, ...(selection.variant ? { variant: selection.variant } : {}) }
          const response = await v2Request(config, '/api/session', createBody)
          if (!response?.data?.id) throw new Error('v2 会话协议不兼容；未提交任务')
          openCodeBindings.put(createBinding(bindingKey, route.project, 'opencode', null, response.data.id, 'v2', new Date().toISOString()))
          return String(response.data.id)
        })()
        inFlightSessionCreations.set(bindingKey, creation)
      }
      try { sessionId = await creation } finally { inFlightSessionCreations.delete(bindingKey) }
    }
    const key = coordinatorKey(cfg.baseUrl, route.workdir, sessionId)
    let coordinator = nativeCoordinators.get(key)
    if (!coordinator) {
      if (nativeCoordinators.size >= 256) throw new Error('native v2 会话协调器数量达到上限')
      const displays = new Map<string, { root: { chatId: string; messageId: string }; text: TextDelivery; card?: ProgressCard; attachments: Extract<AgentEvent, {type: 'attachment.completed'}>[] }>()
      coordinator = new V2SessionCoordinator({ ...config, directory: route.workdir, sessionId,
        idleTimeoutMs: cfg.taskTimeoutSeconds * 1000, hardCapMs: (cfg.taskHardCapSeconds ?? 8 * 3600) * 1000, onWarn: dbg }, {
        started(groupId) {
          const root = nativeRoots.get(groupId)!
          const text = new TextDelivery(async text => { await nativeFeishu(`messages/${encodeURIComponent(root.messageId)}/reply`, 'POST',
            { msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: false }) }, cfg.streamText)
          // Native mode always shows a progress card. Creation once only;
          // ambiguous creation never triggers another create.
          const ready = nativeFeishu(`messages?receive_id_type=chat_id`, 'POST',
            { receive_id: root.chatId, msg_type: 'interactive', content: nativeCard('🤔 等待执行进展') })
            .then(data => data?.message_id).catch(() => undefined)
          const card = new ProgressCard(async line => { const id = await ready; if (id) await nativeFeishu(`messages/${encodeURIComponent(id)}`, 'PATCH', { content: nativeCard(line) }) })
          displays.set(groupId, { root, text, card, attachments: [] })
        },
        event(groupId, event) {
          const display = displays.get(groupId); if (!display) return
          display.card?.event(event)
          if (event.type === 'text.snapshot') display.text.snapshot(event)
          else if (event.type === 'attachment.completed') display.attachments.push(event)
          else if (event.type === 'permission.requested') {
            nativePermissionOwners.set(event.requestId, { coordinator: nativeCoordinators.get(key)!, groupId, card: display.card, chatId: display.root.chatId })
            // Separate path: permission delivery never waits behind text/card patch queues.
            const value = { code: event.requestId }
            const card = JSON.stringify({ schema: '2.0', header: { title: { tag: 'plain_text', content: 'OpenCode 请求授权' }, template: 'orange' },
              body: { elements: [{ tag: 'markdown', content: safeSummary(event.toolName) },
                ...['perm_allow', 'perm_deny'].map(action => ({ tag: 'button', text: { tag: 'plain_text', content: action === 'perm_allow' ? '允许一次' : '拒绝' },
                  value: { ...value, action }, type: action === 'perm_allow' ? 'primary' : 'danger' }))] } })
            void nativeFeishu('messages?receive_id_type=chat_id', 'POST', { receive_id: display.root.chatId, msg_type: 'interactive', content: card })
              .catch(() => { dbg('native OpenCode permission card failed'); void replyText(display.root.chatId, display.root.messageId, '⚠️ OpenCode 授权卡发送失败，请到 OpenCode 处理授权。') })
          }
        },
        async settled(groupId, texts: TextPartSnapshot[], outcome) {
          const display = displays.get(groupId); if (!display) return
          try {
            const delivery = await display.text.finalize(outcome.reason ? texts.map(p => ({ ...p, text: p.text + '\n【任务未完成】' })) : texts)
            for (const att of display.attachments) await sendOpenCodeAttachment(display.root.chatId, att.mime, att.dataUrl, att.filename, 'native opencode', boundedNativeApi())
            const line = outcome.reason ? `⚠️ ${safeSummary(outcome.reason)}${outcome.detail ? `：${safeSummary(outcome.detail)}` : ''}`
              : !delivery.delivered ? '⚠️ 执行完成，回复发送失败或状态待核实' : delivery.hasText ? '✅ 已回复'
              : display.attachments.length ? '执行完成，附件已尝试发送' : '执行结束，无可发送内容'
            await display.card?.finalize(line)
            if (outcome.reason || !delivery.delivered || (!delivery.hasText && !display.attachments.length)) await nativeFeishu(`messages/${encodeURIComponent(display.root.messageId)}/reply`, 'POST',
              { msg_type: 'text', content: JSON.stringify({ text: line }) }).catch(() => dbg('native OpenCode terminal notice failed'))
          } finally {
            await display.card?.finalize('⚠️ 执行结束，投递未完成')
            displays.delete(groupId); nativeRoots.delete(groupId)
            for (const [id, owner] of nativePermissionOwners) if (owner.coordinator === nativeCoordinators.get(key) && owner.groupId === groupId) nativePermissionOwners.delete(id)
          }
        },
      })
      nativeCoordinators.set(key, coordinator)
    }
    if (content.trim() === '/stop') {
      await coordinator.stop(source)
      await replyText(chatId, messageId, '停止已请求；未消费的排队输入没有删除，不会由路由器自动恢复。')
      return
    }
    const queue = /^\/queue(?:\s|$)/.test(content.trim())
    const prompt = queue ? content.trim().replace(/^\/queue\s*/, '') : content
    if (!prompt.trim()) throw new Error('/queue 后需要任务内容')
    const inputId = nativeInputId(sessionId, messageId); pendingInputId = inputId
    nativeRoots.set(inputId, { chatId, messageId })
    const receipt = await coordinator.submit(source, messageId, prompt, queue ? 'queue' : 'steer', selection)
    nativeRoots.delete(inputId)
    if (receipt.joined || queue || receipt.status === 'outcome_unknown') await replyText(chatId, messageId,
      receipt.status === 'outcome_unknown' ? '提交结果待核实，正在按原输入 ID 对账；不会自动重复提交。'
        : queue ? '已提交排队任务，等待执行器在空闲边界接收。' : '已提交补充，等待执行器接收；不会中止正在运行的工具。')
  } catch (error) {
    if (pendingInputId) nativeRoots.delete(pendingInputId)
    dbg(`native opencode: ${error instanceof Error ? `${error.name}: ${error.message}` : 'request failed'}`)
    await replyText(chatId, messageId, `⚠️ OpenCode 原生插入模式失败：${safeSummary(error instanceof Error ? error.message : '请求失败')}。未自动回退 legacy 或重新提交。`)
  }
}

const TMUX_ATTACHMENT_DIR = join(tmpdir(), 'feishu-claude-tmux-attachments')
const TMUX_ATTACHMENT_RETENTION_MS = 24 * 3600 * 1000

/** Downloaded attachments are kept (the CLI may Read one well after the task that received it finishes), so without this they'd accumulate here forever. */
function pruneOldTmuxAttachments() {
  if (!existsSync(TMUX_ATTACHMENT_DIR)) return
  const cutoffMs = Date.now() - TMUX_ATTACHMENT_RETENTION_MS
  let pruned = 0
  for (const name of readdirSync(TMUX_ATTACHMENT_DIR)) {
    const path = join(TMUX_ATTACHMENT_DIR, name)
    try {
      if (statSync(path).mtimeMs < cutoffMs) { unlinkSync(path); pruned++ }
    } catch (e) { dbg(`claude-tmux: failed to prune attachment ${path}: ${e}`) }
  }
  if (pruned) dbg(`claude-tmux: pruned ${pruned} old attachment file(s)`)
}

const tmuxRouting = createTmuxRouting({ api: apiClient, dbg, describeApiError, replyText, attachmentDir: TMUX_ATTACHMENT_DIR })

/** Everything a backend needs to run (or take over) one inbound message. */
interface TaskContext {
  route: NonNullable<ReturnType<typeof resolveRoute>>
  chatId: string
  messageId: string
  chatKind: 'p2p' | 'group'
  content: string
  /** OpenCode variant of `content` (attachments aren't forwarded to OpenCode). */
  ocContent: string
  attachments: AttachmentRef[]
  /** Deliver to the Claude socket worker; false if no worker took it (or it's rate-limited). */
  socketDeliver: () => boolean
}

const BACKEND_DISPLAY: Record<AgentKind, string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
  agy: TMUX_BACKEND_NAMES.agy.short,
}

/**
 * Design doc §7 pre-execution fallback, shared by every primary: only ever
 * called when the message provably never reached the primary backend, so
 * there's no side effect to reconcile. Starts the route's configured
 * fallback (never the primary itself, never a second hop) and returns its
 * display name, or null when none applies.
 */
function startFallback(from: AgentKind, ctx: TaskContext, notice?: string): string | null {
  const choice = chooseFallback(from, ctx.route.agent, { enabled: !!infraConfig?.fallback.enabled, openCodeConfigured: !!openCodeAdapter })
  if (!choice) return null
  const fromName = from === 'claude' && ctx.route.agent.mode === 'tmux' ? TMUX_BACKEND_NAMES.claude.long : BACKEND_DISPLAY[from]
  let started: string | null = null
  if (choice.kind === 'opencode') {
    void handleOpenCodeTask(ctx.route, ctx.chatId, ctx.messageId, ctx.chatKind, ctx.ocContent)
    started = BACKEND_DISPLAY.opencode
  } else if (choice.kind === 'agy') {
    void runAgyTask(ctx, false)
    started = BACKEND_DISPLAY.agy
  } else if (choice.via === 'tmux') {
    void runClaudeTmuxTask(ctx, false)
    started = TMUX_BACKEND_NAMES.claude.long
  } else if (ctx.socketDeliver()) {
    started = BACKEND_DISPLAY.claude
  }
  if (!started) return null
  dbg(`${ctx.chatId}: ${fromName} unavailable for ${ctx.route.workdir}, falling back to ${started} (pre-execution, no side effect)`)
  void replyText(ctx.chatId, ctx.messageId, notice ?? `⚠️ ${fromName} 当前不可用，已切换到 ${started} 处理本次任务。`)
  return started
}

/**
 * Claude via tmux (agent.mode: 'tmux') — keystrokes into a persistent
 * `claude` CLI session; see claude-tmux-worker.ts and tmux-route.ts.
 */
function runClaudeTmuxTask(ctx: TaskContext, allowFallback = true): Promise<void> {
  return tmuxRouting.handleTmuxTask(tmuxClaude, {
    workdir: ctx.route.workdir, chatId: ctx.chatId, messageId: ctx.messageId,
    content: ctx.content, attachments: ctx.attachments,
    spawn: { model: ctx.route.agent.model },
    fallback: () => allowFallback ? startFallback('claude', ctx) : null,
  })
}

const agyDegradedKey = (workdir: string) => `agy:${resolve(workdir)}`
const STOP_ERROR_MAX_LEN = 300

/**
 * Antigravity via tmux (agent.primary: 'agy'). Spawn flags come from
 * access.json agent.model/effort > agents.yaml projects.<id>.agy > agents.agy,
 * all optional (unset = agy's own defaults). A quota/spend-cap stop marks agy
 * unavailable for this workdir for AGY_QUOTA_COOLDOWN_MS, so later messages
 * go to the fallback (pre-delivery) instead of failing one by one.
 */
function runAgyTask(ctx: TaskContext, allowFallback = true): Promise<void> {
  const workdir = ctx.route.workdir
  return tmuxRouting.handleTmuxTask(tmuxAgy, {
    workdir, chatId: ctx.chatId, messageId: ctx.messageId,
    content: ctx.content, attachments: ctx.attachments,
    spawn: resolveAgySpawnOptions(infraConfig, workdir, { model: ctx.route.agent.model, effort: ctx.route.agent.effort }),
    fallback: () => allowFallback ? startFallback('agy', ctx) : null,
    unavailableReason: () => degraded.isDegraded(agyDegradedKey(workdir)) ? 'Antigravity 已达到使用限额，冷却中' : null,
    onStopError: (error) => {
      const shown = error.length > STOP_ERROR_MAX_LEN ? `${error.slice(0, STOP_ERROR_MAX_LEN)}…` : error
      if (isAgyQuotaError(error)) {
        degraded.markDegraded(agyDegradedKey(workdir), Date.now() + AGY_QUOTA_COOLDOWN_MS)
        dbg(`agy: ${workdir} hit a quota/rate limit, unavailable for ${AGY_QUOTA_COOLDOWN_MS / 60_000} min: ${shown}`)
        void replyText(ctx.chatId, ctx.messageId, `⚠️ Antigravity 已达到使用限额：${shown}\n接下来 ${AGY_QUOTA_COOLDOWN_MS / 60_000} 分钟内的新消息${ctx.route.agent.fallback && infraConfig?.fallback.enabled ? `将切换到 ${BACKEND_DISPLAY[ctx.route.agent.fallback]}` : '会直接提示失败'}。`)
      } else {
        void replyText(ctx.chatId, ctx.messageId, `⚠️ Antigravity 本回合出错：${shown}`)
      }
    },
  })
}

async function handleInbound(data: any) {
  const ev = data.event ?? data
  const sender = ev.sender, message = ev.message
  if (!sender || !message) return

  const senderId: string = sender.sender_id?.open_id ?? ''
  const chatId: string = message.chat_id ?? ''
  const chatType: string = message.chat_type ?? 'p2p'
  const messageId: string = message.message_id ?? ''
  const msgType: string = message.message_type ?? (message as any).msg_type ?? 'text'
  const contentStr: string = message.content ?? message.body?.content ?? ''
  const mentions: any[] = message.mentions ?? []
  const createTime: string = message.create_time ?? ''
  if (!senderId || !chatId || !messageId) return
  // Peek only — recorded as processed further down, once delivery actually succeeds,
  // so a Feishu redelivery of a message that failed to route (no worker connected yet)
  // can still be retried instead of being dropped forever.
  if (wasEventProcessed(db, messageId)) { dbg(`duplicate event ${messageId}, dropping`); return }

  let text = ''
  const postImageKeys: string[] = []
  try {
    const parsed = JSON.parse(contentStr)
    if (msgType === 'post') {
      if (parsed.title) text += parsed.title
      const rows: any[] = Array.isArray(parsed.content) ? parsed.content : []
      for (const row of rows) {
        if (!Array.isArray(row)) continue
        const parts: string[] = []
        for (const seg of row) {
          if (seg?.tag === 'text' && seg.text) parts.push(seg.text)
          else if (seg?.tag === 'a' && seg.text) parts.push(`${seg.text}(${seg.href ?? ''})`)
          else if (seg?.tag === 'at' && (seg.user_name ?? seg.user_id)) parts.push(`@${seg.user_name ?? seg.user_id}`)
          else if (seg?.tag === 'img' && seg.image_key) postImageKeys.push(seg.image_key)
        }
        if (parts.length) text += (text ? '\n' : '') + parts.join(' ')
      }
    } else {
      text = parsed.text ?? ''
    }
  } catch { text = contentStr }

  const access = readAccess()
  const chatKind: 'p2p' | 'group' = chatType === 'group' ? 'group' : 'p2p'

  // Access check
  if (chatKind === 'p2p') {
    if (!access.allowFrom.includes(senderId)) { dbg(`dm from unknown ${senderId}, dropping`); return }
  } else {
    const policy = access.groups[chatId]
    if (!policy) { dbg(`group ${chatId} not configured, dropping`); return }
    if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(senderId)) return
  }

  const route = resolveRoute({ chatType: chatKind, chatId }, infraConfig, access)
  if (!route) { dbg(`no route for ${chatId}, dropping`); return }
  if (route.agentSanitized) dbg(`${chatId}: requested agent was not whitelisted for ${route.workdir}, downgraded to Claude-only`)

  if (chatKind === 'group') {
    const mentioned = checkMention(mentions, text, access.mentionPatterns)
    if (route.requireMention && !mentioned) return
  }

  // Ack reaction
  if (access.ackReaction) {
    void (apiClient as any).im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: access.ackReaction } },
    }).catch(() => {})
  }

  // Build attachment info. attDownloads mirrors atts but keeps the structured
  // (fileKey/type/fileName) shape claude-tmux mode needs to actually fetch
  // the file itself — unlike the socket-worker path, there's no MCP channel
  // plugin loaded in a tmux session for the CLI to call download_attachment with.
  const atts: string[] = []
  const attDownloads: { fileKey: string; type: 'file' | 'image'; fileName: string }[] = []
  if (msgType === 'file') {
    try {
      const c = JSON.parse(contentStr)
      atts.push(`${c.file_name ?? 'file'} (file, key:${c.file_key ?? ''})`)
      if (c.file_key) attDownloads.push({ fileKey: c.file_key, type: 'file', fileName: c.file_name ?? 'file' })
    } catch {}
  } else if (msgType === 'image') {
    try {
      const c = JSON.parse(contentStr)
      atts.push(`image (image/jpeg, key:${c.image_key ?? ''})`)
      if (c.image_key) attDownloads.push({ fileKey: c.image_key, type: 'image', fileName: 'image.png' })
    } catch {}
  }
  for (const k of postImageKeys) {
    atts.push(`image (image/jpeg, key:${k})`)
    attDownloads.push({ fileKey: k, type: 'image', fileName: 'image.png' })
  }

  const ts = createTime
    ? new Date(parseInt(createTime) > 1e12 ? parseInt(createTime) : parseInt(createTime) * 1000).toISOString()
    : new Date().toISOString()

  const parentId: string = (message as any).parent_id ?? ''
  const quotePrefix = parentId ? await fetchParentQuote(parentId) : ''
  const body = text || (atts.length ? '(attachment)' : '')
  const content = quotePrefix + body
  if (!content) return

  const workdir = route.workdir
  const ocContent = atts.length ? `${content}\n\n(Note: attachments are not supported by OpenCode yet and were ignored.)` : content

  if (route.agent.primary === 'opencode') {
    dbg(`routing ${chatId} (${chatType}) → ${workdir} via OpenCode`)
    // Mark processed now, at dispatch — not after the task finishes (which can
    // take up to taskTimeoutSeconds). Marking late left a redelivery window
    // where the same Feishu message_id could dispatch a second concurrent
    // OpenCode task before the first one completed.
    markEventProcessed(db, messageId, new Date().toISOString())
    void handleOpenCodeTask(route, chatId, messageId, chatKind, ocContent)
    return
  }

  // Socket-worker delivery, also used when Claude is another backend's fallback.
  const isClaudeRateLimited = () => degraded.isDegraded(resolve(workdir))
  const socketDeliver = () => !isClaudeRateLimited() && routeToWorkdir(workdir, {
    type: 'channel_message',
    content,
    meta: {
      chat_id: chatId,
      message_id: messageId,
      user: senderId,
      user_id: senderId,
      ts,
      chat_type: chatType,
      ...(parentId ? { parent_id: parentId } : {}),
      ...(atts.length ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    },
  })
  const ctx: TaskContext = { route, chatId, messageId, chatKind, content, ocContent, attachments: attDownloads, socketDeliver }

  if (route.agent.primary === 'agy') {
    markEventProcessed(db, messageId, new Date().toISOString())
    void runAgyTask(ctx)
    return
  }

  if (route.agent.mode === 'tmux') {
    markEventProcessed(db, messageId, new Date().toISOString())
    void runClaudeTmuxTask(ctx)
    return
  }

  dbg(`routing ${chatId} (${chatType}) → ${workdir}${parentId ? ' (reply)' : ''}`)
  const rateLimited = isClaudeRateLimited()
  if (rateLimited) dbg(`${chatId}: ${workdir} is rate-limited, skipping Claude Code attempt`)
  const delivered = socketDeliver()
  if (delivered) {
    markEventProcessed(db, messageId, new Date().toISOString())
    return
  }
  // Design doc §7's strictest allowed-fallback case: the task was never
  // delivered to Claude at all — no worker connected, or the worker reported
  // itself rate-limited (worker-link.ts sendDegraded) — so there is provably
  // no side effect and no risk of duplicate execution. A worker accepting the
  // task and then failing is deliberately NOT handled (needs task-state
  // tracking that isn't wired up yet).
  const fallbackNotice = (target: string) => rateLimited
    ? `⚠️ Claude Code 当前已达到使用限额，已切换到 ${target} 处理本次任务。`
    : `⚠️ Claude Code 当前不可用，已切换到 ${target} 处理本次任务。`
  const target = route.agent.fallback
  if (target && target !== 'claude' && startFallback('claude', ctx, fallbackNotice(BACKEND_DISPLAY[target]))) {
    markEventProcessed(db, messageId, new Date().toISOString())
  } else {
    const hint = rateLimited
      ? `⚠️ Claude Code hit its usage limit for \`${workdir}\` and hasn't reset yet. Please retry shortly.`
      : `⚠️ No active Claude Code session for \`${workdir}\`. Please run \`claude-feishu\` in that directory, then send your message again.`
    void (apiClient as any).im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text: hint }), reply_in_thread: false },
    }).catch((e: unknown) => dbg(`no-worker hint reply failed: ${e}`))
  }
}

async function handleCardAction(data: any): Promise<Record<string, unknown>> {
  const value = data?.action?.value ?? {}
  const code = value.code as string | undefined
  const action = value.action as string | undefined
  if (!code || !action) return {}

  if (action === 'tmux_dialog_choice') return tmuxRouting.handleTmuxDialogChoice(code, value.number)

  // Route precisely by the code the issuing worker registered (routing/storage.ts
  // PermissionRegistry). chat_id lookup is a defensive fallback only for the rare
  // case the registration message was lost in flight — we never broadcast to every
  // connected worker, since that could leak an unrelated project's approval prompt.
  const chatId = data?.open_chat_id ?? ''
  const registered = permissionRegistry.resolve(code)
  const workdir = registered?.workdir ?? (chatId ? resolveWorkdir(chatId, 'group') ?? resolveWorkdir(chatId, 'p2p') : undefined)
  // Only consume the registry entry once delivery actually succeeds — if the worker
  // has gone away, keep it so a retry (or a redelivered click) can still resolve it.
  const consumeIfDelivered = (delivered: boolean) => { if (delivered && registered) permissionRegistry.consume(code) }

  if (action === 'perm_allow' || action === 'perm_deny') {
    const behavior = action === 'perm_deny' ? 'deny' : 'allow'

    // OpenCode permission requests are tracked separately (routed directly to the
    // OpenCode Adapter, not to a Claude worker) — see handleOpenCodePermission.
    const nativePermission = nativePermissionOwners.get(code)
    if (nativePermission) {
      // The request/card belongs to one chat; never allow a forwarded callback to resolve another chat's tool.
      const callbackChat = data?.context?.open_chat_id ?? data?.open_chat_id
      if (callbackChat !== nativePermission.chatId) return { toast: { type: 'error', content: '授权来源不匹配' } }
      try {
        await nativePermission.coordinator.respondPermission(code, behavior === 'allow')
        nativePermission.card?.permissionResolved(code); nativePermissionOwners.delete(code)
        return { toast: { type: 'success', content: '授权回复已提交' } }
      } catch { return { toast: { type: 'error', content: '授权发送失败，请重试' } } }
    }
    if (openCodePermissionCodes.has(code)) {
      // Only remove the code once delivery is confirmed — deleting it first
      // (as the old code did) meant a failed respondPermission call stranded
      // the request: the code was gone from this set, but never registered
      // in permissionRegistry either, so a retry click fell through to the
      // Claude-worker branch below and matched nothing.
      let delivered = true
      try {
        await openCodeAdapter!.respondPermission(code, { requestId: code, behavior })
        openCodePermissionCodes.delete(code)
      } catch (e) {
        delivered = false
        dbg(`opencode respondPermission(${code}) failed: ${e}`)
      }
      const statusText = !delivered ? '⚠️ 发送失败，请重试' : (behavior === 'allow' ? '✅ 已允许' : '❌ 已拒绝')
      return {
        toast: { type: !delivered ? 'warning' : (behavior === 'deny' ? 'info' : 'success'), content: statusText },
        card: {
          type: 'raw',
          data: {
            schema: '2.0', config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: `🔐 OpenCode Permission — ${statusText}` }, template: !delivered ? 'red' : (behavior === 'deny' ? 'grey' : 'green') },
            body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${statusText}**` }] },
          },
        },
      }
    }

    const payload = { type: 'permission_response', request_id: code, behavior }
    const delivered = workdir ? routeToWorkdir(workdir, payload) : false
    consumeIfDelivered(delivered)
    if (!delivered) dbg(`callback code ${code} could not be delivered (workdir=${workdir ?? 'unknown'}), not broadcasting`)

    const statusText = !delivered ? '⚠️ 未找到在线实例，请确认对应项目仍在运行后重试' : (behavior === 'allow' ? '✅ 已允许' : '❌ 已拒绝')
    return {
      toast: { type: !delivered ? 'warning' : (behavior === 'deny' ? 'info' : 'success'), content: statusText },
      card: {
        type: 'raw',
        data: {
          schema: '2.0', config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `🔐 Permission Request — ${statusText}` }, template: !delivered ? 'red' : (behavior === 'deny' ? 'grey' : 'green') },
          body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${statusText}**` }] },
        },
      },
    }
  }

  if (action === 'confirm' || action === 'cancel') {
    const isConfirm = action === 'confirm'
    const payload = {
      type: 'confirm_response',
      content: isConfirm ? `CONFIRMED ${code}` : `CANCELLED ${code}`,
      meta: {
        chat_id: chatId || 'system',
        message_id: `card-${Date.now()}`,
        user: 'system',
        user_id: 'system',
        ts: new Date().toISOString(),
        chat_type: 'p2p',
      },
    }
    const delivered = workdir ? routeToWorkdir(workdir, payload) : false
    consumeIfDelivered(delivered)
    if (!delivered) dbg(`callback code ${code} could not be delivered (workdir=${workdir ?? 'unknown'}), not broadcasting`)

    const statusText = !delivered ? '⚠️ 未找到在线实例，请确认对应项目仍在运行后重试' : (isConfirm ? '✅ 已确认' : '❌ 已取消')
    return {
      toast: { type: !delivered ? 'warning' : (isConfirm ? 'success' : 'info'), content: statusText },
      card: {
        type: 'raw',
        data: {
          schema: '2.0', config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `⚡ 操作确认 — ${statusText}` }, template: !delivered ? 'red' : (isConfirm ? 'green' : 'grey') },
          body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${statusText}**` }] },
        },
      },
    }
  }

  return {}
}

// ── Startup ─────────────────────────────────────────────────────────────────

dbg('router starting')
mkdirSync(STATE_DIR, { recursive: true })
if (!acquireRouterLock(LOCK_DIR)) {
  dbg('router already owned by another live process; exiting')
  process.exit(0)
}
await fetchBotOpenId()

// Clean up stale socket
if (existsSync(SOCK_PATH)) { try { unlinkSync(SOCK_PATH) } catch {} }

sockServer.listen(SOCK_PATH, () => {
  chmodSync(SOCK_PATH, 0o600)
  dbg(`unix socket listening: ${SOCK_PATH}`)
})

// ── Router task MCP service (docs/router-task-mcp-design.md) ─────────────────
// Inert unless agents.yaml sets taskService.enabled (or tasks are left to drain).
// Fails closed: a task-service error never stops chat routing.
let taskService: RunningTaskService | null = null
if (infraConfig?.taskService) {
  const claudeTaskBin = resolveBin('claude', [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
  try {
    taskService = await startTaskService({
      input: infraConfig.taskService,
      projects: Object.fromEntries(Object.entries(infraConfig.projects).map(([id, p]) => [id, { workdir: p.workdir, allowedAgents: [...p.allowedAgents] }])),
      allowedRoots: AGENTS_ALLOWED_ROOTS,
      stateDir: STATE_DIR,
      log: dbg,
      onTaskClosed: () => { if (idleShutdownDeferred && workers.size === 0) scheduleIdleShutdown() },
      // Temporary (unmapped) workdirs: their agents live only for the tasks using them.
      onWorkdirReleased: (workdir) => {
        void teardownTaskScopedWorkdir(workdir, {
          configuredWorkdirs: () => {
            const a = readAccess()
            return [a.defaultWorkdir, ...Object.values(a.groups).map(g => g.workdir), ...Object.values(infraConfig?.projects ?? {}).map(p => p.workdir)]
          },
          tmuxManagers: [tmuxClaude, tmuxAgy, tmuxCodex],
          releaseOpenCodeBinding: (dir) => { openCodeBindings.delete(`task:workdir:${dir}`) },
          log: dbg,
        }).catch(e => dbg(`task-service: temporary workdir teardown for ${workdir} failed: ${e}`))
      },
      buildBackends: (cfg, paths) => createTaskBackends(cfg, paths, {
        openCodeAdapter,
        log: dbg,
        // Same binding store + creation lock chat uses; keyed by workdir so tasks on one workdir share its session.
        openCodeSessionFor: (dir) => getOrCreateOpenCodeSession(`task:workdir:${dir}`, { project: dir, workdir: dir } as NonNullable<ReturnType<typeof resolveRoute>>),
        openCodeSessionMissing: (dir, sessionId) => { evictMissingOpenCodeBinding(openCodeBindings, `task:workdir:${dir}`, sessionId, 'session_missing') },
        tmux: {
          claude: {
            manager: tmuxClaude,
            bin: claudeTaskBin,
            spawnFor: (c) => ({ model: explicitModel(c) }),
            authCheck: claudeAuthCheck(claudeTaskBin),
          },
          agy: {
            manager: tmuxAgy,
            bin: infraConfig?.agents.agy?.bin ?? resolveBin('agy', [join(homedir(), '.local', 'bin', 'agy'), '/opt/homebrew/bin/agy', '/usr/local/bin/agy']),
            spawnFor: (c, workdir) => resolveAgySpawnOptions(infraConfig, workdir, { model: explicitModel(c) }),
            unavailableReason: (workdir) => degraded.isDegraded(agyDegradedKey(workdir)) ? 'Antigravity is in a quota cooldown' : null,
            onStopError: (workdir, error) => {
              if (isAgyQuotaError(error)) degraded.markDegraded(agyDegradedKey(workdir), Date.now() + AGY_QUOTA_COOLDOWN_MS)
            },
          },
          codex: {
            manager: tmuxCodex,
            bin: infraConfig?.taskService?.backends?.codex?.bin ?? resolveBin('codex', ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(homedir(), '.local', 'bin', 'codex')]),
            // Sandbox is server config only; approvals stay on-request so prompts reach the broker (backend_policy auto-denies them).
            spawnFor: (c) => ({ model: explicitModel(c), sandbox: cfg.backends.codex?.sandbox ?? 'workspace-write', permissionMode: 'on-request' }),
          },
        },
      }),
    })
  } catch (e) {
    dbg(`task-service failed to start, task MCP unavailable: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const wsClient = new lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: lark.LoggerLevel.warn })
const dispatcher = new lark.EventDispatcher({ encryptKey: ENCRYPT_KEY }).register({
  'im.message.receive_v1': async (data: any) => {
    dbg('im.message.receive_v1 fired')
    return handleInbound(data).catch(e => dbg(`handleInbound failed: ${e}`))
  },
  'card.action.trigger': async (data: any) => {
    dbg('card.action.trigger fired')
    return handleCardAction(data).catch(e => { dbg(`handleCardAction failed: ${e}`); return {} })
  },
})

wsClient.start({ eventDispatcher: dispatcher }).catch(e => dbg(`wsClient error: ${e}`))

// Status on SIGUSR1
process.on('SIGUSR1', () => {
  const lines = [`\n=== Router Status ===`, `workers: ${workers.size}`]
  for (const w of workers.values()) {
    lines.push(`  ${w.workdir}`)
  }
  dbg(lines.join('\n'))
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return; shuttingDown = true
  dbg('shutting down')
  // Stops admission and closes task.sock; running tasks are reconciled on the next start.
  try { taskService?.stop() } catch (e) { dbg(`task-service stop failed: ${e}`) }
  sockServer.close()
  try { unlinkSync(SOCK_PATH) } catch {}
  releaseRouterLock(LOCK_DIR)
  try { (wsClient as any).disconnect?.() } catch {}
  setTimeout(() => process.exit(0), 2000)
}
process.on('SIGTERM', shutdown)
// Safety net: a stray promise rejection (e.g. from a background task-service step) is
// logged instead of terminating the router and every chat route with it.
process.on('unhandledRejection', (reason) => { dbg(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`) })
process.on('SIGINT', shutdown)
process.on('exit', () => releaseRouterLock(LOCK_DIR))

const access = readAccess()
const groupCount = Object.keys(access.groups).length
dbg(`router ready — ${groupCount} groups, defaultWorkdir=${access.defaultWorkdir ?? '(none)'}`)

// Prune processed_events so a long-running router's SQLite file doesn't grow unbounded.
const PRUNE_INTERVAL_MS = 6 * 3600 * 1000
const PRUNE_RETENTION_MS = 7 * 24 * 3600 * 1000
setInterval(() => {
  const n = pruneProcessedEvents(db, new Date(Date.now() - PRUNE_RETENTION_MS).toISOString())
  if (n) dbg(`pruned ${n} old processed_events rows`)
}, PRUNE_INTERVAL_MS)

// Unlike a socket worker (whose Claude Code process exits and takes the
// connection down with it), a tmux Claude session just sits there forever
// with nothing to notice it's unused — sweep for idle ones periodically.
const TMUX_IDLE_MS = 60 * 60 * 1000
const TMUX_IDLE_SWEEP_MS = 10 * 60 * 1000
setInterval(() => { void tmuxClaude.killIdleSessions(TMUX_IDLE_MS) }, TMUX_IDLE_SWEEP_MS)
// agy keeps its conversation id across an idle kill, so the next message resumes it (`--conversation`).
setInterval(() => { void tmuxAgy.killIdleSessions(TMUX_IDLE_MS) }, TMUX_IDLE_SWEEP_MS)
// Codex resumes its thread (`codex resume <id>`) after an idle kill, like agy.
setInterval(() => { void tmuxCodex.killIdleSessions(TMUX_IDLE_MS) }, TMUX_IDLE_SWEEP_MS)
setInterval(pruneOldTmuxAttachments, TMUX_IDLE_SWEEP_MS)

// Keep alive
await new Promise(() => {})
