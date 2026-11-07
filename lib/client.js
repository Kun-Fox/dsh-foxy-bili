window.__ModuleLoader__.load({
  id: 'dsh-foxy-bili',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/api/dsh-foxy-bili'
    const PANEL_ID = 'dsh-foxy-bili'

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

    function Toggle({ checked, onChange, label, hint }) {
      return h(
        'label',
        { className: 'fb-toggle' },
        h('input', { type: 'checkbox', checked: !!checked, onChange: (e) => onChange(e.target.checked) }),
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

    function Panel() {
      const [settings, setSettings] = useState(null)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [qr, setQr] = useState(null)
      const [qrState, setQrState] = useState('')
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
          setNotice('已保存，下一轮扫描生效')
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
            result.skipped
              ? `没有开跑：${result.skipped}`
              : `跑完一轮：检查 ${result.checked || 0} 条，记住 ${result.remembered || 0} 条，评论 ${result.commented || 0} 条`,
          )
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

      if (!settings) {
        return h(
          'div',
          { className: 'fb-page' },
          h('p', { className: 'fb-muted' }, error || '正在读取刷 B 站设置…'),
        )
      }

      const qrText = {
        waiting: '用手机 B 站扫码，扫完在手机上点确认',
        scanned: '已扫码，请在手机上确认登录',
        expired: '二维码已过期，重新点一次「扫码登录」',
      }[qrState]

      return h(
        'div',
        { className: 'fb-page' },
        h(
          'header',
          { className: 'fb-header' },
          h(
            'div',
            null,
            h('h2', null, '刷 B 站'),
            h('p', null, 'Foxy 自己逛热门，觉得有意思才记住或评论；评论和回复都走 foxy3 人设。'),
          ),
          h(
            'span',
            { className: status?.enabled ? 'fb-pill fb-pill-live' : 'fb-pill' },
            status?.enabled ? '自动刷已开' : '已暂停',
          ),
        ),

        h(
          'section',
          { className: 'fb-card' },
          h(Toggle, {
            checked: settings.enabled,
            onChange: (v) => setField('enabled', v),
            label: '启用自动刷 B 站',
            hint: '关闭后定时器不跑，但「手动跑一轮」仍可用',
          }),
        ),

        h(
          'section',
          { className: 'fb-card' },
          h(
            'div',
            { className: 'fb-card-head' },
            h('h3', null, 'B 站账号'),
            settings.cookieSet
              ? h('span', { className: 'fb-badge fb-badge-ok' }, '已登录')
              : h('span', { className: 'fb-badge' }, '未登录'),
          ),
          settings.cookieSet
            ? h(
                'div',
                { className: 'fb-account' },
                h(
                  'div',
                  null,
                  h('strong', null, settings.accountName || 'B 站账号'),
                  h('small', null, settings.accountUid ? `UID ${settings.accountUid}` : '凭证已保存'),
                ),
                h(
                  'button',
                  { className: 'fb-btn fb-btn-ghost', disabled: !!busy, onClick: logout },
                  busy === 'logout' ? '退出中…' : '退出登录',
                ),
              )
            : h(
                'div',
                { className: 'fb-login' },
                h('p', { className: 'fb-muted' }, '不用抓 Cookie，直接扫码。凭证只保存在本机。'),
                h(
                  'button',
                  { className: 'fb-btn fb-btn-primary', disabled: !!busy, onClick: startLogin },
                  busy === 'login' ? '生成二维码…' : '扫码登录',
                ),
              ),
          qr
            ? h(
                'div',
                { className: 'fb-qr' },
                h('img', { src: qr.qr, alt: 'B站登录二维码', width: 220, height: 220 }),
                h('div', null, h('p', null, qrText), h('small', { className: 'fb-muted' }, '二维码有效期约 3 分钟')),
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
          h('div', { className: 'fb-card-head' }, h('h3', null, '说话对象')),
          h(
            'div',
            { className: 'fb-grid' },
            h(
              Field,
              { label: '主人昵称', hint: '评论开头会 @ 这个名字' },
              h('input', {
                value: settings.ownerName || '',
                placeholder: '例如：坤坤',
                onChange: (e) => setField('ownerName', e.target.value),
              }),
            ),
            h(
              Field,
              { label: '主人 UID', hint: '传给 B 站 at 接口；不知道可留空' },
              h('input', {
                value: settings.ownerUid || '',
                placeholder: '例如：2242711967',
                onChange: (e) => setField('ownerUid', e.target.value),
              }),
            ),
          ),
          h(Toggle, {
            checked: settings.mentionOwner,
            onChange: (v) => setField('mentionOwner', v),
            label: '评论时 @ 主人',
            hint: '关闭后只发正文；B 站仍需正文里出现 @昵称 才会显示',
          }),
        ),

        h(
          'section',
          { className: 'fb-card' },
          h('div', { className: 'fb-card-head' }, h('h3', null, '怎么刷')),
          h(
            'div',
            { className: 'fb-grid' },
            h(
              Field,
              { label: '间隔（分钟）', hint: '10–1440，默认 90' },
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
              { label: '每轮看几条', hint: '1–20，默认 5' },
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
              { label: '评论模式', hint: '默认只记录，不自动发评论' },
              h(
                'select',
                {
                  value: settings.commentMode,
                  onChange: (e) => setField('commentMode', e.target.value),
                },
                h('option', { value: 'off' }, '只记录，不评论'),
                h('option', { value: 'auto' }, '遇到合适的才评论'),
              ),
            ),
            h(
              Field,
              { label: '每天最多评论', hint: '0–10；默认 1 条' },
              h('input', {
                type: 'number',
                min: 0,
                max: 10,
                value: settings.maxCommentsPerDay,
                onChange: (e) => setField('maxCommentsPerDay', Number(e.target.value)),
              }),
            ),
          ),
          h(Toggle, {
            checked: settings.enableMemory,
            onChange: (v) => setField('enableMemory', v),
            label: '写进 Foxy 记忆',
            hint: '只记有意思的视频；走 foxyMemory，不直接写 LivingMemory',
          }),
          h(Toggle, {
            checked: settings.runOnStart,
            onChange: (v) => setField('runOnStart', v),
            label: 'DSH 启动后先跑一轮',
            hint: '启动 20 秒后跑；调试时建议关',
          }),
        ),

        h(
          'section',
          { className: 'fb-card fb-run' },
          h(
            'div',
            { className: 'fb-card-head' },
            h('h3', null, '运行状态'),
            h(
              'div',
              { className: 'fb-actions' },
              h(
                'button',
                { className: 'fb-btn fb-btn-ghost', disabled: !!busy, onClick: runNow },
                busy === 'run' ? '跑着呢…' : '手动跑一轮',
              ),
              h(
                'button',
                { className: 'fb-btn fb-btn-primary', disabled: !!busy, onClick: save },
                busy === 'save' ? '保存中…' : '保存设置',
              ),
            ),
          ),
          h(
            'div',
            { className: 'fb-stats' },
            h(Stat, { label: '已看过', value: status?.seen }),
            h(Stat, { label: '今天评论', value: status?.commentsToday }),
            h(Stat, {
              label: '上次运行',
              value: status?.lastRun ? new Date(status.lastRun).toLocaleString() : '还没跑过',
            }),
          ),
          status?.lastResult
            ? h(
                'p',
                { className: 'fb-muted' },
                `上轮：检查 ${status.lastResult.checked || 0}，跳过 ${status.lastResult.skipped || 0}，记住 ${status.lastResult.remembered || 0}，评论 ${status.lastResult.commented || 0}`,
              )
            : null,
        ),

        error ? h('p', { className: 'fb-alert fb-alert-error' }, error) : null,
        notice ? h('p', { className: 'fb-alert' }, notice) : null,
        h(
          'p',
          { className: 'fb-footnote' },
          '安全提示：B 站评论区有风控。建议先保持「只记录」和「自动刷关闭」，看完几轮判断再开自动评论。',
        ),
      )
    }

    const CSS = `
.fb-page { padding: 22px 24px 36px; max-width: 840px; color: var(--dsh-text, #1f2328); height: 100%; overflow: auto; }
.fb-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 16px; }
.fb-header h2 { margin: 0 0 5px; font-size: 20px; letter-spacing: -.2px; }
.fb-header p { margin: 0; color: var(--dsh-muted, #6b7280); font-size: 12px; line-height: 1.65; max-width: 560px; }
.fb-pill { flex: none; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--dsh-border, #d8dce2); color: var(--dsh-muted, #6b7280); font-size: 11px; }
.fb-pill-live { border-color: #7db58c; color: #2f7d4a; background: #f0f9f3; }
.fb-card { padding: 15px 16px; margin: 11px 0; border: 1px solid var(--dsh-border, #d8dce2); border-radius: 10px; background: var(--dsh-panel, #fff); }
.fb-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.fb-card-head h3 { margin: 0; font-size: 13px; font-weight: 650; }
.fb-muted { margin: 6px 0; color: var(--dsh-muted, #6b7280); font-size: 12px; line-height: 1.65; }
.fb-toggle { display: flex; align-items: flex-start; gap: 9px; padding: 6px 0; cursor: pointer; }
.fb-toggle input { position: absolute; opacity: 0; pointer-events: none; }
.fb-toggle-box { width: 34px; height: 20px; flex: none; border-radius: 999px; background: var(--dsh-border, #cfd5dd); position: relative; transition: background .15s; margin-top: 1px; }
.fb-toggle-box::after { content: ''; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 2px rgba(0,0,0,.15); }
.fb-toggle input:checked + .fb-toggle-box { background: #3b82f6; }
.fb-toggle input:checked + .fb-toggle-box::after { transform: translateX(14px); }
.fb-toggle-copy { display: flex; flex-direction: column; gap: 2px; font-size: 12px; line-height: 1.5; }
.fb-toggle-copy small { color: var(--dsh-muted, #6b7280); font-size: 11px; }
.fb-badge { font-size: 10px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--dsh-border, #d8dce2); color: var(--dsh-muted, #6b7280); }
.fb-badge-ok { border-color: #7db58c; color: #2f7d4a; background: #f0f9f3; }
.fb-account { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.fb-account strong { display: block; font-size: 13px; }
.fb-account small { display: block; margin-top: 2px; color: var(--dsh-muted, #6b7280); font-size: 11px; }
.fb-login { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.fb-login .fb-muted { margin: 0; }
.fb-qr { display: flex; gap: 16px; align-items: center; margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--dsh-border, #d8dce2); }
.fb-qr img { border-radius: 8px; background: #fff; padding: 6px; border: 1px solid #e5e7eb; }
.fb-qr p { margin: 0 0 4px; font-size: 12px; }
.fb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 8px; }
.fb-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; }
.fb-field-label { display: flex; flex-direction: column; gap: 1px; font-weight: 600; }
.fb-field-label small { font-weight: 400; color: var(--dsh-muted, #6b7280); font-size: 10px; }
.fb-field input, .fb-field select { height: 32px; padding: 0 9px; border: 1px solid var(--dsh-border, #d8dce2); border-radius: 6px; background: var(--dsh-bg, #fff); color: inherit; font: inherit; font-size: 12px; }
.fb-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.fb-btn { height: 30px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--dsh-border, #d8dce2); background: var(--dsh-panel, #fff); color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.fb-btn:disabled { opacity: .55; cursor: default; }
.fb-btn-primary { border-color: #2563eb; background: #2563eb; color: #fff; }
.fb-btn-ghost:hover { background: var(--dsh-hover, #f4f6f8); }
.fb-stats { display: flex; gap: 28px; flex-wrap: wrap; padding: 4px 0 2px; }
.fb-stat { display: flex; flex-direction: column; gap: 2px; }
.fb-stat span { color: var(--dsh-muted, #6b7280); font-size: 10px; }
.fb-stat strong { font-size: 13px; font-weight: 600; }
.fb-alert { margin: 10px 0 0; padding: 8px 10px; border-radius: 6px; border: 1px solid #b7d7c0; background: #f2faf5; color: #2f6b42; font-size: 12px; }
.fb-alert-error { border-color: #e6b8b5; background: #fdf4f4; color: #a33; }
.fb-footnote { margin: 16px 0 0; color: var(--dsh-muted, #6b7280); font-size: 11px; line-height: 1.7; }
@media (max-width: 640px) { .fb-page { padding: 16px 14px 28px; } .fb-grid { grid-template-columns: 1fr; } .fb-header { flex-direction: column; } .fb-qr { flex-direction: column; align-items: flex-start; } }
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
          { name: 'sidebar.panellist', id: PANEL_ID, order: 13, label: () => 'Foxy 刷B站' },
          BiliIcon,
        ),
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'foxy-bili', order: 31, label: 'Foxy 刷B站' },
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
