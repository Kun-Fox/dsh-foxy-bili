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
  msgfeedAt,
  msgfeedReply,
  parseCookie,
  popular,
  postComment,
  replyComment,
  subtitle,
  video,
  videoByAid,
  videoSummary,
} from './bili.js'
import { hasInterestFilters, matchesInterest } from './interest.js'
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
export const INBOX_ROUTE = '/api/dsh-foxy-bili/inbox/run'

const ACTION_LABELS = {
  skip: '跳过',
  remember: '记录',
  comment: '评论',
  reply: '回复',
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
      inboxSeen:
        parsed.inboxSeen && typeof parsed.inboxSeen === 'object' ? parsed.inboxSeen : {},
      inboxVideos:
        parsed.inboxVideos && typeof parsed.inboxVideos === 'object' ? parsed.inboxVideos : {},
      lastInboxResult: parsed.lastInboxResult || null,
      debug: Array.isArray(parsed.debug) ? parsed.debug.slice(0, 80) : [],
    }
  } catch {
    return {
      seen: {},
      days: {},
      history: [],
      lastRun: 0,
      lastResult: null,
      inboxSeen: {},
      inboxVideos: {},
      lastInboxResult: null,
      debug: [],
    }
  }
}

function debugLog(state, config, event) {
  if (!config.debug) return
  state.debug = [
    { at: Date.now(), ...event },
    ...(Array.isArray(state.debug) ? state.debug : []),
  ].slice(0, 80)
}

function saveState(state) {
  const file = statePath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

function today() {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function commentCount(state) {
  return Number(state.days?.[today()]?.comments || 0)
}

function videoCount(state) {
  return Number(state.days?.[today()]?.videos || 0)
}

function bumpVideos(state) {
  const day = today()
  if (!state.days[day]) state.days[day] = { comments: 0, videos: 0 }
  state.days[day].videos = Number(state.days[day].videos || 0) + 1
}

function bumpComments(state) {
  const day = today()
  if (!state.days[day]) state.days[day] = { comments: 0, videos: 0 }
  state.days[day].comments += 1
}

function clockMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''))
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

export function inBrowseWindow(config, now = new Date()) {
  const start = clockMinutes(config.browseStart)
  const end = clockMinutes(config.browseEnd)
  if (start === null && end === null) return true
  const current = now.getHours() * 60 + now.getMinutes()
  const from = start ?? 0
  const to = end ?? 23 * 60 + 59
  return from <= to ? current >= from && current < to : current >= from || current < to
}

function nextWindowStartDelay(config, now = new Date()) {
  const start = clockMinutes(config.browseStart)
  if (start === null) return null
  const target = new Date(now)
  target.setHours(Math.floor(start / 60), start % 60, 0, 0)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  return target.getTime() - now.getTime()
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

export function inboxItemsFrom(replyItems, atItems) {
  const rows = []
  const seen = new Set()
  const add = (entry, source) => {
    const detail = entry?.item || {}
    if (Number(detail.business_id) !== 1 || !detail.subject_id) return
    const sourceId = String(detail.source_id || detail.target_id || detail.root_id || entry.id || '')
    const key = `rpid:${sourceId || entry.id || ''}`
    if (!sourceId || seen.has(key)) return
    seen.add(key)
    rows.push({
      id: String(entry.id || sourceId),
      source,
      businessId: Number(detail.business_id),
      aid: String(detail.subject_id),
      rpid: sourceId,
      root: String(detail.root_id || sourceId),
      parent: String(detail.source_id || detail.root_id || sourceId),
      user: {
        mid: String(entry.user?.mid || ''),
        nickname: String(entry.user?.nickname || '').trim(),
      },
      title: String(detail.title || '').trim(),
      text: String(detail.source_content || detail.target_reply_content || '').trim(),
      targetText: String(detail.target_reply_content || '').trim(),
      rootText: String(detail.root_reply_content || '').trim(),
      uri: String(detail.uri || ''),
      replyTime: Number(entry.reply_time) || 0,
      key,
    })
  }
  for (const item of Array.isArray(replyItems) ? replyItems : []) add(item, 'reply')
  for (const item of Array.isArray(atItems) ? atItems : []) add(item, 'at')
  return rows.sort((a, b) => b.replyTime - a.replyTime)
}

function markInboxSeen(state, key) {
  state.inboxSeen[key] = Date.now()
  const entries = Object.entries(state.inboxSeen)
  if (entries.length > 500) {
    entries.sort((a, b) => Number(a[1]) - Number(b[1]))
    for (const [oldKey] of entries.slice(0, entries.length - 500)) delete state.inboxSeen[oldKey]
  }
}

export function inboxReplyMessage(config, inbox, decision) {
  // Bilibili already renders the reply-to relationship; adding a second
  // visible @ nickname is noisy. Keep only the reply body.
  return stripLeadingMentions(decision.comment).slice(0, 900)
}

export const INBOX_VIDEO_COOLDOWN_MS = 24 * 60 * 60 * 1000

export function inboxVideoCooling(state, bvid, now = Date.now()) {
  const last = Number(state?.inboxVideos?.[bvid] || 0)
  return Boolean(last) && now - last < INBOX_VIDEO_COOLDOWN_MS
}

async function pollInbox(ctx, config, state, log) {
  if (config.replyInbox !== true) return { skipped: 'disabled' }
  if (!config.cookie) return { skipped: 'no-login' }
  const maxReplies = Math.max(1, Math.min(5, Number(config.maxRepliesPerRun) || 1))
  const feedErrors = []
  const safeFeed = async (name, fn) => {
    try {
      return await fn()
    } catch (error) {
      feedErrors.push({ feed: name, error: error?.message || String(error) })
      ctx.logger?.warn?.(`[foxy-bili] ${name} 通知读取失败: ${error?.message || error}`)
      return []
    }
  }
  const [replyItems, atItems] = await Promise.all([
    safeFeed('reply', () => msgfeedReply(config)),
    safeFeed('at', () => msgfeedAt(config)),
  ])
  const notifications = inboxItemsFrom(replyItems, atItems)
  const selfMid = String(parseCookie(config.cookie).DedeUserID || '').trim()
  const result = {
    checked: 0,
    replied: 0,
    skipped: 0,
    errors: 0,
    items: [],
    feedErrors,
  }

  for (const inbox of notifications) {
    if (state.inboxSeen[inbox.key]) continue
    if (result.replied >= maxReplies) break
    if (selfMid && inbox.user.mid === selfMid) {
      markInboxSeen(state, inbox.key)
      continue
    }
    markInboxSeen(state, inbox.key)
    result.checked += 1
    let entry
    try {
      const item = await videoByAid(inbox.aid, config)
      if (inboxVideoCooling(state, item.bvid)) {
        markInboxSeen(state, inbox.key)
        result.skipped += 1
        debugLog(state, config, {
          kind: 'inbox-video-skip',
          bvid: item.bvid,
          user: inbox.user.nickname || inbox.user.mid,
          reason: '同一视频 24 小时内已回复过',
        })
        continue
      }
      const cid = item.pages?.[0]?.cid || item.cid
      const subtitleText = cid ? await subtitle(item.bvid, cid, config) : ''
      let replies = []
      try {
        replies = await comments(item.aid, 12, config)
      } catch (error) {
        ctx.logger?.warn?.(`[foxy-bili] 读取评论失败 ${item.bvid}: ${error?.message || error}`)
      }
      const candidates = config.nestedReplies ? commentCandidates(replies, config) : []
      const decision = await judgeVideo(ctx, config, {
        item,
        summary: videoSummary(item),
        subtitleText,
        commentsText: commentsTextOf(replies),
        comments: candidates,
        mentionCandidates: mentionCandidates(config),
        mayComment: true,
        mayReply: true,
        nestedReplies: config.nestedReplies === true,
        notification: {
          kind: inbox.source,
          userName: inbox.user.nickname,
          text: inbox.text,
          targetText: inbox.targetText,
          rootText: inbox.rootText,
          title: inbox.title,
          rpid: inbox.rpid,
        },
      })
      debugLog(state, config, {
        kind: 'inbox-judge',
        bvid: item.bvid,
        user: inbox.user.nickname || inbox.user.mid,
        action: decision.action,
        memory: Boolean(decision.memory),
        raw: String(decision.raw || '').slice(0, 500),
      })
      if (decision.action !== 'comment' || !decision.comment) {
        result.skipped += 1
        entry = {
          at: Date.now(),
          kind: 'inbox',
          bvid: item.bvid,
          title: item.title || inbox.title,
          action: 'skip',
          reason: entryReason(decision, decision.action),
          comment: '',
          user: inbox.user.nickname,
          notification: inbox.text,
          memory: 'skipped',
        }
      } else {
        const message = inboxReplyMessage(config, inbox, decision)
        await replyComment({
          aid: item.aid,
          root: inbox.root,
          parent: inbox.parent,
          message,
          config,
        })
        result.replied += 1
        bumpComments(state)
        if (!state.inboxVideos) state.inboxVideos = {}
        state.inboxVideos[item.bvid] = Date.now()
        const memory = await rememberReply(ctx, config, item, inbox, message, state)
        entry = {
          at: Date.now(),
          kind: 'inbox',
          bvid: item.bvid,
          title: item.title || inbox.title,
          action: 'reply',
          reason: firstLine(decision.comment, 140),
          comment: message,
          user: inbox.user.nickname,
          notification: inbox.text,
          replyTo: inbox.rpid,
          memory: memory.ok ? 'written' : memory.reason,
        }
        ctx.logger?.info?.(
          `[foxy-bili] 回复 ${item.bvid} ${inbox.user.nickname || inbox.user.mid} -> rpid=${inbox.rpid}`,
        )
      }
    } catch (error) {
      result.errors += 1
      entry = {
        at: Date.now(),
        kind: 'inbox',
        bvid: '',
        title: inbox.title,
        action: 'error',
        reason: '处理评论通知时出错',
        error: error?.message || String(error),
        user: inbox.user.nickname,
        notification: inbox.text,
      }
      ctx.logger?.warn?.(`[foxy-bili] inbox ${inbox.key} failed: ${error?.message || error}`)
    }
    if (entry) {
      pushHistory(state, entry)
      result.items.push(entry)
      log(
        `[foxy-bili] 评论通知 ${entry.bvid || inbox.aid} ${inbox.source} ${inbox.user.nickname || inbox.user.mid} -> ${
          ACTION_LABELS[entry.action] || entry.action
        }` + (entry.error ? `（${firstLine(entry.error, 100)}）` : ''),
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 800))
  }

  state.lastInboxResult = result
  return result
}

async function remember(ctx, config, item, decision, state, extraText = '') {
  if (!config.enableMemory) return { ok: false, reason: 'disabled' }
  const sourceText = String(decision.memory || extraText || '').trim()
  if (!sourceText) return { ok: false, reason: 'empty' }
  const memory = memoryProvider(ctx)
  if (!memory?.record) return { ok: false, reason: 'no-provider' }
  const eventType = decision.action === 'comment' ? 'comment_sent' : 'browse'
  const clean = sourceText.replace(/^我记得[，,]?\s*/, '')
  const text = clean.startsWith('我')
    ? clean
    : eventType === 'comment_sent'
      ? `我在 B 站评论区回复了「${firstLine(item.title, 60)}」下的评论：${clean}`
      : `我刷到「${firstLine(item.title, 60)}」，${clean}`
  try {
    await memory.record({
      role: 'assistant',
      text,
      sessionId: `bili:${item.bvid}`,
      presetId: config.memoryPresetId || 'foxy3（Character）',
      platform: 'bilibili',
      sourceLabel: 'B站',
      eventType,
      channelType: 'comment',
      channelId: item.bvid,
      title: item.title || '',
      url: `https://www.bilibili.com/video/${item.bvid}`,
      scene: 'bilibili',
    })
    debugLog(state, config, {
      kind: 'memory',
      bvid: item.bvid,
      action: decision.action,
      memory: 'written',
      text: firstLine(text, 300),
    })
    return { ok: true, reason: 'written', text }
  } catch (error) {
    const reason = error?.message || String(error)
    ctx.logger?.warn?.(`[foxy-bili] memory write failed: ${reason}`)
    debugLog(state, config, {
      kind: 'memory',
      bvid: item.bvid,
      action: decision.action,
      memory: 'error',
      reason,
    })
    return { ok: false, reason }
  }
}

async function rememberReply(ctx, config, item, inbox, message, state) {
  if (!config.enableMemory) return { ok: false, reason: 'disabled' }
  const memory = memoryProvider(ctx)
  if (!memory?.record) return { ok: false, reason: 'no-provider' }
  const target = inbox.user?.nickname || inbox.user?.mid || '一位用户'
  const text = `我在 B 站收到 ${target} 的评论回复，看了「${firstLine(item.title, 60)}」后回复：${message}`
  try {
    await memory.record({
      role: 'assistant',
      text,
      sessionId: `bili-inbox:${item.bvid}:${inbox.rpid}`,
      presetId: config.memoryPresetId || 'foxy3（Character）',
      platform: 'bilibili',
      sourceLabel: 'B站评论回复',
      eventType: 'reply_sent',
      channelType: 'comment',
      channelId: item.bvid,
      title: item.title || '',
      url: `https://www.bilibili.com/video/${item.bvid}`,
      scene: 'bilibili',
    })
    debugLog(state, config, {
      kind: 'memory',
      bvid: item.bvid,
      action: 'reply',
      memory: 'written',
      text: firstLine(text, 300),
    })
    return { ok: true, reason: 'written', text }
  } catch (error) {
    const reason = error?.message || String(error)
    ctx.logger?.warn?.(`[foxy-bili] reply memory write failed: ${reason}`)
    debugLog(state, config, {
      kind: 'memory',
      bvid: item.bvid,
      action: 'reply',
      memory: 'error',
      reason,
    })
    return { ok: false, reason }
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
  if (!force && !inBrowseWindow(config)) {
    return { skipped: 'outside-window', browseStart: config.browseStart, browseEnd: config.browseEnd }
  }
  const dailyLimit = Math.max(0, Math.min(100, Number(config.dailyVideoLimit) || 0))
  if (!force && dailyLimit <= 0) return { skipped: 'daily-limit', dailyVideoLimit: dailyLimit }
  const remaining = dailyLimit - videoCount(state)
  if (!force && remaining <= 0) {
    return { skipped: 'daily-limit', dailyVideoLimit: dailyLimit, videosToday: videoCount(state) }
  }
  const requested = Math.max(1, Math.min(20, Number(config.maxVideosPerRun) || 5))
  const limit = force ? requested : Math.max(1, Math.min(requested, remaining))
  const filteredFeed = hasInterestFilters(config)
  const fetchLimit = filteredFeed ? Math.min(50, Math.max(limit * 4, 12)) : limit
  const rawList = await popular(fetchLimit, config)
  const list = (Array.isArray(rawList) ? rawList : [])
    .filter((item) => matchesInterest(item, config))
    .slice(0, limit)
  const result = {
    checked: 0,
    skipped: 0,
    remembered: 0,
    commented: 0,
    errors: 0,
    filtered: Math.max(0, (Array.isArray(rawList) ? rawList.length : 0) - list.length),
    items: [],
  }
  if (filteredFeed) {
    log(`[foxy-bili] 兴趣筛选：${result.filtered} 条不符合关键词/分区，保留 ${list.length} 条`)
  }

  for (const raw of list) {
    const bvid = raw?.bvid
    if (!bvid || state.seen[bvid]) continue
    result.checked += 1
    bumpVideos(state)
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
      debugLog(state, config, {
        kind: 'judge',
        bvid,
        action: decision.action,
        memory: Boolean(decision.memory),
        raw: String(decision.raw || '').slice(0, 500),
      })
      if (decision.action === 'skip') {
        result.skipped += 1
        entry.memory = 'skipped'
        state.seen[bvid] = { at: Date.now(), action: 'skip' }
      } else if (decision.action === 'remember') {
        const memory = await remember(ctx, config, item, decision, state)
        if (memory.ok) result.remembered += 1
        entry.memory = memory.ok ? 'written' : memory.reason
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
        const memory = await remember(
          ctx,
          config,
          item,
          decision,
          state,
          published.ok ? `我在评论区说：${published.message}` : '',
        )
        if (memory.ok) result.remembered += 1
        entry.memory = memory.ok ? 'written' : memory.reason
        if (!state.seen[bvid]) state.seen[bvid] = { at: Date.now(), action: 'comment' }
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
  const memory = await remember(
    ctx,
    config,
    item,
    decision,
    state,
    published.ok ? `我在评论区说：${published.message}` : '',
  )
  debugLog(state, config, {
    kind: 'comment-now',
    bvid: item.bvid,
    action: decision.action,
    memory: memory.ok ? 'written' : memory.reason,
    raw: String(decision.raw || '').slice(0, 500),
  })
  const entry = {
    at: Date.now(),
    bvid: item.bvid,
    title: item.title || '',
    action: published.ok ? 'comment' : 'error',
    reason: published.ok ? entryReason(decision, 'comment') : published.error,
    comment: published.message || decision.comment,
    replyTo: published.replyTo || '',
    error: published.ok ? undefined : published.error,
    memory: memory.ok ? 'written' : memory.reason,
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
  let inboxRunning = false
  let timer
  let windowTimer
  let inboxTimer
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

  const runInbox = async (reason = 'timer') => {
    if (inboxRunning) return { skipped: 'busy' }
    if (config.replyInbox !== true) return { skipped: 'disabled' }
    inboxRunning = true
    try {
      log(`[foxy-bili] 开始检查评论通知（${reason}）`)
      const result = await pollInbox(ctx, config, state, log)
      saveState(state)
      log(`[foxy-bili] 评论通知检查结束 ${JSON.stringify(result)}`)
      return result
    } catch (error) {
      saveState(state)
      ctx.logger?.warn?.(`[foxy-bili] inbox failed: ${error?.message || error}`)
      return { error: String(error?.message || error) }
    } finally {
      inboxRunning = false
    }
  }

  const status = () => ({
    enabled: config.enabled,
    running,
    inboxRunning,
    replyInbox: config.replyInbox === true,
    lastRun: state.lastRun,
    lastResult: state.lastResult,
    lastInboxResult: state.lastInboxResult,
    recent: state.history.slice(0, 12),
    seen: Object.keys(state.seen).length,
    inboxSeen: Object.keys(state.inboxSeen || {}).length,
    commentsToday: commentCount(state),
    videosToday: videoCount(state),
    dailyVideoLimit: config.dailyVideoLimit,
    browseStart: config.browseStart,
    browseEnd: config.browseEnd,
    inBrowseWindow: inBrowseWindow(config),
    commentMode: config.commentMode,
    cookieSet: Boolean(config.cookie),
    accountName: config.accountName || '',
    accountUid: config.accountUid || '',
    debugEnabled: config.debug === true,
    debug: Array.isArray(state.debug) ? state.debug.slice(0, 40) : [],
  })

  const capability = {
    version: 1,
    scan: () => run('manual', true),
    inbox: () => runInbox('manual'),
    status,
  }
  const foxy = typeof ctx.get === 'function' ? ctx.get('foxy') : undefined
  foxy?.registerCapability?.('bili', async () => capability)
  ctx.provide?.('foxyBili', capability)

  const restartTimer = () => {
    clearInterval(timer)
    clearTimeout(windowTimer)
    const minutes = Math.max(10, Number(config.intervalMinutes) || 90)
    timer = setInterval(() => {
      run('timer').catch(() => {})
    }, minutes * 60 * 1000)
    timer.unref?.()
    const delay = nextWindowStartDelay(config)
    if (delay !== null) {
      windowTimer = setTimeout(() => {
        run('window').catch(() => {})
        restartTimer()
      }, delay)
      windowTimer.unref?.()
    }
  }
  restartTimer()
  ctx.effect?.(() => () => {
    clearInterval(timer)
    clearTimeout(windowTimer)
  }, 'foxy-bili: scan timer')

  const restartInboxTimer = () => {
    clearInterval(inboxTimer)
    const minutes = Math.max(2, Number(config.replyIntervalMinutes) || 10)
    inboxTimer = setInterval(() => {
      runInbox('timer').catch(() => {})
    }, minutes * 60 * 1000)
    inboxTimer.unref?.()
  }
  restartInboxTimer()
  ctx.effect?.(() => () => clearInterval(inboxTimer), 'foxy-bili: inbox timer')

  if (config.runOnStart) {
    startTimer = setTimeout(() => {
      run('start').catch(() => {})
      runInbox('start').catch(() => {})
    }, 20_000)
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
        restartInboxTimer()
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

    route(INBOX_ROUTE, ['POST'], async () => {
      const result = await runInbox('manual')
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
      `window=${config.browseStart || '00:00'}-${config.browseEnd || '23:59'} ` +
      `daily=${config.dailyVideoLimit} comment=${config.commentMode} memory=${config.enableMemory}`,
  )
}

