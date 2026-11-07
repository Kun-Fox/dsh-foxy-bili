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
  popular,
  postComment,
  replyComment,
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
export const COMMENT_NOW_ROUTE = '/api/dsh-foxy-bili/comment-now'

const ACTION_LABELS = {
  skip: '跳过',
  remember: '记录',
  comment: '评论',
  error: '失败',
}

function statePath() {
  return join(foxyHome(), 'foxy-bili', 'state.json')
}

function loadState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    return {
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, 50) : [],
      lastRun: Number(parsed.lastRun) || 0,
      lastResult: parsed.lastResult || null,
    }
  } catch {
    return { seen: {}, days: {}, history: [], lastRun: 0, lastResult: null }
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

function pushHistory(state, entry) {
  state.history = [entry, ...(Array.isArray(state.history) ? state.history : [])].slice(0, 50)
}

function mentionCandidates(config) {
  const rows = []
  const seen = new Set()
  const add = (name, uid, role) => {
    const cleanName = String(name || '').trim()
    const cleanUid = String(uid || '').trim()
    if (!cleanName && !cleanUid) return
    const key = `${cleanName}\u0000${cleanUid}`
    if (seen.has(key)) return
    seen.add(key)
    rows.push({ name: cleanName, uid: cleanUid, role })
  }
  if (config.mentionOwner !== false) add(config.ownerName, config.ownerUid, 'owner')
  for (const entry of Array.isArray(config.mentionWhitelist) ? config.mentionWhitelist : []) {
    add(entry?.name, entry?.uid, 'whitelist')
  }
  return rows
}

function selectMentions(config, decision) {
  const candidates = mentionCandidates(config)
  const wanted = Array.isArray(decision.mentions) ? decision.mentions : []
  const selected = []
  const seen = new Set()
  for (const raw of wanted) {
    const value = String(raw || '').trim()
    if (!value) continue
    const found =
      candidates.find((item) => item.name === value) ||
      candidates.find((item) => item.uid && item.uid === value)
    if (!found) continue
    const key = `${found.name}\u0000${found.uid}`
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(found)
    if (selected.length >= 3) break
  }
  if (!selected.length && config.mentionOwner !== false) {
    const owner = candidates.find((item) => item.role === 'owner')
    if (owner) selected.push(owner)
  }
  return selected
}

function stripLeadingMentions(text) {
  let value = String(text || '').trim()
  while (value.startsWith('@')) {
    const match = value.match(/^@\S+\s*/)
    if (!match) break
    value = value.slice(match[0].length).trim()
  }
  return value
}

function buildCommentMessage(config, decision) {
  const mentions = selectMentions(config, decision)
  const body = stripLeadingMentions(decision.comment)
  const prefix = mentions.map((item) => `@${item.name}`).join(' ')
  return {
    message: `${prefix ? `${prefix} ` : ''}${body}`.slice(0, 900),
    mentions,
  }
}

function commentCandidates(replies, config) {
  const rows = []
  for (const top of Array.isArray(replies) ? replies : []) {
    if (!top?.rpid) continue
    rows.push({
      rpid: String(top.rpid),
      root: String(top.rpid),
      parent: String(top.rpid),
      level: 'root',
      uname: top.member?.uname || '',
      mid: String(top.member?.mid || ''),
      message: top.content?.message || '',
    })
    if (config.nestedReplies) {
      for (const sub of Array.isArray(top.replies) ? top.replies : []) {
        if (!sub?.rpid) continue
        rows.push({
          rpid: String(sub.rpid),
          root: String(top.rpid),
          parent: String(sub.rpid),
          level: 'sub',
          uname: sub.member?.uname || '',
          mid: String(sub.member?.mid || ''),
          message: sub.content?.message || '',
        })
      }
    }
    if (rows.length >= 12) break
  }
  return rows.slice(0, 12)
}

function findReplyTarget(candidates, replyTo) {
  const id = String(replyTo || '')
  if (!id || id === '0') return null
  return (Array.isArray(candidates) ? candidates : []).find((item) => item.rpid === id) || null
}

function commentsTextOf(replies) {
  return (Array.isArray(replies) ? replies : [])
    .slice(0, 10)
    .map((reply) => firstLine(reply?.content?.message, 120))
    .filter(Boolean)
    .join('\n')
}

function memoryProvider(ctx) {
  return typeof ctx.get === 'function' ? ctx.get('foxyMemory') : undefined
}

function bridgeConfig() {
  try {
    const file = join(foxyHome(), 'foxy', 'settings.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      url: String(parsed.bridgeUrl || '').trim().replace(/\/+$/, ''),
      token: String(parsed.bridgeToken || '').trim(),
    }
  } catch {
    return { url: '', token: '' }
  }
}

function privateText(config, item, decision) {
  const url = `https://www.bilibili.com/video/${item.bvid}`
  const body = String(decision.dmText || decision.comment || decision.memory || '').trim()
  if (!body) return `我刷到「${firstLine(item.title, 80)}」，觉得挺有意思，想给你看看。\n${url}`
  if (/^我刷到/.test(body)) return `${body}\n${url}`
  return `我刷到「${firstLine(item.title, 80)}」，${firstLine(body, 300)}\n${url}`
}

async function rememberPrivate(ctx, config, item, text) {
  if (!config.enableMemory) return false
  const memory = memoryProvider(ctx)
  if (!memory?.record) return false
  try {
    await memory.record({
      role: 'assistant',
      text,
      sessionId: `bili-private:${item.bvid}`,
      presetId: config.memoryPresetId || 'foxy3（Character）',
      platform: 'qq',
      sourceLabel: '私聊',
      scene: 'private',
    })
    return true
  } catch (error) {
    ctx.logger?.warn?.(`[foxy-bili] private memory write failed: ${error?.message || error}`)
    return false
  }
}

async function pushPrivate(ctx, config, item, decision) {
  if (!config.privatePush || decision.action === 'skip' || decision.dm !== true) return null
  const bridge = bridgeConfig()
  if (!bridge.url) {
    ctx.logger?.warn?.('[foxy-bili] private push skipped: foxy-memory bridge URL is missing')
    return { ok: false, error: '未配置 Foxy 记忆桥地址' }
  }
  const text = privateText(config, item, decision)
  try {
    const response = await fetch(`${bridge.url}/send-private`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bridge.token ? { authorization: `Bearer ${bridge.token}` } : {}),
      },
      body: JSON.stringify({
        text,
        ...(config.privateTarget ? { userId: String(config.privateTarget) } : {}),
      }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || data.ok === false) {
      const error = data.error || `HTTP ${response.status}`
      ctx.logger?.warn?.(`[foxy-bili] private push failed: ${error}`)
      return { ok: false, error }
    }
    const remembered = await rememberPrivate(ctx, config, item, text)
    ctx.logger?.info?.(
      `[foxy-bili] 私聊推送成功 ${item.bvid} -> ${data.userId || config.privateTarget || '默认主人'}`,
    )
    return { ok: true, text, userId: data.userId || '', remembered }
  } catch (error) {
    const message = error?.message || String(error)
    ctx.logger?.warn?.(`[foxy-bili] private push failed: ${message}`)
    return { ok: false, error: message }
  }
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

async function publishComment(ctx, config, item, decision, state, candidates, options = {}) {
  if (!decision.comment) {
    return { ok: false, error: '模型没有生成可发布的评论' }
  }
  if (!options.force && config.commentMode !== 'auto') {
    return { ok: false, error: '评论模式未开启' }
  }
  const cap = Number(config.maxCommentsPerDay ?? 1)
  if (!options.force && commentCount(state) >= cap) {
    return { ok: false, error: '今日评论额度已用完' }
  }
  const { message, mentions } = buildCommentMessage(config, decision)
  if (!message.trim()) return { ok: false, error: '评论正文为空' }
  const target = findReplyTarget(candidates, decision.replyTo)
  const atMids = mentions.map((entry) => entry.uid).filter(Boolean)
  try {
    if (target) {
      await replyComment({
        aid: item.aid,
        root: target.root,
        parent: target.parent,
        message,
        atMids,
        config,
      })
    } else {
      await postComment({ aid: item.aid, message, atMids, config })
    }
    if (!options.force) bumpComments(state)
    ctx.logger?.info?.(
      `[foxy-bili] 评论成功 ${item.bvid} ${target ? `回复 rpid=${target.rpid}` : '一级评论'}：${firstLine(message, 80)}`,
    )
    return {
      ok: true,
      message,
      mentions: mentions.map((entry) => entry.name),
      replyTo: target?.rpid || '',
    }
  } catch (error) {
    const messageText =
      error instanceof BiliError ? `${error.code}: ${error.message}` : String(error)
    ctx.logger?.warn?.(`[foxy-bili] comment failed on ${item.bvid}: ${messageText}`)
    return { ok: false, error: messageText }
  }
}

function entryReason(decision, action) {
  if (decision.mood) return decision.mood
  if (action === 'comment') return firstLine(decision.comment, 140)
  if (action === 'remember') return firstLine(decision.memory, 140)
  return '模型判断没有浏览或发布价值'
}

async function scanOnce(ctx, config, state, log, force = false) {
  if (!config.enabled && !force) return { skipped: 'disabled' }
  const limit = Math.max(1, Math.min(20, Number(config.maxVideosPerRun) || 5))
  const list = await popular(limit, config)
  const result = {
    checked: 0,
    skipped: 0,
    remembered: 0,
    commented: 0,
    dms: 0,
    dmErrors: 0,
    errors: 0,
    items: [],
  }

  for (const raw of list) {
    const bvid = raw?.bvid
    if (!bvid || state.seen[bvid]) continue
    result.checked += 1
    let entry
    try {
      const item = await video(bvid, config)
      const pages = item.pages || []
      const cid = pages[0]?.cid || item.cid
      const subtitleText = cid ? await subtitle(bvid, cid, config) : ''
      let replies = []
      try {
        replies = await comments(item.aid, 12, config)
      } catch (error) {
        ctx.logger?.warn?.(`[foxy-bili] 读取评论失败 ${bvid}: ${error?.message || error}`)
      }
      const candidates = config.replyOthers ? commentCandidates(replies, config) : []
      const summary = videoSummary(item)
      const decision = await judgeVideo(ctx, config, {
        item,
        summary,
        subtitleText,
        commentsText: commentsTextOf(replies),
        comments: candidates,
        mentionCandidates: mentionCandidates(config),
        mayComment: config.commentMode === 'auto',
        mayReply: config.replyOthers === true,
        nestedReplies: config.nestedReplies === true,
        privatePush: config.privatePush === true,
      })
      entry = {
        at: Date.now(),
        bvid,
        title: item.title || raw.title || '',
        action: decision.action,
        reason: entryReason(decision, decision.action),
        comment: decision.comment,
        replyTo: decision.replyTo || '',
      }
      if (decision.action === 'skip') {
        result.skipped += 1
        state.seen[bvid] = { at: Date.now(), action: 'skip' }
      } else if (decision.action === 'remember') {
        if (await remember(ctx, config, item, decision)) result.remembered += 1
        state.seen[bvid] = { at: Date.now(), action: 'remember' }
      } else if (decision.action === 'comment') {
        const published = await publishComment(ctx, config, item, decision, state, candidates)
        if (published.ok) {
          result.commented += 1
          entry.action = 'comment'
          entry.comment = published.message
          entry.replyTo = published.replyTo || ''
        } else {
          entry.action = 'remember'
          entry.error = published.error
          state.seen[bvid] = { at: Date.now(), action: 'remember' }
        }
        if (await remember(ctx, config, item, decision)) result.remembered += 1
        if (!state.seen[bvid]) state.seen[bvid] = { at: Date.now(), action: 'comment' }
      }
      if (decision.action !== 'skip' && decision.dm === true) {
        const pushed = await pushPrivate(ctx, config, item, decision)
        if (pushed?.ok) {
          result.dms += 1
          entry.dm = 'sent'
          entry.dmText = pushed.text
        } else if (pushed) {
          result.dmErrors += 1
          entry.dm = 'error'
          entry.dmError = pushed.error
        }
      }
    } catch (error) {
      result.errors += 1
      entry = {
        at: Date.now(),
        bvid,
        title: raw?.title || '',
        action: 'error',
        reason: '处理视频时出错',
        error: error?.message || String(error),
      }
      state.seen[bvid] = { at: Date.now(), action: 'error' }
      ctx.logger?.warn?.(`[foxy-bili] ${bvid} failed: ${error?.message || error}`)
    }
    if (entry) {
      pushHistory(state, entry)
      result.items.push(entry)
      log(
        `[foxy-bili] 浏览 ${entry.bvid} 《${firstLine(entry.title, 60)}》 -> ${ACTION_LABELS[entry.action] || entry.action}` +
          (entry.error ? `（${firstLine(entry.error, 100)}）` : ''),
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 800))
  }

  state.lastRun = Date.now()
  state.lastResult = result
  return result
}

async function runCommentNow(ctx, config, state, bvid) {
  if (!config.cookie) throw new BiliError('请先扫码登录 B 站账号', 'NO_LOGIN', 'comment-now')
  const targetBvid = String(bvid || '').trim()
  let item
  if (targetBvid) {
    item = await video(targetBvid, config)
  } else {
    const list = await popular(1, config)
    if (!list[0]?.bvid) throw new BiliError('热门列表为空，暂时没有可评论的视频', 'NO_VIDEO', 'comment-now')
    item = await video(list[0].bvid, config)
  }
  let replies = []
  try {
    replies = await comments(item.aid, 12, config)
  } catch {
    // 评论区关闭时仍然允许发一级评论
  }
  const candidates = config.replyOthers ? commentCandidates(replies, config) : []
  const decision = await judgeVideo(ctx, config, {
    item,
    summary: videoSummary(item),
    subtitleText: '',
    commentsText: commentsTextOf(replies),
    comments: candidates,
    mentionCandidates: mentionCandidates(config),
    mayComment: true,
    mayReply: config.replyOthers === true,
    nestedReplies: config.nestedReplies === true,
    forceComment: true,
    privatePush: config.privatePush === true,
  })
  if (!decision.comment) {
    ctx.logger?.warn?.(
      `[foxy-bili] comment-now got no comment; action=${decision.action} raw=${String(decision.raw || '').slice(0, 800)}`,
    )
    throw new BiliError('模型没有生成可发布的评论', 'NO_COMMENT', 'comment-now')
  }
  const published = await publishComment(ctx, config, item, decision, state, candidates, {
    force: true,
  })
  const pushed = published.ok ? await pushPrivate(ctx, config, item, decision) : null
  const entry = {
    at: Date.now(),
    bvid: item.bvid,
    title: item.title || '',
    action: published.ok ? 'comment' : 'error',
    reason: published.ok ? entryReason(decision, 'comment') : published.error,
    comment: published.message || decision.comment,
    replyTo: published.replyTo || '',
    error: published.ok ? undefined : published.error,
    dm: pushed?.ok ? 'sent' : pushed ? 'error' : undefined,
    dmText: pushed?.text,
    dmError: pushed && !pushed.ok ? pushed.error : undefined,
    manual: true,
  }
  state.seen[item.bvid] = { at: Date.now(), action: entry.action }
  pushHistory(state, entry)
  return {
    ok: published.ok,
    target: {
      bvid: item.bvid,
      title: item.title || '',
      url: `https://www.bilibili.com/video/${item.bvid}`,
    },
    decision: {
      action: decision.action,
      comment: decision.comment,
      memory: decision.memory,
      mentions: published.mentions || [],
      replyTo: published.replyTo || '',
    },
    published,
    privatePush: pushed,
    entry,
  }
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
      log(`[foxy-bili] 开始运行（${reason}）`)
      const result = await scanOnce(ctx, config, state, log, force)
      saveState(state)
      log(`[foxy-bili] 运行结束 ${JSON.stringify(result)}`)
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
    recent: state.history.slice(0, 12),
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

    route(COMMENT_NOW_ROUTE, ['POST'], async (request) => {
      const body = await readJsonBody(request)
      const result = await runCommentNow(ctx, config, state, body?.bvid)
      saveState(state)
      return json({ ok: true, result, status: status() })
    })
  })

  log(
    `[foxy-bili] ready enabled=${config.enabled} interval=${config.intervalMinutes}m ` +
      `comment=${config.commentMode} memory=${config.enableMemory}`,
  )
}
