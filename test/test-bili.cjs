const assert = require('node:assert/strict')

async function main() {
  const bili = await import('../lib/bili.js')
  const judge = await import('../lib/judge.js')
  const login = await import('../lib/login.js')
  const settings = await import('../lib/settings.js')

  const cookie = 'SESSDATA=abc; bili_jct=xyz; DedeUserID=82588812'
  assert.equal(bili.parseCookie(cookie).bili_jct, 'xyz')
  assert.equal(bili.csrfFromCookie(cookie), 'xyz')
  assert.equal(bili.csrfFromCookie('SESSDATA=abc'), '')

  const summary = bili.videoSummary({
    title: '测试视频',
    bvid: 'BV1xx',
    owner: { name: 'UP' },
    duration: 130,
    stat: { view: 10, like: 2, reply: 1 },
    desc: '简介',
  })
  assert.match(summary, /标题：测试视频/)
  assert.match(summary, /BV：BV1xx/)
  assert.match(summary, /时长：2 分钟/)

  const persona = judge.readFoxyPersona({})
  assert.ok(persona.length > 100, 'foxy3 persona should be readable')
  assert.match(persona, /Foxy|狐狸|kunfox/)

  const normalized = settings.normalizePatch(settings.DEFAULTS, {
    enabled: 'yes',
    intervalMinutes: 2,
    maxVideosPerRun: 99,
    maxCommentsPerDay: -3,
    commentMode: 'weird',
    ownerName: '  测试账号 ',
    mentionWhitelist: [
      { name: ' 白名单甲 ', uid: ' 100 ' },
      { name: '', uid: '200' },
      { name: '白名单甲', uid: '100' },
    ],
    replyOthers: true,
    nestedReplies: true,
    privatePush: true,
    privateTarget: ' 10001 ',
    biliDmPush: true,
    biliDmTarget: ' 20002 ',
  })
  assert.equal(normalized.enabled, false)
  assert.equal(normalized.intervalMinutes, 10)
  assert.equal(normalized.maxVideosPerRun, 20)
  assert.equal(normalized.maxCommentsPerDay, 0)
  assert.equal(normalized.commentMode, 'off')
  assert.equal(normalized.ownerName, '测试账号')
  assert.deepEqual(normalized.mentionWhitelist, [
    { name: '白名单甲', uid: '100' },
    { name: '', uid: '200' },
  ])
  assert.equal(normalized.replyOthers, true)
  assert.equal(normalized.nestedReplies, true)
  assert.equal(normalized.privatePush, true)
  assert.equal(normalized.privateTarget, '10001')
  assert.equal(normalized.biliDmPush, true)
  assert.equal(normalized.biliDmTarget, '20002')
  assert.deepEqual(settings.DEFAULTS.mentionWhitelist, [])
  assert.equal(settings.DEFAULTS.ownerName, '')
  const publicSettings = settings.publicSettings({ ...normalized, cookie: 'SESSDATA=secret' })
  assert.equal(publicSettings.cookie, undefined)
  assert.equal(publicSettings.cookieSet, true)
  assert.equal(publicSettings.mentionWhitelist.length, 2)

  const previousFetch = global.fetch
  let dmRequest
  global.fetch = async (url, init) => {
    dmRequest = { url, init }
    return new Response(JSON.stringify({ code: 0, data: { msg_key: 'dm-key-1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const dm = await bili.sendDm({ toUid: '20002', text: '给你看个视频', config: { cookie } })
  assert.equal(dm.msgKey, 'dm-key-1')
  assert.match(dmRequest.url, /web_im\/v1\/web_im\/send_msg/)
  const dmForm = new URLSearchParams(dmRequest.init.body)
  assert.equal(dmForm.get('msg[sender_uid]'), '82588812')
  assert.equal(dmForm.get('msg[receiver_id]'), '20002')
  assert.equal(dmForm.get('msg[msg_type]'), '1')
  assert.equal(dmForm.get('csrf'), 'xyz')
  assert.match(dmForm.get('msg[content]'), /给你看个视频/)

  global.fetch = async () =>
    new Response(JSON.stringify({ code: 0, data: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  await assert.rejects(
    () => bili.sendDm({ toUid: '20002', text: '给你看个视频', config: { cookie } }),
    /msg_key/,
  )
  global.fetch = previousFetch

  const jar = login.pickCredentials([
    'SESSDATA=abc%2Cdef; Path=/; HttpOnly',
    'bili_jct=xyz; Path=/',
    'DedeUserID=82588812; Path=/',
    'buvid3=buvid; Path=/',
  ])
  assert.deepEqual(jar, {
    sessdata: 'abc,def',
    bili_jct: 'xyz',
    dedeuserid: '82588812',
    buvid3: 'buvid',
  })
  assert.match(login.credentialToCookie(jar), /SESSDATA=abc,def/)

  let systemText = ''
  let restricted = false
  let responses = ['{"action":"remember","comment":"","memory":"我刷到一个测试视频。"}']
  let responseIndex = -1
  const fakeSession = {
    deriveMessages() {
      const content = responses[Math.min(Math.max(responseIndex, 0), responses.length - 1)]
      return [
        { role: 'system', content: systemText },
        { role: 'assistant', content },
      ]
    },
  }
  const fakeCtx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) },
    agents: {
      async create(opts) {
        assert.equal(opts.sessionId.startsWith('foxy-bili-'), true)
        opts.setup({
          systemPrompt: {
            section(section) {
              systemText = section.text
              assert.equal(section.complete, true)
              assert.equal(section.interpolate, false)
            },
          },
          tools: {
            restrict(spec) {
              restricted = true
              assert.deepEqual(spec.allow, [])
            },
          },
        })
        return {
          agent: {
            async followup() {
              responseIndex += 1
            },
            async whenIdle() {},
            session: fakeSession,
          },
          async dispose() {},
        }
      },
    },
  }

  const decision = await judge.judgeVideo(fakeCtx, {}, {
    item: { bvid: 'BV1xx', title: '测试视频' },
    summary: '标题：测试视频',
    subtitleText: '',
    commentsText: '',
    mayComment: true,
  })
  assert.equal(decision.action, 'remember')
  assert.match(decision.memory, /测试视频/)
  assert.equal(restricted, true)
  assert.ok(systemText.includes(persona.slice(0, 30)))

  responses = [
    '{"action":"skip","comment":"","memory":""}',
    '{"action":"comment","comment":"这个视频我也刷到了，确实有点意思。"}',
  ]
  responseIndex = -1
  const forced = await judge.judgeVideo(fakeCtx, {}, {
    item: { bvid: 'BV1xx', title: '测试视频' },
    summary: '标题：测试视频',
    subtitleText: '',
    commentsText: '',
    mayComment: true,
    forceComment: true,
  })
  assert.equal(forced.action, 'comment')
  assert.match(forced.comment, /有点意思/)
  assert.equal(responseIndex, 1)

  responses = ['{"action":"skip","comment":""}', '这个视频讲得挺清楚的，我记一下。']
  responseIndex = -1
  const prose = await judge.judgeVideo(fakeCtx, {}, {
    item: { bvid: 'BV1xx', title: '测试视频' },
    summary: '标题：测试视频',
    subtitleText: '',
    commentsText: '',
    mayComment: true,
    forceComment: true,
  })
  assert.equal(prose.action, 'comment')
  assert.match(prose.comment, /记一下/)

  responses = ['{"action":"remember","memory":"记一下","dm":true,"dmText":"这个我也想发给你看看。"}']
  responseIndex = -1
  const privateDecision = await judge.judgeVideo(fakeCtx, {}, {
    item: { bvid: 'BV1xx', title: '测试视频' },
    summary: '标题：测试视频',
    subtitleText: '',
    commentsText: '',
    mayComment: false,
    privatePush: true,
  })
  assert.equal(privateDecision.dm, true)
  assert.match(privateDecision.dmText, /发给你/)

  const privateOff = await judge.judgeVideo(fakeCtx, {}, {
    item: { bvid: 'BV1xx', title: '测试视频' },
    summary: '标题：测试视频',
    subtitleText: '',
    commentsText: '',
    mayComment: false,
    privatePush: false,
  })
  assert.equal(privateOff.dm, false)
  assert.equal(privateOff.dmText, '')

  console.log('foxy-bili tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
