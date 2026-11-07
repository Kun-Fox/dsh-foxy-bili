window.__ModuleLoader__.load({
  id: 'dsh-foxy-bili',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/api/dsh-foxy-bili'
    const PANEL_ID = 'dsh-foxy-bili'
    const SIDEBAR_LABEL = 'Foxy-bili'

    function BiliIcon({ size = 18 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 3 }),
        h('path', { d: 'M8 5 6 2.8M16 5l2-2.2M8 10.5h2M14 10.5h2M9 15c1.8 1 4.2 1 6 0' }),
      )
    }

    async function request(path, options = {}) {
      const res = await fetch(API + path, {
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
        ...options,
      })
      let body = {}
      try {
        body = await res.json()
      } catch {}
      if (!res.ok || body.ok === false) {
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      return body
    }

    function Toggle({ checked, onChange, label, hint, disabled }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': !!checked,
          className: disabled ? 'fb-toggle fb-disabled' : 'fb-toggle',
          disabled: !!disabled,
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'fb-toggle-box', 'aria-hidden': true }),
        h(
          'span',
          { className: 'fb-toggle-copy' },
          h('strong', null, label),
          hint ? h('small', null, hint) : null,
        ),
      )
    }

    function Field({ label, hint, children }) {
      return h(
        'label',
        { className: 'fb-field' },
        h('span', { className: 'fb-field-label' }, label, hint ? h('small', null, hint) : null),
        children,
      )
    }

    function Stat({ label, value }) {
      return h(
        'div',
        { className: 'fb-stat' },
        h('span', null, label),
        h('strong', null, value ?? '—'),
      )
    }

    function SectionHead({ title, description, extra }) {
      return h(
        'div',
        { className: 'fb-card-head' },
        h('div', null, h('h3', null, title), description ? h('p', null, description) : null),
        extra || null,
      )
    }

    const ACTION_LABELS = {
      skip: '跳过',
      remember: '记录',
      comment: '评论',
      error: '失败',
    }

    function actionLabel(action) {
      return ACTION_LABELS[action] || action || '未知'
    }

    function Panel() {
      const [settings, setSettings] = useState(null)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [qr, setQr] = useState(null)
      const [qrState, setQrState] = useState('')
      const [instantBvid, setInstantBvid] = useState('')
      const [instantResult, setInstantResult] = useState(null)
      const timerRef = useRef(null)
      const mountedRef = useRef(true)

      const stopPoll = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = null
      }, [])

      const refresh = useCallback(async () => {
        const data = await request('/status')
        if (!mountedRef.current) return
        setSettings(data.settings)
        setStatus(data.status)
      }, [])

      useEffect(() => {
        mountedRef.current = true
        refresh().catch((e) => setError(e.message))
        return () => {
          mountedRef.current = false
          stopPoll()
        }
      }, [refresh, stopPoll])

      const setField = (key, value) => {
        setSettings((current) => (current ? { ...current, [key]: value } : current))
      }

      const listText = (value) =>
        Array.isArray(value) ? value.join(', ') : String(value || '')

      const save = async () => {
        if (!settings) return
        setBusy('save')
        setError('')
        setNotice('')
        try {
          const data = await request('/settings', {
            method: 'POST',
            body: JSON.stringify(settings),
          })
          setSettings(data.settings)
          setStatus(data.status)
          setNotice('设置已保存')
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }

      const runNow = async () => {
        setBusy('run')
        setError('')
        setNotice('')
        try {
          const data = await request('/run', { method: 'POST', body: '{}' })
          setStatus(data.status)
          const result = data.result || {}
          setNotice(
            result.skipped === 'disabled'
              ? '未开始运行：自动浏览已关闭'
              : result.skipped === 'busy'
                ? '正在运行，请稍候'
                : `运行完成：检查 ${result.checked || 0} 条，记录 ${result.remembered || 0} 条，评论 ${result.commented || 0} 条，私聊 ${result.dms || 0} 条` +
                  (result.filtered ? `，兴趣筛选 ${result.filtered} 条` : '') +
                  (result.errors ? `，失败 ${result.errors} 条` : ''),
          )
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }

      const commentNow = async () => {
        setBusy('comment')
        setError('')
        setNotice('')
        setInstantResult(null)
        try {
          const data = await request('/comment-now', {
            method: 'POST',
            body: JSON.stringify({ bvid: instantBvid.trim() }),
          })
          setStatus(data.status)
          setInstantResult(data.result)
          if (data.result?.ok) {
            setNotice('评论已发布')
          } else {
            setError(data.result?.published?.error || '评论发布失败')
          }
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }

      const logout = async () => {
        if (!window.confirm('退出 B 站登录？已保存的视频记录不会删除。')) return
        setBusy('logout')
        setError('')
        try {
          const data = await request('/logout', { method: 'POST', body: '{}' })
          setSettings(data.settings)
          setStatus(data.status)
          setNotice('已退出 B 站登录')
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }

      const startLogin = async () => {
        stopPoll()
        setBusy('login')
        setError('')
        setNotice('')
        setQr(null)
        setQrState('')
        try {
          const data = await request('/login/start', { method: 'POST', body: '{}' })
          if (!mountedRef.current) return
          setQr(data)
          setQrState('waiting')
          let attempts = 0
          const tick = async () => {
            if (!mountedRef.current) return
            attempts += 1
            try {
              const poll = await request('/login/poll', {
                method: 'POST',
                body: JSON.stringify({ key: data.key }),
              })
              if (!mountedRef.current) return
              if (poll.state === 'ok') {
                setSettings(poll.settings)
                setStatus(poll.status)
                setQr(null)
                setQrState('')
                setNotice(
                  poll.account?.uname
                    ? `登录成功：${poll.account.uname}`
                    : '登录成功，凭证已保存',
                )
                return
              }
              if (poll.state === 'expired') {
                setQrState('expired')
                return
              }
              setQrState(poll.state === 'scanned' ? 'scanned' : 'waiting')
              if (attempts >= 90) {
                setQrState('expired')
                return
              }
              timerRef.current = setTimeout(tick, 2000)
            } catch (e) {
              if (mountedRef.current) setError(e.message)
            }
          }
          timerRef.current = setTimeout(tick, 1200)
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy('')
        }
      }

      const whitelist = Array.isArray(settings?.mentionWhitelist) ? settings.mentionWhitelist : []
      const updateWhitelist = (index, patch) => {
        const next = whitelist.map((row, i) => (i === index ? { ...row, ...patch } : row))
        setField('mentionWhitelist', next)
      }
      const addWhitelist = () => {
        if (whitelist.length >= 20) return
        setField('mentionWhitelist', [...whitelist, { name: '', uid: '' }])
      }
      const removeWhitelist = (index) => {
        setField(
          'mentionWhitelist',
          whitelist.filter((_, i) => i !== index),
        )
      }

      if (!settings) {
        return h(
          'div',
          { className: 'fb-page' },
          h('p', { className: 'fb-muted' }, error || '正在读取 B 站设置…'),
        )
      }

      const qrText = {
        waiting: '使用手机 B 站扫码，并在手机上确认登录',
        scanned: '已扫码，请在手机上确认',
        expired: '二维码已过期，请重新生成',
      }[qrState]

      const recent = Array.isArray(status?.recent) ? status.recent : []
      const lastResult = status?.lastResult

      return h(
        'div',
        { className: 'fb-page' },
        h(
          'header',
          { className: 'fb-header' },
          h(
            'div',
            null,
            h('span', { className: 'fb-eyebrow' }, 'Foxy extension'),
            h('h2', null, 'B站浏览'),
            h(
              'p',
              null,
              'Foxy 按 foxy3 预设浏览热门视频，判断是否记录或评论；评论与回复均由预设生成。',
            ),
          ),
          h(
            'span',
            { className: status?.enabled ? 'fb-pill fb-pill-live' : 'fb-pill' },
            status?.enabled ? '自动浏览已启用' : '自动浏览已关闭',
          ),
        ),

        h(
          'section',
          { className: 'fb-card' },
          h(
            SectionHead,
            {
              title: '账号与登录',
              description: '扫码登录后，插件才能读取个性化内容并发布评论。',
              extra: settings.cookieSet
                ? h('span', { className: 'fb-badge fb-badge-ok' }, '已登录')
                : h('span', { className: 'fb-badge' }, '未登录'),
            },
          ),
          settings.cookieSet
            ? h(
                'div',
                { className: 'fb-account' },
                h(
                  'div',
                  null,
                  h('strong', null, settings.accountName || 'B站账号'),
                  h('small', null, settings.accountUid ? `UID ${settings.accountUid}` : '凭证已保存'),
                ),
                h(
                  'button',
                  { className: 'fb-btn fb-btn-ghost', disabled: !!busy, onClick: logout },
                  busy === 'logout' ? '正在退出…' : '退出登录',
                ),
              )
            : h(
                'div',
                { className: 'fb-login' },
                h('p', { className: 'fb-muted' }, '无需手动填写 Cookie；凭证仅保存在本机。'),
                h(
                  'button',
                  { className: 'fb-btn fb-btn-primary', disabled: !!busy, onClick: startLogin },
                  busy === 'login' ? '正在生成二维码…' : '扫码登录',
                ),
              ),
          qr
            ? h(
                'div',
                { className: 'fb-qr' },
                h('img', { src: qr.qr, alt: 'B站登录二维码', width: 220, height: 220 }),
                h(
                  'div',
                  null,
                  h('p', null, qrText),
                  h('small', { className: 'fb-muted' }, '二维码有效期约 3 分钟'),
                ),
                h(
                  'button',
                  {
                    className: 'fb-btn fb-btn-ghost',
                    onClick: () => {
                      stopPoll()
                      setQr(null)
                      setQrState('')
                    },
                  },
                  '取消',
                ),
              )
            : null,
        ),

        h(
          'section',
          { className: 'fb-card' },
          h(SectionHead, {
            title: 'AI 模型',
            description: '默认跟随 DSH 当前模型；也可以填写 API Key 直连，绕过 DSH 的模型传输层。',
          }),
          h(
            'div',
            { className: 'fb-grid' },
            h(
              Field,
              { label: '调用方式', hint: '直连模式使用下面的 API Key，不再请求 DSH 模型' },
              h(
                'select',
                {
                  value: settings.llmMode || 'dsh',
                  onChange: (e) => setField('llmMode', e.target.value),
                },
                h('option', { value: 'dsh' }, '跟随 DSH 当前模型'),
                h('option', { value: 'direct' }, '直接 API（推荐）'),
              ),
            ),
            h(
              Field,
              { label: 'API Key 状态', hint: 'Key 只保存在本机，不会回传前端' },
              h(
                'div',
                { className: settings.llmApiKeySet ? 'fb-key-state fb-key-set' : 'fb-key-state' },
                settings.llmApiKeySet ? '已配置' : '未配置',
              ),
            ),
          ),
          settings.llmMode === 'direct'
            ? h(
                'div',
                { className: 'fb-grid' },
                h(
                  Field,
                  { label: '接口地址', hint: 'OpenAI 兼容地址；会自动补 /chat/completions' },
                  h('input', {
                    value: settings.llmBaseUrl || '',
                    placeholder: 'https://api.deepseek.com',
                    onChange: (e) => setField('llmBaseUrl', e.target.value),
                  }),
                ),
                h(
                  Field,
                  { label: '模型名', hint: '例如 deepseek-chat 或 deepseek-reasoner' },
                  h('input', {
                    value: settings.llmModel || '',
                    placeholder: 'deepseek-chat',
                    onChange: (e) => setField('llmModel', e.target.value),
                  }),
                ),
                h(
                  Field,
                  { label: 'API Key', hint: '留空表示保留已保存的 Key' },
                  h('input', {
                    type: 'password',
                    value: settings.llmApiKey || '',
                    placeholder: settings.llmApiKeySet ? '已保存，留空不修改' : 'sk-...',
                    autoComplete: 'new-password',
                    onChange: (e) => setField('llmApiKey', e.target.value),
                  }),
                ),
              )
            : null,
          h(
            'p',
            { className: 'fb-muted fb-llm-note' },
            '直连模式只影响 B 站判断/评论；不经过 DSH 的模型选择。',
          ),
        ),

        h(
          'section',
          { className: 'fb-card' },
          h(SectionHead, {
            title: '浏览模式',
            description: '控制自动浏览频率、每轮样本量与评论触发方式。',
          }),
          h(Toggle, {
            checked: settings.enabled,
            onChange: (v) => setField('enabled', v),
            label: '启用自动浏览',
            hint: '关闭后定时任务不会运行，仍可使用「立即运行」。',
          }),
          h(
            'div',
            { className: 'fb-grid' },
            h(
              Field,
              { label: '浏览间隔', hint: '单位：分钟，范围 10–1440' },
              h('input', {
                type: 'number',
                min: 10,
                max: 1440,
                value: settings.intervalMinutes,
                onChange: (e) => setField('intervalMinutes', Number(e.target.value)),
              }),
            ),
            h(
              Field,
              { label: '每轮浏览数量', hint: '范围 1–20' },
              h('input', {
                type: 'number',
                min: 1,
                max: 20,
                value: settings.maxVideosPerRun,
                onChange: (e) => setField('maxVideosPerRun', Number(e.target.value)),
              }),
            ),
            h(
              Field,
              {
                label: '兴趣关键词',
                hint: '标题/简介包含任一关键词才浏览；用逗号分隔，留空不筛选',
              },
              h('input', {
                value: listText(settings.interestKeywords),
                placeholder: '例如：编程, 游戏, 纪录片',
                onChange: (e) => setField('interestKeywords', e.target.value),
              }),
            ),
            h(
              Field,
              {
                label: '兴趣分区',
                hint: '只浏览这些分区；用逗号分隔，留空不筛选',
              },
              h('input', {
                value: listText(settings.interestCategories),
                placeholder: '例如：科技, 游戏, 知识',
                onChange: (e) => setField('interestCategories', e.target.value),
              }),
            ),
            h(
              Field,
              { label: '评论模式', hint: '自动评论会使用当前账号发布内容' },
              h(
                'select',
                {
                  value: settings.commentMode,
                  onChange: (e) => setField('commentMode', e.target.value),
                },
                h('option', { value: 'off' }, '仅记录'),
                h('option', { value: 'auto' }, '自动评论'),
              ),
            ),
            h(
              Field,
              { label: '每日评论上限', hint: '仅限制自动评论，范围 0–10' },
              h('input', {
                type: 'number',
                min: 0,
                max: 10,
                value: settings.maxCommentsPerDay,
                onChange: (e) => setField('maxCommentsPerDay', Number(e.target.value)),
              }),
            ),
          ),
          h(
            'div',
            { className: 'fb-toggle-group' },
            h(Toggle, {
              checked: settings.enableMemory,
              onChange: (v) => setField('enableMemory', v),
              label: '写入 Foxy 记忆',
              hint: '只记录模型判断为有价值的视频；通过 foxyMemory 写入。',
            }),
            h(Toggle, {
              checked: settings.runOnStart,
              onChange: (v) => setField('runOnStart', v),
              label: '启动 DSH 后自动运行',
              hint: '启动约 20 秒后执行一轮，调试时建议关闭。',
            }),
          ),
        ),

        h(
          'section',
          { className: 'fb-card' },
          h(SectionHead, {
            title: '评论功能',
            description: '配置默认提及账号、提及白名单，以及是否回复他人评论。',
          }),
          h(
            'div',
            { className: 'fb-grid' },
            h(
              Field,
              { label: '默认提及账号', hint: '自动评论时默认 @ 的 B 站昵称' },
              h('input', {
                value: settings.ownerName || '',
                placeholder: 'B站昵称',
                onChange: (e) => setField('ownerName', e.target.value),
              }),
            ),
            h(
              Field,
              { label: '默认提及 UID', hint: '可选，用于 B 站 at 接口' },
              h('input', {
                value: settings.ownerUid || '',
                placeholder: 'B站 UID',
                onChange: (e) => setField('ownerUid', e.target.value),
              }),
            ),
          ),
          h(Toggle, {
            checked: settings.mentionOwner,
            onChange: (v) => setField('mentionOwner', v),
            label: '默认 @ 该账号',
            hint: '关闭后，模型未选择其他提及对象时，评论不带 @。',
          }),
          h(
            'div',
            { className: 'fb-whitelist' },
            h(
              'div',
              { className: 'fb-whitelist-head' },
              h('strong', null, '提及白名单'),
              h('small', null, '除默认账号外，模型只能从以下账号中选择 @；最多 20 个。'),
            ),
            whitelist.length
              ? h(
                  'div',
                  { className: 'fb-whitelist-list' },
                  whitelist.map((row, index) =>
                    h(
                      'div',
                      { className: 'fb-whitelist-row', key: `wl-${index}` },
                      h('input', {
                        value: row.name || '',
                        placeholder: 'B站昵称',
                        onChange: (e) => updateWhitelist(index, { name: e.target.value }),
                      }),
                      h('input', {
                        value: row.uid || '',
                        placeholder: 'B站 UID（可选）',
                        onChange: (e) => updateWhitelist(index, { uid: e.target.value }),
                      }),
                      h(
                        'button',
                        {
                          className: 'fb-btn fb-btn-ghost',
                          onClick: () => removeWhitelist(index),
                        },
                        '移除',
                      ),
                    ),
                  ),
                )
              : h('p', { className: 'fb-muted' }, '暂未添加白名单账号。'),
            h(
              'button',
              {
                className: 'fb-btn fb-btn-ghost',
                disabled: whitelist.length >= 20,
                onClick: addWhitelist,
              },
              '添加账号',
            ),
          ),
          h(
            'div',
            { className: 'fb-toggle-group' },
            h(Toggle, {
              checked: settings.replyOthers,
              onChange: (v) => {
                setField('replyOthers', v)
                if (!v) setField('nestedReplies', false)
              },
              label: '回复他人评论',
              hint: '允许 Foxy 回复视频下的一级评论；关闭时只发表一级评论。',
            }),
            h(Toggle, {
              checked: settings.nestedReplies,
              onChange: (v) => setField('nestedReplies', v),
              label: '楼中楼回复',
              hint: '允许回复子评论；关闭时只回复一级评论。需先开启「回复他人评论」。',
              disabled: !settings.replyOthers,
            }),
          ),
          h(
            'div',
            { className: 'fb-instant' },
            h(
              'div',
              null,
              h('strong', null, '立即评论一次'),
              h(
                'small',
                null,
                '手动测试评论功能，不占用自动评论配额；留空时选择当前热门视频。',
              ),
            ),
            h('input', {
              value: instantBvid,
              placeholder: 'BV 号（可留空）',
              onChange: (e) => setInstantBvid(e.target.value),
            }),
            h(
              'button',
              { className: 'fb-btn fb-btn-primary', disabled: !!busy, onClick: commentNow },
              busy === 'comment' ? '正在发布…' : '立即评论一次',
            ),
          ),
          instantResult
            ? h(
                'div',
                { className: instantResult.ok ? 'fb-result fb-result-ok' : 'fb-result fb-result-error' },
                h(
                  'p',
                  null,
                  instantResult.ok ? '评论已发布' : `评论失败：${instantResult.published?.error || '未知错误'}`,
                ),
                instantResult.target
                  ? h(
                      'a',
                      {
                        href: instantResult.target.url,
                        target: '_blank',
                        rel: 'noreferrer',
                      },
                      `${instantResult.target.title || instantResult.target.bvid}（${instantResult.target.bvid}）`,
                    )
                  : null,
                instantResult.published?.message
                  ? h('small', null, instantResult.published.message)
                  : null,
                instantResult.privatePush
                  ? h(
                      'small',
                      null,
                      instantResult.privatePush.sent?.length
                        ? `已私聊推送：${
                            instantResult.privatePush.sent
                              .map((channel) => (channel === 'bilibili' ? 'B站' : 'QQ'))
                              .join(' + ')
                          }`
                        : `私聊推送失败：${instantResult.privatePush.error || '未知错误'}`,
                    )
                  : null,
              )
            : null,
        ),

        h(
          'section',
          { className: 'fb-card' },
          h(SectionHead, {
            title: '私聊推送',
            description: '发现值得分享的视频时，通过 QQ 或 B站私聊主动发给主人；推送内容会写入私聊记忆。',
          }),
          h(Toggle, {
            checked: settings.privatePush,
            onChange: (v) => setField('privatePush', v),
            label: 'QQ 私聊推送',
            hint: '由 Foxy 判断是否值得分享；无聊、广告、标题党不会推送。',
          }),
          h(
            Field,
            { label: 'QQ 号', hint: '留空时使用 Koishi 记忆桥配置的 owner QQ' },
            h('input', {
              value: settings.privateTarget || '',
              placeholder: 'QQ 号（可留空）',
              onChange: (e) => setField('privateTarget', e.target.value),
            }),
          ),
          h(Toggle, {
            checked: settings.biliDmPush,
            onChange: (v) => setField('biliDmPush', v),
            label: 'B站私聊推送',
            hint: '使用当前扫码登录的 B站账号，直接发给站内私信；需要对方接受陌生人私信。',
          }),
          h(
            Field,
            { label: 'B站私聊对象 UID', hint: '留空时使用默认提及账号的 B站 UID' },
            h('input', {
              value: settings.biliDmTarget || '',
              placeholder: 'B站 UID（可留空）',
              onChange: (e) => setField('biliDmTarget', e.target.value),
            }),
          ),
        ),

        h(
          'section',
          { className: 'fb-card' },
          h(
            SectionHead,
            {
              title: '运行与日志',
              description: '每次运行会记录浏览过的视频、模型判断与发布结果。',
              extra: h(
                'div',
                { className: 'fb-actions' },
                h(
                  'button',
                  { className: 'fb-btn fb-btn-ghost', disabled: !!busy, onClick: runNow },
                  busy === 'run' ? '正在运行…' : '立即运行',
                ),
                h(
                  'button',
                  { className: 'fb-btn fb-btn-primary', disabled: !!busy, onClick: save },
                  busy === 'save' ? '正在保存…' : '保存设置',
                ),
              ),
            },
          ),
          h(
            'div',
            { className: 'fb-stats' },
            h(Stat, { label: '已浏览', value: status?.seen }),
            h(Stat, { label: '今日评论', value: status?.commentsToday }),
            h(Stat, {
              label: '上次运行',
              value: status?.lastRun ? new Date(status.lastRun).toLocaleString() : '尚未运行',
            }),
          ),
          lastResult
            ? h(
                'p',
                { className: 'fb-muted' },
                `本轮：检查 ${lastResult.checked || 0} 条，跳过 ${lastResult.skipped || 0} 条，记录 ${lastResult.remembered || 0} 条，评论 ${lastResult.commented || 0} 条，私聊 ${lastResult.dms || 0} 条` +
                  (lastResult.filtered ? `，兴趣筛选 ${lastResult.filtered} 条` : '') +
                  (lastResult.errors ? `，失败 ${lastResult.errors} 条` : ''),
              )
            : null,
          recent.length
            ? h(
                'div',
                { className: 'fb-log' },
                recent.map((item, index) =>
                  h(
                    'div',
                    { className: 'fb-log-row', key: `${item.bvid}-${item.at}-${index}` },
                    h(
                      'div',
                      { className: 'fb-log-main' },
                      h(
                        'a',
                        {
                          href: `https://www.bilibili.com/video/${item.bvid}`,
                          target: '_blank',
                          rel: 'noreferrer',
                        },
                        item.title || item.bvid,
                      ),
                      h('small', null, `${item.bvid} · ${new Date(item.at).toLocaleString()}`),
                    ),
                    h(
                      'span',
                      { className: `fb-action fb-action-${item.action || 'skip'}` },
                      actionLabel(item.action),
                    ),
                    h(
                      'p',
                      null,
                      item.reason || item.error || (item.comment ? item.comment : ''),
                    ),
                    item.dm
                      ? h(
                          'small',
                          {
                            className:
                              item.dm === 'error' ? 'fb-dm fb-dm-error' : 'fb-dm fb-dm-ok',
                          },
                          item.dm === 'error'
                            ? `私聊推送失败：${item.dmError || '未知错误'}`
                            : `已私聊推送${
                                item.dmChannels?.length
                                  ? `：${item.dmChannels
                                      .map((channel) => (channel === 'bilibili' ? 'B站' : 'QQ'))
                                      .join(' + ')}`
                                  : ''
                              }${item.dmError ? `（部分失败：${item.dmError}）` : ''}`,
                        )
                      : null,
                  ),
                ),
              )
            : h('p', { className: 'fb-muted' }, '暂无运行记录。'),
        ),

        error ? h('p', { className: 'fb-alert fb-alert-error' }, error) : null,
        notice ? h('p', { className: 'fb-alert' }, notice) : null,
        h(
          'p',
          { className: 'fb-footnote' },
          '安全提示：B 站评论区存在风控。建议先使用「仅记录」和「立即运行」观察结果，再开启自动评论。',
        ),
      )
    }

    const CSS = `
.fb-page { padding: 28px 32px 44px; max-width: 880px; color: var(--dsw-alias-label-primary, #1f2328); height: 100%; overflow: auto; overflow-anchor: none; box-sizing: border-box; }
.fb-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 20px; }
.fb-eyebrow { display: block; margin-bottom: 6px; font-size: 10px; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary, #8b949e); }
.fb-header h2 { margin: 0 0 6px; font-size: 22px; line-height: 1.25; letter-spacing: -.3px; }
.fb-header p { margin: 0; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12px; line-height: 1.65; max-width: 580px; }
.fb-pill { flex: none; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--dsw-alias-bg-layer-3, #d8dce2); color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; white-space: nowrap; }
.fb-pill-live { border-color: #6aa87a; color: #2f7d4a; background: rgba(47, 125, 74, .08); }
.fb-card { padding: 18px 20px; margin: 12px 0; border: 1px solid var(--dsw-alias-bg-layer-3, #d8dce2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #fff); }
.fb-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
.fb-card-head h3 { margin: 0; font-size: 14px; line-height: 1.4; font-weight: 650; }
.fb-card-head p { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; line-height: 1.55; }
.fb-muted { margin: 8px 0; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 12px; line-height: 1.65; }
.fb-key-state { display: inline-flex; align-items: center; min-height: 34px; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 12px; }
.fb-key-set { color: var(--dsw-alias-label-success, #2e7d32); font-weight: 600; }
.fb-llm-note { margin: 4px 0 0; }
.fb-toggle { position: relative; display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 7px 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.fb-toggle:disabled { cursor: default; }
.fb-toggle-box { width: 36px; height: 21px; flex: none; border-radius: 999px; background: var(--dsw-alias-bg-layer-4, #cfd5dd); position: relative; transition: background .15s; margin-top: 1px; }
.fb-toggle-box::after { content: ''; position: absolute; top: 3px; left: 3px; width: 15px; height: 15px; border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 2px rgba(0,0,0,.18); }
.fb-toggle[aria-checked="true"] .fb-toggle-box { background: #3b82f6; }
.fb-toggle[aria-checked="true"] .fb-toggle-box::after { transform: translateX(15px); }
.fb-toggle-copy { display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 1.5; }
.fb-toggle-copy small { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; }
.fb-toggle-group { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; margin-top: 6px; padding-top: 10px; border-top: 1px dashed var(--dsw-alias-bg-layer-3, #e5e7eb); }
.fb-disabled { opacity: .5; cursor: default; }
.fb-badge { font-size: 10px; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-bg-layer-3, #d8dce2); color: var(--dsw-alias-label-tertiary, #6b7280); white-space: nowrap; }
.fb-badge-ok { border-color: #6aa87a; color: #2f7d4a; background: rgba(47, 125, 74, .08); }
.fb-account { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.fb-account strong { display: block; font-size: 13px; }
.fb-account small { display: block; margin-top: 3px; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; }
.fb-login { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.fb-login .fb-muted { margin: 0; }
.fb-qr { display: flex; gap: 18px; align-items: center; margin-top: 16px; padding-top: 16px; border-top: 1px dashed var(--dsw-alias-bg-layer-3, #e5e7eb); }
.fb-qr img { border-radius: 10px; background: #fff; padding: 6px; border: 1px solid #e5e7eb; }
.fb-qr p { margin: 0 0 5px; font-size: 12px; }
.fb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; margin: 12px 0 4px; }
.fb-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; min-width: 0; }
.fb-field-label { display: flex; flex-direction: column; gap: 1px; font-weight: 600; }
.fb-field-label small { font-weight: 400; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 10px; line-height: 1.4; }
.fb-field input, .fb-field select, .fb-whitelist-row input, .fb-instant input { height: 34px; padding: 0 10px; box-sizing: border-box; border: 1px solid var(--dsw-alias-bg-layer-3, #d8dce2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2, #fff); color: inherit; font: inherit; font-size: 12px; min-width: 0; }
.fb-field input:focus, .fb-field select:focus, .fb-whitelist-row input:focus, .fb-instant input:focus { outline: none; border-color: #3b82f6; }
.fb-field select { color-scheme: light dark; }
.fb-field select option { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, #1a1a1a); }
.fb-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.fb-btn { height: 31px; padding: 0 12px; border-radius: 7px; border: 1px solid var(--dsw-alias-bg-layer-3, #d8dce2); background: var(--dsw-alias-bg-layer-2, #fff); color: inherit; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
.fb-btn:disabled { opacity: .5; cursor: default; }
.fb-btn-primary { border-color: #2563eb; background: #2563eb; color: #fff; }
.fb-btn-ghost:hover { background: var(--dsw-alias-interactive-bg-hover, #f4f6f8); }
.fb-whitelist { margin: 12px 0 4px; padding: 12px 0 0; border-top: 1px dashed var(--dsw-alias-bg-layer-3, #e5e7eb); }
.fb-whitelist-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
.fb-whitelist-head strong { font-size: 12px; }
.fb-whitelist-head small { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 10px; line-height: 1.5; }
.fb-whitelist-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.fb-whitelist-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center; }
.fb-instant { display: grid; grid-template-columns: minmax(180px, 1fr) 200px auto; gap: 12px; align-items: end; margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--dsw-alias-bg-layer-3, #e5e7eb); }
.fb-instant strong { display: block; font-size: 12px; }
.fb-instant small { display: block; margin-top: 3px; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 10px; line-height: 1.5; }
.fb-result { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; padding: 9px 11px; border-radius: 7px; font-size: 11px; line-height: 1.5; }
.fb-result p { margin: 0; }
.fb-result a { color: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.fb-result small { color: var(--dsw-alias-label-secondary, #6b7280); word-break: break-word; }
.fb-result-ok { border: 1px solid #b7d7c0; background: rgba(47, 125, 74, .08); color: #2f6b42; }
.fb-result-error { border: 1px solid #e6b8b5; background: rgba(180, 50, 40, .06); color: #a33; }
.fb-stats { display: flex; gap: 32px; flex-wrap: wrap; padding: 2px 0 10px; }
.fb-stat { display: flex; flex-direction: column; gap: 2px; }
.fb-stat span { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 10px; }
.fb-stat strong { font-size: 13px; font-weight: 600; }
.fb-log { margin-top: 10px; border-top: 1px solid var(--dsw-alias-bg-layer-3, #e5e7eb); }
.fb-log-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; padding: 10px 0; border-bottom: 1px solid var(--dsw-alias-bg-layer-3, #e5e7eb); }
.fb-log-main { min-width: 0; }
.fb-log-main a { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: inherit; font-size: 12px; font-weight: 600; text-decoration: none; }
.fb-log-main a:hover { text-decoration: underline; }
.fb-log-main small { display: block; margin-top: 2px; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 10px; }
.fb-log-row p { grid-column: 1 / -1; margin: 0; color: var(--dsw-alias-label-secondary, #6b7280); font-size: 11px; line-height: 1.5; word-break: break-word; }
.fb-action { align-self: start; padding: 2px 7px; border-radius: 5px; font-size: 10px; white-space: nowrap; background: var(--dsw-alias-bg-layer-4, rgba(128,128,128,.12)); color: var(--dsw-alias-label-secondary, #6b7280); }
.fb-action-comment { color: #2f7d4a; background: rgba(47, 125, 74, .1); }
.fb-action-error { color: #a33; background: rgba(180, 50, 40, .08); }
.fb-dm { display: block; margin-top: 4px; font-size: 10px; }
.fb-dm-ok { color: #2f7d4a; }
.fb-dm-error { color: #a33; }
.fb-alert { margin: 10px 0 0; padding: 9px 11px; border-radius: 7px; border: 1px solid #b7d7c0; background: rgba(47, 125, 74, .08); color: #2f6b42; font-size: 12px; }
.fb-alert-error { border-color: #e6b8b5; background: rgba(180, 50, 40, .06); color: #a33; }
.fb-footnote { margin: 18px 0 0; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; line-height: 1.7; }
@media (max-width: 720px) {
  .fb-page { padding: 20px 16px 32px; }
  .fb-header { flex-direction: column; }
  .fb-grid, .fb-toggle-group { grid-template-columns: 1fr; }
  .fb-instant { grid-template-columns: 1fr; }
  .fb-whitelist-row { grid-template-columns: 1fr 1fr auto; }
  .fb-qr { flex-direction: column; align-items: flex-start; }
  .fb-log-row { grid-template-columns: minmax(0, 1fr) auto; }
}
`

    const name = 'dsh-foxy-bili'
    const inject = ['slots']

    function apply(ctx) {
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', 'dsh-foxy-bili')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(() => () => style.remove(), 'dsh-foxy-bili: settings style')

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          { name: 'main', key: PANEL_ID, inject: () => ({ workbench: true }) },
          () => h(Panel),
        ),
      )
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 13, label: () => SIDEBAR_LABEL },
          BiliIcon,
        ),
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'foxy-bili', order: 31, label: SIDEBAR_LABEL },
          () => h(Panel),
        ),
      )
    }

    const module = { exports: {} }
    module.exports.name = name
    module.exports.inject = inject
    module.exports.apply = apply
    return module.exports
  },
})
