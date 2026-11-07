/**
 * Minimal Bilibili web client for Foxy.
 *
 * It deliberately uses the same cookie-based web endpoints as the browser
 * (there is no public "bot" API for comments). Reads work anonymously; comment
 * writes need SESSDATA + bili_jct. The client is intentionally small and does
 * not try to be a general Bilibili SDK.
 */

import { randomUUID } from 'node:crypto'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36'

export class BiliError extends Error {
  constructor(message, code, url) {
    super(message)
    this.name = 'BiliError'
    this.code = code
    this.url = url
  }
}

export function parseCookie(cookie = '') {
  const out = {}
  for (const part of String(cookie).split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    if (key) out[key] = part.slice(index + 1).trim()
  }
  return out
}

export function csrfFromCookie(cookie = '') {
  return parseCookie(cookie).bili_jct || ''
}

function headers(config = {}) {
  const cookie = String(config.cookie || '').trim()
  return {
    'user-agent': UA,
    referer: 'https://www.bilibili.com/',
    origin: 'https://www.bilibili.com',
    ...(cookie ? { cookie } : {}),
    ...(config.headers || {}),
  }
}

async function request(url, config = {}, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers(config), ...(options.headers || {}) },
    signal: options.signal,
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new BiliError(`Bilibili returned non-JSON (${response.status})`, response.status, url)
  }
  if (!response.ok) {
    throw new BiliError(`Bilibili HTTP ${response.status}`, response.status, url)
  }
  if (typeof body?.code === 'number' && body.code !== 0) {
    throw new BiliError(body.message || `Bilibili code ${body.code}`, body.code, url)
  }
  return body.data
}

function absolutize(url) {
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('http')) return url
  return `https://${url.replace(/^\/+/, '')}`
}

export async function popular(limit = 20, config = {}) {
  const size = Math.max(1, Math.min(50, Number(limit) || 20))
  const data = await request(
    `https://api.bilibili.com/x/web-interface/popular?pn=1&ps=${size}`,
    config,
  )
  return (data?.list || []).slice(0, size)
}

export async function ranking(limit = 20, config = {}) {
  const size = Math.max(1, Math.min(50, Number(limit) || 20))
  const data = await request(
    'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
    config,
  )
  return (data?.list || []).slice(0, size)
}

export async function video(bvid, config = {}) {
  const data = await request(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    config,
  )
  if (!data?.bvid) throw new BiliError('video not found', 'NOT_FOUND', bvid)
  return data
}

export async function subtitle(bvid, cid, config = {}) {
  try {
    const data = await request(
      `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`,
      config,
    )
    const item = data?.subtitle?.subtitles?.[0]
    if (!item?.subtitle_url) return ''
    const url = absolutize(item.subtitle_url)
    const raw = await fetch(url, { headers: headers(config) })
    if (!raw.ok) return ''
    const json = await raw.json()
    return (json?.body || [])
      .map((line) => String(line?.content || '').trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 12000)
  } catch {
    return ''
  }
}

export async function comments(aid, limit = 20, config = {}) {
  const data = await request(
    `https://api.bilibili.com/x/v2/reply?type=1&oid=${encodeURIComponent(aid)}&sort=2&ps=${Math.max(1, Math.min(20, limit))}`,
    config,
  )
  return data?.replies || []
}

/**
 * Post a top-level comment. `message` should already contain the visible
 * `@nickname` prefixes. The old `at_name_to_mid` parameter is intentionally
 * not sent: Bilibili rejects comma-separated UID lists with
 * `-400 invalid at_name_to_mid`, and the visible `@name` in `message` is what
 * readers actually see.
 */
export async function postComment({ aid, message, atMid, atMids, config = {} }) {
  const csrf = csrfFromCookie(config.cookie)
  if (!csrf) throw new BiliError('missing bili_jct (csrf) in cookie', 'NO_CSRF', 'reply/add')
  const body = new URLSearchParams({
    oid: String(aid),
    type: '1',
    message: String(message),
    csrf,
    plat: '1',
  })
  return request('https://api.bilibili.com/x/v2/reply/add', config, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
}

/**
 * Reply inside a comment thread. `root` is the top-level rpid and `parent` is
 * the rpid being replied to; for a top-level reply they are the same.
 */
export async function replyComment({ aid, root, parent, message, atMid, atMids, config = {} }) {
  const csrf = csrfFromCookie(config.cookie)
  if (!csrf) throw new BiliError('missing bili_jct (csrf) in cookie', 'NO_CSRF', 'reply/add')
  const body = new URLSearchParams({
    oid: String(aid),
    type: '1',
    root: String(root),
    parent: String(parent || root),
    message: String(message),
    csrf,
    plat: '1',
  })
  return request('https://api.bilibili.com/x/v2/reply/add', config, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
}

/**
 * Send a Bilibili web private message. The web endpoint needs a valid
 * SESSDATA + bili_jct and returns a msg_key only when the message was really
 * accepted; a code 0 without msg_key is treated as a failure (often anti-spam
 * or the recipient does not accept strangers).
 */
export async function sendDm({ toUid, text, config = {} }) {
  const cookie = parseCookie(config.cookie)
  const senderUid = String(cookie.DedeUserID || '').trim()
  const csrf = String(cookie.bili_jct || '').trim()
  const targetUid = String(toUid || '').trim()
  const message = String(text || '').trim()
  if (!senderUid || !csrf) {
    throw new BiliError('请先扫码登录 B 站账号', 'NO_LOGIN', 'send-msg')
  }
  if (!/^\d+$/.test(targetUid) || targetUid === '0') {
    throw new BiliError('B站私聊对象 UID 无效', 'NO_TARGET', 'send-msg')
  }
  if (!message) {
    throw new BiliError('B站私聊内容不能为空', 'NO_TEXT', 'send-msg')
  }

  const body = new URLSearchParams({
    'msg[sender_uid]': senderUid,
    'msg[receiver_id]': targetUid,
    'msg[receiver_type]': '1',
    'msg[msg_type]': '1',
    'msg[dev_id]': randomUUID().toUpperCase(),
    'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
    'msg[content]': JSON.stringify({ content: message.slice(0, 1000) }),
    csrf,
    csrf_token: csrf,
  })

  const response = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
    method: 'POST',
    headers: {
      ...headers(config),
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://message.bilibili.com/',
      origin: 'https://message.bilibili.com',
    },
    body,
  })
  const textBody = await response.text()
  let payload
  try {
    payload = JSON.parse(textBody)
  } catch {
    throw new BiliError(`B站私信接口返回非 JSON（HTTP ${response.status}）`, 'BAD_JSON', 'send-msg')
  }
  if (!response.ok) {
    throw new BiliError(`B站私信 HTTP ${response.status}`, response.status, 'send-msg')
  }
  if (typeof payload?.code === 'number' && payload.code !== 0) {
    throw new BiliError(
      payload.message || payload.msg || `B站私信接口 code ${payload.code}`,
      payload.code,
      'send-msg',
    )
  }
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {}
  const msgKey = data.msg_key || data.msgKey || payload?.msg_key
  if (!msgKey) {
    throw new BiliError(
      'B站私信接口没有返回投递回执（msg_key），可能被风控或对方不接受陌生人私信',
      'NO_RECEIPT',
      'send-msg',
    )
  }
  return { msgKey: String(msgKey), raw: payload }
}

export function videoSummary(item = {}) {
  const owner = item.owner?.name || 'up主'
  const stat = item.stat || {}
  return [
    `标题：${item.title || ''}`,
    `BV：${item.bvid || ''}`,
    `UP主：${owner}`,
    `时长：${item.duration ? `${Math.round(item.duration / 60)} 分钟` : '未知'}`,
    `播放：${stat.view ?? '?'}，点赞：${stat.like ?? '?'}，评论：${stat.reply ?? '?'}`,
    item.desc ? `简介：${String(item.desc).slice(0, 500)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
