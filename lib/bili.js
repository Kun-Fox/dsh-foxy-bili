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

/** Personalized recommendation stream, broader than the popular list. */
export async function recommend(limit = 20, config = {}) {
  const size = Math.max(1, Math.min(50, Number(limit) || 20))
  const data = await request(
    `https://api.bilibili.com/x/web-interface/index/top/feed/rcmd?ps=${size}`,
    config,
  )
  return (data?.item || []).filter((item) => item?.bvid).slice(0, size)
}

function stripHtml(value = '') {
  return String(value)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

/** Keyword search. The web search endpoint works with the logged-in cookie. */
export async function search(keyword, limit = 20, config = {}) {
  const word = String(keyword || '').trim()
  if (!word) throw new BiliError('搜索关键词为空', 'NO_KEYWORD', 'search')
  const size = Math.max(1, Math.min(50, Number(limit) || 20))
  const data = await request(
    `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(word)}&page=1`,
    config,
  )
  const rows = Array.isArray(data?.result) ? data.result : []
  return rows
    .filter((item) => item?.bvid)
    .slice(0, size)
    .map((item) => ({
      ...item,
      title: stripHtml(item.title),
      description: stripHtml(item.description),
      author: item.author || '',
      mid: item.mid,
    }))
}

export async function video(bvid, config = {}) {
  const data = await request(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    config,
  )
  if (!data?.bvid) throw new BiliError('video not found', 'NOT_FOUND', bvid)
  return data
}

export async function videoByAid(aid, config = {}) {
  const data = await request(
    `https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(aid)}`,
    config,
  )
  if (!data?.bvid) throw new BiliError('video not found', 'NOT_FOUND', String(aid))
  return data
}

/** Replies to Foxy's comments. `data.items[].item.business_id === 1` is a video comment. */
export async function msgfeedReply(config = {}) {
  const data = await request(
    'https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web',
    config,
  )
  return Array.isArray(data?.items) ? data.items : []
}

/** Comments that mention Foxy. Same item shape as `msgfeedReply`. */
export async function msgfeedAt(config = {}) {
  const data = await request(
    'https://api.bilibili.com/x/msgfeed/at?platform=web&build=0&mobi_app=web',
    config,
  )
  return Array.isArray(data?.items) ? data.items : []
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

function normalizeAtNameToMid(atNameToMid, atMentions, atMids = []) {
  const map = {}
  if (atNameToMid && typeof atNameToMid === 'object' && !Array.isArray(atNameToMid)) {
    for (const [name, mid] of Object.entries(atNameToMid)) {
      const cleanName = String(name || '').replace(/^@/, '').trim()
      const cleanMid = String(mid || '').trim()
      if (cleanName && cleanMid) map[cleanName] = /^\d+$/.test(cleanMid) ? Number(cleanMid) : cleanMid
    }
  }
  if (Array.isArray(atMentions)) {
    for (const entry of atMentions) {
      if (!entry || typeof entry !== 'object') continue
      const cleanName = String(entry.name || '').replace(/^@/, '').trim()
      const cleanMid = String(entry.uid ?? entry.mid ?? '').trim()
      if (cleanName && cleanMid) map[cleanName] = /^\d+$/.test(cleanMid) ? Number(cleanMid) : cleanMid
    }
  }
  return map
}

function commentBody({ aid, root, parent, message, atMid, atMids, atMentions, atNameToMid, csrf }) {
  const body = new URLSearchParams({
    oid: String(aid),
    type: '1',
    message: String(message),
    csrf,
    plat: '1',
  })
  if (root !== undefined) body.set('root', String(root))
  if (parent !== undefined) body.set('parent', String(parent || root))
  const map = normalizeAtNameToMid(atNameToMid, atMentions, atMids)
  if (Object.keys(map).length) body.set('at_name_to_mid', JSON.stringify(map))
  return body
}

/**
 * Post a top-level comment. `message` should already contain the visible
 * `@nickname` prefixes. `atMentions` is `[{ name, uid }]`; Bilibili expects
 * `at_name_to_mid` as a JSON object (name -> numeric mid), not a comma list.
 */
export async function postComment({
  aid,
  message,
  atMid,
  atMids,
  atMentions,
  atNameToMid,
  config = {},
}) {
  const csrf = csrfFromCookie(config.cookie)
  if (!csrf) throw new BiliError('missing bili_jct (csrf) in cookie', 'NO_CSRF', 'reply/add')
  const body = commentBody({ aid, message, atMid, atMids, atMentions, atNameToMid, csrf })
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
export async function replyComment({
  aid,
  root,
  parent,
  message,
  atMid,
  atMids,
  atMentions,
  atNameToMid,
  config = {},
}) {
  const csrf = csrfFromCookie(config.cookie)
  if (!csrf) throw new BiliError('missing bili_jct (csrf) in cookie', 'NO_CSRF', 'reply/add')
  const body = commentBody({
    aid,
    root,
    parent,
    message,
    atMid,
    atMids,
    atMentions,
    atNameToMid,
    csrf,
  })
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

