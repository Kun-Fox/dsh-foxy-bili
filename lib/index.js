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
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

export const name = 'dsh-foxy-bili'
export const inject = ['agents', 'agentDefaultModel']

const DEFAULTS = {
  enabled: false,
  cookie: '',
  ownerUid: '',
  ownerName: '',
  presetId: 'foxy3',
  presetPath: '',
  intervalMinutes: 90,
  maxVideosPerRun: 5,
  commentMode: 'off', // off | auto
  maxCommentsPerRun: 1,
  enableMemory: true,
  memoryPresetId: 'foxy3（Character）',
  runOnStart: false,
  debug: false,
}

function expand(value) {
  if (!value) return ''
  return resolve(String(value).replace(/^~(?=$|[\\/])/, homedir()))
}

function statePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'foxy-bili', 'state.json')
}

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf8'))
  } catch {
    return { seen: {}, days: {}, lastRun: 0 }
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
  const day = today()
  return Number(state.days?.[day]?.comments || 0)
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
  if (!name) return ''
  return `@${name} `
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
  if (commentCount(state) >= Number(config.maxCommentsPerRun || 1)) return false
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
    const messageText = error instanceof BiliError ? `${error.code}: ${error.message}` : String(error)
    ctx.logger?.warn?.(`[foxy-bili] comment failed on ${item.bvid}: ${messageText}`)
    return false
  }
}

async function scanOnce(ctx, config, state, log) {
  if (!config.enabled) return { skipped: 'disabled' }
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
  return result
}

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig }
  const log = (message) => ctx.logger?.info?.(message)

  let running = false
  let timer
  let state = loadState()

  const run = async (reason = 'timer') => {
    if (running) return { skipped: 'busy' }
    running = true
    try {
      log(`[foxy-bili] scan start (${reason})`)
      const result = await scanOnce(ctx, config, state, log)
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

  const capability = {
    version: 1,
    scan: () => run('manual'),
    status: () => ({
      enabled: config.enabled,
      running,
      lastRun: state.lastRun,
      seen: Object.keys(state.seen).length,
      commentsToday: commentCount(state),
      commentMode: config.commentMode,
    }),
  }
  const foxy = typeof ctx.get === 'function' ? ctx.get('foxy') : undefined
  foxy?.registerCapability?.('bili', capability)
  ctx.provide?.('foxyBili', capability)

  const minutes = Math.max(10, Number(config.intervalMinutes) || 90)
  timer = setInterval(() => {
    run('timer').catch(() => {})
  }, minutes * 60 * 1000)
  timer.unref?.()
  ctx.effect?.(() => () => clearInterval(timer), 'foxy-bili: scan timer')

  if (config.runOnStart) {
    setTimeout(() => run('start').catch(() => {}), 20_000).unref?.()
  }

  log(
    `[foxy-bili] ready enabled=${config.enabled} interval=${minutes}m ` +
      `comment=${config.commentMode} memory=${config.enableMemory}`,
  )
}
