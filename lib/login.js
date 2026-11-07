/**
 * Bilibili passport QR login.
 *
 * The credentials arrive in the poll response's Set-Cookie header, not in the
 * QR URL. That detail is the reason the old handwritten-cookie flow was so
 * fragile, so keep it in one place.
 */
import QRCode from 'qrcode'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const POLL = (key) =>
  'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' +
  encodeURIComponent(key) +
  '&source=main-fe-header'
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'
const NAV = 'https://api.bilibili.com/x/web-interface/nav'

function headers(extra = {}) {
  return {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    ...extra,
  }
}

async function getJson(url, cookie = '') {
  const res = await fetch(url, {
    headers: headers(cookie ? { Cookie: cookie } : {}),
    redirect: 'manual',
  })
  const text = await res.text()
  let body = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { message: text.slice(0, 200) }
  }
  return { res, body }
}

/** Pull the four cookies we need out of a Set-Cookie array. */
export function pickCredentials(setCookies = []) {
  const wanted = {
    SESSDATA: 'sessdata',
    bili_jct: 'bili_jct',
    DedeUserID: 'dedeuserid',
    buvid3: 'buvid3',
  }
  const jar = {}
  for (const raw of setCookies) {
    for (const part of String(raw).split(/,(?=\s*[A-Za-z0-9_]+=)/)) {
      const first = part.split(';')[0] || ''
      const i = first.indexOf('=')
      if (i <= 0) continue
      const name = first.slice(0, i).trim()
      const value = first.slice(i + 1).trim()
      if (wanted[name]) jar[wanted[name]] = decodeURIComponent(value)
    }
  }
  return jar
}

function setCookieList(res) {
  const h = res.headers
  if (typeof h.getSetCookie === 'function') return h.getSetCookie()
  const raw = h.get('set-cookie') || ''
  return raw ? [raw] : []
}

async function ensureBuvid3(jar) {
  if (jar.buvid3) return jar
  try {
    const { body } = await getJson(SPI)
    const value = body?.data?.b_3
    if (value) jar.buvid3 = value
  } catch {}
  return jar
}

export function credentialToCookie(jar = {}) {
  return [
    jar.sessdata ? `SESSDATA=${jar.sessdata}` : '',
    jar.bili_jct ? `bili_jct=${jar.bili_jct}` : '',
    jar.dedeuserid ? `DedeUserID=${jar.dedeuserid}` : '',
    jar.buvid3 ? `buvid3=${jar.buvid3}` : '',
  ]
    .filter(Boolean)
    .join('; ')
}

export async function loginStart() {
  const { body } = await getJson(GEN)
  const data = body?.data
  if (!data?.qrcode_key || !data?.url) {
    throw new Error(`生成二维码失败：${body?.message || '返回里没有 qrcode_key'}`)
  }
  const qr = await QRCode.toDataURL(data.url, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 280,
    color: { dark: '#111111', light: '#ffffff' },
  })
  return { key: data.qrcode_key, url: data.url, qr }
}

export async function fetchAccount(cookie) {
  if (!cookie) return null
  try {
    const { body } = await getJson(NAV, cookie)
    if (body?.code !== 0 || !body?.data?.isLogin) return null
    return {
      mid: String(body.data.mid || ''),
      uname: String(body.data.uname || ''),
      face: String(body.data.face || ''),
    }
  } catch {
    return null
  }
}

/**
 * Poll once. state: waiting | scanned | expired | ok | unknown.
 * On ok, returns both the credential object and an account summary.
 */
export async function loginPoll(key) {
  if (!key) throw new Error('缺少二维码 key')
  const res = await fetch(POLL(key), { headers: headers(), redirect: 'manual' })
  let body = {}
  try {
    body = await res.json()
  } catch {}
  const code = body?.data?.code
  if (code === 0) {
    const jar = await ensureBuvid3(pickCredentials(setCookieList(res)))
    const cookie = credentialToCookie(jar)
    if (!jar.sessdata) {
      return { state: 'unknown', code, message: '登录成功，但响应里没有 SESSDATA，请重试' }
    }
    return {
      state: 'ok',
      code,
      credential: jar,
      cookie,
      account: await fetchAccount(cookie),
    }
  }
  const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }
  return { state: map[code] ?? 'unknown', code, message: body?.message || '' }
}
