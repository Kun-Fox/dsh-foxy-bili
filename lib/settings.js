import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULTS = {
  enabled: false,
  cookie: '',
  ownerUid: '',
  ownerName: '',
  presetId: 'foxy3',
  presetPath: '',
  intervalMinutes: 90,
  maxVideosPerRun: 5,
  commentMode: 'off', // off | auto
  maxCommentsPerDay: 1,
  enableMemory: true,
  memoryPresetId: 'foxy3（Character）',
  mentionOwner: true,
  mentionWhitelist: [],
  replyOthers: false,
  nestedReplies: false,
  privatePush: false,
  privateTarget: '',
  biliDmPush: false,
  biliDmTarget: '',
  runOnStart: false,
  debug: false,
}

export const SETTING_KEYS = [
  'enabled',
  'ownerUid',
  'ownerName',
  'presetId',
  'presetPath',
  'intervalMinutes',
  'maxVideosPerRun',
  'commentMode',
  'maxCommentsPerDay',
  'enableMemory',
  'memoryPresetId',
  'mentionOwner',
  'mentionWhitelist',
  'replyOthers',
  'nestedReplies',
  'privatePush',
  'privateTarget',
  'biliDmPush',
  'biliDmTarget',
  'runOnStart',
  'debug',
]

const TEXT_KEYS = new Set([
  'ownerUid',
  'ownerName',
  'presetId',
  'presetPath',
  'commentMode',
  'memoryPresetId',
  'privateTarget',
  'biliDmTarget',
])
const BOOLEAN_KEYS = new Set([
  'enabled',
  'enableMemory',
  'mentionOwner',
  'replyOthers',
  'nestedReplies',
  'privatePush',
  'biliDmPush',
  'runOnStart',
  'debug',
])
export const MAX_WHITELIST = 20

export function foxyHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function settingsPath() {
  return join(foxyHome(), 'foxy-bili', 'settings.json')
}

function clampNumber(key, value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  if (key === 'intervalMinutes') return Math.max(10, Math.min(24 * 60, Math.round(n)))
  if (key === 'maxVideosPerRun') return Math.max(1, Math.min(20, Math.round(n)))
  if (key === 'maxCommentsPerDay') return Math.max(0, Math.min(10, Math.round(n)))
  return n
}

export function normalizeWhitelist(value) {
  if (!Array.isArray(value)) return []
  const out = []
  const seen = new Set()
  for (const entry of value.slice(0, MAX_WHITELIST)) {
    let name = ''
    let uid = ''
    if (typeof entry === 'string') {
      name = entry.trim()
    } else if (entry && typeof entry === 'object') {
      name = String(entry.name ?? entry.uname ?? '').trim()
      uid = String(entry.uid ?? entry.mid ?? '').trim()
    }
    if (!name && !uid) continue
    const key = `${name}\u0000${uid}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name, uid })
  }
  return out
}

export function normalizePatch(current = {}, patch = {}) {
  const next = { ...DEFAULTS, ...current }
  for (const key of SETTING_KEYS) {
    if (patch[key] === undefined || key === 'mentionWhitelist') continue
    if (BOOLEAN_KEYS.has(key)) next[key] = patch[key] === true
    else if (key === 'commentMode') next[key] = patch[key] === 'auto' ? 'auto' : 'off'
    else if (TEXT_KEYS.has(key)) next[key] = String(patch[key] ?? '').trim()
    else next[key] = clampNumber(key, patch[key], next[key])
  }
  if (patch.mentionWhitelist !== undefined) {
    next.mentionWhitelist = normalizeWhitelist(patch.mentionWhitelist)
  }
  if (patch.cookie !== undefined) next.cookie = String(patch.cookie || '')
  if (patch.clearCookie === true) next.cookie = ''
  if (typeof patch.accountName === 'string') next.accountName = patch.accountName.trim()
  if (typeof patch.accountUid === 'string') next.accountUid = patch.accountUid.trim()
  next.enabled = next.enabled === true
  next.enableMemory = next.enableMemory !== false
  next.mentionOwner = next.mentionOwner !== false
  next.replyOthers = next.replyOthers === true
  next.nestedReplies = next.nestedReplies === true
  next.privatePush = next.privatePush === true
  next.biliDmPush = next.biliDmPush === true
  next.mentionWhitelist = normalizeWhitelist(next.mentionWhitelist)
  return next
}

export function loadSettings(base = {}) {
  let next = normalizePatch(DEFAULTS, base)
  try {
    if (existsSync(settingsPath())) {
      const parsed = JSON.parse(readFileSync(settingsPath(), 'utf8'))
      // Migrate the 0.1.x name without making old settings silently reset.
      if (parsed.maxCommentsPerDay === undefined && parsed.maxCommentsPerRun !== undefined) {
        parsed.maxCommentsPerDay = parsed.maxCommentsPerRun
      }
      next = normalizePatch(next, parsed)
      // Cookie is the only secret and is never accepted from the UI as a
      // redacted placeholder. Keep whatever is explicitly stored.
      if (typeof parsed.cookie === 'string') next.cookie = parsed.cookie
    }
  } catch {}
  return next
}

export function saveSettings(settings) {
  const file = settingsPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  return file
}

export function publicSettings(settings) {
  const out = {}
  for (const key of SETTING_KEYS) out[key] = settings[key]
  out.cookieSet = Boolean(settings.cookie)
  out.accountName = settings.accountName || ''
  out.accountUid = settings.accountUid || ''
  return out
}
