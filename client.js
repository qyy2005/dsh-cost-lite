/**
 * dsh-cost-lite — Client half.
 *
 * 三个座位，一个原则：数字在，别挡路。
 *
 *  1. `conversation.composer.dock` —— 输入框下面一行：
 *     `¥0.83 · 今日 ¥12.40 · 谷 2h13m`。点它开面板。
 *  2. `shell.overlay` —— 面板，一屏到底，不分局、不换页：
 *     本会话/今日/本月 三个数、缓存命中、预算条、峰谷、调用明细、余额卡。
 *  3. `settings.section` —— 「费用」页：价目表、预算、峰谷、余额站点。
 *
 * 不引入任何 Harness Client 包，全部本地标记 + 主题 token，保持免构建。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cost-lite',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const BASE = '/dsh-cost-lite'
    const SNAPSHOT = `${BASE}/api/snapshot`
    const TOTALS = `${BASE}/api/totals`
    const SETTINGS = `${BASE}/api/settings`
    const BALANCE = `${BASE}/api/balance`

    const TEXT = {
      pill: '费用明细',
      noSession: '未选择会话',
      loading: '···',
      panelTitle: '费用',
      close: '关闭',
      session: '本会话',
      today: '今日',
      month: '本月',
      input: '输入',
      output: '输出',
      cache: '缓存命中',
      budget: '预算',
      peak: '峰谷',
      peakAlert: '分钟后切换',
      rangeTitle: '区间消耗',
      rangeToday: '今天',
      range7: '近 7 天',
      range30: '近 30 天',
      rangeMonth: '本月',
      rangeCustom: '自定义',
      rangeBySource: '按来源',
      rangeByDay: '按天',
      detailEmpty: '还没有计费调用',
      detail: '调用明细',
      colTime: '时间',
      colModel: '模型',
      colIn: '输入',
      colCache: '缓存',
      colOut: '输出',
      colAmount: '金额',
      balance: '余额',
      refresh: '刷新',
      refreshing: '查询中…',
      official: 'DeepSeek 官方',
      signedOut: '未登录',
      noSite: '没配余额站点',
      failed: '查询失败',
      settingsHint: '含回收站里的已删除会话；价目表、预算和余额站点在 设置 → 费用 里改',
      priceNote: '参考价',
      assumed: '估价',
      settingsTitle: '费用',
      settingsHintLong: '金额按当前价目表现算，改完保存后历史数字一起变；已删除会话（回收站）的用量也计入。令牌只存在本机 DSH_HOME 下。',
      priceTable: '价目表（¥ / 100 万 token）',
      colMatch: '模型匹配',
      colInPrice: '输入',
      colOutPrice: '输出',
      colCrPrice: '缓存读',
      colCwPrice: '缓存写',
      colOffFactor: '谷价倍率',
      addPrice: '+ 加一行',
      resetPrices: '恢复默认价',
      remove: '删除',
      budgetTitle: '预算（0 = 不设）',
      budgetDaily: '今日上限',
      budgetMonthly: '本月上限',
      displayTitle: '显示',
      rowAmountLabel: '在会话列表行末显示该会话金额（默认关闭）',
      lockPriceLabel: '锁价：改价目表只影响之后的调用，历史金额不变',
      peakTitle: '峰谷',
      peakEnable: '启用峰谷计价',
      peakWindows: '峰时时段（北京时间，逗号分隔，如 09:00-12:00,14:00-18:00）',
      peakWeekdays: '只在工作日峰时（周末与法定节假日全按谷价）',
      peakAlert: '切换前提醒（分钟）',
      cacheInInput: '输入 token 里已包含缓存读（多数渠道分开上报，默认不勾）',
      sitesTitle: '余额站点',
      siteName: '名称',
      siteUrl: '地址',
      siteToken: '访问令牌',
      siteApiKey: '密钥',
      siteUser: '用户 ID',
      siteUnit: '配额单位',
      sitePath: '接口路径',
      siteRate: '换算倍率（美元站填 6.7，默认 1）',
      advLabel: '高级',
      methodLabel: '方法',
      headersLabel: '请求头（一行一个，如 X-Api-Key: xxx）',
      headersPlaceholder: 'X-Api-Key: your-key\nAccept: application/json',
      jsonPathLabel: 'JSONPath（点号路径，如 data.balance）',
      siteCurrency: '币种',
      addSite: '+ 加一个站点',
      test: '测试',
      testing: '测试中…',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '保存失败',
      tokenKept: '「测试」直接用当前草稿，不用先保存；已保存的令牌不会被空输入覆盖。',
      siteOk: '已识别',
      siteFail: '没查通',
    }

    const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' }
    const symbolOf = (code) => CURRENCY_SYMBOL[code] ?? `${code} `

    // ---- 面板开关：一个进程内的小 store，dock 和 overlay 共用 ----------------
    let open = false
    const listeners = new Set()
    const subscribeOpen = (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    const isOpen = () => open
    const setOpen = (value) => {
      open = value
      for (const listener of [...listeners]) listener()
    }

    // ---- 格式化 ---------------------------------------------------------------
    function money(amount, currency) {
      if (!Number.isFinite(amount)) return '—'
      const symbol = symbolOf(currency ?? 'CNY')
      const abs = Math.abs(amount)
      if (abs === 0) return `${symbol}0`
      if (abs < 1) return `${symbol}${amount.toFixed(4)}`
      if (abs < 100) return `${symbol}${amount.toFixed(2)}`
      return `${symbol}${amount.toFixed(abs < 10000 ? 1 : 0)}`
    }

    function tokens(count) {
      if (!Number.isFinite(count) || count <= 0) return '0'
      if (count >= 1e9) return `${(count / 1e9).toFixed(2)}B`
      if (count >= 1e6) return `${(count / 1e6).toFixed(2)}M`
      if (count >= 1e4) return `${(count / 1e3).toFixed(1)}K`
      return String(Math.round(count))
    }

    function clock(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const d = new Date(ms)
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    function countdown(minutes) {
      if (!Number.isFinite(minutes)) return ''
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return rest === 0 ? `${hours}h` : `${hours}h${rest}m`
    }

    /** 只取来源的短名字，用于分组标题。 */
    function humanModelName(provider, model) {
      const providerLabel = /official/i.test(provider)
        ? 'DeepSeek 官方'
        : /account/i.test(provider)
          ? 'DeepSeek 账号'
          : provider.replace(/^a6api-/, 'A6 ').replace(/^everygpt-/, 'EveryGPT ').replace(/^se-/, 'SEL ')
      return `${providerLabel} · ${String(model).replace(/^deepseek-/, '').replace(/-/g, ' ')}`
    }

    function ratioLabel(ratio) {
      if (ratio === null || ratio === undefined) return ''
      return `${Math.round(ratio * 100)}%`
    }

    /** 把 `provider/model/mode` 变成人话：DeepSeek 账号 · flash · 谷价 */
    function humanSource(id) {
      const parts = String(id).split('/')
      const provider = parts[0] ?? ''
      const model = parts[1] ?? ''
      const mode = parts[2] ?? ''
      const providerLabel = /official/i.test(provider)
        ? 'DeepSeek 官方'
        : /account/i.test(provider)
          ? 'DeepSeek 账号'
          : provider.replace(/^a6api-/, 'A6 ').replace(/^everygpt-/, 'EveryGPT ').replace(/^se-/, 'SEL ')
      const modelLabel = model.replace(/^deepseek-/, '').replace(/-/g, ' ')
      return `${providerLabel} · ${modelLabel} · ${mode === 'peak' ? '峰价' : '谷价'}`
    }

    /** 测试结果的一行结论：协议错误、http 状态、或者“没有返回”。 */
    function failureText(test) {
      const result = test?.result
      if (result) {
        const detail =
          Array.isArray(result.tried) && result.tried.length > 0
            ? result.tried.join('；')
            : result.message
        return `${result.hint ? `${result.hint}｜` : ''}${detail ?? '没有返回内容'}`
      }
      return test?.error || '没有返回结果（点一次「测试」）'
    }

    // ---- Host 调用 ------------------------------------------------------------
    async function getJson(path) {
      const response = await fetch(path, { cache: 'no-store' })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) {
        throw Object.assign(new Error(payload?.message ?? `HTTP ${response.status}`), {
          code: payload?.code,
        })
      }
      return payload
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) {
        throw Object.assign(new Error(payload?.message ?? `HTTP ${response.status}`), {
          code: payload?.code,
        })
      }
      return payload
    }

    // ---- 当前会话 id：dock 挂在哪，面板就跟着看哪 ---------------------------
    let currentSessionId = ''
    const sessionListeners = new Set()
    const subscribeSession = (listener) => {
      sessionListeners.add(listener)
      return () => sessionListeners.delete(listener)
    }
    const readSessionId = () => currentSessionId
    function rememberSession(sessionId) {
      const next = typeof sessionId === 'string' ? sessionId : ''
      if (next === currentSessionId) return
      currentSessionId = next
      for (const listener of [...sessionListeners]) listener()
    }

    /** 文档不可见时不轮询；可见时每 5 秒一次，且只拿 brief。 */
    function useSnapshot(sessionId, brief, enabled, withBalance) {
      const [state, setState] = useState({ phase: 'loading', data: null, error: null })
      const alive = useRef(true)

      const load = useCallback(async () => {
        if (enabled === false) return
        const params = new URLSearchParams()
        if (sessionId) params.set('sessionId', sessionId)
        if (brief) params.set('brief', '1')
        if (withBalance === true) params.set('balance', '1')
        try {
          const payload = await getJson(`${SNAPSHOT}?${params.toString()}`)
          if (alive.current) setState({ phase: 'ready', data: payload, error: null })
        } catch (error) {
          if (alive.current) setState((prev) => ({ phase: prev.data ? 'ready' : 'failed', data: prev.data, error: error.message }))
        }
      }, [sessionId, brief, enabled, withBalance])

      useEffect(() => {
        alive.current = true
        if (enabled === false) return () => { alive.current = false }
        void load()
        const timer = setInterval(() => {
          if (document.visibilityState === 'hidden') return
          void load()
        }, 5000)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') void load()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          alive.current = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [load, enabled])

      return { ...state, reload: load }
    }

    // ---- 输入框下面那一行 -----------------------------------------------------
    /**
     * `props.sessionId` 由 owner 传进来（conversation.composer.dock 的 standardProps）。
     * 没有会话时只显示今日，仍然有用。
     */
    function CostDock(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const { data } = useSnapshot(sessionId, true, true, true)

      useEffect(() => {
        rememberSession(sessionId)
      }, [sessionId])

      const sessionAmount = data?.session?.ok ? data.session.amount : null
      const todayAmount = data?.today?.amount ?? null
      const peak = data?.peak
      const official = data?.balance?.official
      const overBudget =
        (data?.budget?.dailyRatio !== null && data?.budget?.dailyRatio !== undefined && data.budget.dailyRatio >= 1) ||
        (data?.budget?.monthlyRatio !== null && data?.budget?.monthlyRatio !== undefined && data.budget.monthlyRatio >= 1)

      const parts = []
      if (sessionId !== '' && sessionAmount !== null) parts.push(money(sessionAmount, data?.currency))
      if (sessionId === '' && todayAmount !== null) parts.push(`${TEXT.today} ${money(todayAmount, data?.currency)}`)
      else if (todayAmount !== null) parts.push(`${TEXT.today} ${money(todayAmount, data?.currency)}`)
      // 余额直接摆在这一行上：不用点进设置才看得到。
      if (official?.ok && official.wallets?.length) {
        parts.push(`余 ${money(official.wallets[0].amount, official.wallets[0].currency)}`)
      }
      if (peak?.enabled) {
        parts.push(`${peak.label === '谷价' ? '谷' : '峰'} ${countdown(peak.next?.minutes ?? NaN)}`)
      }
      if (parts.length === 0) parts.push(TEXT.loading)

      return h(
        'div',
        { className: 'dcl-dock' },
        h(
          'button',
          {
            type: 'button',
            className: `dcl-pill${overBudget ? ' dcl-pillOver' : ''}`,
            title: TEXT.pill,
            onClick: () => setOpen(true),
          },
          h('span', { className: 'dcl-dot', 'aria-hidden': true }),
          h('span', { className: 'dcl-pillText', children: parts.join('  ·  ') }),
        ),
      )
    }

    // ---- 面板 -----------------------------------------------------------------
    function StatCell({ label, value, tone }) {
      return h(
        'div',
        { className: `dcl-stat${tone ? ` dcl-stat-${tone}` : ''}` },
        h('div', { className: 'dcl-statLabel', children: label }),
        h('div', { className: 'dcl-statValue', children: value }),
      )
    }

    function BudgetBar({ label, ratio, text }) {
      if (ratio === null || ratio === undefined) return null
      const width = Math.min(1, Math.max(0, ratio)) * 100
      const tone = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok'
      return h(
        'div',
        { className: 'dcl-budget' },
        h('div', { className: 'dcl-budgetHead' },
          h('span', { children: label }),
          h('span', { className: `dcl-budgetValue dcl-${tone}`, children: text }),
        ),
        h('div', { className: 'dcl-track' }, h('div', { className: `dcl-fill dcl-${tone}`, style: { width: `${width}%` } })),
      )
    }

    function BalanceCard({ title, amountText, note, tone }) {
      return h(
        'div',
        { className: 'dcl-card' },
        h('div', { className: 'dcl-cardTitle', children: title }),
        h('div', { className: `dcl-cardValue${tone ? ` dcl-${tone}` : ''}`, children: amountText }),
        note ? h('div', { className: 'dcl-cardNote', children: note }) : null,
      )
    }

    function CostPanel() {
      const visible = useSyncExternalStore(subscribeOpen, isOpen)
      const sessionId = useSyncExternalStore(subscribeSession, readSessionId)

      useEffect(() => {
        if (!visible) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [visible])

      const { data, error, reload } = useSnapshot(sessionId, false, visible)
      const [month, setMonth] = useState(null)
      const [rangeKey, setRangeKey] = useState('30')
      const [rangeData, setRangeData] = useState(null)
      const [customFrom, setCustomFrom] = useState(() => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10))
      const [customTo, setCustomTo] = useState(() => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10))
      const [balance, setBalance] = useState({ phase: 'idle', official: null, sites: [], error: null })

      useEffect(() => {
        if (!visible) return undefined
        let alive = true
        void (async () => {
          try {
            const payload = await getJson(`${TOTALS}?period=month`)
            if (alive) setMonth(payload)
          } catch {
            if (alive) setMonth(null)
          }
        })()
        return () => {
          alive = false
        }
      }, [visible])

      const loadBalance = useCallback(async (force) => {
        setBalance((prev) => ({ ...prev, phase: 'loading', error: null }))
        try {
          const payload = await postJson(BALANCE, { force: force === true })
          setBalance({ phase: 'ready', official: payload.official, sites: payload.sites ?? [], error: null })
        } catch (caught) {
          setBalance({ phase: 'failed', official: null, sites: [], error: caught.message })
        }
      }, [])

      useEffect(() => {
        if (!visible) return undefined
        let alive = true
        const dayOf = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10)
        const now = Date.now()
        let to = dayOf(now)
        let from = to
        if (rangeKey === 'custom') {
          from = customFrom
          to = customTo
        } else if (rangeKey === '7') from = dayOf(now - 6 * 86400000)
        else if (rangeKey === '30') from = dayOf(now - 29 * 86400000)
        else if (rangeKey === 'month') from = `${to.slice(0, 7)}-01`
        void (async () => {
          try {
            const payload = await getJson(`${BASE}/api/range?from=${from}&to=${to}`)
            if (alive) setRangeData(payload)
          } catch {
            if (alive) setRangeData(null)
          }
        })()
        return () => {
          alive = false
        }
      }, [visible, rangeKey, customFrom, customTo])

      useEffect(() => {
        if (!visible) return
        void loadBalance(false)
      }, [visible, loadBalance])

      const modelGroups = useMemo(() => {
        const map = new Map()
        for (const row of rangeData?.bySource ?? []) {
          const [provider, model, mode] = String(row.id).split('/')
          const key = `${provider}/${model}`
          const entry = map.get(key) ?? { key, provider, model, amount: 0, parts: [] }
          entry.amount += row.amount
          entry.parts.push({ mode, amount: row.amount })
          map.set(key, entry)
        }
        return [...map.values()].sort((a, b) => b.amount - a.amount)
      }, [rangeData])

      const rangeTotal = Math.max(0.000001, rangeData?.amount ?? 0)

      if (!visible) return null

      const currency = data?.currency ?? 'CNY'
      const session = data?.session?.ok ? data.session : null
      const calls = session?.calls ?? []
      const cacheRatio = session?.cacheRatio ?? 0
      const peak = data?.peak
      const budget = data?.budget

      return h(
        'div',
        { className: 'dcl-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': TEXT.panelTitle },
        h('div', { className: 'dcl-mask', onClick: () => setOpen(false) }),
        h(
          'div',
          { className: 'dcl-panel' },
          // head
          h(
            'div',
            { className: 'dcl-head' },
            h('h2', { className: 'dcl-title', children: TEXT.panelTitle }),
            h('button', { type: 'button', className: 'dcl-iconButton', title: TEXT.close, onClick: () => setOpen(false), children: '✕' }),
          ),
          // three numbers
          h(
            'div',
            { className: 'dcl-stats' },
            h(StatCell, { label: TEXT.session, value: session ? money(session.amount, currency) : '—' }),
            h(StatCell, { label: TEXT.today, value: money(data?.today?.amount ?? NaN, currency) }),
            h(StatCell, { label: TEXT.month, value: money(month?.amount ?? data?.month?.amount ?? NaN, currency) }),
          ),
          // one fact line
          h(
            'div',
            { className: 'dcl-facts' },
            session
              ? [
                  `${TEXT.input} ${tokens(session.totals.input)}`,
                  `${TEXT.output} ${tokens(session.totals.output)}`,
                  `${TEXT.cache} ${Math.round(cacheRatio * 100)}%`,
                  `${calls.length} 次调用`,
                ].join('  ·  ')
              : error ?? TEXT.detailEmpty,
          ),
          budget && (budget.daily > 0 || budget.monthly > 0)
            ? h(
                'div',
                { className: 'dcl-budgets' },
                budget.daily > 0
                  ? h(BudgetBar, {
                      label: `${TEXT.budget} · 今日`,
                      ratio: budget.dailyRatio,
                      text: `${money(data?.today?.amount ?? 0, currency)} / ${money(budget.daily, currency)} · ${ratioLabel(budget.dailyRatio)}`,
                    })
                  : null,
                budget.monthly > 0
                  ? h(BudgetBar, {
                      label: `${TEXT.budget} · 本月`,
                      ratio: budget.monthlyRatio,
                      text: `${money(data?.month?.amount ?? 0, currency)} / ${money(budget.monthly, currency)} · ${ratioLabel(budget.monthlyRatio)}`,
                    })
                  : null,
              )
            : null,
          // peak
          peak?.enabled
            ? h(
                'div',
                { className: 'dcl-peak' },
                h('span', { className: `dcl-peakDot${peak.off ? ' dcl-off' : ''}`, 'aria-hidden': true }),
                h('span', {
                  children: `${peak.label}中 · ${countdown(peak.next?.minutes ?? NaN)} 后${peak.off ? '转峰价' : '转谷价'}${
                    peak.next ? `（${clock(peak.next.at)}）` : ''
                  }`,
                }),
              )
            : null,
          // 区间消耗
          h(
            'div',
            { className: 'dcl-block' },
            h(
              'div',
              { className: 'dcl-blockHead' },
              h('span', { children: TEXT.rangeTitle }),
              h(
                'div',
                { className: 'dcl-tabs' },
                ...[
                  ['today', TEXT.rangeToday],
                  ['7', TEXT.range7],
                  ['30', TEXT.range30],
                  ['month', TEXT.rangeMonth],
                  ['custom', TEXT.rangeCustom],
                ].map(([key, label]) =>
                  h('button', {
                    key,
                    type: 'button',
                    className: `dcl-tab${rangeKey === key ? ' dcl-tabOn' : ''}`,
                    onClick: () => setRangeKey(key),
                    children: label,
                  }),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dcl-daterow', style: { display: rangeKey === 'custom' ? 'flex' : 'none' } },
              h('input', {
                type: 'date',
                className: 'dcl-input dcl-date',
                value: customFrom,
                onChange: (event) => setCustomFrom(event.target.value),
              }),
              h('span', { className: 'dcl-muted', children: '→' }),
              h('input', {
                type: 'date',
                className: 'dcl-input dcl-date',
                value: customTo,
                onChange: (event) => setCustomTo(event.target.value),
              }),
              h('button', {
                type: 'button',
                className: `dcl-tab${rangeKey === 'custom' ? ' dcl-tabOn' : ''}`,
                onClick: () => setRangeKey('custom'),
                children: TEXT.rangeCustom,
              }),
            ),
            rangeData === null
              ? h('p', { className: 'dcl-note', children: '···' })
              : h(                  React.Fragment,
                  null,
                  h('div', {
                    className: 'dcl-facts',
                    children: `${money(rangeData.amount, rangeData.currency)} · ${tokens(
                      rangeData.tokens.input + rangeData.tokens.cacheRead + rangeData.tokens.output,
                    )} tokens · ${rangeData.from} → ${rangeData.to}`,
                  }),
                  h(
                    'div',
                    { className: 'dcl-groups' },
                    ...modelGroups.map((group) => {
                      const share = Math.round((group.amount / rangeTotal) * 100)
                      return h(
                        'details',
                        { className: 'dcl-groupRow', key: group.key },
                        h(
                          'summary',
                          { className: 'dcl-groupSummary' },
                          h('span', { className: 'dcl-groupName', children: humanModelName(group.provider, group.model) }),
                          h('span', {
                            className: 'dcl-share',
                            children: h('i', { style: { width: `${Math.min(100, share)}%` } }),
                          }),
                          h('span', { className: 'dcl-shareText', children: `${share}%` }),
                          h('span', { className: 'dcl-num dcl-amount', children: money(group.amount, rangeData.currency) }),
                        ),
                        h(
                          'div',
                          { className: 'dcl-groupBody' },
                          ...group.parts.map((part) =>
                            h(
                              'div',
                              { className: 'dcl-miniRow', key: part.mode },
                              h('span', { className: 'dcl-muted', children: part.mode === 'peak' ? '峰价' : '谷价' }),
                              h('span', { className: 'dcl-num', children: money(part.amount, rangeData.currency) }),
                            ),
                          ),
                        ),
                      )
                    }),
                  ),
                ),
          ),
          // balance
          h(
            'div',
            { className: 'dcl-block' },
            h(
              'div',
              { className: 'dcl-blockHead' },
              h('span', { children: TEXT.balance }),
              h('button', {
                type: 'button',
                className: 'dcl-textButton',
                disabled: balance.phase === 'loading',
                onClick: () => void loadBalance(true),
                children: balance.phase === 'loading' ? TEXT.refreshing : TEXT.refresh,
              }),
            ),
            h(
              'div',
              { className: 'dcl-cards' },
              h(BalanceCard, {
                title: TEXT.official,
                amountText:
                  balance.official?.ok && balance.official.wallets?.length
                    ? balance.official.wallets.map((wallet) => money(wallet.amount, wallet.currency)).join(' + ')
                    : balance.phase === 'loading'
                    ? '···'
                    : TEXT.signedOut,
                note:
                  balance.official?.ok && balance.official.bonus?.length
                    ? `赠送 ${balance.official.bonus.map((wallet) => money(wallet.amount, wallet.currency)).join(' + ')}`
                    : balance.official?.message ?? null,
                tone: balance.official?.ok ? null : 'muted',
              }),
              balance.sites.length === 0
                ? h(BalanceCard, { title: TEXT.balance, amountText: TEXT.noSite, note: TEXT.settingsHint, tone: 'muted' })
                : balance.sites.map((site) =>
                    h(BalanceCard, {
                      key: site.id,
                      title: site.name || TEXT.balance,
                      amountText: site.ok
                        ? site.unlimited
                          ? '未限额'
                          : money(site.amount, site.currency)
                        : balance.phase === 'loading'
                          ? '···'
                          : TEXT.failed,
                      note: site.ok
                        ? `${site.protocol}${site.ratios ? ` · 倍率 ${site.ratios.modelRatio}×${site.ratios.completionRatio}（${site.ratios.model}）` : ''}`
                        : `${site.hint ? `${site.hint}｜` : ''}${(site.tried ?? [site.message]).join('；')}${site.ratios ? `｜自报倍率 ${site.ratios.modelRatio}×${site.ratios.completionRatio}（${site.ratios.model}）` : ''}`,
                      tone: site.ok ? null : 'muted',
                    }),
                  ),
            ),
          ),
          h('p', { className: 'dcl-foot', children: TEXT.settingsHint }),
        ),
      )
    }

    // ---- 侧边栏行末金额：默认关闭，开关在 设置 → 费用 ----
    const rowCache = new Map()
    let rowToggle = null
    let rowToggleAt = 0

    async function rowToggleOn() {
      if (rowToggle !== null && Date.now() - rowToggleAt < 60000) return rowToggle
      try {
        const payload = await getJson(SETTINGS)
        rowToggle = payload.settings?.rowAmount === true
      } catch {
        rowToggle = false
      }
      rowToggleAt = Date.now()
      return rowToggle
    }

    async function fetchRowAmount(sessionId) {
      const cached = rowCache.get(sessionId)
      if (cached && Date.now() - cached.at < 60000) return cached
      let row = { at: Date.now(), amount: null, currency: 'CNY' }
      try {
        const payload = await getJson(`${BASE}/api/session-total?sessionId=${encodeURIComponent(sessionId)}`)
        row = { at: Date.now(), amount: payload.amount, currency: payload.currency }
      } catch {
        /* 行末金额失败就安静地不显示 */
      }
      rowCache.set(sessionId, row)
      return row
    }

    /** 侧边栏会话行末的金额；关掉开关或索引里没有这个会话就什么都不渲染。 */
    function RowAmount(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const [state, setState] = useState({ on: null, amount: null, currency: 'CNY' })

      useEffect(() => {
        if (sessionId === '') return undefined
        let alive = true
        void (async () => {
          const on = await rowToggleOn()
          if (!on) {
            if (alive) setState({ on: false, amount: null, currency: 'CNY' })
            return
          }
          const row = await fetchRowAmount(sessionId)
          if (alive) setState({ on: true, amount: row.amount, currency: row.currency })
        })()
        return () => {
          alive = false
        }
      }, [sessionId])

      if (state.on !== true || state.amount === null) return null
      if (state.amount < 0.005) return null
      return h('span', { className: 'dcl-rowAmount', title: TEXT.session, children: money(state.amount, state.currency) })
    }


    // ---- 每回合费用：挂在消息操作栏前面 ----
    let turnCache = { sessionId: '', at: 0, turns: {} }

    async function fetchTurnCosts(sessionId) {
      if (turnCache.sessionId === sessionId && Date.now() - turnCache.at < 20000) return turnCache.turns
      try {
        const payload = await getJson(`${BASE}/api/turn-costs?sessionId=${encodeURIComponent(sessionId)}`)
        turnCache = { sessionId, at: Date.now(), turns: payload.turns ?? {} }
      } catch {
        turnCache = { sessionId, at: Date.now(), turns: {} }
      }
      return turnCache.turns
    }

    function turnNumberOf(raw) {
      if (raw === null || raw === undefined) return null
      if (typeof raw === 'number') return raw
      for (const key of ['turn', 'index', 'number', 'id']) {
        const value = raw[key]
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return null
    }

    /** 一个回合花了多少，紧挨着「用量 xx tok」那一行显示。 */
    function TurnCost(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : readSessionId()
      const turnNo = turnNumberOf(props?.turn)
      const [amount, setAmount] = useState(null)

      useEffect(() => {
        if (sessionId === '' || turnNo === null) return undefined
        let alive = true
        void (async () => {
          const turns = await fetchTurnCosts(sessionId)
          if (alive) setAmount(Number(turns[turnNo] ?? turns[String(turnNo)] ?? 0))
        })()
        return () => {
          alive = false
        }
      }, [sessionId, turnNo])

      if (amount === null || !Number.isFinite(amount) || amount < 0.0005) return null
      return h('span', { className: 'dcl-turnCost', title: '本回合费用', children: money(amount, 'CNY') })
    }

    // ---- 设置页 ---------------------------------------------------------------
    function Field({ label, children }) {
      return h('label', { className: 'dcl-field' }, h('span', { className: 'dcl-fieldLabel', children: label }), children)
    }

    function TextInput({ value, onChange, placeholder, mono, password }) {
      return h('input', {
        className: `dcl-input${mono ? ' dcl-mono' : ''}`,
        type: password ? 'password' : 'text',
        value: value ?? '',
        placeholder: placeholder ?? '',
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
      })
    }

    function CostSettings() {
      const [draft, setDraft] = useState(null)
      const [status, setStatus] = useState({ phase: 'loading', message: '' })
      const [tests, setTests] = useState({})

      useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const payload = await getJson(SETTINGS)
            if (alive) {
              setDraft(payload.settings)
              setStatus({ phase: 'ready', message: '' })
            }
          } catch (error) {
            if (alive) setStatus({ phase: 'failed', message: error.message })
          }
        })()
        return () => {
          alive = false
        }
      }, [])

      const patch = useCallback((mutate) => {
        setDraft((prev) => {
          if (prev === null) return prev
          const next = JSON.parse(JSON.stringify(prev))
          mutate(next)
          return next
        })
      }, [])

      const save = useCallback(async () => {
        if (draft === null) return
        setStatus({ phase: 'saving', message: TEXT.saving })
        try {
          const payload = await postJson(SETTINGS, { settings: draft })
          setDraft(payload.settings)
          setStatus({ phase: 'ready', message: TEXT.saved })
        } catch (error) {
          setStatus({ phase: 'failed', message: `${TEXT.saveFailed}：${error.message}` })
        }
      }, [draft])

      const testSite = useCallback(async (site) => {
        setTests((prev) => ({ ...prev, [site.id]: { phase: 'testing' } }))
        try {
          // 草稿一起发过去：没点保存也能测。
          const payload = await postJson(BALANCE, { id: site.id, site, force: true })
          const siteResult = (payload.sites ?? [])[0] ?? null
          setTests((prev) => ({ ...prev, [site.id]: { phase: 'done', result: siteResult } }))
        } catch (error) {
          setTests((prev) => ({ ...prev, [site.id]: { phase: 'done', error: error.message } }))
        }
      }, [])

      if (draft === null) {
        return h('div', { className: 'dcl-section' },
          h('h3', { className: 'dcl-sectionTitle', children: TEXT.settingsTitle }),
          h('p', { className: 'dcl-note', children: status.phase === 'failed' ? status.message : '正在读取…' }),
        )
      }

      const windowsText = (draft.peak?.windows ?? []).map((pair) => pair.join('-')).join(', ')

      return h(
        'div',
        { className: 'dcl-section' },
        h('div', { className: 'dcl-sectionHead' },
          h('h3', { className: 'dcl-sectionTitle', children: TEXT.settingsTitle }),
          h('button', { type: 'button', className: 'dcl-button', onClick: () => void save(), children: status.phase === 'saving' ? TEXT.saving : TEXT.save }),
        ),
        h('p', { className: 'dcl-note', children: TEXT.settingsHintLong }),

        // 峰谷与预算
        h('div', { className: 'dcl-group' },
          h('div', { className: 'dcl-groupTitle', children: TEXT.peakTitle }),
          h(Field, { label: TEXT.peakEnable },
            h('input', {
              type: 'checkbox',
              checked: draft.peak?.enabled !== false,
              onChange: (event) => patch((next) => {
                next.peak.enabled = event.target.checked
              }),
            }),
          ),
          h(Field, { label: TEXT.peakWindows },
            h(TextInput, {
              value: windowsText,
              mono: true,
              placeholder: '09:00-12:00,14:00-18:00',
              onChange: (value) => patch((next) => {
                next.peak.windows = value
                  .split(',')
                  .map((piece) => piece.trim())
                  .filter((piece) => piece.includes('-'))
                  .map((piece) => piece.split('-').map((side) => side.trim()))
                  .filter((pair) => pair.length === 2)
              }),
            }),
          ),
          h(Field, { label: TEXT.peakWeekdays },
            h('input', {
              type: 'checkbox',
              checked: draft.peak?.weekdaysOnly !== false,
              onChange: (event) => patch((next) => {
                next.peak.weekdaysOnly = event.target.checked
              }),
            }),
          ),
          h(Field, { label: TEXT.peakAlert },
            h(TextInput, {
              value: String(draft.peak?.alertMinutes ?? 10),
              onChange: (value) => patch((next) => {
                next.peak.alertMinutes = Number(value) || 0
              }),
            }),
          ),
          h(Field, { label: TEXT.cacheInInput },
            h('input', {
              type: 'checkbox',
              checked: draft.cacheInInput !== false,
              onChange: (event) => patch((next) => {
                next.cacheInInput = event.target.checked
              }),
            }),
          ),
        ),

        h('div', { className: 'dcl-group' },
          h('div', { className: 'dcl-groupTitle', children: TEXT.budgetTitle }),
          h('div', { className: 'dcl-inline' },
            h(Field, { label: TEXT.budgetDaily },
              h(TextInput, {
                value: String(draft.budget?.daily ?? 0),
                onChange: (value) => patch((next) => {
                  next.budget.daily = Number(value) || 0
                }),
              }),
            ),
            h(Field, { label: TEXT.budgetMonthly },
              h(TextInput, {
                value: String(draft.budget?.monthly ?? 0),
                onChange: (value) => patch((next) => {
                  next.budget.monthly = Number(value) || 0
                }),
              }),
            ),
          ),
        ),

        h('div', { className: 'dcl-group' },
          h('div', { className: 'dcl-groupTitle', children: TEXT.displayTitle }),
          h(Field, { label: TEXT.rowAmountLabel },
            h('input', {
              type: 'checkbox',
              checked: draft.rowAmount === true,
              onChange: (event) => patch((next) => {
                next.rowAmount = event.target.checked
              }),
            }),
          ),
        ),

        // 价目表
        h('div', { className: 'dcl-group' },
          h('div', { className: 'dcl-groupTitle', children: TEXT.priceTable }),
          h(Field, { label: TEXT.lockPriceLabel },
            h('input', {
              type: 'checkbox',
              checked: draft.lockPrice === true,
              onChange: (event) => patch((next) => {
                next.lockPrice = event.target.checked
              }),
            }),
          ),
          h('div', { className: 'dcl-priceTable' },
            h('div', { className: 'dcl-priceRow dcl-priceHead' },
              h('span', { children: TEXT.colMatch }),
              h('span', { children: TEXT.colInPrice }),
              h('span', { children: TEXT.colOutPrice }),
              h('span', { children: TEXT.colCrPrice }),
              h('span', { children: TEXT.colCwPrice }),
              h('span', { children: TEXT.colOffFactor }),
              h('span', { children: '' }),
            ),
            (draft.models ?? []).map((model, index) =>
              h('div', { className: 'dcl-priceRow', key: `${model.match}-${index}` },
                h(TextInput, {
                  value: model.match,
                  mono: true,
                  onChange: (value) => patch((next) => {
                    next.models[index].match = value
                  }),
                }),
                ...['input', 'output', 'cacheRead', 'cacheWrite', 'offFactor'].map((key) =>
                  h(TextInput, {
                    key,
                    value: String(model[key] ?? 0),
                    onChange: (value) => patch((next) => {
                      next.models[index][key] = Number(value) || 0
                    }),
                  }),
                ),
                h('button', {
                  type: 'button',
                  className: 'dcl-textButton dcl-danger',
                  onClick: () => patch((next) => {
                    next.models.splice(index, 1)
                  }),
                  children: TEXT.remove,
                }),
              ),
            ),
          ),
          h('div', { className: 'dcl-inline' },
            h('button', {
              type: 'button',
              className: 'dcl-textButton',
              onClick: () => patch((next) => {
                next.models.push({ match: '*', label: '新模型', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, offFactor: 1, assumed: true })
              }),
              children: TEXT.addPrice,
            }),
          ),
        ),

        // 余额站点
        h('div', { className: 'dcl-group' },
          h('div', { className: 'dcl-groupTitle', children: TEXT.sitesTitle }),
          (draft.sites ?? []).map((site, index) =>
            h('div', { className: 'dcl-site', key: site.id },
              h('div', { className: 'dcl-inline' },
                h(Field, { label: TEXT.siteName },
                  h(TextInput, {
                    value: site.name,
                    onChange: (value) => patch((next) => {
                      next.sites[index].name = value
                    }),
                  }),
                ),
                h(Field, { label: TEXT.siteCurrency },
                  h(TextInput, {
                    value: site.currency,
                    onChange: (value) => patch((next) => {
                      next.sites[index].currency = value
                    }),
                  }),
                ),
              ),
              h(Field, { label: TEXT.siteUrl },
                h(TextInput, {
                  value: site.baseUrl,
                  mono: true,
                  placeholder: 'https://api.example.com',
                  onChange: (value) => patch((next) => {
                    next.sites[index].baseUrl = value
                  }),
                }),
              ),
              h('div', { className: 'dcl-inline' },
                h(Field, { label: TEXT.siteApiKey },
                  h(TextInput, {
                    value: site.apiKey ?? '',
                    mono: true,
                    password: true,
                    placeholder: 'sk-…',
                    onChange: (value) => patch((next) => {
                      next.sites[index].apiKey = value
                    }),
                  }),
                ),
              ),
              h(Field, { label: TEXT.siteUnit },
                h(TextInput, {
                  value: String(site.unit ?? 500000),
                  onChange: (value) => patch((next) => {
                    next.sites[index].unit = Number(value) || 0
                  }),
                }),
              ),
              h(Field, { label: TEXT.sitePath },
                h(TextInput, {
                  value: site.path ?? '',
                  mono: true,
                  placeholder: '/v1/usage',
                  onChange: (value) => patch((next) => {
                    next.sites[index].path = value.trim()
                  }),
                }),
              ),
              h('details', { className: 'dcl-adv' },
                h('summary', { className: 'dcl-advSummary', children: TEXT.advLabel }),
                h('div', { className: 'dcl-inline' },
                  h(Field, { label: TEXT.siteToken },
                    h(TextInput, {
                      value: site.token,
                      mono: true,
                      password: true,
                      placeholder: '访问令牌',
                      onChange: (value) => patch((next) => {
                        next.sites[index].token = value
                      }),
                    }),
                  ),
                  h(Field, { label: TEXT.siteUser },
                    h(TextInput, {
                      value: site.userId,
                      mono: true,
                      placeholder: '数字',
                      onChange: (value) => patch((next) => {
                        next.sites[index].userId = value
                      }),
                    }),
                  ),
                ),
                h(Field, { label: TEXT.siteRate },
                  h(TextInput, {
                    value: String(site.rate ?? 1),
                    mono: true,
                    placeholder: '1',
                    onChange: (value) => patch((next) => {
                      next.sites[index].rate = Number(value) || 1
                    }),
                  }),
                ),
                h('div', { className: 'dcl-inline' },
                  h(Field, { label: TEXT.methodLabel },
                    h('select', {
                      className: 'dcl-input dcl-select',
                      value: site.method ?? 'GET',
                      onChange: (event) => patch((next) => {
                        next.sites[index].method = event.target.value
                      }),
                    },
                      h('option', { value: 'GET', children: 'GET' }),
                      h('option', { value: 'POST', children: 'POST' }),
                    ),
                  ),
                  h(Field, { label: TEXT.jsonPathLabel },
                    h(TextInput, {
                      value: site.jsonPath ?? '',
                      mono: true,
                      placeholder: 'data.balance',
                      onChange: (value) => patch((next) => {
                        next.sites[index].jsonPath = value.trim()
                      }),
                    }),
                  ),
                ),
                h(Field, { label: TEXT.headersLabel },
                  h('textarea', {
                    className: 'dcl-input dcl-textarea',
                    value: site.headers ?? '',
                    placeholder: TEXT.headersPlaceholder,
                    spellCheck: false,
                    onChange: (event) => patch((next) => {
                      next.sites[index].headers = event.target.value
                    }),
                  }),
                ),
              ),
              h('div', { className: 'dcl-inline' },
                h('button', {
                  type: 'button',
                  className: 'dcl-button',
                  disabled: tests[site.id]?.phase === 'testing',
                  onClick: () => void testSite(site),
                  children: tests[site.id]?.phase === 'testing' ? TEXT.testing : TEXT.test,
                }),
                h('button', {
                  type: 'button',
                  className: 'dcl-textButton dcl-danger',
                  onClick: () => patch((next) => {
                    next.sites.splice(index, 1)
                  }),
                  children: TEXT.remove,
                }),
                h('span', { className: 'dcl-note', children: '只填密钥即可，其余全部留空' }),
                tests[site.id]?.phase === 'done'
                  ? h('span', {
                      className: `dcl-testResult ${tests[site.id].result?.ok ? 'dcl-ok' : 'dcl-bad'}`,
                      children: tests[site.id].result?.ok
                        ? `${TEXT.siteOk} ${tests[site.id].result.protocol} · ${
                            tests[site.id].result.unlimited
                              ? '未限额（查不到真实余额）'
                              : money(tests[site.id].result.amount, site.currency)
                          }`
                        : `${TEXT.siteFail}：${failureText(tests[site.id])}`,
                    })
                  : null,
              ),
            ),
          ),
          h('div', { className: 'dcl-inline' },
            h('button', {
              type: 'button',
              className: 'dcl-textButton',
              onClick: () => patch((next) => {
                next.sites.push({
                  id: `site-${Date.now()}`,
                  name: '中转站',
                  baseUrl: '',
                  token: '',
                  userId: '',
                  unit: 500000,
                  currency: 'CNY',
                  path: '',
                  enabled: true,
                })
              }),
              children: TEXT.addSite,
            }),
          ),
          h('p', { className: 'dcl-note', children: TEXT.tokenKept }),
        ),

        status.message === '' ? null : h('p', { className: `dcl-note${status.phase === 'failed' ? ' dcl-bad' : ''}`, children: status.message }),
        // 底部再放一个保存：改完站点不用回到顶部找。
        h('div', { className: 'dcl-inline' },
          h('button', { type: 'button', className: 'dcl-button', onClick: () => void save(), children: status.phase === 'saving' ? TEXT.saving : TEXT.save }),
        ),
      )
    }

    // ---- 样式 ---------------------------------------------------------------
    const CSS = `
.dcl-dock{display:flex;align-items:center;justify-content:flex-start;padding:2px 2px 0}
.dcl-pill{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:2px 8px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b909a);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcl-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#a8adb7)}
.dcl-pillOver{color:var(--dsw-alias-state-warning-primary,#d9a441)}
.dcl-dot{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.65;flex:none}
.dcl-pillText{overflow:hidden;text-overflow:ellipsis}
.dcl-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px}
.dcl-mask{position:absolute;inset:0;background:rgba(0,0,0,.45)}
.dcl-panel{position:relative;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;width:min(600px,100%);max-height:min(86vh,760px);overflow:auto;padding:18px 20px 16px;border-radius:var(--dsw-radius-panel,14px);background:var(--dsw-alias-bg-layer-2,#1b1d21);color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.34))}
.dcl-head{display:flex;align-items:center;gap:10px}
.dcl-title{margin:0;flex:1;font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dcl-iconButton{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#a8adb7);cursor:pointer;font:inherit;font-size:15px;line-height:1}
.dcl-iconButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dcl-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.dcl-stat{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#f7f8fa);border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.dcl-statLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b909a)}
.dcl-statValue{font-size:19px;line-height:26px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dcl-facts{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#a8adb7);font-variant-numeric:tabular-nums}
.dcl-budgets{display:flex;flex-direction:column;gap:6px}
.dcl-budget{display:flex;flex-direction:column;gap:4px}
.dcl-budgetHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#a8adb7)}
.dcl-budgetValue{font-variant-numeric:tabular-nums}
.dcl-track{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16));overflow:hidden}
.dcl-fill{height:100%;border-radius:999px;transition:width .2s ease}
.dcl-ok{background:var(--dsw-alias-state-success-primary,#3fb950);color:var(--dsw-alias-state-success-primary,#3fb950)}
.dcl-warn{background:var(--dsw-alias-state-warning-primary,#d9a441);color:var(--dsw-alias-state-warning-primary,#d9a441)}
.dcl-over{background:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}
.dcl-peak{display:flex;align-items:center;gap:7px;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f7f8fa);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#a8adb7)}
.dcl-peakDot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warning-primary,#d9a441);flex:none}
.dcl-peakDot.dcl-off{background:var(--dsw-alias-state-success-primary,#3fb950)}
.dcl-block{display:flex;flex-direction:column;gap:7px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.dcl-blockHead{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dcl-table{display:flex;flex-direction:column;max-height:230px;overflow:auto;font-variant-numeric:tabular-nums}
.dcl-row{display:grid;grid-template-columns:44px minmax(0,1fr) 58px 54px 54px 74px;align-items:center;gap:6px;padding:3px 2px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-secondary,#a8adb7)}
.dcl-rowHead{position:sticky;top:0;background:var(--dsw-alias-bg-layer-2,#1b1d21);font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8b909a);border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.dcl-row:nth-child(even){background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.04))}
.dcl-num{text-align:right;white-space:nowrap}
.dcl-muted{color:var(--dsw-alias-label-tertiary,#8b909a)}
.dcl-amount{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dcl-model{display:flex;align-items:center;gap:4px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dcl-tag{flex:none;padding:0 4px;border-radius:4px;font-style:normal;font-size:10px;line-height:15px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16));color:var(--dsw-alias-label-tertiary,#8b909a)}
.dcl-tagOff{background:var(--dsw-alias-state-success-bg,rgba(63,185,80,.14));color:var(--dsw-alias-state-success-primary,#3fb950)}
.dcl-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.dcl-card{display:flex;flex-direction:column;gap:1px;min-width:0;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#f7f8fa);border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.dcl-cardTitle{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b909a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcl-cardValue{font-size:15px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dcl-cardNote{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,#8b909a);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dcl-foot{margin:2px 0 0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8b909a)}
.dcl-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#a8adb7)}
.dcl-bad{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dcl-textButton{padding:2px 6px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#a8adb7);font:inherit;font-size:11.5px;line-height:17px;cursor:pointer}
.dcl-textButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#e6e6e6)}
.dcl-textButton:disabled{cursor:not-allowed;opacity:.5}
.dcl-danger{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dcl-section{display:flex;flex-direction:column;gap:12px;max-width:720px}
.dcl-sectionHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dcl-sectionTitle{margin:0;font-size:16px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dcl-group{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));background:var(--dsw-alias-bg-layer-1,#f7f8fa)}
.dcl-groupTitle{font-size:12.5px;line-height:19px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dcl-field{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.dcl-fieldLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b909a)}
.dcl-input{box-sizing:border-box;width:100%;height:30px;padding:0 8px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32));background:var(--dsw-alias-bg-layer-2,#1b1d21);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12.5px;line-height:18px}
.dcl-input:focus{outline:none;border-color:var(--dsw-alias-state-info-primary,#4c8dff)}
.dcl-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dcl-inline{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
.dcl-priceTable{display:flex;flex-direction:column;gap:4px}
.dcl-priceRow{display:grid;grid-template-columns:minmax(0,1.4fr) repeat(5,minmax(0,.7fr)) 40px;align-items:center;gap:4px}
.dcl-priceHead{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,#8b909a)}
.dcl-priceRow .dcl-input{height:26px;font-size:11.5px}
.dcl-adv{display:flex;flex-direction:column;gap:6px;padding-top:4px}
.dcl-advSummary{cursor:pointer;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8b909a);list-style:none}
.dcl-advSummary::-webkit-details-marker{display:none}
.dcl-advSummary::before{content:"▸ ";color:currentColor}
.dcl-adv[open] .dcl-advSummary::before{content:"▾ "}
.dcl-select{height:30px;padding:0 6px}
.dcl-textarea{height:56px;min-height:56px;padding:6px 8px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px}
.dcl-site{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));background:var(--dsw-alias-bg-layer-2,#1b1d21)}
.dcl-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:30px;padding:0 12px;border-radius:7px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.32));background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12.5px;line-height:18px;cursor:pointer}
.dcl-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dcl-button:disabled{cursor:not-allowed;opacity:.5}
.dcl-testResult{font-size:11.5px;line-height:17px;word-break:break-word;color:var(--dsw-alias-label-secondary,#a8adb7)}
.dcl-rowAmount{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b909a);font-variant-numeric:tabular-nums;white-space:nowrap}
.dcl-tabs{display:flex;align-items:center;gap:4px}
.dcl-tab{padding:1px 7px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b909a);font:inherit;font-size:11px;line-height:17px;cursor:pointer}
.dcl-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dcl-tabOn{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,#e6e6e6)}
.dcl-split{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.dcl-splitCol{display:flex;flex-direction:column;gap:1px;min-width:0}
.dcl-subTitle{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-tertiary,#8b909a);margin-bottom:2px}
.dcl-miniRow{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#a8adb7);font-variant-numeric:tabular-nums}
.dcl-miniName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcl-daterow{display:flex;align-items:center;gap:6px;margin-top:2px}
.dcl-date{height:28px;width:142px;font-size:11.5px;padding:0 8px}
.dcl-panel{overflow:auto;overscroll-behavior:contain}
.dcl-groups{display:flex;flex-direction:column;gap:2px}
.dcl-groupRow{border-radius:12px}
.dcl-groupRow[open]{background:rgba(127,127,127,.05)}
.dcl-groupSummary{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:12px;cursor:pointer;list-style:none}
.dcl-groupSummary::-webkit-details-marker{display:none}
.dcl-groupName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:#12141A}
.dcl-share{width:74px;height:5px;border-radius:999px;background:#E4E8F0;overflow:hidden;flex:none}
.dcl-share i{display:block;height:100%;background:#3B82F6;border-radius:999px}
.dcl-shareText{width:40px;text-align:right;font-size:11px;color:#8A8F98;flex:none}
.dcl-groupBody{padding:0 10px 8px 10px}
.dcl-details>summary{cursor:pointer;list-style:none}
.dcl-details>summary::-webkit-details-marker{display:none}
.dcl-details[open]>*{margin-top:6px}
.dcl-spark{display:flex;align-items:flex-end;gap:3px;height:38px;padding:2px 0}
.dcl-sparkBar{flex:1;min-width:3px;border:none;padding:0;border-radius:3px 3px 2px 2px;background:#3B82F6;opacity:.9;cursor:pointer;transition:opacity .12s}
.dcl-sparkBar:hover{opacity:1;background:#1D4ED8}
.dcl-sparkFoot{margin-top:4px;font-size:11px;color:#8A8F98}
.dcl-turnCost{font-size:11.5px;line-height:17px;color:#8A8F98;font-variant-numeric:tabular-nums;margin-right:10px;white-space:nowrap}

/* ---- 2026-11 视觉重做：深色、大数字、无边框卡片、细分割线 ---- */
.dcl-panel{width:min(560px,100%);border-radius:18px;padding:20px 22px 18px;gap:12px;background:var(--dsw-alias-bg-layer-2,#14161a);box-shadow:0 24px 60px rgba(0,0,0,.45)}
.dcl-title{font-size:13px;line-height:20px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8b909a)}
.dcl-stats{gap:10px}
.dcl-stat{border:none;border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1,#1a1d22)}
.dcl-statLabel{font-size:10px;line-height:14px;letter-spacing:.08em;text-transform:uppercase}
.dcl-statValue{font-size:25px;line-height:33px;font-weight:650;letter-spacing:-.02em}
.dcl-facts{font-size:11.5px;line-height:18px;letter-spacing:.01em}
.dcl-block{border-top:1px solid rgba(127,127,127,.13);padding-top:11px;gap:8px}
.dcl-blockHead{font-size:11px;line-height:17px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8b909a)}
.dcl-card{border:none;border-radius:11px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1,#1a1d22)}
.dcl-cardValue{font-size:17px;line-height:24px;font-weight:600;letter-spacing:-.01em}
.dcl-peak{border-radius:10px;background:var(--dsw-alias-bg-layer-1,#1a1d22);padding:9px 12px}
.dcl-row{padding:4px 2px}
.dcl-rowHead{background:transparent;border-bottom:1px solid rgba(127,127,127,.13)}
.dcl-tab{border-radius:7px;padding:2px 8px}
.dcl-tabOn{background:rgba(127,127,127,.18)}
.dcl-pill{font-size:11.5px;letter-spacing:.01em;font-variant-numeric:tabular-nums}

/* ---- Agibankz 风格：浅底 + 白卡 + 大数字 + 青柠强调 ---- */
.dcl-overlay{background:transparent}
.dcl-mask{background:rgba(17,19,23,.32);backdrop-filter:blur(2px)}
.dcl-panel{width:min(620px,100%);border-radius:26px;padding:22px 24px 20px;gap:14px;background:#F4F5F2;color:#12141A;box-shadow:0 30px 80px rgba(0,0,0,.28)}
.dcl-title{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em;text-transform:none;color:#12141A}
.dcl-iconButton{width:34px;height:34px;border-radius:999px;background:#fff;color:#12141A;font-size:14px}
.dcl-iconButton:hover{background:#EDEFEA}
.dcl-stats{gap:12px}
.dcl-stat{border:none;border-radius:20px;padding:16px 18px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.dcl-statLabel{font-size:12px;line-height:16px;letter-spacing:0;text-transform:none;color:#6B7280}
.dcl-statValue{font-size:30px;line-height:38px;font-weight:600;letter-spacing:-.02em;color:#12141A}
.dcl-facts{font-size:12px;line-height:18px;color:#6B7280}
.dcl-block{border-top:none;padding-top:6px;gap:10px}
.dcl-blockHead{font-size:15px;line-height:22px;font-weight:600;letter-spacing:0;text-transform:none;color:#12141A}
.dcl-card{border:none;border-radius:18px;padding:14px 16px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.dcl-cardTitle{font-size:12px;line-height:16px;color:#6B7280}
.dcl-cardValue{font-size:20px;line-height:28px;font-weight:600;letter-spacing:-.01em;color:#12141A}
.dcl-cardNote{font-size:11px;line-height:15px;color:#8A8F98}
.dcl-peak{border-radius:18px;padding:12px 16px;background:#fff;color:#374151;font-size:12.5px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.dcl-peakDot{background:#E0A33E}
.dcl-peakDot.dcl-off{background:#9BD65B}
.dcl-tabs{gap:6px}
.dcl-tab{padding:5px 12px;border-radius:999px;font-size:12px;line-height:18px;color:#4B5563;background:transparent}
.dcl-tab:hover{background:#E9EBE5}
.dcl-tabOn{background:#C9F26B;color:#12141A;font-weight:600}
.dcl-budgetHead{color:#6B7280}
.dcl-track{height:6px;background:#E7E8E5}
.dcl-fill.dcl-ok{background:#9BD65B}
.dcl-ok{color:#4E8B12;background:transparent}
.dcl-warn{color:#B45309;background:transparent}
.dcl-over{color:#D92D20;background:transparent}
.dcl-fill.dcl-warn{background:#E0A33E}
.dcl-fill.dcl-over{background:#E5484D}
.dcl-table{color:#4B5563}
.dcl-row{padding:6px 2px;font-size:12px;color:#4B5563}
.dcl-rowHead{background:transparent;border-bottom:1px solid #E7E8E5;color:#8A8F98;font-size:11px}
.dcl-row:nth-child(even){background:transparent}
.dcl-num,.dcl-amount{color:#12141A}
.dcl-muted{color:#8A8F98}
.dcl-tag{background:#EDEFEA;color:#6B7280;border-radius:6px}
.dcl-tagOff{background:#E9F6D2;color:#4E8B12}
.dcl-splitCol{gap:2px}
.dcl-subTitle{font-size:11px;color:#8A8F98}
.dcl-miniRow{font-size:12px;line-height:19px;color:#6B7280}
.dcl-miniName{color:#374151}
.dcl-note{font-size:12px;color:#6B7280}
.dcl-foot{font-size:11px;color:#8A8F98}
.dcl-textButton{color:#4B5563;border-radius:999px;padding:4px 10px}
.dcl-textButton:hover{background:#E9EBE5}
.dcl-pill{font-size:11.5px;padding:3px 10px;border-radius:999px;background:#fff;color:#4B5563;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.dcl-pill:hover{background:#fff;color:#12141A}
.dcl-pillOver{background:#FFF4E5;color:#B45309}
.dcl-dot{background:#9BD65B;opacity:1}
.dcl-button{height:32px;border-radius:999px;border:1px solid #E7E8E5;background:#fff;color:#12141A;font-size:12.5px}
.dcl-button:hover:not(:disabled){background:#EDEFEA}
.dcl-input{border:1px solid #E7E8E5;background:#fff;color:#12141A;border-radius:10px}
.dcl-group{background:#fff;border:none;border-radius:18px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.dcl-sectionTitle{color:#12141A}
.dcl-fieldLabel{color:#8A8F98}
.dcl-site{background:#fff;border:none;border-radius:16px}
.dcl-advSummary{color:#8A8F98}

/* ---- 蓝白配色：替换青柠，其余沿用 Agibankz 结构 ---- */
.dcl-panel{background:#F3F5F9}
.dcl-tabOn{background:#E4ECFB;color:#1D4ED8;font-weight:600}
.dcl-tab:hover{background:#E9EDF4}
.dcl-fill.dcl-ok{background:#3B82F6}
.dcl-peakDot.dcl-off{background:#3B82F6}
.dcl-peakDot{background:#F0B24A}
.dcl-dot{background:#3B82F6}
.dcl-tagOff{background:#E4ECFB;color:#1D4ED8}
.dcl-ok{color:#1D4ED8}
.dcl-pill{background:#fff;color:#4B5563}
.dcl-pillOver{background:#FFF4E5;color:#B45309}
.dcl-track{background:#E4E8F0}
.dcl-statValue,.dcl-cardValue{color:#0F172A}
.dcl-title,.dcl-blockHead{color:#0F172A}
.dcl-iconButton{background:#fff;color:#0F172A}
.dcl-iconButton:hover{background:#E9EDF4}
.dcl-input:focus{border-color:#3B82F6}
.dcl-button{border-color:#DCE3EE}
.dcl-rowHead{border-bottom-color:#E4E8F0}
.dcl-row:nth-child(even){background:transparent}
`

    /** 样式随组件一起挂载，卸载即消失。 */
    function Styles() {
      return h('style', { 'data-dsh-plugin': 'dsh-cost-lite', children: CSS })
    }

    function WithStyles(Component) {
      function StyledComponent(props) {
        return h(React.Fragment, null, h(Styles, { key: 'style' }), h(Component, { ...props, key: 'body' }))
      }
      StyledComponent.displayName = `DshCostLite(${Component.name})`
      return StyledComponent
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 输入框下面那一行：始终在视野里，但只占一行。
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'cost-lite', order: 5, label: () => TEXT.pill, inject: () => ({}) },
            WithStyles(CostDock),
          ),
        )
        // 面板：frame 级浮层，切会话不会把它关在某个面板里。
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-cost-lite-panel', order: 70 }, WithStyles(CostPanel)),
        )
        // 设置 → 费用：价目表、预算、峰谷、余额站点。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'cost-lite', order: 30, label: () => TEXT.settingsTitle, inject: () => ({}) },
            WithStyles(CostSettings),
          ),
        )
        // 每回合费用：挂在消息操作栏前。
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            { name: 'conversation.chat.turnTail', id: 'cost-lite-turn', order: 30 },
            WithStyles(TurnCost),
          ),
        )
        // 会话列表行末金额（默认关闭，开关在设置里）。
        ctx.slots.inject('sidebar.session.row.trailing', () =>
          ctx.slots.register(
            { name: 'sidebar.session.row.trailing', id: 'cost-lite-row', order: 20 },
            WithStyles(RowAmount),
          ),
        )
      },
    }
  },
})
