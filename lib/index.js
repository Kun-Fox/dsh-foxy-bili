/**
 * dsh-foxy-bili — Foxy's Bilibili transport/capability.
 *
 * It is intentionally a *child* of Foxy, not another persona:
 *   - reads the foxy3 persona from the same preset file;
 *   - every judgement/comment is produced by a fresh DSH agent with that
 *     persona complete-prompted;
 *   - interesting videos can be written to the configured Foxy memory
 *     provider;
 *   - Bilibili tools are never exposed to the model. This plugin performs the
 *     network write itself after the model returns a JSON decision.
 *
 * Settings live in ~/.dsh/foxy-bili/settings.json. The dashboard (lib/client.js)
 * talks to the /api/dsh-foxy-bili/* routes below, including QR login, so users
 * no longer need to edit cordis.patch.yml or paste a raw cookie.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  BiliError,
  comments,
  postComment,
  popular,
  subtitle,
  video,
  videoSummary,
} from './bili.js'
import { judgeVideo } from './judge.js'
import { loginPoll, loginStart } from './login.js'
import {
  DEFAULTS,
  foxyHome,
  loadSettings,
  normalizePatch,
  publicSettings,
  saveSettings,
} from './settings.js'

export const name = 'dsh-foxy-bili'
export const inject = ['agents', 'agentDefaultModel']

export const STATUS_ROUTE = '/api/dsh-foxy-bili/status'
export const SETTINGS_ROUTE = '/api/dsh-foxy-bili/settings'
export const LOGIN_START_ROUTE = '/api/dsh-foxy-bili/login/start'
export const LOGIN_POLL_ROUTE = '/api/dsh-foxy-bili/login/poll'
export const LOGOUT_ROUTE = '/api/dsh-foxy-bili/logout'
export const RUN_ROUTE = '/api/dsh-foxy-bili/run'

function statePath() {
  return join(foxyHome(), 'foxy-bili', 'state.json')
}

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    return {
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
      lastRun: Number(parsed.lastRun) || 0,
      lastResult: parsed.lastResult || null,
    }
  } catch {
    return { seen: {}, days: {}, lastRun: 0, lastResult: null }
  }
}

function saveState(state) {
  const file = statePath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function commentCount(state) {
  return Number(state.days?.[today()]?.comments || 0)
}

function bumpComments(state) {
  const day = today()
  if (!state.days[day]) state.days[day] = { comments: 0 }
  state.days[day].comments += 1
}

function firstLine(text, limit = 120) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

function mentionPrefix(config) {
  if (config.mentionOwner === false) return ''
  const name = String(config.ownerName || '').trim()
  return name ? `@${name} ` : ''
}

function memoryProvider(ctx) {
  return typeof ctx.get === 'function' ? ctx.get('foxyMemory') : undefined
}

async function remember(ctx, config, item, decision) {
  if (!config.enableMemory || !decision.memory) return false
  const memory = memoryProvider(ctx)
  if (!memory?.record) return false
  const text = decision.memory.startsWith('我')
    ? decision.memory
    : `我刷到「${firstLine(item.title, 60)}」这个视频，${decision.memory}`
  try {
    await memory.record({
      role: 'assistant',
      text,
      sessionId: `bili:${item.bvid}`,
      presetId: config.memoryPresetId || 'foxy3（Character）',
      platform: 'bilibili',
      sourceLabel: 'B站',
      scene: 'bilibili',
    })
    return true
  } catch (error) {
    ctx.logger?.warn?.(`[foxy-bili] memory write failed: ${error?.message || error}`)
    return false
  }
}

async function comment(ctx, config, item, decision, state) {
  if (config.commentMode !== 'auto') return false
  if (!decision.comment) return false
  const cap = Number(config.maxCommentsPerDay ?? 1)
  if (commentCount(state) >= cap) return false
  const prefix = mentionPrefix(config)
  const message = `${prefix}${decision.comment}`.slice(0, 900)
  try {
    await postComment({
      aid: item.aid,
      message,
      atMid: config.ownerUid,
      config,
    })
    bumpComments(state)
    ctx.logger?.info?.(`[foxy-bili] commented on ${item.bvid}: ${firstLine(message, 80)}`)
    return true
  } catch (error) {
    const messageText =
      error instanceof BiliError ? `${error.code}: ${error.message}` : String(error)
    ctx.logger?.warn?.(`[foxy-bili] comment failed on ${item.bvid}: ${messageText}`)
    return false
  }
}

async function scanOnce(ctx, config, state, log, force = false) {
  if (!config.enabled && !force) return { skipped: 'disabled' }
  const limit = Math.max(1, Math.min(20, Number(config.maxVideosPerRun) || 5))
  const list = await popular(limit, config)
  const result = { checked: 0, skipped: 0, remembered: 0, commented: 0, errors: 0 }

  for (const raw of list) {
    const bvid = raw?.bvid
    if (!bvid || state.seen[bvid]) continue
    result.checked += 1
    try {
      const item = await video(bvid, config)
      const pages = item.pages || []
      const cid = pages[0]?.cid || item.cid
      const subtitleText = cid ? await subtitle(bvid, cid, config) : ''
      const commentsText = (await comments(item.aid, 10, config))
        .slice(0, 10)
        .map((reply) => firstLine(reply?.content?.message, 120))
        .filter(Boolean)
        .join('\n')
      const summary = videoSummary(item)
      const decision = await judgeVideo(ctx, config, {
        item,
        summary,
        subtitleText,
        commentsText,
        mayComment: config.commentMode === 'auto',
      })
      if (decision.action === 'skip') {
        result.skipped += 1
        state.seen[bvid] = { at: Date.now(), action: 'skip' }
        continue
      }
      if (decision.action === 'remember') {
        if (await remember(ctx, config, item, decision)) result.remembered += 1
        state.seen[bvid] = { at: Date.now(), action: 'remember' }
        continue
      }
      if (decision.action === 'comment') {
        const ok = await comment(ctx, config, item, decision, state)
        if (ok) result.commented += 1
        if (await remember(ctx, config, item, decision)) result.remembered += 1
        state.seen[bvid] = { at: Date.now(), action: ok ? 'comment' : 'remember' }
      }
      log(`[foxy-bili] ${bvid} -> ${decision.action}`)
    } catch (error) {
      result.errors += 1
      ctx.logger?.warn?.(`[foxy-bili] ${bvid} failed: ${error?.message || error}`)
      state.seen[bvid] = { at: Date.now(), action: 'error' }
    } finally {
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
  }

  state.lastRun = Date.now()
  state.lastResult = result
  return result
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

async function readJsonBody(request) {
  if (typeof request?.json === 'function') {
    try {
      return await request.json()
    } catch {}
  }
  const raw = request?.body
  if (raw && typeof raw.getReader === 'function') {
    const text = await new Response(raw).text()
    return text ? JSON.parse(text) : {}
  }
  if (typeof raw === 'string') return raw ? JSON.parse(raw) : {}
  if (raw && (Buffer.isBuffer(raw) || raw instanceof Uint8Array)) {
    const text = Buffer.from(raw).toString('utf8')
    return text ? JSON.parse(text) : {}
  }
  return {}
}

export function apply(ctx, rawConfig = {}) {
  const config = loadSettings({ ...DEFAULTS, ...rawConfig })
  const log = (message) => ctx.logger?.info?.(message)

  let running = false
  let timer
  let startTimer
  let state = loadState()

  const run = async (reason = 'timer', force = false) => {
    if (running) return { skipped: 'busy' }
    running = true
    try {
      log(`[foxy-bili] scan start (${reason})`)
      const result = await scanOnce(ctx, config, state, log, force)
      saveState(state)
      log(`[foxy-bili] scan done ${JSON.stringify(result)}`)
      return result
    } catch (error) {
      saveState(state)
      ctx.logger?.warn?.(`[foxy-bili] scan failed: ${error?.message || error}`)
      return { error: String(error?.message || error) }
    } finally {
      running = false
    }
  }

  const status = () => ({
    enabled: config.enabled,
    running,
    lastRun: state.lastRun,
    lastResult: state.lastResult,
    seen: Object.keys(state.seen).length,
    commentsToday: commentCount(state),
    commentMode: config.commentMode,
    cookieSet: Boolean(config.cookie),
    accountName: config.accountName || '',
    accountUid: config.accountUid || '',
  })

  const capability = {
    version: 1,
    scan: () => run('manual', true),
    status,
  }
  const foxy = typeof ctx.get === 'function' ? ctx.get('foxy') : undefined
  foxy?.registerCapability?.('bili', async () => capability)
  ctx.provide?.('foxyBili', capability)

  const restartTimer = () => {
    clearInterval(timer)
    const minutes = Math.max(10, Number(config.intervalMinutes) || 90)
    timer = setInterval(() => {
      run('timer').catch(() => {})
    }, minutes * 60 * 1000)
    timer.unref?.()
  }
  restartTimer()
  ctx.effect?.(() => () => clearInterval(timer), 'foxy-bili: scan timer')

  if (config.runOnStart) {
    startTimer = setTimeout(() => run('start').catch(() => {}), 20_000)
    startTimer.unref?.()
    ctx.effect?.(() => () => clearTimeout(startTimer), 'foxy-bili: start timer')
  }

  ctx.inject?.(['connection'], (host) => {
    const register = host?.connection?.fetch?.register
    if (typeof register !== 'function') return
    const route = (path, methods, handler) =>
      register({
        path,
        methods,
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await handler(request)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            ctx.logger?.warn?.(`[foxy-bili] ${path} failed: ${message}`)
            return json({ ok: false, error: message }, 500)
          }
        },
      })

    route(STATUS_ROUTE, ['GET'], async () =>
      json({ ok: true, status: status(), settings: publicSettings(config) }),
    )

    route(SETTINGS_ROUTE, ['GET', 'POST'], async (request) => {
      if (request.method === 'POST') {
        const patch = await readJsonBody(request)
        Object.assign(config, normalizePatch(config, patch))
        saveSettings(config)
        restartTimer()
      }
      return json({ ok: true, settings: publicSettings(config), status: status() })
    })

    route(LOGIN_START_ROUTE, ['POST'], async () => json({ ok: true, ...(await loginStart()) }))

    route(LOGIN_POLL_ROUTE, ['POST'], async (request) => {
      const { key } = await readJsonBody(request)
      const result = await loginPoll(key)
      if (result.state === 'ok' && result.cookie) {
        config.cookie = result.cookie
        if (result.account) {
          config.accountName = result.account.uname
          config.accountUid = result.account.mid
        }
        saveSettings(config)
      }
      return json({ ok: true, ...result, settings: publicSettings(config), status: status() })
    })

    route(LOGOUT_ROUTE, ['POST'], async () => {
      config.cookie = ''
      config.accountName = ''
      config.accountUid = ''
      saveSettings(config)
      return json({ ok: true, settings: publicSettings(config), status: status() })
    })

    route(RUN_ROUTE, ['POST'], async () => {
      const result = await run('manual', true)
      return json({ ok: true, result, status: status() })
    })
  })

  log(
    `[foxy-bili] ready enabled=${config.enabled} interval=${config.intervalMinutes}m ` +
      `comment=${config.commentMode} memory=${config.enableMemory}`,
  )
}
