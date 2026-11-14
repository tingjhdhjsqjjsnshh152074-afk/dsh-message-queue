/**
 * Host half of the message-queue bundle.
 *
 * Owns one durable queue per Session, delivers its items strictly in order, and answers the
 * JSON endpoint the Client half calls. An item's trigger is an absolute time, the end of the
 * turn that was running when it was queued, or a delay after that turn.
 */
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name. */
export const name = 'message-queue'

/** Host services this plugin cannot do without. */
export const inject = ['webServer', 'agents', 'sessions']

const CLIENT_FILE = fileURLToPath(new URL('./client.js', import.meta.url))
const ROUTE_PATH = '/plugin/message-queue'
const TICK_MS = 1_000
const MAX_BODY_BYTES = 64 * 1024
const MAX_WAITING = 50
const KEEP_SENT = 12
const MAX_TEXT = 8_000
/** An `at` item overdue by more than this needs a human decision after a Host restart. */
const MISSED_GRACE_MS = 5 * 60 * 1_000
const MAX_DELAY_SECONDS = 30 * 24 * 3_600

/**
 * Freeze one plain JSON value in place.
 * @param value - value to freeze recursively.
 * @returns the same value.
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

/**
 * @param value - candidate JSON value.
 * @returns whether it is a plain object.
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Report the browser half's artifact identity.
 * @returns a size and modification stamp, or unknown when it cannot be read.
 */
function clientRevision() {
  try {
    const stat = statSync(CLIENT_FILE)
    return `${stat.size}-${Math.round(stat.mtimeMs)}`
  } catch {
    return 'unknown'
  }
}

/** @returns the durable queue document path under the deployment's data home. */
function storagePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'message-queue.json')
}

/** @returns an empty queue document. */
function emptyDocument() {
  return { version: 1, sessions: {} }
}

/**
 * Read one stored trigger, dropping anything unrecognized.
 * @param raw - stored trigger.
 * @returns the normalized trigger, or `undefined` when unusable.
 */
function readTrigger(raw) {
  if (!isObject(raw)) return undefined
  if (raw.kind === 'after') return { kind: 'after' }
  if (raw.kind === 'delay') {
    const seconds = Number(raw.seconds)
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DELAY_SECONDS) return undefined
    return { kind: 'delay', seconds: Math.round(seconds) }
  }
  if (raw.kind === 'at') {
    const at = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN
    if (!Number.isFinite(at)) return undefined
    return { kind: 'at', at: new Date(at).toISOString() }
  }
  return undefined
}

/**
 * Read one stored item.
 * @param raw - stored item.
 * @returns the normalized item, or `undefined` when unusable.
 */
function readItem(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.text !== 'string') return undefined
  const trigger = readTrigger(raw.trigger)
  if (trigger === undefined) return undefined
  const status = raw.status === 'sending' || raw.status === 'missed'
    ? 'missed'
    : raw.status === 'sent' ? 'sent' : 'waiting'
  const item = { id: raw.id, text: raw.text, trigger, status, createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString() }
  if (typeof raw.armedAt === 'string') item.armedAt = raw.armedAt
  if (typeof raw.sentAt === 'string') item.sentAt = raw.sentAt
  if (typeof raw.lastError === 'string') item.lastError = raw.lastError
  if (isObject(raw.repeat)) {
    if (raw.repeat.endless === true) item.repeat = { endless: true }
    else {
      const remaining = Number(raw.repeat.remaining)
      if (Number.isFinite(remaining) && remaining > 0) item.repeat = { remaining: Math.min(Math.floor(remaining), 99) }
    }
  }
  if (typeof raw.sentCount === 'number' && raw.sentCount > 0) item.sentCount = raw.sentCount
  // A Host that died mid-delivery leaves `sending`; the message may or may not have landed.
  if (raw.status === 'sending') item.lastError = '上次发送被中断，请确认是否已经发出'
  return item
}

/**
 * Restore one stored document, dropping rows this version cannot interpret.
 * @param raw - parsed file content.
 * @returns the normalized document.
 */
function readDocument(raw) {
  const document = emptyDocument()
  if (!isObject(raw) || !isObject(raw.sessions)) return document
  for (const [sessionId, entry] of Object.entries(raw.sessions)) {
    if (!isObject(entry)) continue
    const items = Array.isArray(entry.items)
      ? entry.items.map(readItem).filter(item => item !== undefined)
      : []
    document.sessions[sessionId] = { paused: entry.paused === true, items }
  }
  return document
}

/**
 * Write the document atomically.
 * @param file - destination path.
 * @param text - complete JSON text.
 * @returns fulfillment after the rename.
 */
async function writeSnapshot(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
}

/**
 * Read one request body as JSON.
 * @param request - incoming HTTP request.
 * @returns the parsed body.
 */
function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(text.length === 0 ? {} : JSON.parse(text))
      } catch (error) {
        reject(new Error(`JSON 无效：${error instanceof Error ? error.message : String(error)}`))
      }
    })
    request.on('error', reject)
  })
}

/**
 * @param response - outgoing response.
 * @param status - HTTP status.
 * @param payload - JSON body.
 */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Mount the queue: durable state, the delivery timer, and the Client endpoint.
 * @param ctx - Host context with `webServer`, `agents`, and `sessions`.
 */
export function apply(ctx) {
  const file = storagePath()
  let document = emptyDocument()
  let ready = false
  const delivering = new Set()
  let writing = Promise.resolve()
  /** Client-half breadcrumbs: which stage of the browser bundle reached this Host process. */
  const probe = { factory: undefined, apply: undefined, render: undefined, error: undefined }

  /** @returns the mutable queue entry of one Session. */
  function queueOf(sessionId) {
    let entry = document.sessions[sessionId]
    if (entry === undefined) {
      entry = { paused: false, items: [] }
      document.sessions[sessionId] = entry
    }
    return entry
  }

  /** @returns fulfillment after the document reached disk. */
  function save() {
    const snapshot = JSON.stringify(document)
    writing = writing
      .then(() => writeSnapshot(file, snapshot), () => writeSnapshot(file, snapshot))
      .catch((error) => {
        ctx.logger.warn(`message-queue: could not write ${file}: ${String(error)}`)
      })
    return writing
  }

  /**
   * @param sessionId - Session identity.
   * @returns whether its live Agent owns an active turn.
   */
  function agentBusy(sessionId) {
    const agent = ctx.agents.get(sessionId)
    return agent !== undefined && agent.status !== 'idle'
  }

  /**
   * Resolve the live Agent of one Session, activating it when needed.
   * @param sessionId - Session identity.
   * @returns the live Agent.
   */
  async function resolveAgent(sessionId) {
    const controller = ctx.get('sessionController')
    if (controller !== undefined && typeof controller.resolveAgent === 'function') {
      const resolved = await controller.resolveAgent(sessionId)
      if (resolved !== undefined && resolved !== null && 'error' in resolved) throw resolved.error
      if (resolved?.agent !== undefined) return resolved.agent
    }
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error(`会话 ${sessionId} 不可用`)
    return agent
  }

  /**
   * Resolve when a turn-relative item starts counting: the running turn must end first.
   * @param item - waiting item.
   * @param sessionId - owning Session.
   * @param now - current epoch milliseconds.
   * @returns whether the item has an anchor now.
   */
  function arm(item, sessionId, now) {
    if (item.trigger.kind === 'at') return true
    if (item.armedAt !== undefined) return true
    if (agentBusy(sessionId)) return false
    item.armedAt = new Date(now).toISOString()
    void save()
    return true
  }

  /**
   * @param item - armed item.
   * @param now - current epoch milliseconds.
   * @returns whether it may be delivered.
   */
  function due(item, now) {
    // A looping item waits out its own floor so one idle boundary cannot cascade sends.
    if (item.repeatAt !== undefined && now < Date.parse(item.repeatAt)) return false
    if (item.trigger.kind === 'at') return now >= Date.parse(item.trigger.at)
    if (item.trigger.kind === 'after') return true
    return now >= Date.parse(item.armedAt) + item.trigger.seconds * 1_000
  }

  /**
   * Keep the newest sent receipts and everything still pending.
   * @param entry - owning queue entry.
   */
  function prune(entry) {
    const sent = entry.items.filter(item => item.status === 'sent')
    const excess = sent.length - KEEP_SENT
    if (excess <= 0) return
    const dropped = new Set(sent.slice(0, excess).map(item => item.id))
    entry.items = entry.items.filter(item => !dropped.has(item.id))
  }

  /**
   * Deliver one item, then hold the Session's slot until its turn reaches idle.
   * @param sessionId - owning Session.
   * @param entry - owning queue entry.
   * @param item - item to deliver.
   */
  async function deliver(sessionId, entry, item) {
    delivering.add(sessionId)
    item.status = 'sending'
    await save()
    let agent
    try {
      agent = await resolveAgent(sessionId)
      agent.followup(deepFreeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: item.text }],
        source: { kind: 'user' },
      }))
      const flushed = await ctx.sessions.flush(agent.session)
      if (flushed === false) throw new Error('会话没有确认持久化')
      item.sentAt = new Date().toISOString()
      item.sentCount = (item.sentCount ?? 0) + 1
      delete item.armedAt
      delete item.lastError
      const repeat = item.repeat
      const looping = repeat !== undefined && (repeat.endless === true || repeat.remaining > 0)
      item.status = looping ? 'waiting' : 'sent'
      if (looping && repeat.endless !== true) repeat.remaining -= 1
      prune(entry)
      await save()
    } catch (error) {
      item.status = 'missed'
      item.lastError = error instanceof Error ? error.message : String(error)
      agent = undefined
      await save()
    }
    if (agent !== undefined) {
      try {
        await agent.whenIdle()
      } catch (error) {
        ctx.logger.warn(`message-queue: idle wait rejected for ${sessionId}: ${String(error)}`)
      }
    }
    if (item.status === 'waiting') {
      // A looping item restarts its turn-relative countdown at this idle boundary.
      item.armedAt = new Date().toISOString()
      item.repeatAt = new Date(Date.now() + 2_500).toISOString()
      await save()
      delivering.delete(sessionId)
      tick()
      return
    }
    delivering.delete(sessionId)
  }

  /** Advance every unpaused queue by at most one item. */
  function tick() {
    if (!ready) return
    const now = Date.now()
    for (const [sessionId, entry] of Object.entries(document.sessions)) {
      if (entry.paused || delivering.has(sessionId)) continue
      const item = entry.items.find(candidate => candidate.status === 'waiting')
      if (item === undefined) continue
      if (arm(item, sessionId, now) && due(item, now)) void deliver(sessionId, entry, item)
    }
  }

  /**
   * Build the Client view of one Session's queue.
   * @param sessionId - Session identity.
   * @returns its public queue state.
   */
  function publicState(sessionId) {
    const entry = document.sessions[sessionId] ?? { paused: false, items: [] }
    return {
      sessionId,
      paused: entry.paused === true,
      delivering: delivering.has(sessionId),
      agentBusy: agentBusy(sessionId),
      build: clientRevision(),
      client: { ...probe },
      now: new Date().toISOString(),
      items: entry.items.map(item => ({ ...item })),
    }
  }

  /**
   * @param body - request body.
   * @returns the addressed Session identity.
   */
  function sessionOf(body) {
    if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) throw new Error('缺少 sessionId')
    return body.sessionId
  }

  /**
   * Read one request trigger from a body.
   * @param raw - requested trigger.
   * @returns the normalized trigger.
   */
  function parseTrigger(raw) {
    const trigger = readTrigger(raw)
    if (trigger === undefined) throw new Error('触发方式无效')
    return trigger
  }

  /**
   * Read one requested repeat rule.
   * @param raw - requested repeat.
   * @returns the repeat rule, or `undefined` for a single send.
   */
  function parseRepeat(raw) {
    if (!isObject(raw)) return undefined
    if (raw.endless === true) return { endless: true }
    const remaining = Number(raw.remaining)
    if (!Number.isFinite(remaining) || remaining <= 0) return undefined
    return { remaining: Math.min(Math.floor(remaining), 99) }
  }

  /**
   * @param body - request body.
   * @returns the item to remove.
   */
  function itemOf(body, sessionId) {
    if (typeof body.id !== 'string') throw new Error('缺少 id')
    const entry = document.sessions[sessionId]
    const item = entry?.items.find(candidate => candidate.id === body.id)
    if (item === undefined) throw new Error('这一条已经不在队列里了')
    return item
  }

  /**
   * Apply one queue operation.
   * @param body - operation name plus its parameters.
   * @returns the resulting public state.
   */
  async function rpc(body) {
    if (!isObject(body)) throw new Error('请求体无效')
    if (body.op === 'hello') {
      if (typeof body.stage === 'string') probe[body.stage] = { at: new Date().toISOString(), note: typeof body.note === 'string' ? body.note : undefined }
      return { sessionId: '', paused: false, delivering: false, agentBusy: false, now: new Date().toISOString(), items: [], build: clientRevision(), client: { ...probe } }
    }
    const sessionId = sessionOf(body)
    const entry = queueOf(sessionId)

    if (body.op === 'state') return publicState(sessionId)

    if (body.op === 'add') {
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text.length === 0) throw new Error('消息是空的')
      if (text.length > MAX_TEXT) throw new Error(`消息太长（上限 ${MAX_TEXT} 字）`)
      if (entry.items.filter(item => item.status === 'waiting').length >= MAX_WAITING) {
        throw new Error(`队列已满（${MAX_WAITING} 条）`)
      }
      const trigger = parseTrigger(body.trigger)
      const repeat = parseRepeat(body.repeat)
      const now = Date.now()
      const item = {
        id: randomUUID(),
        text,
        trigger,
        status: 'waiting',
        createdAt: new Date(now).toISOString(),
        ...(repeat === undefined ? {} : { repeat }),
      }
      if (trigger.kind !== 'at' && !agentBusy(sessionId)) item.armedAt = new Date(now).toISOString()
      entry.items.push(item)
      await save()
      tick()
      return publicState(sessionId)
    }

    if (body.op === 'cancel') {
      const item = itemOf(body, sessionId)
      if (item.status === 'sending') throw new Error('这一条正在发送，停不下来')
      entry.items = entry.items.filter(candidate => candidate.id !== item.id)
      await save()
      return publicState(sessionId)
    }

    if (body.op === 'move') {
      const item = itemOf(body, sessionId)
      const pending = entry.items.filter(candidate => candidate.status === 'waiting')
      const at = pending.indexOf(item)
      if (at === -1) throw new Error('只有等待中的条目能调整顺序')
      const swapWith = body.direction === 'up' ? at - 1 : at + 1
      if (swapWith < 0 || swapWith >= pending.length) return publicState(sessionId)
      const other = pending[swapWith]
      const from = entry.items.indexOf(item)
      const to = entry.items.indexOf(other)
      entry.items[from] = other
      entry.items[to] = item
      await save()
      return publicState(sessionId)
    }

    if (body.op === 'pause') {
      entry.paused = body.paused === true
      await save()
      return publicState(sessionId)
    }

    if (body.op === 'confirm') {
      const item = itemOf(body, sessionId)
      const action = body.action
      if (action === 'drop') {
        entry.items = entry.items.filter(candidate => candidate.id !== item.id)
        await save()
        return publicState(sessionId)
      }
      if (action === 'send') {
        const now = Date.now()
        item.status = 'waiting'
        delete item.lastError
        if (item.trigger.kind === 'at') item.trigger = { kind: 'at', at: new Date(now).toISOString() }
        else item.armedAt = new Date(now).toISOString()
        await save()
        tick()
        return publicState(sessionId)
      }
      if (action === 'reschedule') {
        item.status = 'waiting'
        delete item.lastError
        item.trigger = parseTrigger({ kind: 'at', at: body.at })
        delete item.armedAt
        await save()
        return publicState(sessionId)
      }
      throw new Error('未知的确认动作')
    }

    if (body.op === 'clearSent') {
      entry.items = entry.items.filter(item => item.status !== 'sent')
      await save()
      return publicState(sessionId)
    }

    throw new Error(`未知操作：${String(body.op)}`)
  }

  /**
   * Mark items a Host restart made impossible to send on time.
   * @returns the number of items that need confirmation.
   */
  function markOverdue() {
    const now = Date.now()
    let marked = 0
    for (const entry of Object.values(document.sessions)) {
      for (const item of entry.items) {
        if (item.status !== 'waiting' || item.trigger.kind !== 'at') continue
        if (now - Date.parse(item.trigger.at) <= MISSED_GRACE_MS) continue
        item.status = 'missed'
        item.lastError = '错过了执行窗口'
        marked += 1
      }
    }
    return marked
  }

  /** @returns fulfillment once the stored document is loaded and the timer may deliver. */
  async function load() {
    try {
      document = readDocument(JSON.parse(await readFile(file, 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        ctx.logger.warn(`message-queue: could not read ${file}: ${String(error)}`)
      }
      document = emptyDocument()
    }
    markOverdue()
    ready = true
    tick()
  }

  /**
   * Answer one Client request.
   * @param request - incoming request.
   * @param response - outgoing response.
   */
  async function handle(request, response) {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: '只接受 POST' })
      return
    }
    try {
      const body = await readJson(request)
      sendJson(response, 200, { ok: true, state: await rpc(body) })
    } catch (error) {
      sendJson(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: handle }))

  ctx.effect(() => {
    const timer = setInterval(tick, TICK_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  })

  ctx.effect(() => {
    void load()
    return () => {
      ready = false
    }
  })
}
