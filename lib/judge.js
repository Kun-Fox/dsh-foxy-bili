/**
 * Foxy's Bilibili judgement layer.
 *
 * Every decision is made by a fresh DSH agent whose system prompt is the
 * foxy3 persona. The agent never gets tools: this plugin performs the Bilibili
 * action itself, so a malicious video title/subtitle cannot reach a shell.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const FALLBACK_PERSONA =
  '你是 Foxy，一只有点懒、嘴硬心软、会自己浏览 B 站的小狐狸。你说中文，第一人称，别像客服。'

function expand(value) {
  if (!value) return ''
  return resolve(String(value).replace(/^~(?=$|[\\/])/, homedir()))
}

function topLevelBlock(text, key) {
  const lines = String(text || '').split(/\r?\n/)
  const head = new RegExp(`^${key}\\s*:\\s*[|>]?\\s*$`)
  const start = lines.findIndex((line) => head.test(line))
  if (start < 0) return ''
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^[A-Za-z_][\w-]*\s*:/.test(line)) break
    out.push(line.replace(/^\s{2}/, ''))
  }
  return out.join('\n').trim()
}

export function readFoxyPersona(config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const candidates = [
    config.presetPath,
    process.env.FOXY_PRESET_PATH,
    join(home, 'foxy', 'presets', `${config.presetId || 'foxy3'}.yml`),
    join(homedir(), '.dsh', 'foxy', 'presets', `${config.presetId || 'foxy3'}.yml`),
    join(process.cwd(), 'dsh-foxy', 'presets', 'foxy3.yml'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    const file = expand(candidate)
    if (!existsSync(file)) continue
    try {
      const text = readFileSync(file, 'utf8')
      const persona = topLevelBlock(text, 'persona') || topLevelBlock(text, 'system')
      if (persona) return persona
    } catch {
      // try next
    }
  }
  return FALLBACK_PERSONA
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text') return part.text || ''
      return ''
    })
    .join('')
}

function messageText(message) {
  return contentText(message?.content ?? message?.text ?? '')
}

function lastAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role === 'assistant' || m?.type === 'assistant') return messageText(m)
    if (m?.type === 'assistant/message') return messageText(m.data?.message ?? m.message)
  }
  return ''
}

function parseJson(text) {
  const raw = String(text || '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

function sessionOf(ctx, handle, sessionId) {
  return handle?.agent?.session || ctx.sessions?.get?.(sessionId)
}

function modelOf(ctx, config) {
  if (config.provider && config.model) {
    return { provider: config.provider, model: config.model }
  }
  const selected = ctx.agentDefaultModel?.currentSelection?.()
  if (selected?.provider && selected?.model) return selected
  return undefined
}

function mentionLines(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .slice(0, 12)
    .map((item) => `- ${item.name}（UID ${item.uid || '未填写'}，${item.role === 'owner' ? '默认账号' : '白名单'}）`)
}

function commentLines(comments = []) {
  return (Array.isArray(comments) ? comments : [])
    .slice(0, 12)
    .map((item) => {
      const level = item.level === 'sub' ? '楼中楼' : '一级评论'
      const name = item.uname || 'B站用户'
      const text = String(item.message || '').replace(/\s+/g, ' ').slice(0, 160)
      return `- rpid=${item.rpid} ${level} ${name}：${text}`
    })
}

export async function judgeVideo(ctx, config, input) {
  const {
    item,
    subtitleText,
    commentsText,
    comments = [],
    mentionCandidates = [],
    mayComment,
    mayReply = false,
    forceComment = false,
  } = input
  const persona = readFoxyPersona(config)
  const sessionId = `foxy-bili-${randomUUID()}`
  const prompt = [
    '你正在浏览 B 站的视频，不是在回复 QQ，也不是客服。',
    '下面是一个视频的信息与字幕节选。请用 Foxy 的判断，决定：',
    '- skip：无聊、广告、纯标题党、没信息量，直接跳过；',
    '- remember：有点意思，但不需要公开评论，自己记一笔；',
    '- comment：值得在评论区说一句，才评论。',
    mayComment ? '本次允许评论。' : '本次不允许评论，只能 skip 或 remember。',
    forceComment ? '本次是用户手动发起的评论测试，请必须输出 action=comment，并写一条可发布的评论。' : '',
    '',
    '评论要求：像 Foxy 自己刷到后随口说的，中文，第一人称，不超过 100 字；不要客服腔，不要“这个视频告诉我们”，不要复述字幕。',
    '评论正文不要自己写 @ 前缀，插件会按 mentions 统一添加。',
    '记忆要求：如果值得记，写成自然的第一人称，例如“我刷到一个讲……的视频，觉得……”。不超过 180 字；不要流水账。',
    '',
    mentionCandidates.length
      ? [
          '提及对象：只能从下面名单中选择，不能编造账号；最多选 3 个。',
          ...mentionLines(mentionCandidates),
          'mentions 填昵称数组；不需要 @ 任何人时填空数组。',
        ].join('\n')
      : '本次没有可提及账号；mentions 必须为空数组，评论正文不要写 @。',
    '',
    mayReply && comments.length
      ? [
          '回复规则：可以回复下面的评论。replyTo 填要回复的 rpid；只发一级评论时填 0。',
          '不要回复自己，不要回复明显引战、广告或违法违规内容。',
          ...commentLines(comments),
        ].join('\n')
      : '本次不回复他人评论；replyTo 必须为 0。',
    '',
    '只输出一个 JSON 对象，不要 Markdown：',
    '{"action":"skip|remember|comment","comment":"...","memory":"...","mentions":[],"replyTo":0,"mood":"..."}',
    '',
    '视频信息：',
    input.summary,
    subtitleText ? `\n字幕节选：\n${subtitleText.slice(0, 6000)}` : '\n（没有字幕，只能根据标题/简介判断）',
    !mayReply && commentsText ? `\n部分评论：\n${commentsText.slice(0, 2000)}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: modelOf(ctx, config),
    setup(agentCtx) {
      agentCtx.systemPrompt.section({
        name: 'foxy:bili',
        order: 0,
        text: persona,
        complete: true,
        interpolate: false,
      })
      const tools = agentCtx.tools || (typeof agentCtx.get === 'function' ? agentCtx.get('tools') : undefined)
      if (tools?.restrict) {
        try {
          tools.restrict({ allow: [] })
        } catch {
          // no tools is the default for this plugin anyway
        }
      }
    },
  })

  try {
    await handle.agent.followup({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'foxy-bili' },
    })
    await handle.agent.whenIdle()
    const session = sessionOf(ctx, handle, sessionId)
    const messages = session?.deriveMessages?.() || []
    const text = lastAssistant(messages)
    const parsed = parseJson(text) || {}
    let action = ['skip', 'remember', 'comment'].includes(parsed.action)
      ? parsed.action
      : 'skip'
    if (forceComment && action !== 'comment' && parsed.comment) action = 'comment'
    const mentions = Array.isArray(parsed.mentions)
      ? parsed.mentions
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .slice(0, 3)
      : []
    const replyTo = Number(parsed.replyTo) || 0
    return {
      action: action === 'comment' && !mayComment ? 'remember' : action,
      comment: String(parsed.comment || '').trim().slice(0, 300),
      memory: String(parsed.memory || '').trim().slice(0, 500),
      mentions,
      replyTo: mayReply ? replyTo : 0,
      mood: String(parsed.mood || '').trim().slice(0, 40),
      raw: text.slice(0, 1000),
    }
  } finally {
    try {
      await handle.dispose?.()
    } catch {
      // the session is disposable; a failed cleanup must not fail the scan
    }
  }
}
