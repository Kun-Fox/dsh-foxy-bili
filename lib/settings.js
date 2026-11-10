import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeTextList } from './interest.js'
import { DEFAULT_JUDGE_PROMPT } from './prompts.js'

export const DEFAULTS = {
  enabled: false,
  cookie: '',
  ownerUid: '',
  ownerName: '',
  presetId: 'foxy3',
  presetPath: '',
  intervalMinutes: 90,
  maxVideosPerRun: 5,
  feedSource: 'mixed', // mixed | popular | ranking | search | recommend
  searchKeywords: [],
  browseStart: '',
  browseEnd: '',
  dailyVideoLimit: 20,
  interestKeywords: [],
  interestCategories: [],
  commentMode: 'off', // off | auto
  maxCommentsPerDay: 1,
  replyInbox: false,
  replyIntervalMinutes: 10,
  maxRepliesPerRun: 1,
  enableMemory: true,
  memoryPresetId: 'foxy3（Character）',
  mentionOwner: true,
  mentionWhitelist: [],
  replyOthers: false,
  nestedReplies: false,
  llmMode: 'dsh', // dsh | direct
  llmBaseUrl: 'https://api.deepseek.com',
  llmModel: 'deepseek-chat',
  llmApiKey: '',
  basePrompt: DEFAULT_JUDGE_PROMPT,
  customPrompt: '',
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
  'feedSource',
  'searchKeywords',
  'interestKeywords',
  'interestCategories',
  'commentMode',
  'maxCommentsPerDay',
  'replyInbox',
  'replyIntervalMinutes',
  'maxRepliesPerRun',
  'enableMemory',
  'memoryPresetId',
  'mentionOwner',
  'mentionWhitelist',
  'replyOthers',
  'nestedReplies',
  'browseStart',
  'browseEnd',
  'dailyVideoLimit',
  'llmMode',
  'llmBaseUrl',
  'llmModel',
  'basePrompt',
  'customPrompt',
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
  'llmMode',
  'llmBaseUrl',
  'llmModel',
  'basePrompt',
  'customPrompt',
])
const BOOLEAN_KEYS = new Set([
  'enabled',
  'enableMemory',
  'mentionOwner',
  'replyOthers',
  'nestedReplies',
  'replyInbox',
  'runOnStart',
  'debug',
])
export const MAX_WHITELIST = 20
export const FEED_SOURCES = new Set(['mixed', 'popular', 'ranking', 'search', 'recommend'])

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
  if (key === 'dailyVideoLimit') return Math.max(0, Math.min(100, Math.round(n)))
  if (key === 'maxCommentsPerDay') return Math.max(0, Math.min(10, Math.round(n)))
  if (key === 'replyIntervalMinutes') return Math.max(2, Math.min(24 * 60, Math.round(n)))
  if (key === 'maxRepliesPerRun') return Math.max(1, Math.min(5, Math.round(n)))
  return n
}

export function normalizeClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!match) return ''
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return ''
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
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
    if (
      patch[key] === undefined ||
      key === 'mentionWhitelist' ||
      key === 'interestKeywords' ||
      key === 'interestCategories' ||
      key === 'searchKeywords'
    ) {
      continue
    }
    if (BOOLEAN_KEYS.has(key)) next[key] = patch[key] === true
    else if (key === 'commentMode') next[key] = patch[key] === 'auto' ? 'auto' : 'off'
    else if (key === 'llmMode') next[key] = patch[key] === 'direct' ? 'direct' : 'dsh'
    else if (TEXT_KEYS.has(key)) next[key] = String(patch[key] ?? '').trim()
    else next[key] = clampNumber(key, patch[key], next[key])
  }
  if (patch.feedSource !== undefined) {
    next.feedSource = FEED_SOURCES.has(patch.feedSource) ? patch.feedSource : next.feedSource
  }
  if (patch.mentionWhitelist !== undefined) {
    next.mentionWhitelist = normalizeWhitelist(patch.mentionWhitelist)
  }
  if (patch.searchKeywords !== undefined) {
    next.searchKeywords = normalizeTextList(patch.searchKeywords)
  }
  if (patch.interestKeywords !== undefined) {
    next.interestKeywords = normalizeTextList(patch.interestKeywords)
  }
  if (patch.interestCategories !== undefined) {
    next.interestCategories = normalizeTextList(patch.interestCategories)
  }
  if (patch.browseStart !== undefined) next.browseStart = normalizeClock(patch.browseStart)
  if (patch.browseEnd !== undefined) next.browseEnd = normalizeClock(patch.browseEnd)
  if (patch.cookie !== undefined) next.cookie = String(patch.cookie || '')
  if (patch.clearCookie === true) next.cookie = ''
  // The API key is write-only from the dashboard. An empty value means
  // "keep the existing key", not "clear it"; a dedicated clear flag is
  // available for the explicit clear button.
  if (typeof patch.llmApiKey === 'string' && patch.llmApiKey.trim()) {
    next.llmApiKey = patch.llmApiKey.trim()
  }
  if (patch.clearLlmApiKey === true) next.llmApiKey = ''
  if (typeof patch.accountName === 'string') next.accountName = patch.accountName.trim()
  if (typeof patch.accountUid === 'string') next.accountUid = patch.accountUid.trim()
  next.enabled = next.enabled === true
  next.enableMemory = next.enableMemory !== false
  next.mentionOwner = next.mentionOwner !== false
  next.replyOthers = next.replyOthers === true
  next.nestedReplies = next.nestedReplies === true
  next.replyInbox = next.replyInbox === true
  next.browseStart = normalizeClock(next.browseStart)
  next.browseEnd = normalizeClock(next.browseEnd)
  next.mentionWhitelist = normalizeWhitelist(next.mentionWhitelist)
  next.interestKeywords = normalizeTextList(next.interestKeywords)
  next.interestCategories = normalizeTextList(next.interestCategories)
  next.searchKeywords = normalizeTextList(next.searchKeywords)
  next.feedSource = FEED_SOURCES.has(next.feedSource) ? next.feedSource : 'mixed'
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
      // Secrets are never accepted from the UI as redacted placeholders.
      // Keep whatever is explicitly stored.
      if (typeof parsed.cookie === 'string') next.cookie = parsed.cookie
      if (typeof parsed.llmApiKey === 'string') next.llmApiKey = parsed.llmApiKey
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
  out.llmApiKeySet = Boolean(settings.llmApiKey)
  out.accountName = settings.accountName || ''
  out.accountUid = settings.accountUid || ''
  return out
}
