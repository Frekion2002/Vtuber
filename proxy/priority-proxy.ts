import * as fs from 'node:fs'
import * as path from 'node:path'

import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Priority = 'P0' | 'P1' | 'P2' | 'P3'
const ORDER: Priority[] = ['P0', 'P1', 'P2', 'P3']

interface QueueItem {
  priority: Priority
  enqueuedAt: number
  body: unknown
  resolve: (res: Response) => void
  reject: (err: unknown) => void
}

const queues: Record<Priority, QueueItem[]> = { P0: [], P1: [], P2: [], P3: [] }

// Tier 1: 150 RPM → 400ms. Tier 0 (10 RPM) 사용 시 6000ms로 올려야 함.
const MIN_INTERVAL_MS = 420

// 우선순위별 stale drop 기준. P0는 절대 drop 금지.
const STALE_MS: Record<Priority, number> = {
  P0: Number.POSITIVE_INFINITY,
  P1: 10_000,
  P2: 5_000,
  P3: 2_000,
}

const UPSTREAM = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
const MODEL_PRIMARY = 'gemini-2.5-flash'
const MODEL_FALLBACK = 'gemini-2.5-flash-lite'
const API_KEY = process.env.GEMINI_API_KEY ?? ''

// Persona injection. We replace any system message in the chat completion body
// with the contents of ~/Airi/persona.md, so airi's bundled card prompt doesn't
// leak (e.g. ACT/emotion markers Gemini doesn't follow correctly). Cached by
// mtime — edit the file and the next request picks up the change. No restart.
const PERSONA_PATH = path.resolve(import.meta.dir, '..', 'persona.md')
let personaCache: { content: string, mtimeMs: number } | null = null

// Kill switch — broadcast safety control enforced OUTSIDE the LLM path so the
// model can never override it via prompt manipulation. State persists in
// ~/Airi/kill_switch.json and survives proxy restart. Edit the file or POST to
// /admin/kill_switch to change state.
//
// States:
//   NORMAL    — pass through, no intervention
//   THROTTLE  — add 3s delay to every chat / TTS request (suspicious but not catastrophic)
//   PAUSE     — bypass LLM entirely, return canned safe response. TTS muted.
//   FULL_STOP — return 503 on chat AND TTS. Hard emergency stop.
type KillSwitchState = 'NORMAL' | 'THROTTLE' | 'PAUSE' | 'FULL_STOP'

interface KillSwitchConfig {
  state: KillSwitchState
  reason?: string
  since?: number
}

const KILL_SWITCH_PATH = path.resolve(import.meta.dir, '..', 'kill_switch.json')
const THROTTLE_EXTRA_MS = 3000
const VALID_STATES: KillSwitchState[] = ['NORMAL', 'THROTTLE', 'PAUSE', 'FULL_STOP']

const SAFE_PAUSE_RESPONSE = {
  id: 'kill-switch-pause',
  object: 'chat.completion',
  created: 0,
  model: 'kill-switch',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content: '...P짱, 잠깐만요. 저 잠시 쉬어야 할 것 같아요. 곧 돌아올게요.',
    },
    finish_reason: 'stop',
  }],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
}

let killSwitchCache: { config: KillSwitchConfig, mtimeMs: number } | null = null

function loadKillSwitch(): KillSwitchConfig {
  let stat: fs.Stats
  try {
    stat = fs.statSync(KILL_SWITCH_PATH)
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'NORMAL' }
    console.warn('[kill_switch] stat failed:', err)
    return { state: 'NORMAL' }
  }
  if (killSwitchCache && killSwitchCache.mtimeMs === stat.mtimeMs) return killSwitchCache.config
  try {
    const content = fs.readFileSync(KILL_SWITCH_PATH, 'utf-8')
    const config = JSON.parse(content) as KillSwitchConfig
    if (!VALID_STATES.includes(config.state)) {
      console.warn(`[kill_switch] invalid state in file: ${config.state} — defaulting to NORMAL`)
      return { state: 'NORMAL' }
    }
    killSwitchCache = { config, mtimeMs: stat.mtimeMs }
    console.log(`[kill_switch] loaded state=${config.state} reason=${config.reason ?? '(none)'}`)
    return config
  }
  catch (err) {
    console.warn('[kill_switch] parse failed:', err)
    return { state: 'NORMAL' }
  }
}

function saveKillSwitch(config: KillSwitchConfig): void {
  const toWrite: KillSwitchConfig = { ...config, since: Date.now() }
  fs.writeFileSync(KILL_SWITCH_PATH, JSON.stringify(toWrite, null, 2))
  killSwitchCache = null  // force re-read on next request
  console.log(`[kill_switch] state changed to ${toWrite.state} reason=${toWrite.reason ?? '(none)'}`)
}

// Safety blocklist — categorized forbidden terms (politicians, religion, curse,
// etc.). Substring match (case-insensitive). Layer 0 scans user input before
// LLM call; Layer 2 scans LLM output before forwarding. Either match → replace
// with shiro-tone canned boundary response. Hot-reloaded on file mtime change.
const BLOCKLIST_PATH = path.resolve(import.meta.dir, '..', 'safety_blocklist.json')

interface BlocklistTerm {
  category: string
  term: string
  lower: string
}

let blocklistCache: { terms: BlocklistTerm[], mtimeMs: number } | null = null

function loadBlocklist(): BlocklistTerm[] {
  let stat: fs.Stats
  try {
    stat = fs.statSync(BLOCKLIST_PATH)
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    console.warn('[blocklist] stat failed:', err)
    return []
  }
  if (blocklistCache && blocklistCache.mtimeMs === stat.mtimeMs) return blocklistCache.terms
  try {
    const content = fs.readFileSync(BLOCKLIST_PATH, 'utf-8')
    const parsed = JSON.parse(content) as Record<string, unknown>
    const terms: BlocklistTerm[] = []
    for (const [category, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        for (const term of value) {
          if (typeof term === 'string' && term.length > 0) {
            terms.push({ category, term, lower: term.toLowerCase() })
          }
        }
      }
    }
    blocklistCache = { terms, mtimeMs: stat.mtimeMs }
    console.log(`[blocklist] loaded ${terms.length} terms (${new Set(terms.map(t => t.category)).size} categories)`)
    return terms
  }
  catch (err) {
    console.warn('[blocklist] parse failed:', err)
    return []
  }
}

function checkBlocklist(text: string): { category: string, term: string } | null {
  if (!text) return null
  const lower = text.toLowerCase()
  const terms = loadBlocklist()
  for (const t of terms) {
    if (lower.includes(t.lower)) return { category: t.category, term: t.term }
  }
  return null
}

// Shiro-tone canned responses for safety filter rejection. Multiple variants
// to avoid robotic repetition when same category triggers repeatedly.
const SAFE_BOUNDARY_MESSAGES = [
  '음... P짱. 그런 얘긴 안 받을게요. 후후. 다른 얘기 할까요?',
  'P짱, 그건 제가 다루는 주제가 아니에요. 죄송해요. 다른 거 얘기해요.',
  '...P짱. 그 얘긴 그만요. 우리 다른 거 해요. 오늘 어떠셨어요?',
  '후후, P짱. 그런 건 안 할게요. 노래라도 부를까요?',
  'P짱, 그건 좀... 다른 화제로 가요. 저 떡볶이 생각났거든요.',
  '...P짱. 그 얘긴 안 할래요. P짱은 오늘 어떤 노래 듣고 계셨어요?',
]

function buildSafeResponse(layer: 'layer0' | 'layer2'): object {
  const pick = SAFE_BOUNDARY_MESSAGES[Math.floor(Math.random() * SAFE_BOUNDARY_MESSAGES.length)]
  return {
    id: `safety-${layer}-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: `safety-filter-${layer}`,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: pick },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findLastUserMessage(body: any): string | null {
  if (!body || !Array.isArray(body.messages)) return null
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i]
    if (m?.role === 'user' && typeof m.content === 'string') return m.content
  }
  return null
}

// Format a chat.completion JSON object as a Server-Sent Events stream so
// streaming clients (airi sends stream:true) can parse it. We emit a single
// chunk with the full content + a [DONE] terminator. OpenAI streaming format.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatAsSSE(chatCompletion: any): Response {
  const content = chatCompletion?.choices?.[0]?.message?.content ?? ''
  const chunk = {
    id: chatCompletion.id,
    object: 'chat.completion.chunk',
    created: chatCompletion.created,
    model: chatCompletion.model,
    choices: [{
      index: 0,
      delta: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
  }
  const sse = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`
  return new Response(sse, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  })
}

function loadPersona(): string | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(PERSONA_PATH)
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.warn(`[persona] stat failed:`, err)
    return null
  }
  if (personaCache && personaCache.mtimeMs === stat.mtimeMs) return personaCache.content
  const content = fs.readFileSync(PERSONA_PATH, 'utf-8')
  personaCache = { content, mtimeMs: stat.mtimeMs }
  console.log(`[persona] loaded ${PERSONA_PATH} (${content.length} chars, mtime=${new Date(stat.mtimeMs).toISOString()})`)
  return content
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function injectPersona(body: any): void {
  const persona = loadPersona()
  if (!persona) return
  if (!body || !Array.isArray(body.messages)) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nonSystem = body.messages.filter((m: any) => m?.role !== 'system')
  body.messages = [{ role: 'system', content: persona }, ...nonSystem]
}

// hyp3r.link routes `/v1/audio/speech` with the /v1 prefix but serves voices at
// `/api/voices` (no /v1/). The bundled unspeech SDK builds both paths from one
// baseURL, so neither choice works end-to-end. We rewrite here.
const TTS_UPSTREAM = 'https://unspeech.hyp3r.link'

let lastDispatch = 0
let draining = false

function dequeue(): QueueItem | undefined {
  for (const p of ORDER) {
    const q = queues[p]
    while (q.length) {
      const item = q.shift()!
      if (Date.now() - item.enqueuedAt > STALE_MS[item.priority]) {
        item.reject(new Error(`priority ${item.priority} request dropped (stale)`))
        continue
      }
      return item
    }
  }
  return undefined
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (true) {
      const item = dequeue()
      if (!item) break
      const wait = Math.max(0, lastDispatch + MIN_INTERVAL_MS - Date.now())
      if (wait > 0) await new Promise(r => setTimeout(r, wait))
      lastDispatch = Date.now()
      try {
        item.resolve(await callUpstream(item.body, MODEL_PRIMARY))
      } catch (err) {
        item.reject(err)
      }
    }
  } finally {
    draining = false
  }
}

async function callUpstream(body: unknown, model: string): Promise<Response> {
  const payload = { ...(body as object), model }

  // TODO(verify-on-desktop): Gemini OpenAI-compat 엔드포인트 인증 방식이 Bearer 토큰인지 최종 확인
  const res = await fetch(UPSTREAM, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(payload),
  })

  if (res.status === 429) {
    if (model === MODEL_PRIMARY) return callUpstream(body, MODEL_FALLBACK)
    const retryAfter = res.headers.get('retry-after')
    throw new Error(`quota exhausted (both models), retry-after=${retryAfter}`)
  }

  // TODO: 5xx 발생 시 지수 백오프 (1s → 2s → 4s, 최대 3회). 현재는 그대로 중계.
  return res
}

const app = new Hono()

app.use('/*', async (c, next) => {
  const start = Date.now()
  const method = c.req.method
  const path = c.req.path
  const prio = c.req.header('x-priority') ?? '-'
  await next()
  const ms = Date.now() - start
  console.log(`[${new Date().toISOString()}] ${method} ${path} prio=${prio} → ${c.res.status} ${ms}ms`)
})

app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Priority'],
}))

app.get('/v1/models', c => c.json({
  object: 'list',
  data: [
    { id: 'gemini-2.5-flash', object: 'model', created: 0, owned_by: 'google' },
    { id: 'gemini-2.5-flash-lite', object: 'model', created: 0, owned_by: 'google' },
  ],
}))

app.post('/v1/chat/completions', async (c) => {
  // Kill switch enforcement BEFORE any LLM call. State outside LLM control.
  const ks = loadKillSwitch()
  if (ks.state === 'FULL_STOP') {
    return c.json({ error: { message: 'broadcast halted (FULL_STOP)', type: 'kill_switch' } }, 503)
  }
  if (ks.state === 'PAUSE') {
    const canned = { ...SAFE_PAUSE_RESPONSE, created: Math.floor(Date.now() / 1000) }
    return c.json(canned)  // skip LLM entirely
  }
  if (ks.state === 'THROTTLE') {
    await new Promise(r => setTimeout(r, THROTTLE_EXTRA_MS))
    // continue with normal flow
  }

  const body = await c.req.json()

  // Remember whether client wanted SSE — we still force non-streaming UPSTREAM
  // (so Layer 2 can scan full response), but format reply back to client as SSE
  // if that's what they expected. Otherwise airi can't parse our reply.
  const wantStreaming = body.stream === true

  // Layer 0 — input filter. Scan last user message before any LLM call.
  // Match → bypass LLM, return shiro-tone boundary response. No quota burn.
  const lastUser = findLastUserMessage(body)
  if (lastUser) {
    const hit = checkBlocklist(lastUser)
    if (hit) {
      console.log(`[layer0] BLOCKED input category=${hit.category} term="${hit.term}"`)
      const safe = buildSafeResponse('layer0')
      return wantStreaming ? formatAsSSE(safe) : c.json(safe)
    }
  }

  injectPersona(body)

  // Force non-streaming so Layer 2 can scan the full response before forwarding.
  // Trade-off: client gets full response at once (we re-stream as one SSE chunk
  // if they wanted streaming). Latency: ~1-2s extra before TTS starts.
  body.stream = false

  const rawPriority = c.req.header('x-priority')?.toUpperCase() ?? 'P2'
  if (!ORDER.includes(rawPriority as Priority)) {
    return c.json({ error: `invalid x-priority header: ${rawPriority}` }, 400)
  }
  const priority = rawPriority as Priority

  const upstream = await new Promise<Response>((resolve, reject) => {
    queues[priority].push({ priority, enqueuedAt: Date.now(), body, resolve, reject })
    drain()
  })

  // Pass non-200 (errors) through as-is so airi can react properly to 429 etc.
  if (upstream.status !== 200) {
    const errBody = await upstream.text()
    const forwardHeaders = new Headers()
    const ct = upstream.headers.get('content-type')
    if (ct) forwardHeaders.set('content-type', ct)
    const ra = upstream.headers.get('retry-after')
    if (ra) forwardHeaders.set('retry-after', ra)
    return new Response(errBody, { status: upstream.status, headers: forwardHeaders })
  }

  // Layer 2 — output filter. Scan assistant content. Match → replace.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let upstreamData: any
  try {
    upstreamData = await upstream.json()
  }
  catch (err) {
    console.warn('[layer2] failed to parse upstream JSON:', err)
    return c.json({ error: 'upstream parse failed' }, 502)
  }

  const assistantContent = upstreamData?.choices?.[0]?.message?.content
  if (typeof assistantContent === 'string') {
    const hit = checkBlocklist(assistantContent)
    if (hit) {
      console.log(`[layer2] BLOCKED output category=${hit.category} term="${hit.term}"`)
      const safe = buildSafeResponse('layer2')
      return wantStreaming ? formatAsSSE(safe) : c.json(safe)
    }
  }

  return wantStreaming ? formatAsSSE(upstreamData) : c.json(upstreamData)
})

app.post('/v1/audio/speech', async (c) => {
  // Kill switch — TTS muted on PAUSE, blocked on FULL_STOP, delayed on THROTTLE.
  const ks = loadKillSwitch()
  if (ks.state === 'FULL_STOP') {
    return new Response(null, { status: 503 })
  }
  if (ks.state === 'PAUSE') {
    return new Response(null, { status: 204 })  // silent — no audio body
  }
  if (ks.state === 'THROTTLE') {
    await new Promise(r => setTimeout(r, THROTTLE_EXTRA_MS))
  }

  const authHeader = c.req.header('authorization') ?? ''
  const contentType = c.req.header('content-type') ?? 'application/json'
  const body = await c.req.arrayBuffer()

  const upstream = await fetch(`${TTS_UPSTREAM}/v1/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body,
  })

  const forwardHeaders = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) forwardHeaders.set('content-type', ct)

  return new Response(upstream.body, {
    status: upstream.status,
    headers: forwardHeaders,
  })
})

// unspeech's createUnElevenLabs.voice() strips `/v1/` from the baseURL before
// calling listVoices, so the incoming request lands on `/api/voices` (no /v1/).
// speech() does NOT strip, so /v1/audio/speech stays as-is above.
app.get('/api/voices', async (c) => {
  const authHeader = c.req.header('authorization') ?? ''
  const qs = new URL(c.req.url).searchParams.toString()
  const upstream = await fetch(`${TTS_UPSTREAM}/api/voices${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: authHeader ? { Authorization: authHeader } : {},
  })

  const forwardHeaders = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) forwardHeaders.set('content-type', ct)

  return new Response(upstream.body, {
    status: upstream.status,
    headers: forwardHeaders,
  })
})

app.get('/health', c => c.json({
  ok: true,
  queues: {
    P0: queues.P0.length,
    P1: queues.P1.length,
    P2: queues.P2.length,
    P3: queues.P3.length,
  },
}))

// Admin — kill switch state visibility + control. No auth: proxy listens on
// localhost only, anyone with shell access can do anything anyway. Add token
// auth here if you ever bind to a non-localhost interface.
app.get('/admin/status', (c) => {
  const ks = loadKillSwitch()
  const terms = loadBlocklist()
  const categories = new Set(terms.map(t => t.category))
  return c.json({
    kill_switch: ks,
    persona_loaded: !!personaCache,
    blocklist: { total_terms: terms.length, categories: categories.size },
    queues: {
      P0: queues.P0.length,
      P1: queues.P1.length,
      P2: queues.P2.length,
      P3: queues.P3.length,
    },
  })
})

app.post('/admin/kill_switch', async (c) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any
  try {
    body = await c.req.json()
  }
  catch {
    return c.json({ error: 'body must be JSON' }, 400)
  }
  if (!body || typeof body.state !== 'string' || !VALID_STATES.includes(body.state as KillSwitchState)) {
    return c.json({ error: `state must be one of: ${VALID_STATES.join(', ')}` }, 400)
  }
  saveKillSwitch({ state: body.state, reason: body.reason })
  return c.json({ ok: true, state: body.state, reason: body.reason ?? null })
})

// Bun.serve는 Bun 런타임에서만 동작. Node에서 쓰려면 @hono/node-server로 교체 필요.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).Bun?.serve({ port: 3100, fetch: app.fetch })
console.log('Priority proxy listening on http://localhost:3100')
