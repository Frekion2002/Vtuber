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
  const body = await c.req.json()
  injectPersona(body)
  const rawPriority = c.req.header('x-priority')?.toUpperCase() ?? 'P2'
  if (!ORDER.includes(rawPriority as Priority)) {
    return c.json({ error: `invalid x-priority header: ${rawPriority}` }, 400)
  }
  const priority = rawPriority as Priority

  const upstream = await new Promise<Response>((resolve, reject) => {
    queues[priority].push({ priority, enqueuedAt: Date.now(), body, resolve, reject })
    drain()
  })

  // Forward only safe headers. fetch() already decompressed gzip, so forwarding
  // `content-encoding: gzip` poisons the browser's decoder → "Failed to fetch".
  // Drop `content-length` too (wrong after decompression). Drop upstream cookies
  // and CORS headers (ours are injected by the cors middleware).
  const forwardHeaders = new Headers()
  const ct = upstream.headers.get('content-type')
  if (ct) forwardHeaders.set('content-type', ct)
  const ra = upstream.headers.get('retry-after')
  if (ra) forwardHeaders.set('retry-after', ra)

  return new Response(upstream.body, {
    status: upstream.status,
    headers: forwardHeaders,
  })
})

app.post('/v1/audio/speech', async (c) => {
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

// Bun.serve는 Bun 런타임에서만 동작. Node에서 쓰려면 @hono/node-server로 교체 필요.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).Bun?.serve({ port: 3100, fetch: app.fetch })
console.log('Priority proxy listening on http://localhost:3100')
