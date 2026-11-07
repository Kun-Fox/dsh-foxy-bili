/**
 * Minimal Bilibili web client for Foxy.
 *
 * It deliberately uses the same cookie-based web endpoints as the browser
 * (there is no public "bot" API for comments). Reads work anonymously; comment
 * writes need SESSDATA + bili_jct. The client is intentionally small and does
 * not try to be a general Bilibili SDK.
 */

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
 * `@nickname` prefix; `atMid` is sent as an extra hint for clients that read it.
 */
export async function postComment({ aid, message, atMid, config = {} }) {
  const csrf = csrfFromCookie(config.cookie)
  if (!csrf) throw new BiliError('missing bili_jct (csrf) in cookie', 'NO_CSRF', 'reply/add')
  const body = new URLSearchParams({
    oid: String(aid),
    type: '1',
    message: String(message),
    csrf,
    plat: '1',
  })
  if (atMid) body.set('at_name_to_mid', String(atMid))
  return request('https://api.bilibili.com/x/v2/reply/add', config, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
}

/**
 * Reply inside a comment thread.
 */
export async function replyComment({ aid, root, parent, message, atMid, config = {} }) {
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
  if (atMid) body.set('at_name_to_mid', String(atMid))
  return request('https://api.bilibili.com/x/v2/reply/add', config, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
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
