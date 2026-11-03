/**
 * FreeBridge — 浏览器半边（设置页 UI）。
 *
 * 用宿主提供的 ModuleLoader 加载，不需要构建步骤，只依赖 shell 已经提供的 react。
 *
 * 贡献两件事：
 *   1. 一个设置页区块（settings.section id freebridge）：
 *      Token 用量统计、会话统计、分流状态、守门状态、桌面编排、模块健康与单模块重启
 *   2. 首次运行的引导卡片（settings.onboarding）
 *
 * 数据从插件自己的同源接口 /freebridge/* 读取。
 * 所有颜色取自主题变量，切换配色不会瞎。
 */
window.__ModuleLoader__.load({
  id: 'dsh-freebridge',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useMemo } = React

    const inject = ['slots', 'locale']
    const NS = 'settings.freebridge'

    // ── 文案 ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: 'FreeBridge',
        title: 'FreeBridge 免费模型桥',
        subtitle: '免账号、免 API Key 接入匿名免费上游，带用量统计与操作守门',

        'health.title': '模块状态',
        'health.hint': '任一模块异常都不影响其他功能；可单独重启',
        'health.restart': '重启',
        'health.state.running': '正常',
        'health.state.degraded': '异常',
        'health.state.stopped': '已停止',
        'health.state.pending': '等待中',
        'health.restarted': '已重启',

        'stats.title': 'Token 用量',
        'stats.global': '全局',
        'stats.level.logical': '逻辑级',
        'stats.level.attempt': '尝试级',
        'stats.levelHint': '逻辑级只算最终成功渠道；尝试级含重试',
        'stats.requests': '请求',
        'stats.input': '输入',
        'stats.output': '输出',
        'stats.total': '总计',
        'stats.byProvider': '按渠道',
        'stats.byModel': '按模型',
        'stats.byDay': '按日趋势',
        'stats.estimated': '含估算',
        'stats.empty': '还没有用量数据，发起一次对话后这里会显示',
        'stats.historyTitle': '历史会话总用量',
        'stats.historyHint': '扫描全部会话文件（含归档），装插件前的用量也算在内',
        'stats.historySessions': '会话',
        'stats.historyTurns': '轮',
        'stats.historyMsgs': '消息',
        'stats.rescan': '重新扫描',

        'models.title': '可用模型',
        'models.hint': '只列出实测能正常回复的模型；不可用的已剔除，不会出现在选择器',
        'models.verified': '已验证可用',
        'models.excluded': '已剔除',
        'models.best': '推荐',

        'sessions.title': '会话统计',
        'sessions.hint': '点击会话先看总量，再展开看供应商与模型',
        'sessions.empty': '还没有会话记录',
        'sessions.detail': '明细',
        'sessions.main': '主线',
        'sessions.branch': '旁支',
        'sessions.edited': '已编辑',
        'sessions.retracted': '已撤回',
        'sessions.segments': '切换段',

        'routes.title': '网络分流',
        'routes.hint': '直连优先，失败自动走代理；规则由插件自己学习',
        'routes.direct': '直连',
        'routes.proxy': '代理',
        'routes.nodes': '节点',
        'routes.empty': '还没有学到任何域名的路由',

        'guard.title': '操作守门',
        'guard.hint': '超出你原话范围的操作会先询问，不直接执行',
        'guard.on': '已开启',
        'guard.off': '已关闭',
        'guard.rules': '规则',

        'desktop.title': '桌面编排',
        'desktop.capabilities': '已接入能力',
        'desktop.apps': '已登记应用',
        'desktop.none': '宿主未提供桌面控制能力（会回退为提示手动操作）',

        'settings.title': '开关',
        'settings.guard': '操作守门',
        'settings.guardHint': '默认开启，越界操作先询问',

        'loading': '加载中…',
        'error': '读取失败',
        'retry': '重试',
        'refresh': '刷新',
        'tokens': 'tokens',
      },
      en: {
        nav: 'FreeBridge',
        title: 'FreeBridge',
        subtitle: 'Anonymous free LLM bridge with usage stats and an operation guard',

        'health.title': 'Modules',
        'health.hint': 'One broken module never blocks the others; restart individually',
        'health.restart': 'Restart',
        'health.state.running': 'running',
        'health.state.degraded': 'degraded',
        'health.state.stopped': 'stopped',
        'health.state.pending': 'pending',
        'health.restarted': 'restarted',

        'stats.title': 'Token usage',
        'stats.global': 'Global',
        'stats.level.logical': 'logical',
        'stats.level.attempt': 'attempt',
        'stats.levelHint': 'logical counts only the successful lane; attempt includes retries',
        'stats.requests': 'requests',
        'stats.input': 'input',
        'stats.output': 'output',
        'stats.total': 'total',
        'stats.byProvider': 'By provider',
        'stats.byModel': 'By model',
        'stats.byDay': 'Daily',
        'stats.estimated': 'estimated',
        'stats.empty': 'No usage yet — send one message and it shows up here',

        'sessions.title': 'Sessions',
        'sessions.hint': 'Click a session: total first, then provider and model breakdown',
        'sessions.empty': 'No sessions yet',
        'sessions.detail': 'Detail',
        'sessions.main': 'main',
        'sessions.branch': 'branch',
        'sessions.edited': 'edited',
        'sessions.retracted': 'retracted',
        'sessions.segments': 'segments',

        'routes.title': 'Network routing',
        'routes.hint': 'Direct first, proxy on failure; rules are learned automatically',
        'routes.direct': 'direct',
        'routes.proxy': 'proxy',
        'routes.nodes': 'nodes',
        'routes.empty': 'No domain learned yet',

        'guard.title': 'Operation guard',
        'guard.hint': 'Out-of-scope actions ask before running',
        'guard.on': 'on',
        'guard.off': 'off',
        'guard.rules': 'rules',

        'desktop.title': 'Desktop orchestration',
        'desktop.capabilities': 'capabilities',
        'desktop.apps': 'apps',
        'desktop.none': 'Host provides no desktop control capability (falls back to manual hint)',

        'settings.title': 'Switches',
        'settings.guard': 'Operation guard',
        'settings.guardHint': 'On by default; out-of-scope actions ask first',

        'loading': 'loading…',
        'error': 'failed to load',
        'retry': 'retry',
        'refresh': 'refresh',
        'tokens': 'tokens',
      },
    }

    function localeTag(ctx) {
      const raw = (() => {
        try { return String(ctx?.locale?.get?.() ?? ctx?.locale?.current ?? '') } catch { return '' }
      })()
      return raw.toLowerCase().startsWith('en') ? 'en' : 'zh'
    }

    function translator(ctx) {
      const tag = localeTag(ctx)
      const dict = DICT[tag] ?? DICT.zh
      return key => dict[key] ?? DICT.zh[key] ?? key
    }

    // ── 数据读取 ──────────────────────────────────────────────────────────────

    async function getJson(path) {
      const res = await fetch(path, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    function useApi(path, deps = []) {
      const [state, setState] = useState({ loading: true, data: null, error: null })
      const load = useCallback(async () => {
        setState(prev => ({ ...prev, loading: true, error: null }))
        try {
          const data = await getJson(path)
          setState({ loading: false, data, error: null })
        } catch (error) {
          setState({ loading: false, data: null, error: String(error?.message ?? error) })
        }
      }, [path, ...deps])
      useEffect(() => { void load() }, [load])
      return { ...state, reload: load }
    }

    // ── 样式（全部走主题变量）───────────────────────────────────────────────
    const S = {
      card: {
        border: '1px solid var(--color-border, rgba(128,128,128,.25))',
        borderRadius: 10,
        padding: '14px 16px',
        marginBottom: 14,
        background: 'var(--color-bg-secondary, transparent)',
      },
      h2: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
      hint: { fontSize: 12, opacity: 0.65, margin: '0 0 12px', lineHeight: 1.5 },
      row: { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' },
      stat: {
        minWidth: 88,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--color-bg-tertiary, rgba(128,128,128,.08))',
      },
      statLabel: { fontSize: 11, opacity: 0.6, display: 'block', marginBottom: 2 },
      statValue: { fontSize: 16, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
      th: { textAlign: 'left', padding: '5px 6px', opacity: 0.6, fontWeight: 500, borderBottom: '1px solid var(--color-border, rgba(128,128,128,.2))' },
      td: { padding: '5px 6px', borderBottom: '1px solid var(--color-border, rgba(128,128,128,.1))' },
      pill: (tone) => ({
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 11,
        background: tone === 'ok'
          ? 'var(--color-success-bg, rgba(46,160,67,.15))'
          : tone === 'bad'
            ? 'var(--color-danger-bg, rgba(248,81,73,.15))'
            : 'var(--color-bg-tertiary, rgba(128,128,128,.15))',
        color: tone === 'ok'
          ? 'var(--color-success-fg, #2ea043)'
          : tone === 'bad'
            ? 'var(--color-danger-fg, #f85149)'
            : 'inherit',
      }),
      btn: {
        fontSize: 12,
        padding: '3px 10px',
        borderRadius: 6,
        border: '1px solid var(--color-border, rgba(128,128,128,.3))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      seg: (active) => ({
        fontSize: 12,
        padding: '3px 10px',
        borderRadius: 6,
        border: '1px solid var(--color-border, rgba(128,128,128,.3))',
        background: active ? 'var(--color-accent-bg, rgba(56,139,253,.18))' : 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      }),
    }

    function Stat({ label, value }) {
      return h('div', { style: S.stat },
        h('span', { style: S.statLabel }, label),
        h('span', { style: S.statValue }, value))
    }

    function nf(n) {
      const v = Number(n ?? 0)
      if (!Number.isFinite(v)) return '0'
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
      return String(Math.round(v))
    }

    function Loading({ t }) {
      return h('div', { style: { fontSize: 12, opacity: 0.6, padding: '8px 0' } }, t('loading'))
    }

    function Failed({ t, error, onRetry }) {
      return h('div', { style: { fontSize: 12, padding: '8px 0' } },
        h('span', { style: { color: 'var(--color-danger-fg, #f85149)' } }, `${t('error')}: ${error}`),
        h('button', { style: { ...S.btn, marginLeft: 10 }, onClick: onRetry }, t('retry')))
    }

    // ── 模块状态 + 单模块重启 ──────────────────────────────────────────────────
    function HealthSection({ t, onAnyRestart }) {
      const { loading, data, error, reload } = useApi('/freebridge/health')
      const [restarting, setRestarting] = useState(null)

      const restart = useCallback(async name => {
        setRestarting(name)
        try {
          await fetch(`/freebridge/restart?module=${encodeURIComponent(name)}`, { credentials: 'same-origin' })
          await reload()
          onAnyRestart?.()
        } finally {
          setRestarting(null)
        }
      }, [reload, onAnyRestart])

      if (loading) return h(Loading, { t })
      if (error !== null) return h(Failed, { t, error, onRetry: reload })

      const modules = data?.modules?.modules ?? []
      return h('div', { style: S.card },
        h('h2', { style: S.h2 }, t('health.title')),
        h('div', { style: S.hint }, t('health.hint')),
        modules.length === 0
          ? h('div', { style: { fontSize: 12, opacity: 0.6 } }, t('loading'))
          : h('table', { style: S.table },
            h('tbody', null,
              modules.map(m => h('tr', { key: m.name },
                h('td', { style: S.td }, m.name),
                h('td', { style: S.td },
                  h('span', { style: S.pill(m.state === 'running' ? 'ok' : 'bad') },
                    t(`health.state.${m.state}`) || m.state)),
                h('td', { style: { ...S.td, opacity: 0.65, fontSize: 11.5 } }, m.error ?? ''),
                h('td', { style: { ...S.td, textAlign: 'right' } },
                  h('button', {
                    style: S.btn,
                    disabled: restarting === m.name,
                    onClick: () => void restart(m.name),
                  }, restarting === m.name ? '…' : t('health.restart'))))))))
    }

    // ── Token 用量（模块一）─────────────────────────────────────────────────
    function StatsSection({ t }) {
      const [level, setLevel] = useState('logical')
      const { loading, data, error, reload } = useApi(`/freebridge/stats?level=${level}&branch=0`)

      if (loading) return h(Loading, { t })
      if (error !== null) return h(Failed, { t, error, onRetry: reload })

      const totals = data?.totals ?? {}
      const byProvider = data?.byProvider ?? []
      const byModel = data?.byModel ?? []
      const byDay = data?.byDay ?? []

      return h('div', { style: S.card },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 } },
          h('div', null,
            h('h2', { style: S.h2 }, t('stats.title')),
            h('div', { style: S.hint }, t('stats.levelHint'))),
          h('div', { style: S.row },
            h('button', { style: S.seg(level === 'logical'), onClick: () => setLevel('logical') }, t('stats.level.logical')),
            h('button', { style: S.seg(level === 'attempt'), onClick: () => setLevel('attempt') }, t('stats.level.attempt')),
            h('button', { style: S.btn, onClick: reload }, t('refresh')))),

        // ── 历史会话总用量（全部会话，包含归档、包含装插件前）──
        data?.history?.available === true
          ? h('div', { style: { marginBottom: 14, padding: '10px 12px', borderRadius: 8, background: 'var(--color-bg-tertiary, rgba(128,128,128,.08))' } },
            h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 2 } }, t('stats.historyTitle')),
            h('div', { style: { fontSize: 11, opacity: 0.6, marginBottom: 8 } }, t('stats.historyHint')),
            h('div', { style: S.row },
              h(Stat, { label: t('stats.total'), value: nf(data.history.totalTokens) }),
              h(Stat, { label: t('stats.input'), value: nf(data.history.inputTokens) }),
              h(Stat, { label: t('stats.output'), value: nf(data.history.outputTokens) }),
              h(Stat, { label: t('stats.historySessions'), value: String(data.history.sessions?.length ?? 0) }),
              h(Stat, { label: t('stats.historyTurns'), value: String(data.history.turns ?? 0) })))
          : null,

        totals.requests === 0
          ? h('div', { style: { fontSize: 12, opacity: 0.6, padding: '6px 0' } }, t('stats.empty'))
          : h(React.Fragment, null,
            h('div', { style: S.row },
              h(Stat, { label: t('stats.total'), value: nf(totals.totalTokens) }),
              h(Stat, { label: t('stats.input'), value: nf(totals.inputTokens) }),
              h(Stat, { label: t('stats.output'), value: nf(totals.outputTokens) }),
              h(Stat, { label: t('stats.requests'), value: nf(totals.requests) }),
              data.estimatedCount > 0 ? h(Stat, { label: t('stats.estimated'), value: nf(data.estimatedCount) }) : null),

            byProvider.length > 0 ? h('div', { style: { marginTop: 14 } },
              h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, t('stats.byProvider')),
              h('table', { style: S.table },
                h('tbody', null, byProvider.slice(0, 8).map(p => h('tr', { key: p.provider },
                  h('td', { style: S.td }, p.provider),
                  h('td', { style: { ...S.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, nf(p.totalTokens)),
                  h('td', { style: { ...S.td, textAlign: 'right', opacity: 0.6 } }, `${nf(p.requests)} ${t('stats.requests')}`)))))) : null,

            byModel.length > 0 ? h('div', { style: { marginTop: 14 } },
              h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, t('stats.byModel')),
              h('table', { style: S.table },
                h('tbody', null, byModel.slice(0, 10).map(m => h('tr', { key: `${m.provider}::${m.model}` },
                  h('td', { style: { ...S.td, fontSize: 11.5 } }, m.model),
                  h('td', { style: { ...S.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, nf(m.totalTokens))))))) : null,

            byDay.length > 0 ? h('div', { style: { marginTop: 14 } },
              h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, t('stats.byDay')),
              h('table', { style: S.table },
                h('tbody', null, byDay.slice(-10).reverse().map(d => h('tr', { key: d.day },
                  h('td', { style: S.td }, d.day),
                  h('td', { style: { ...S.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, nf(d.totalTokens))))))) : null))
    }

    // ── 会话统计（模块一 · 三层下钻）────────────────────────────────────────
    function SessionsSection({ t }) {
      const { loading, data, error, reload } = useApi('/freebridge/sessions')
      const [open, setOpen] = useState(null)
      const [detail, setDetail] = useState({ loading: false, data: null })

      const openSession = useCallback(async id => {
        if (open === id) { setOpen(null); setDetail({ loading: false, data: null }); return }
        setOpen(id)
        setDetail({ loading: true, data: null })
        try {
          const d = await getJson(`/freebridge/session?id=${encodeURIComponent(id)}`)
          setDetail({ loading: false, data: d })
        } catch (err) {
          setDetail({ loading: false, data: null })
        }
      }, [open])

      if (loading) return h(Loading, { t })
      if (error !== null) return h(Failed, { t, error, onRetry: reload })

      const sessions = data?.sessions ?? []

      return h('div', { style: S.card },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 } },
          h('div', null,
            h('h2', { style: S.h2 }, t('sessions.title')),
            h('div', { style: S.hint }, t('sessions.hint'))),
          h('button', { style: S.btn, onClick: reload }, t('refresh'))),

        sessions.length === 0
          ? h('div', { style: { fontSize: 12, opacity: 0.6, padding: '6px 0' } }, t('sessions.empty'))
          : h('table', { style: S.table },
            h('tbody', null, sessions.slice(0, 30).map(s => {
              const isOpen = open === s.sessionId
              const rows = [
                h('tr', {
                  key: s.sessionId,
                  style: { cursor: 'pointer', background: isOpen ? 'var(--color-accent-bg, rgba(56,139,253,.1))' : undefined },
                  onClick: () => void openSession(s.sessionId),
                },
                h('td', { style: { ...S.td, fontFamily: 'monospace', fontSize: 11.5 } }, s.sessionId.slice(0, 14)),
                h('td', { style: { ...S.td, opacity: 0.65, fontSize: 11 } }, new Date(s.startAt).toLocaleString()),
                h('td', { style: { ...S.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, nf(s.logicalTokens)),
                h('td', { style: { ...S.td, textAlign: 'right', opacity: 0.6, fontSize: 11 } }, `${nf(s.attemptTokens)} ${t('stats.level.attempt')}`),
                ),
              ]

              if (isOpen && detail.loading) {
                rows.push(h('tr', { key: `${s.sessionId}-ld` }, h('td', { colSpan: 4, style: S.td }, t('loading'))))
              } else if (isOpen && detail.data !== null) {
                const d = detail.data
                const inner = []

                inner.push(h('tr', { key: `${s.sessionId}-sum` },
                  h('td', { colSpan: 4, style: { ...S.td, paddingTop: 10 } },
                    h('div', { style: S.row },
                      h('span', { style: S.pill('n') }, `${t('sessions.main')} ${nf(d.mainTotal)}`),
                      d.branchTotal > 0 ? h('span', { style: S.pill('n') }, `${t('sessions.branch')} ${nf(d.branchTotal)}`) : null,
                      d.editedTurns > 0 ? h('span', { style: S.pill('n') }, `${t('sessions.edited')} ×${d.editedTurns}`) : null,
                      d.retractedTurns > 0 ? h('span', { style: S.pill('n') }, `${t('sessions.retracted')} ×${d.retractedTurns}`) : null))))

                for (const p of d.providers ?? []) {
                  inner.push(h('tr', { key: `${s.sessionId}-p-${p.provider}` },
                    h('td', { style: { ...S.td, paddingLeft: 18, fontWeight: 600, fontSize: 12 } }, p.provider),
                    h('td', { style: { ...S.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, nf(p.totalTokens)),
                    h('td', { colSpan: 2, style: { ...S.td, opacity: 0.6, fontSize: 11 } }, `${nf(p.requests)} req`)))
                  for (const m of p.models ?? []) {
                    inner.push(h('tr', { key: `${s.sessionId}-m-${p.provider}-${m.model}` },
                      h('td', { style: { ...S.td, paddingLeft: 36, fontSize: 11.5, opacity: 0.85 } }, m.model),
                      h('td', { style: { ...S.td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: 11.5 } }, nf(m.totalTokens)),
                      h('td', { colSpan: 2, style: S.td })))
                  }
                }

                if ((d.segments ?? []).length > 0) {
                  inner.push(h('tr', { key: `${s.sessionId}-seg` },
                    h('td', { colSpan: 4, style: { ...S.td, paddingTop: 8, fontSize: 11, opacity: 0.6 } },
                      `${t('sessions.segments')}: ` + d.segments.map(x => `${x.upstream ?? '?'}/${x.model ?? '?'} ${nf(x.totalTokens)}`).join(' · '))))
                }

                rows.push(h('tr', { key: `${s.sessionId}-d` }, h('td', { colSpan: 4, style: { padding: 0 } },
                  h('table', { style: S.table }, h('tbody', null, inner)))))
              }

              return h(React.Fragment, { key: s.sessionId }, rows)
            }))))
    }

    // ── 分流（模块二）────────────────────────────────────────────────────────
    // ── 可用模型表 ──────────────────────────────────────────────────────────
    function ModelsSection({ t }) {
      const { loading, data, error, reload } = useApi('/freebridge/models')
      if (loading) return h(Loading, { t })
      if (error !== null) return h(Failed, { t, error, onRetry: reload })

      const verified = data?.verified ?? []
      const excluded = data?.excluded ?? []

      return h('div', { style: S.card },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 } },
          h('div', null,
            h('h2', { style: S.h2 }, t('models.title')),
            h('div', { style: S.hint }, t('models.hint'))),
          h('button', { style: S.btn, onClick: reload }, t('refresh'))),

        h('div', { style: { fontSize: 12, fontWeight: 600, margin: '4px 0 6px' } },
          `${t('models.verified')} (${verified.length})`),
        h('table', { style: S.table },
          h('tbody', null,
            verified.map(m => h('tr', { key: m.id },
              h('td', { style: S.td },
                h('span', { style: S.pill(m.tier === 'best' ? 'ok' : 'n') },
                  m.tier === 'best' ? t('models.best') : m.tier)),
              h('td', { style: { ...S.td, fontFamily: 'monospace', fontSize: 11.5 } }, m.id),
              h('td', { style: { ...S.td, fontSize: 11, opacity: 0.7 } }, m.note ?? '')))))

        , excluded.length > 0
          ? h('div', { style: { marginTop: 12 } },
            h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6, opacity: 0.7 } },
              `${t('models.excluded')} (${excluded.length})`),
            h('table', { style: S.table },
              h('tbody', null,
                excluded.map(m => h('tr', { key: m.id },
                  h('td', { style: { ...S.td, fontFamily: 'monospace', fontSize: 11, opacity: 0.6 } }, m.id),
                  h('td', { style: { ...S.td, fontSize: 11, opacity: 0.55 } }, m.reason))))))
          : null
      )
    }

    function RoutesSection({ t }) {
      const { loading, data, error, reload } = useApi('/freebridge/routes')
      if (loading) return h(Loading, { t })
      if (error !== null) return h(Failed, { t, error, onRetry: reload })

      const snap = data?.snapshot ?? { direct: 0, proxy: 0, total: 0, hosts: [] }
      const nodes = data?.nodes ?? []

      return h('div', { style: S.card },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 } },
          h('div', null,
            h('h2', { style: S.h2 }, t('routes.title')),
            h('div', { style: S.hint }, t('routes.hint'))),
          h('button', { style: S.btn, onClick: reload }, t('refresh'))),

        h('div', { style: S.row },
          h(Stat, { label: t('routes.direct'), value: nf(snap.direct) }),
          h(Stat, { label: t('routes.proxy'), value: nf(snap.proxy) }),
          h(Stat, { label: t('routes.nodes'), value: nf(nodes.length) })),

        (snap.hosts ?? []).length === 0
          ? h('div', { style: { fontSize: 12, opacity: 0.6, marginTop: 10 } }, t('routes.empty'))
          : h('table', { style: { ...S.table, marginTop: 10 } },
            h('tbody', null, snap.hosts.slice(0, 10).map(x => h('tr', { key: `${x.kind}::${x.host}` },
              h('td', { style: S.td }, x.host),
              h('td', { style: S.td },
                h('span', { style: S.pill(x.route === 'proxy' ? 'bad' : 'ok') },
                  x.route === 'proxy' ? t('routes.proxy') : t('routes.direct'))),
              h('td', { style: { ...S.td, opacity: 0.6, fontSize: 11 } }, x.kind))))))
    }

    // ── 守门（模块四）────────────────────────────────────────────────────────
    function GuardSection({ t }) {
      const { loading, data, error, reload } = useApi('/freebridge/guard')
      if (loading) return h(Loading, { t })
      if (error !== null) return h(Failed, { t, error, onRetry: reload })

      return h('div', { style: S.card },
        h('h2', { style: S.h2 }, t('guard.title')),
        h('div', { style: S.hint }, t('guard.hint')),
        h('div', { style: S.row },
          h('span', { style: S.pill(data.enabled ? 'ok' : 'bad') }, data.enabled ? t('guard.on') : t('guard.off')),
          h('span', { style: { fontSize: 11.5, opacity: 0.65 } },
            `${t('guard.rules')}: hard ${data.rules?.hard ?? 0} · suspicious ${data.rules?.suspicious ?? 0} · intent ${data.rules?.intent ?? 0}`)))
    }

    // ── 桌面编排（模块三）────────────────────────────────────────────────────
    function DesktopSection({ t }) {
      const { loading, data, error, reload } = useApi('/freebridge/desktop')
      if (loading) return h(Loading, { t })
      if (error !== null) return h(Failed, { t, error, onRetry: reload })

      const caps = data?.capabilities ?? []
      const apps = data?.apps ?? []

      return h('div', { style: S.card },
        h('h2', { style: S.h2 }, t('desktop.title')),
        caps.length === 0 && apps.length === 0
          ? h('div', { style: S.hint }, t('desktop.none'))
          : h(React.Fragment, null,
            caps.length > 0 ? h('div', { style: { fontSize: 12, marginBottom: 6 } },
              `${t('desktop.capabilities')}: `,
              caps.map(c => h('span', { key: c, style: { ...S.pill('ok'), marginRight: 4 } }, c))) : null,
            apps.length > 0 ? h('div', { style: { fontSize: 12 } },
              `${t('desktop.apps')}: `, apps.join(' · ')) : null))
    }

    // ── 主设置页 ──────────────────────────────────────────────────────────────
    function SettingsPage(props) {
      const t = props.t
      const [nonce, setNonce] = useState(0)
      const bump = useCallback(() => setNonce(n => n + 1), [])

      return h('div', { style: { padding: '4px 2px 24px' } },
        h('div', { style: { marginBottom: 16 } },
          h('div', { style: { fontSize: 18, fontWeight: 700, marginBottom: 4 } }, t('title')),
          h('div', { style: { fontSize: 12.5, opacity: 0.7, lineHeight: 1.6 } }, t('subtitle'))),
        h(HealthSection, { t, onAnyRestart: bump }),
        h(StatsSection, { t }),
        h(SessionsSection, { t }),
        h(ModelsSection, { t }),
        h(RoutesSection, { t }),
        h(GuardSection, { t }),
        h(DesktopSection, { t }))
    }

    // ── 引导卡片（模块五）───────────────────────────────────────────────────
    function OnboardingCard(props) {
      const t = props.t
      const [questions, setQuestions] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let alive = true
        getJson('/freebridge/onboarding')
          .then(d => { if (alive) setQuestions(d) })
          .catch(() => { if (alive) setQuestions({ questions: [], completed: true }) })
        return () => { alive = false }
      }, [])

      if (questions === null) return null
      if (questions.completed === true) return null

      const items = questions.questions ?? []

      return h('div', { style: S.card },
        h('h2', { style: S.h2 }, t('title')),
        h('div', { style: S.hint }, t('subtitle')),
        items.map(q => h('div', { key: q.id, style: { fontSize: 12.5, marginBottom: 8 } },
          h('div', { style: { fontWeight: 600 } }, q.question),
          q.hint ? h('div', { style: { opacity: 0.6, fontSize: 11.5 } }, q.hint) : null)),
        h('button', {
          style: S.btn,
          disabled: busy,
          onClick: async () => {
            setBusy(true)
            try {
              await fetch('/freebridge/onboarding/accept-defaults', { method: 'POST', credentials: 'same-origin' })
              setQuestions({ ...questions, completed: true })
            } finally { setBusy(false) }
          },
        }, busy ? '…' : '全部用默认值'))
    }

    // ── 插件入口 ──────────────────────────────────────────────────────────────
    function apply(ctx) {
      const t = translator(ctx)

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'freebridge',
        order: 40,
        label: () => t('nav'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, t })))

      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
        name: 'settings.onboarding',
        id: 'freebridge-onboarding',
        order: -20,
        locale: NS,
      }, props => h(OnboardingCard, { ...props, t })))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'freebridge'
    return module.exports
  },
})
