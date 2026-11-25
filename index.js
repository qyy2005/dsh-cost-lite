/**
 * dsh-cost-lite — Host half.
 *
 * 一句话：把「这次会话花了多少钱」做成一个数字，别的都不要。
 *
 * 数据来源（全部是 Harness 已有的，不另建账本）：
 *  - 会话日志里的 `assistant/message` 事件带 `usage: TokenUsage`
 *    （inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens）。
 *  - 活会话走 `ctx.sessions`，冷会话走 `ctx.sessionQuery.readSession`，都不改写任何日志。
 *  - 官方余额走 `ctx.deepseekAccount.getBalance`；中转站余额走用户配置的 HTTP 端点。
 *
 * 唯一的本地文件是「派生索引」：按会话、按天记 token 数量（不是金额），
 * 金额永远按当前价目表现算，所以改价之后历史数字立刻跟着对。
 * 索引删掉可重建，损坏没有修复工具的必要——这是刻意的。
 *
 * /dsh-cost-lite/api/snapshot  本会话 + 今日 + 峰谷 + 预算
 * /dsh-cost-lite/api/totals    指定区间（今日 / 本月）
 * /dsh-cost-lite/api/settings  GET / POST 价目表、预算、峰谷、余额站点
 * /dsh-cost-lite/api/balance   POST 查一个或全部中转站余额
 */

import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import zlib from 'node:zlib'

export const inject = ['webServer']

const BASE = '/dsh-cost-lite'
const ROUTES = {
  snapshot: `${BASE}/api/snapshot`,
  totals: `${BASE}/api/totals`,
  settings: `${BASE}/api/settings`,
  balance: `${BASE}/api/balance`,
  sessionTotal: `${BASE}/api/session-total`,
  syncPrices: `${BASE}/api/prices/sync`,
  range: `${BASE}/api/range`,
  turnCosts: `${BASE}/api/turn-costs`,
}

/** 官方中文价格页：表格里直接是人民币，不用汇率换算。 */
const PRICE_PAGE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'
const PRICE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
const PRICE_SYNC_INTERVAL = 6 * 3600 * 1000

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

const MAX_BODY_BYTES = 64 * 1024
const INDEX_VERSION = 4

/** 回收站里的会话日志是「每条追加一个 zstd frame」拼起来的，按 magic 逐帧解。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** 北京没有夏令时：固定 UTC+8，比 Intl 每帧调用便宜得多。 */
const BEIJING_OFFSET_MINUTES = 8 * 60

/**
 * 内置价目（元 / 100 万 token），一律按**峰时价**填，谷时用 offFactor 折。
 *
 * 2026-09-10 起的官方口径（多来源一致）：
 *   deepseek-flash  命中 0.04 / 未命中 2 / 输出 8（谷时各减半 → 0.02 / 1 / 4）
 *   deepseek-v4-pro 命中 0.30 / 未命中 9 / 输出 27（谷时各减半）
 * 峰时段：北京时间周一至周五 09:00-12:00、14:00-18:00；周末与法定节假日全谷时。
 * 这些数字仍请对照官方页核对——表里每一格都能改。
 */
const DEFAULT_MODELS = [
  {
    match: 'deepseek-flash',
    label: 'deepseek-flash',
    input: 2,
    output: 8,
    cacheRead: 0.04,
    cacheWrite: 0,
    offFactor: 0.5,
    assumed: false,
  },
  {
    match: 'deepseek-v4-pro',
    label: 'deepseek-v4-pro',
    input: 9,
    output: 27,
    cacheRead: 0.3,
    cacheWrite: 0,
    offFactor: 0.5,
    assumed: false,
  },
  {
    match: 'deepseek-chat',
    label: 'deepseek-chat（旧）',
    input: 2,
    output: 3,
    cacheRead: 0.2,
    cacheWrite: 0,
    offFactor: 0.5,
    assumed: true,
  },
  {
    match: 'deepseek-reasoner',
    label: 'deepseek-reasoner（旧）',
    input: 2,
    output: 3,
    cacheRead: 0.2,
    cacheWrite: 0,
    offFactor: 0.25,
    assumed: true,
  },
]

/** 没匹配到任何价目时用这一行（按 flash 价），并打上「估价」标记。 */
const FALLBACK_MODEL = {
  match: '*',
  label: '未知模型',
  input: 2,
  output: 8,
  cacheRead: 0.04,
  cacheWrite: 0,
  offFactor: 0.5,
  assumed: true,
}

const DEFAULT_SETTINGS = {
  currency: 'CNY',
  // 实测口径：DSH 上报的 inputTokens 不含缓存读，缓存读单独给。
  cacheInInput: false,
  priceNote: '内置价 2026-09-10 官方口径（峰时价，谷时减半），请对照官方核对',
  budget: { daily: 0, monthly: 0 },
  // 会话行末金额：默认关闭，避免默认把侧边栏弄乱。
  rowAmount: false,
  // 锁价：开启后，改价目表只影响之后的调用；历史按改价时的版本固化。
  lockPrice: false,
  priceVersions: [],
  // 价格自动同步：从官方中文价格页拉表，默认开。
  autoSyncPrices: true,
  priceSyncedAt: 0,
  priceSource: '',
  peak: {
    enabled: true,
    windows: [
      ['09:00', '12:00'],
      ['14:00', '18:00'],
    ],
    weekdaysOnly: true,
    holidays: [],
    alertMinutes: 10,
    rev: 2,
  },
  models: DEFAULT_MODELS,
  sites: [],
}

/** 注册 Host 路由。 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTES.snapshot, handler: lift(ctx, serveSnapshot) }),
    'dsh-cost-lite: snapshot',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTES.totals, handler: lift(ctx, serveTotals) }),
    'dsh-cost-lite: totals',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTES.settings, handler: lift(ctx, serveSettings) }),
    'dsh-cost-lite: settings',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTES.balance, handler: lift(ctx, serveBalance) }),
    'dsh-cost-lite: balance',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTES.sessionTotal, handler: lift(ctx, serveSessionTotal) }),
    'dsh-cost-lite: session-total',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTES.syncPrices, handler: lift(ctx, serveSyncPrices) }),
    'dsh-cost-lite: sync-prices',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTES.range, handler: lift(ctx, serveRange) }),
    'dsh-cost-lite: range',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTES.turnCosts, handler: lift(ctx, serveTurnCosts) }),
    'dsh-cost-lite: turn-costs',
  )

  // 价格自动同步：启动跑一次，之后每 6 小时一次（可在设置里关掉）。
  ctx.effect(() => {
    const run = () => {
      void syncPrices(ctx, false).catch((error) => {
        ctx.logger?.warn?.(`[dsh-cost-lite] price sync failed: ${error?.message ?? error}`)
      })
    }
    const warmup = setTimeout(run, 5000)
    const timer = setInterval(run, PRICE_SYNC_INTERVAL)
    return () => {
      clearTimeout(warmup)
      clearInterval(timer)
    }
  }, 'dsh-cost-lite: price sync timer')
  ctx.logger?.info?.(`[dsh-cost-lite] mounted ${BASE}/api/{snapshot,totals,settings,balance}`)
}

// ---------------------------------------------------------------------------
// HTTP 外壳
// ---------------------------------------------------------------------------

function lift(ctx, handler) {
  return (request, response) => {
    void handler(ctx, request, response).catch((error) => {
      ctx.logger?.warn?.(`[dsh-cost-lite] ${request?.url ?? '?'} failed: ${error?.message ?? error}`)
      sendJson(response, 500, { ok: false, code: 'internal', message: String(error?.message ?? error) })
    })
  }
}

function sendJson(response, status, payload) {
  if (response.headersSent) return
  const body = JSON.stringify(payload)
  response.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function urlOf(request) {
  try {
    return new URL(request.url ?? '/', 'http://localhost')
  } catch {
    return new URL('http://localhost/')
  }
}

// ---------------------------------------------------------------------------
// 路径与设置
// ---------------------------------------------------------------------------

function dataRoot() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured !== '' ? configured : join(homedir(), '.dsh')
}

function stateDir() {
  return join(dataRoot(), 'cost-lite')
}

function settingsFile() {
  return join(stateDir(), 'settings.json')
}

function indexFile() {
  return join(stateDir(), 'index.json')
}

/** 读设置，缺失或坏掉时落到默认值（坏掉不覆盖用户文件）。 */
async function readSettings() {
  try {
    const text = await fsp.readFile(settingsFile(), 'utf8')
    const parsed = JSON.parse(text)
    return normalizeSettings(parsed)
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS)
  }
}

function normalizeSettings(raw) {
  const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS))
  const out = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) }
  out.budget = { ...base.budget, ...(out.budget && typeof out.budget === 'object' ? out.budget : {}) }
  out.peak = { ...base.peak, ...(out.peak && typeof out.peak === 'object' ? out.peak : {}) }
  out.models = Array.isArray(out.models) && out.models.length > 0 ? out.models : base.models
  out.sites = Array.isArray(out.sites) ? out.sites : []
  out.models = out.models.map((entry) => ({
    match: String(entry?.match ?? '*'),
    label: String(entry?.label ?? entry?.match ?? '*'),
    input: numberOr(entry?.input, 0),
    output: numberOr(entry?.output, 0),
    cacheRead: numberOr(entry?.cacheRead, 0),
    cacheWrite: numberOr(entry?.cacheWrite, 0),
    offFactor: clampFactor(entry?.offFactor, 1),
    assumed: entry?.assumed === true,
  }))
  out.sites = out.sites.map(normalizeSite)
  out.cacheInInput = out.cacheInInput !== false
  out.rowAmount = out.rowAmount === true
  out.lockPrice = out.lockPrice === true
  out.autoSyncPrices = out.autoSyncPrices !== false
  out.priceSyncedAt = numberOr(out.priceSyncedAt, 0)
  out.priceSource = String(out.priceSource ?? '')
  out.priceVersions = Array.isArray(out.priceVersions)
    ? out.priceVersions
        .filter((version) => version && typeof version === 'object' && Number.isFinite(Number(version.at)))
        .map((version) => ({
          at: Number(version.at),
          models: Array.isArray(version.models) ? version.models : base.models,
          peak: version.peak ?? base.peak,
          cacheInInput: version.cacheInInput !== false,
        }))
        .sort((a, b) => a.at - b.at)
    : []
  // 价目/峰谷口径升级：老配置里的价目表是错的口径，直接换新默认值（只换一次）。
  if (numberOr(out.pricesRev, 0) !== 2) {
    out.models = base.models
    out.peak = { ...base.peak }
    out.priceNote = base.priceNote
    out.priceVersions = []
    out.pricesRev = 2
  }
  return out
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normalizeSite(site, index) {
  return {
    id: String(site?.id ?? `site-${(index ?? 0) + 1}`),
    name: String(site?.name ?? '中转站'),
    baseUrl: String(site?.baseUrl ?? '').trim(),
    token: String(site?.token ?? ''),
    apiKey: String(site?.apiKey ?? ''),
    rate: numberOr(site?.rate, 1),
    userId: String(site?.userId ?? '').trim(),
    unit: numberOr(site?.unit, 500000),
    currency: String(site?.currency ?? 'CNY'),
    path: String(site?.path ?? '').trim(),
    method: String(site?.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
    headers: String(site?.headers ?? ''),
    jsonPath: String(site?.jsonPath ?? '').trim(),
    enabled: site?.enabled !== false,
  }
}

function clampFactor(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

/** 原子写设置：先写临时文件再改名，权限 600（里面有中转站令牌）。 */
async function writeSettings(settings) {
  await fsp.mkdir(stateDir(), { recursive: true })
  const tmp = `${settingsFile()}.tmp-${process.pid}-${Date.now()}`
  const body = `${JSON.stringify(settings, null, 2)}\n`
  await fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(tmp, settingsFile())
}

// ---------------------------------------------------------------------------
// 派生索引（按会话 × 按天存 token，不存金额）
// ---------------------------------------------------------------------------

/**
 * index 形态：
 * {
 *   version: 1,
 *   days: { "2026-11-22": { "deepseek|deepseek-chat|peak|1": {i,o,cr,cw} } },
 *   sessions: { "<id>": { scanned: <事件条数>, updatedAt, created } }
 * }
 * 天桶里按 模型+峰谷 分组，金额在读取时用当前价目表现算。
 */
let indexCache = null
let indexWriting = null

async function readIndex() {
  if (indexCache !== null) return indexCache
  try {
    const text = await fsp.readFile(indexFile(), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && parsed.version === INDEX_VERSION && parsed.sessions && typeof parsed.sessions === 'object') {
      indexCache = parsed
      return indexCache
    }
  } catch {
    /* 不存在、旧版本或损坏：重建即可 */
  }
  indexCache = { version: INDEX_VERSION, sessions: {} }
  return indexCache
}

function scheduleIndexWrite() {
  if (indexWriting !== null) return
  indexWriting = (async () => {
    try {
      await fsp.mkdir(stateDir(), { recursive: true })
      const tmp = `${indexFile()}.tmp-${process.pid}-${Date.now()}`
      await fsp.writeFile(tmp, JSON.stringify(indexCache), { encoding: 'utf8', mode: 0o600 })
      await fsp.rename(tmp, indexFile())
    } catch {
      /* 索引写不进去不影响读取：下次重建 */
    } finally {
      indexWriting = null
    }
  })()
}

function dayKeyOf(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MINUTES * 60000)
  return shifted.toISOString().slice(0, 10)
}

function monthKeyOf(ms) {
  return dayKeyOf(ms).slice(0, 7)
}

// ---------------------------------------------------------------------------
// 峰谷
// ---------------------------------------------------------------------------

function minutesOfDay(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MINUTES * 60000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

function parseWindows(windows) {
  const out = []
  for (const item of Array.isArray(windows) ? windows : []) {
    if (!Array.isArray(item) || item.length !== 2) continue
    const start = parseClock(item[0])
    const end = parseClock(item[1])
    if (start === null || end === null || start === end) continue
    out.push([start, end])
  }
  return out
}

/** 周六、周日（北京时间）。 */
function isWeekend(ms) {
  const day = new Date(ms + BEIJING_OFFSET_MINUTES * 60000).getUTCDay()
  return day === 0 || day === 6
}

/** 这一刻是不是峰时：峰时段命中 + 工作日约束 + 非法定节假日。 */
function isPeakAt(ms, peak) {
  if (!peak || peak.enabled === false) return false
  if (peak.weekdaysOnly !== false && isWeekend(ms)) return false
  if (Array.isArray(peak.holidays) && peak.holidays.includes(dayKeyOf(ms))) return false
  const now = minutesOfDay(ms)
  for (const [start, end] of parseWindows(peak.windows)) {
    if (start < end) {
      if (now >= start && now < end) return true
    } else if (now >= start || now < end) {
      return true
    }
  }
  return false
}

/**
 * 下一次峰/谷切换。按分钟向前找状态翻转点，最多看 8 天：
 * 周末与节假日会让「下一个边界」不在今天，逐分钟找比写日历简单且不会错。
 */
function nextSwitch(ms, peak) {
  const base = startOfMinute(ms)
  const nowPeak = isPeakAt(base, peak)
  for (let step = 1; step <= 8 * 1440; step += 1) {
    const at = base + step * 60000
    if (isPeakAt(at, peak) !== nowPeak) return { minutes: step, at }
  }
  return null
}

function startOfMinute(ms) {
  return ms - (ms % 60000)
}

function peakView(settings, nowMs) {
  const peak = settings.peak ?? {}
  const windows = parseWindows(peak.windows)
  if (peak.enabled === false || windows.length === 0) {
    return { enabled: false, peak: false, off: true, label: '', next: null }
  }
  const on = isPeakAt(nowMs, peak)
  return {
    enabled: true,
    peak: on,
    off: !on,
    label: on ? '峰价' : '谷价',
    next: nextSwitch(nowMs, peak),
    alertMinutes: numberOr(peak.alertMinutes, 10),
  }
}

// ---------------------------------------------------------------------------
// 计费
// ---------------------------------------------------------------------------

function pickPriceModel(settings, provider, model) {
  const providerText = String(provider ?? '').toLowerCase()
  const modelText = String(model ?? '').toLowerCase()
  for (const entry of settings.models) {
    const match = String(entry.match ?? '').toLowerCase()
    if (match === '*' || match === '') continue
    if (providerText.includes(match) || modelText.includes(match)) return entry
  }
  const fallback = settings.models.find((entry) => entry.match === '*')
  return fallback ?? FALLBACK_MODEL
}

/**
 * 一条 usage 的拆解与计价。
 * inputTokens 默认视为「不含缓存读」（DSH 实测口径），可在设置里改成包含。
 * 价目表填峰时价；谷时乘模型的 offFactor。
 */
/**
 * 锁价：价目表每改一次（锁价开启时）压一个版本快照，历史按「事件发生时的版本」计价。
 * 版本不存在（-1）表示用当前表，也就是没开锁价。
 */
function versionAt(settings, atMs) {
  const versions = Array.isArray(settings.priceVersions) ? settings.priceVersions : []
  let found = -1
  for (let index = 0; index < versions.length; index += 1) {
    if (numberOr(versions[index]?.at, 0) <= atMs) found = index
    else break
  }
  if (found < 0) return { index: -1, models: settings.models, peak: settings.peak, cacheInInput: settings.cacheInInput }
  const version = versions[found]
  return {
    index: found,
    models: Array.isArray(version.models) ? version.models : settings.models,
    peak: version.peak ?? settings.peak,
    cacheInInput: version.cacheInInput !== false,
  }
}

function priceUsage(settings, provider, model, usage, atMs) {
  const version = versionAt(settings, atMs)
  const entry = pickPriceModel({ models: version.models }, provider, model)
  const input = numberOr(usage?.inputTokens, 0)
  const output = numberOr(usage?.outputTokens, 0)
  const cacheRead = numberOr(usage?.cacheReadTokens, 0)
  const cacheWrite = numberOr(usage?.cacheWriteTokens, 0)
  const reasoning = numberOr(usage?.reasoningTokens, 0)
  const billableInput = version.cacheInInput
    ? Math.max(0, input - cacheRead - cacheWrite)
    : input
  // 中转站按倍率计费，没有峰谷；只有 DeepSeek 官方/账号渠道才分峰谷。
  const relay = !/deepseek/i.test(String(provider))
  const peakNow = relay ? true : isPeakAt(atMs, version.peak)
  const factor = peakNow ? 1 : entry.offFactor > 0 ? entry.offFactor : 1
  const perMillion = (count, price) => (count / 1e6) * price * factor
  const amount =
    perMillion(billableInput, entry.input) +
    perMillion(cacheRead, entry.cacheRead) +
    perMillion(cacheWrite, entry.cacheWrite) +
    perMillion(output, entry.output)
  return {
    provider: String(provider ?? ''),
    model: String(model ?? ''),
    priceModel: entry.match,
    assumed: entry.assumed === true,
    input,
    billableInput,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    factor,
    peak: peakNow,
    offPeak: !peakNow,
    version: version.index,
    unit: { input: entry.input, output: entry.output, cacheRead: entry.cacheRead, cacheWrite: entry.cacheWrite },
    amount,
  }
}

function bucketKey(provider, model, isPeak, assumed, version) {
  return `${provider}|${model}|${isPeak ? 'peak' : 'off'}|${assumed ? 'a' : 'e'}|v${version}`
}

/** 把一个调用累加进「这个会话这一天这个档位这个价目版本」的桶。 */
function recordAdd(record, atMs, call) {
  const day = dayKeyOf(atMs)
  const dayBuckets = record.days[day] ?? (record.days[day] = {})
  const key = bucketKey(call.provider, call.model, call.peak, call.assumed, call.version)
  const bucket = dayBuckets[key] ?? (dayBuckets[key] = { i: 0, o: 0, cr: 0, cw: 0 })
  bucket.i += call.billableInput
  bucket.o += call.output
  bucket.cr += call.cacheRead
  bucket.cw += call.cacheWrite
}

function amountOfBucket(settings, key, bucket) {
  const parts = key.split('|')
  const [provider, model, mode] = parts
  const versionText = parts[4] ?? 'v-1'
  const versionIndex = numberOr(versionText.replace(/^v/, ''), -1)
  const versions = Array.isArray(settings.priceVersions) ? settings.priceVersions : []
  // v-1 表示「锁价开启之前写入的桶」：有基线版本时用基线，没有就用当前表。
  const resolved = versionIndex >= 0 ? versions[versionIndex] : versions[0]
  const snapshot = resolved ?? null
  const models = Array.isArray(snapshot?.models) ? snapshot.models : settings.models
  const entry = pickPriceModel({ models }, provider, model)
  const factor = mode === 'off' ? (entry.offFactor > 0 ? entry.offFactor : 1) : 1
  const perMillion = (count, price) => (count / 1e6) * price * factor
  return (
    perMillion(bucket.i, entry.input) +
    perMillion(bucket.cr, entry.cacheRead) +
    perMillion(bucket.cw, entry.cacheWrite) +
    perMillion(bucket.o, entry.output)
  )
}

/** 非 token 计费项：官方 Search / Fetch API 一律 ¥5 / 1000 次。 */
const TOOL_RATES = { web_search: 0.005, web_fetch: 0.005 }

function toolTotals(index, dayPredicate) {
  const counts = {}
  let amount = 0
  for (const record of Object.values(index.sessions)) {
    for (const [day, tools] of Object.entries(record.toolDays ?? {})) {
      if (!dayPredicate(day)) continue
      for (const [name, count] of Object.entries(tools)) {
        counts[name] = (counts[name] ?? 0) + count
        amount += (TOOL_RATES[name] ?? 0) * count
      }
    }
  }
  return { amount, counts }
}

/**
 * 汇总：桶按会话存（不是全局天桶），所以重扫一个会话只影响它自己，
 * 永远不会把同一段用量加两遍。
 */
function totalOfDays(settings, index, dayPredicate) {
  let amount = 0
  let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const record of Object.values(index.sessions)) {
    for (const [day, buckets] of Object.entries(record.days ?? {})) {
      if (!dayPredicate(day)) continue
      for (const [key, bucket] of Object.entries(buckets)) {
        amount += amountOfBucket(settings, key, bucket)
        tokens = {
          input: tokens.input + bucket.i,
          output: tokens.output + bucket.o,
          cacheRead: tokens.cacheRead + bucket.cr,
          cacheWrite: tokens.cacheWrite + bucket.cw,
        }
      }
    }
  }
  return { amount, tokens }
}

/** 按模型汇总（诊断用：一眼看出哪一行把预算吃掉了）。 */
function breakdownByModel(settings, index, dayPredicate) {
  const rows = new Map()
  for (const record of Object.values(index.sessions)) {
    for (const [day, buckets] of Object.entries(record.days ?? {})) {
      if (!dayPredicate(day)) continue
      for (const [key, bucket] of Object.entries(buckets)) {
        const [provider, model, mode] = key.split('|')
        const id = `${provider}/${model}/${mode}`
        const row = rows.get(id) ?? { id, amount: 0, input: 0, cacheRead: 0, output: 0 }
        row.amount += amountOfBucket(settings, key, bucket)
        row.input += bucket.i
        row.cacheRead += bucket.cr
        row.output += bucket.o
        rows.set(id, row)
      }
    }
  }
  return [...rows.values()].sort((a, b) => b.amount - a.amount)
}

// ---------------------------------------------------------------------------
// 会话扫描
// ---------------------------------------------------------------------------

function isCostEvent(event) {
  return event?.type === 'assistant/message' && event.data?.usage != null
}

/**
 * usage.outputTokens 不含思考过程（reasoning），但官方按生成 token 计费。
 * 思考 token 从流式记录里按字符估算（中英混排 ~2.6 字符/token），标记为估算。
 */
function reasoningTokensOf(event) {
  const stream = event?.data?.stream
  if (!Array.isArray(stream)) return 0
  let chars = 0
  for (const record of stream) {
    if (record?.type !== 'reasoning-chunks') continue
    for (const text of record.texts ?? []) chars += String(text).length
  }
  return chars === 0 ? 0 : Math.round(chars / 2.6)
}

/** 计费口径的 usage：把缺失的思考 token 补进 output，并标注 estimated。 */
function effectiveUsage(event) {
  const usage = event?.data?.usage
  if (!usage) return usage
  if (numberOr(usage.reasoningTokens, 0) > 0) return { ...usage, estimated: false }
  const estimate = reasoningTokensOf(event)
  if (estimate <= 0) return usage
  return {
    ...usage,
    outputTokens: numberOr(usage.outputTokens, 0) + estimate,
    reasoningTokens: estimate,
    estimated: true,
  }
}

/**
 * 把一个会话里尚未入索引的 assistant/message 事件逐个计价入桶。
 * 返回本次新增的调用明细（只用于「本会话」面板，不落盘）。
 */
function ensureRecord(index, sid) {
  const existing = index.sessions[sid]
  if (existing && typeof existing === 'object' && existing.days) return existing
  const record = { scanned: -1, skip: 0, mode: '', days: {}, createdAt: 0, updatedAt: 0 }
  index.sessions[sid] = record
  return record
}

/**
 * 扫一个会话里还没入索引的 assistant/message 事件。
 *
 * 两种模式互斥地记账：
 *  - live：自己发的事件（ownEvents 已排除继承前缀），增量追加；
 *  - cold：整条日志（可能含 fork 继承的前缀），一旦模式从 live 转 cold
 *    就整条重算并替换自己的桶，绝不叠加。
 */
async function ingestSession(ctx, settings, sid, index, options) {
  const record = ensureRecord(index, sid)
  const calls = []
  let events = null
  let mode = 'cold'
  let skip = 0

  const liveSession = ctx.get?.('sessions')?.get?.(sid)
  if (liveSession) {
    mode = 'live'
    events = liveSession.ownEvents()
  } else if (options?.cold !== false) {
    const query = ctx.get?.('sessionQuery')
    if (!query) return { calls, mode, missing: false }
    try {
      const snapshot = await query.readSession(sid)
      events = snapshot.events
      skip = numberOr(snapshot.inheritedEventCount, 0)
      record.createdAt = snapshot.session?.createdAt ?? record.createdAt
    } catch {
      return { calls, mode, missing: true }
    }
  }
  if (!events) return { calls, mode, missing: false }

  let startAt
  if (record.scanned < 0 || record.mode !== mode) {
    // 模式变了（live → cold）或第一次扫：整条重算，先清空自己的桶。
    record.days = {}
    record.toolDays = {}
    record.scanned = -1
    startAt = mode === 'cold' ? Math.max(0, skip) : 0
  } else {
    startAt = Math.max(record.scanned + 1, mode === 'cold' ? skip : 0)
  }

  for (let position = startAt; position < events.length; position += 1) {
    const event = events[position]
    // 非 token 计费项：官方按次收（Search/Fetch ¥5 / 1000 次），单独记数。
    if (event?.type === 'session/title') {
      const title = String(event.data?.title ?? '')
      if (title !== '') record.title = title
      continue
    }
    if (event?.type === 'tool/call') {
      const name = String(event.data?.name ?? '')
      if (name === 'web_search' || name === 'web_fetch') {
        const day = dayKeyOf(event.time)
        record.toolDays = record.toolDays ?? {}
        const dayMap = record.toolDays[day] ?? (record.toolDays[day] = {})
        dayMap[name] = (dayMap[name] ?? 0) + 1
      }
      continue
    }
    if (!isCostEvent(event)) continue
    const provider = event.data?.message?.source?.provider ?? ''
    const model = event.data?.message?.source?.model ?? ''
    const call = priceUsage(settings, provider, model, effectiveUsage(event), event.time)
    call.time = event.time
    call.seq = event.seq
    recordAdd(record, event.time, call)
    calls.push(call)
  }
  record.mode = mode
  record.skip = skip
  record.scanned = events.length - 1
  record.updatedAt = Date.now()
  return { calls, mode, missing: false }
}

/** 本会话全量明细：每次都从头算，保证面板和日志对得上。 */
async function sessionView(ctx, settings, sid) {
  let events = null
  let header = null
  let skip = 0
  const liveSession = ctx.get?.('sessions')?.get?.(sid)
  if (liveSession) {
    events = liveSession.ownEvents()
    header = liveSession.header
  } else {
    const query = ctx.get?.('sessionQuery')
    if (!query) return { ok: false, code: 'unavailable', message: '当前没有可用的会话查询服务' }
    try {
      const snapshot = await query.readSession(sid)
      // fork / 种子会话的前缀属于父会话，不能在这里再算一遍。
      skip = numberOr(snapshot.inheritedEventCount, 0)
      events = skip > 0 ? snapshot.events.slice(skip) : snapshot.events
      header = snapshot.session
    } catch (error) {
      return { ok: false, code: 'missing', message: String(error?.message ?? error) }
    }
  }
  const calls = []
  let amount = 0
  let totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  for (const event of events) {
    if (!isCostEvent(event)) continue
    const provider = event.data?.message?.source?.provider ?? ''
    const model = event.data?.message?.source?.model ?? ''
    const call = priceUsage(settings, provider, model, effectiveUsage(event), event.time)
    call.time = event.time
    call.seq = event.seq
    call.turn = numberOr(event.data?.turn, 0)
    amount += call.amount
    totals = {
      input: totals.input + call.input,
      output: totals.output + call.output,
      cacheRead: totals.cacheRead + call.cacheRead,
      cacheWrite: totals.cacheWrite + call.cacheWrite,
      reasoning: totals.reasoning + call.reasoning,
    }
    calls.push(call)
  }
  const cacheRatio = totals.input + totals.cacheRead > 0
    ? totals.cacheRead / (totals.input + totals.cacheRead)
    : 0
  return {
    ok: true,
    id: sid,
    title: header?.id ?? sid,
    createdAt: header?.createdAt ?? 0,
    live: Boolean(liveSession),
    amount,
    totals,
    cacheRatio,
    calls,
  }
}

// ---------------------------------------------------------------------------
// 回收站：用户删掉的会话，官方账单里照样计费
// ---------------------------------------------------------------------------

let lastTrashScan = 0

function frameOffsets(buffer) {
  const offsets = []
  for (let index = 0; index < buffer.length - 3; index += 1) {
    if (
      buffer[index] === ZSTD_MAGIC[0] &&
      buffer[index + 1] === ZSTD_MAGIC[1] &&
      buffer[index + 2] === ZSTD_MAGIC[2] &&
      buffer[index + 3] === ZSTD_MAGIC[3]
    ) {
      offsets.push(index)
    }
  }
  return offsets
}

/** 把「拼接式 zstd 日志」解成事件数组；解不出的块直接跳过。 */
function decodeLogEvents(buffer) {
  const events = []
  for (const offset of frameOffsets(buffer)) {
    let text
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(offset)).toString('utf8')
    } catch {
      continue // 压缩数据里的假 magic
    }
    if (!text.trimStart().startsWith('{')) continue
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        events.push(JSON.parse(line))
      } catch {
        /* 半截行 */
      }
    }
  }
  return events
}

async function listFileTree(root, suffix, depth) {
  const found = []
  if (depth > 4) return found
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) found.push(...(await listFileTree(full, suffix, depth + 1)))
    else if (entry.name.endsWith(suffix)) found.push(full)
  }
  return found
}

/**
 * 扫回收站。同 id 的会话已在正片里扫过就跳过，避免 restore 之后算两遍。
 * 每个文件按 mtime+size 记一次，重扫很便宜。
 */
async function ingestTrash(ctx, settings, index) {
  const root = join(dataRoot(), 'session-trash')
  const files = await listFileTree(root, '.zstd', 0)
  if (files.length === 0) return 0
  index.trash = index.trash ?? {}
  let scanned = 0
  for (const file of files) {
    let stat
    try {
      stat = await fsp.stat(file)
    } catch {
      continue
    }
    const known = index.trash[file]
    if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) continue
    if (scanned >= 80) break
    let buffer
    try {
      buffer = await fsp.readFile(file)
    } catch {
      continue
    }
    const events = decodeLogEvents(buffer)
    const header = events.find((event) => event?.type === 'session')
    const sid = typeof header?.id === 'string' ? header.id : ''
    if (sid === '') {
      index.trash[file] = { mtimeMs: stat.mtimeMs, size: stat.size, sid: '', skipped: true }
      continue
    }
    const existing = index.sessions[sid]
    if (existing && typeof existing === 'object' && existing.scanned >= 0) {
      index.trash[file] = { mtimeMs: stat.mtimeMs, size: stat.size, sid, skipped: true }
      continue
    }
    const record = ensureRecord(index, sid)
    record.days = {}
    record.toolDays = {}
    for (const event of events) {
      if (!isCostEvent(event)) continue
      const provider = event.data?.message?.source?.provider ?? ''
      const model = event.data?.message?.source?.model ?? ''
      const call = priceUsage(settings, provider, model, effectiveUsage(event), event.time)
      recordAdd(record, event.time, call)
    }
    record.mode = 'trash'
    record.scanned = events.length - 1
    record.updatedAt = Date.now()
    record.createdAt = numberOr(header?.createdAt, 0)
    index.trash[file] = { mtimeMs: stat.mtimeMs, size: stat.size, sid }
    scanned += 1
  }
  return scanned
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function serveSnapshot(ctx, request, response) {
  const settings = await readSettings()
  const url = urlOf(request)
  const sid = String(url.searchParams.get('sessionId') ?? '').trim()
  const now = Date.now()
  const index = await readIndex()

  let session = null
  if (sid !== '') {
    session = await sessionView(ctx, settings, sid)
    await ingestSession(ctx, settings, sid, index, { cold: true })
    if (url.searchParams.get('brief') === '1' && session?.ok) {
      session = { ...session, calls: [], callCount: session.calls.length }
    }
  }

  // 回收站里的会话也要计入今日/本月；最多 5 分钟扫一次。
  if (now - lastTrashScan > 5 * 60000) {
    lastTrashScan = now
    await ingestTrash(ctx, settings, index).catch(() => 0)
    scheduleIndexWrite()
  }

  const today = dayKeyOf(now)
  const todayTotal = totalOfDays(settings, index, (day) => day === today)
  const todayTools = toolTotals(index, (day) => day === today)
  const month = monthKeyOf(now)
  const monthTotal = totalOfDays(settings, index, (day) => day.slice(0, 7) === month)
  const monthTools = toolTotals(index, (day) => day.slice(0, 7) === month)
  const tokenToday = todayTotal.amount
  const tokenMonth = monthTotal.amount

  scheduleIndexWrite()

  // 余额：读缓存，过期就在后台刷；请求本身不等人。
  const wantBalance = url.searchParams.get('balance') === '1'
  if (wantBalance && now - balanceState.at > 120000) {
    void refreshBalanceState(ctx, settings).catch(() => {})
  }

  sendJson(response, 200, {
    ok: true,
    now,
    currency: settings.currency,
    priceNote: settings.priceNote,
    session,
    today: {
      amount: tokenToday + todayTools.amount,
      tokenAmount: tokenToday,
      toolAmount: todayTools.amount,
      toolCounts: todayTools.counts,
      tokens: todayTotal.tokens,
    },
    month: {
      amount: tokenMonth + monthTools.amount,
      tokenAmount: tokenMonth,
      toolAmount: monthTools.amount,
    },
    budget: {
      daily: numberOr(settings.budget.daily, 0),
      monthly: numberOr(settings.budget.monthly, 0),
      dailyRatio: ratio(tokenToday + todayTools.amount, settings.budget.daily),
      monthlyRatio: ratio(tokenMonth + monthTools.amount, settings.budget.monthly),
    },
    peak: peakView(settings, now),
    balance: wantBalance ? { at: balanceState.at, official: balanceState.official, sites: balanceState.sites } : undefined,
  })
}

function ratio(amount, limit) {
  const cap = numberOr(limit, 0)
  if (cap <= 0) return null
  return Math.max(0, amount / cap)
}

/**
 * 一个会话的累计金额，只读索引（不触发重扫）：
 * 侧边栏一行一个请求，不能让它去解压日志。
 */
async function serveSessionTotal(ctx, request, response) {
  const settings = await readSettings()
  const url = urlOf(request)
  const sid = String(url.searchParams.get('sessionId') ?? '').trim()
  if (sid === '') {
    sendJson(response, 400, { ok: false, code: 'missing-session', message: '缺少 sessionId' })
    return
  }
  const index = await readIndex()
  const record = index.sessions[sid]
  if (!record || typeof record !== 'object' || record.scanned < 0) {
    sendJson(response, 200, { ok: true, amount: null, currency: settings.currency })
    return
  }
  let amount = 0
  for (const buckets of Object.values(record.days ?? {})) {
    for (const [key, bucket] of Object.entries(buckets)) {
      amount += amountOfBucket(settings, key, bucket)
    }
  }
  sendJson(response, 200, { ok: true, amount, currency: settings.currency })
}

async function serveTotals(ctx, request, response) {
  const settings = await readSettings()
  const url = urlOf(request)
  const period = String(url.searchParams.get('period') ?? 'month')
  const index = await readIndex()
  const now = Date.now()

  const query = ctx.get?.('sessionQuery')
  let scanned = 0
  let scannedFailed = 0
  let partial = false
  if (query && period !== 'day') {
    try {
      // 不按 createdAt 过滤：一次会话可以跨月继续用，缺了它就会少算。
      const records = await query.listSessions()
      for (const record of records) {
        const sid = record?.header?.id
        if (!sid) continue
        const known = index.sessions[sid]
        if (known && typeof known === 'object' && known.scanned >= 0) continue
        if (scanned + scannedFailed >= 400) {
          partial = true
          break
        }
        const result = await ingestSession(ctx, settings, sid, index, { cold: true })
        if (result.missing) scannedFailed += 1
        else scanned += 1
      }
    } catch {
      /* 列表拿不到就只用已有索引 */
    }
    scheduleIndexWrite()
  }

  const trashScanned = await ingestTrash(ctx, settings, index).catch(() => 0)
  if (trashScanned > 0) scheduleIndexWrite()

  const predicate =
    period === 'day' ? (day) => day === dayKeyOf(now) : (day) => day.slice(0, 7) === monthKeyOf(now)
  const total = totalOfDays(settings, index, predicate)
  const payload = {
    ok: true,
    period,
    amount: total.amount,
    tokens: total.tokens,
    currency: settings.currency,
    scanned,
    scannedFailed,
    partial,
    trashScanned,
  }
  if (url.searchParams.get('breakdown') === '1') {
    payload.breakdown = breakdownByModel(settings, index, predicate)
  }
  sendJson(response, 200, payload)
}

// ---------------------------------------------------------------------------
// 官方价格自动同步
// ---------------------------------------------------------------------------

/** 抓官方中文价格页，解析出「峰时价 + 谷时倍率」。 */
async function fetchOfficialPriceTable() {
  const response = await fetch(PRICE_PAGE, {
    headers: { 'user-agent': PRICE_UA, accept: 'text/html' },
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(`价格页 HTTP ${response.status}`)
  const html = await response.text()
  const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((row) =>
    [...row[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => cell[1].replace(/<[^>]+>/g, '').trim()),
  )
  const table = { hit: { off: [], peak: [] }, miss: { off: [], peak: [] }, out: { off: [], peak: [] } }
  let key = ''
  for (const cells of rows) {
    const text = cells.join(' ')
    if (text.includes('缓存命中')) key = 'hit'
    else if (text.includes('缓存未命中')) key = 'miss'
    else if (/输出/.test(text) && /tokens/i.test(text)) key = 'out'
    if (key === '') continue
    const isOffPeak = text.includes('空闲时段')
    const isPeak = text.includes('高峰时段')
    if (!isOffPeak && !isPeak) continue
    const numbers = [...text.matchAll(/([\d.]+)\s*元/g)].map((match) => Number(match[1])).filter(Number.isFinite)
    if (numbers.length < 2) continue
    table[key][isOffPeak ? 'off' : 'peak'] = numbers.slice(0, 2)
  }
  if (!table.hit.peak.length || !table.miss.peak.length || !table.out.peak.length) {
    throw new Error('价格表解析失败：官方页面结构可能变了')
  }
  const readModel = (index) => {
    const peakHit = table.hit.peak[index]
    const offHit = table.hit.off[index] ?? peakHit / 2
    const factor = peakHit > 0 ? Math.round((offHit / peakHit) * 1000) / 1000 : 0.5
    return { input: table.miss.peak[index], output: table.out.peak[index], cacheRead: peakHit, offFactor: factor }
  }
  return { flash: readModel(0), pro: readModel(1), fetchedAt: Date.now() }
}

/** 把官方表写进价目表：只覆盖认识的两行，其余自定义行保留。 */
function applyOfficialTable(settings, table) {
  return settings.models.map((entry) => {
    const match = String(entry.match ?? '').toLowerCase()
    const next = match.includes('flash') ? table.flash : match.includes('v4-pro') ? table.pro : null
    if (!next) return entry
    return {
      ...entry,
      input: next.input,
      output: next.output,
      cacheRead: next.cacheRead,
      offFactor: next.offFactor,
      assumed: false,
    }
  })
}

async function syncPrices(ctx, force) {
  const settings = await readSettings()
  if (!force && settings.autoSyncPrices === false) return { ok: true, skipped: true }
  const table = await fetchOfficialPriceTable()
  const models = applyOfficialTable(settings, table)
  const changed =
    priceSignature(settings) !== priceSignature({ models, peak: settings.peak, cacheInInput: settings.cacheInInput })
  const next = { ...settings, models, priceSyncedAt: table.fetchedAt, priceSource: PRICE_PAGE }
  if (changed && next.lockPrice) {
    const versions = [...(next.priceVersions ?? [])]
    if (versions.length === 0) {
      versions.push({ at: 0, models: settings.models, peak: settings.peak, cacheInInput: settings.cacheInInput })
    }
    versions.push({ at: table.fetchedAt, models, peak: next.peak, cacheInInput: next.cacheInInput })
    next.priceVersions = versions
  }
  await writeSettings(next)
  ctx.logger?.info?.(`[dsh-cost-lite] 价格同步完成，变更=${changed}`)
  return { ok: true, changed, models, syncedAt: table.fetchedAt, source: PRICE_PAGE }
}

/** 把正片里还没索引的会话扫一遍；两个查询接口共用。 */
async function ensureCorpus(ctx, settings, index) {
  const query = ctx.get?.('sessionQuery')
  if (!query) return { scanned: 0, failed: 0, partial: false }
  let scanned = 0
  let failed = 0
  let partial = false
  try {
    const records = await query.listSessions()
    for (const record of records) {
      const sid = record?.header?.id
      if (!sid) continue
      const known = index.sessions[sid]
      if (known && typeof known === 'object' && known.scanned >= 0) continue
      if (scanned + failed >= 400) {
        partial = true
        break
      }
      const result = await ingestSession(ctx, settings, sid, index, { cold: true })
      if (result.missing) failed += 1
      else scanned += 1
    }
  } catch {
    /* 列表拿不到就只用已有索引 */
  }
  const trashScanned = await ingestTrash(ctx, settings, index).catch(() => 0)
  if (scanned > 0 || trashScanned > 0) scheduleIndexWrite()
  return { scanned, failed, partial, trashScanned }
}

/** 每个回合花了多少（会话内），供消息尾部的费用标签用。 */
async function serveTurnCosts(ctx, request, response) {
  const settings = await readSettings()
  const url = urlOf(request)
  const sid = String(url.searchParams.get('sessionId') ?? '').trim()
  if (sid === '') {
    sendJson(response, 400, { ok: false, code: 'missing-session', message: '缺少 sessionId' })
    return
  }
  const view = await sessionView(ctx, settings, sid)
  if (!view || view.ok !== true) {
    sendJson(response, 200, { ok: true, turns: {} })
    return
  }
  const turns = {}
  for (const call of view.calls ?? []) {
    const turn = numberOr(call.turn, 0)
    if (turn <= 0) continue
    turns[turn] = (turns[turn] ?? 0) + call.amount
  }
  sendJson(response, 200, { ok: true, turns, currency: settings.currency })
}

async function serveRange(ctx, request, response) {
  const settings = await readSettings()
  const url = urlOf(request)
  const now = Date.now()
  const todayKey = dayKeyOf(now)
  const from = String(url.searchParams.get('from') ?? todayKey).slice(0, 10)
  const to = String(url.searchParams.get('to') ?? todayKey).slice(0, 10)
  const index = await readIndex()
  const inRange = (day) => day >= from && day <= to

  // 和 /totals 一样：先把还没索引的会话扫进来，否则区间数字会缩水。
  await ensureCorpus(ctx, settings, index)

  const total = totalOfDays(settings, index, inRange)
  const tools = toolTotals(index, inRange)
  const bySource = breakdownByModel(settings, index, inRange)
  const days = {}
  for (const record of Object.values(index.sessions)) {
    for (const [day, buckets] of Object.entries(record.days ?? {})) {
      if (!inRange(day)) continue
      let amount = 0
      for (const [key, bucket] of Object.entries(buckets)) amount += amountOfBucket(settings, key, bucket)
      days[day] = (days[day] ?? 0) + amount
    }
  }
  const sessions = []
  for (const [sid, record] of Object.entries(index.sessions)) {
    let amount = 0
    for (const [day, buckets] of Object.entries(record.days ?? {})) {
      if (!inRange(day)) continue
      for (const [key, bucket] of Object.entries(buckets)) amount += amountOfBucket(settings, key, bucket)
    }
    if (amount > 0.000001) sessions.push({ id: sid, title: record.title ?? '', amount })
  }
  sessions.sort((a, b) => b.amount - a.amount)

  sendJson(response, 200, {
    ok: true,
    from,
    to,
    amount: total.amount + tools.amount,
    tokenAmount: total.amount,
    toolAmount: tools.amount,
    toolCounts: tools.counts,
    tokens: total.tokens,
    currency: settings.currency,
    bySource,
    sessions: sessions.slice(0, 30),
    days: Object.entries(days)
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([day, amount]) => ({ day, amount })),
  })
}

async function serveSyncPrices(ctx, request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, code: 'method', message: '只支持 POST' })
    return
  }
  try {
    const result = await syncPrices(ctx, true)
    sendJson(response, 200, result)
  } catch (error) {
    sendJson(response, 502, { ok: false, code: 'sync-failed', message: String(error?.message ?? error) })
  }
}

async function serveSettings(ctx, request, response) {
  if (request.method === 'GET') {
    const settings = await readSettings()
    sendJson(response, 200, { ok: true, settings: publicSettings(settings), hasTokens: tokenFlags(settings) })
    return
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, code: 'method', message: '只支持 GET / POST' })
    return
  }
  const body = await readJson(request)
  const next = normalizeSettings(body?.settings ?? {})
  // 空令牌表示「保持原值」，避免把已保存的令牌误清空。
  const previous = await readSettings()
  next.sites = next.sites.map((site) => {
    const old = previous.sites.find((item) => item.id === site.id)
    if (!old) return site
    return {
      ...site,
      token: site.token !== '' ? site.token : old.token,
      apiKey: site.apiKey !== '' ? site.apiKey : old.apiKey,
    }
  })
  // 锁价：价目相关字段变了就压版本快照——旧历史留在旧版本，新调用用新版本。
  if (next.lockPrice && priceSignature(previous) !== priceSignature(next)) {
    const versions = [...(previous.priceVersions ?? [])]
    if (versions.length === 0) {
      // 第一次锁价：先补一个基线，盖住锁价之前已经发生的调用。
      versions.push({
        at: 0,
        models: previous.models,
        peak: previous.peak,
        cacheInInput: previous.cacheInInput,
      })
    }
    versions.push({
      at: Date.now(),
      models: next.models,
      peak: next.peak,
      cacheInInput: next.cacheInInput,
    })
    next.priceVersions = versions
  } else {
    next.priceVersions = previous.priceVersions ?? []
  }
  await writeSettings(next)
  sendJson(response, 200, { ok: true, settings: publicSettings(next), hasTokens: tokenFlags(next) })
}

/** 价目表里会影响金额的字段指纹，用来判断「这次保存是不是改价了」。 */
function priceSignature(settings) {
  return JSON.stringify({
    models: settings.models,
    peak: settings.peak,
    cacheInInput: settings.cacheInInput,
  })
}

function tokenFlags(settings) {
  return settings.sites.map((site) => ({ id: site.id, hasToken: site.token !== '' }))
}

/** 下发到浏览器时永远不带令牌原文；`hasToken` 告诉界面「这里已经存过」。 */
function publicSettings(settings) {
  return {
    ...settings,
    sites: settings.sites.map((site) => ({
      ...site,
      token: '',
      apiKey: '',
      hasToken: site.token !== '',
      hasApiKey: site.apiKey !== '',
    })),
  }
}

async function serveBalance(ctx, request, response) {
  if (request.method !== 'POST') {
    sendJson(response, 405, { ok: false, code: 'method', message: '只支持 POST' })
    return
  }
  const body = await readJson(request)
  const settings = await readSettings()

  // 「测试」可以直接提交还没保存的草稿站点：不然用户没点保存就永远测不出东西。
  if (body?.site && typeof body.site === 'object') {
    const draft = normalizeSite(body.site, 0)
    if (draft.token === '') {
      const saved = settings.sites.find((item) => item.id === draft.id)
      if (saved) draft.token = saved.token
    }
    const result = await querySite(ctx, draft, true)
    const official = await queryOfficial(ctx)
    sendJson(response, 200, { ok: true, official, sites: [result] })
    return
  }

  const wantedId = String(body?.id ?? '').trim()
  const force = body?.force === true
  const sites = settings.sites.filter((site) => site.enabled && (wantedId === '' || site.id === wantedId))

  const results = []
  for (const site of sites) {
    results.push(await querySite(ctx, site, force))
  }

  const official = await queryOfficial(ctx)
  sendJson(response, 200, { ok: true, official, sites: results })
}

const balanceCache = new Map()

/** 面板/顶栏用的余额快照：后台刷新，读的时候不等网络。 */
let balanceState = { at: 0, official: null, sites: [] }
let balanceRunning = false

async function refreshBalanceState(ctx, settings) {
  if (balanceRunning) return
  balanceRunning = true
  try {
    const official = await queryOfficial(ctx)
    const sites = []
    for (const site of settings.sites) {
      if (!site.enabled) continue
      sites.push(await querySite(ctx, site, false))
    }
    balanceState = { at: Date.now(), official, sites }
  } catch {
    balanceState = { ...balanceState, at: Date.now() }
  } finally {
    balanceRunning = false
  }
}

async function querySite(ctx, site, force) {
  if (site.baseUrl === '') {
    return { id: site.id, name: site.name, ok: false, code: 'unconfigured', message: '没有填写站点地址' }
  }
  const cached = balanceCache.get(site.id)
  if (!force && cached && Date.now() - cached.at < 60000) return cached.result

  const result = await probeSite(site)
  // 有些站返回美元（quota/500000），控制台却显示人民币，用倍率换算。
  if (result.ok && !result.unlimited && Number.isFinite(result.amount)) {
    const rate = numberOr(site.rate, 1)
    if (rate !== 1 && rate > 0) result.amount = result.amount * rate
    result.rate = rate
  }
  result.id = site.id
  result.name = site.name
  result.currency = site.currency
  result.at = Date.now()
  // 中转站自报倍率（new-api 的 /api/pricing 是公开的）：查不到就安静地不带。
  result.ratios = await fetchSiteRatio(normalizeBase(site.baseUrl))
  balanceCache.set(site.id, { at: Date.now(), result })
  return result
}

/**
 * 站点自报倍率。注意：new-api 的 model_ratio 基准各站不同，
 * 不能直接换算成「官方价 ×几倍」，所以只如实显示，不做二次解释。
 */
async function fetchSiteRatio(base) {
  try {
    const { response, text } = await getText(`${base}/api/pricing`, { accept: 'application/json' })
    if (!response.ok) return null
    const json = JSON.parse(text)
    const rows = Array.isArray(json?.data) ? json.data : []
    const candidates = rows.filter((row) => /deepseek/i.test(String(row?.model_name ?? '')))
    const hit =
      candidates.find((row) => /v4(\.1)?[-_ ]?flash(?!.*(vision|exp))/i.test(String(row.model_name))) ??
      candidates.find((row) => /flash/i.test(String(row.model_name)) && !/vision|exp/i.test(String(row.model_name))) ??
      candidates.find((row) => /flash/i.test(String(row.model_name))) ??
      candidates[0]
    if (!hit) return null
    return {
      model: String(hit.model_name ?? ''),
      modelRatio: Number(hit.model_ratio),
      completionRatio: Number(hit.completion_ratio),
    }
  } catch {
    return null
  }
}

/**
 * 基地址归一化：用户填 `https://x.com`、`https://x.com/`、`https://x.com/v1`
 * 都应当能查，不能因为多写一个 /v1 就 404。
 */
function normalizeBase(raw) {
  let base = String(raw ?? '').trim().replace(/\/+$/, '')
  if (base.toLowerCase().endsWith('/v1')) base = base.slice(0, -3)
  return base.replace(/\/+$/, '')
}

/** 从任意 JSON 里找余额字段：认不得的网关也能用一个路径配通。 */
const AMOUNT_KEYS = [
  'balance',
  'remaining_balance',
  'remaining',
  'remain_quota',
  'quota',
  'credits',
  'credit',
  'available',
  'total_balance',
  'amount',
  'total',
]

function extractAmount(node, trail) {
  const prefix = trail ?? ''
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = extractAmount(item, prefix)
      if (hit) return hit
    }
    return null
  }
  const lowered = {}
  for (const [key, value] of Object.entries(node)) lowered[key.toLowerCase()] = { key, value }
  for (const wanted of AMOUNT_KEYS) {
    const entry = lowered[wanted]
    if (!entry) continue
    const numeric = typeof entry.value === 'number' ? entry.value : Number(entry.value)
    if (Number.isFinite(numeric)) return { amount: numeric, field: `${prefix}${entry.key}` }
  }
  for (const [key, value] of Object.entries(node)) {
    const hit = extractAmount(value, `${prefix}${key}.`)
    if (hit) return hit
  }
  return null
}

/** 一次 HTTP 取文本：默认 20s；冷连接超时就重试一次，别让首包慢把结论判死。 */
/** 一次 HTTP 取文本：默认 20s；冷连接超时就重试一次，别让首包慢把结论判死。 */
async function getText(url, init) {
  // 兼容两种调用：直接给 headers，或给完整的 fetch init（带 method/body）。
  const base = init && (init.headers || init.method || init.body) ? init : { headers: init }
  const attempt = () => fetch(url, { ...base, signal: AbortSignal.timeout(20000) })
  let response
  try {
    response = await attempt()
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      response = await attempt()
    } else {
      throw error
    }
  }
  return { response, text: await response.text() }
}

/** 把失败说清楚：状态码 + 服务端 message/code（new-api 的报错很具体）。 */
function describeFailure(response, text) {
  let detail = `HTTP ${response.status}`
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.message ?? parsed?.error?.message ?? parsed?.msg
    const code = parsed?.code ?? parsed?.error?.code
    if (typeof message === 'string' && message !== '') detail += ` ${message.slice(0, 120)}`
    if (typeof code === 'string' && code !== '') detail += `（${code}）`
  } catch {
    /* 非 JSON */
  }
  return detail
}

/** 按点号路径取一个数字；取不到就返回 null。 */
function readPath(node, path) {
  let current = node
  for (const key of String(path).split('.')) {
    if (current === null || typeof current !== 'object') return null
    current = Array.isArray(current) ? current[Number(key)] : current[key]
  }
  const numeric = typeof current === 'number' ? current : Number(current)
  return Number.isFinite(numeric) ? { amount: numeric, field: path } : null
}

/**
 * 依次尝试三种主流形态，失败时保留每一次的响应片段：
 * 「查不到」必须能看见原因，这是上一版最烦人的地方。
 */
async function probeSite(site) {
  const base = normalizeBase(site.baseUrl)
  // API 密钥走 OpenAI 兼容账单；访问令牌走 new-api。任一为空就互相兜底。
  const apiKey = site.apiKey !== '' ? site.apiKey : site.token
  const tried = []

  // 1) new-api / one-api：/api/user/self
  try {
    const newApiToken = site.token !== '' ? site.token : site.apiKey
    const headers = { authorization: `Bearer ${newApiToken}`, accept: 'application/json' }
    // 用户 ID 必须是数字（控制台里的 uid），填昵称只会让服务端犯迷糊。
    if (/^\d+$/.test(site.userId)) headers['new-api-user'] = site.userId
    const { response, text } = await getText(`${base}/api/user/self`, headers)
    if (!response.ok) throw new Error(describeFailure(response, text))
    const json = JSON.parse(text)
    if (json?.success !== true) throw new Error(json?.message ?? '不是 new-api 的返回')
    const quota = Number(json?.data?.quota)
    if (!Number.isFinite(quota)) throw new Error('返回里没有 data.quota')
    const amount = quota / (site.unit > 0 ? site.unit : 500000)
    return { ok: true, protocol: 'new-api', amount, note: `quota ${quota}`, used: Number(json?.data?.used_quota ?? 0) }
  } catch (error) {
    const code = error?.name === 'TimeoutError' ? '超时（12s 无响应）' : (error?.message ?? error)
    tried.push(`new-api: ${code}`)
  }

  // 2) OpenAI 兼容账单：/v1/dashboard/billing/subscription + /usage
  try {
    const headers = { authorization: `Bearer ${apiKey}`, accept: 'application/json' }
    const sub = await getText(`${base}/v1/dashboard/billing/subscription`, headers)
    if (!sub.response.ok) throw new Error(describeFailure(sub.response, sub.text))
    const parsed = JSON.parse(sub.text)
    const limit = Number(parsed?.hard_limit_usd ?? parsed?.system_hard_limit_usd)
    if (!Number.isFinite(limit)) throw new Error('返回里没有 hard_limit_usd')
    const end = new Date()
    const start = new Date(end.getTime() - 100 * 86400000)
    const iso = (day) => day.toISOString().slice(0, 10)
    const usage = await getText(
      `${base}/v1/dashboard/billing/usage?start_date=${iso(start)}&end_date=${iso(end)}`,
      headers,
    )
    if (!usage.response.ok) throw new Error(`用量接口 ${describeFailure(usage.response, usage.text)}`)
    const usedUsd = numberOr(JSON.parse(usage.text)?.total_usage, 0) / 100
    const amount = limit - usedUsd
    // 99999999 这类是「未限额」占位符，不是余额，不能当钱显示。
    if (limit >= 1e8) {
      return { ok: true, protocol: 'openai-billing', unlimited: true, amount: null, note: '站点返回「未限额」，查不到真实余额' }
    }
    return { ok: true, protocol: 'openai-billing', amount, note: `额度 ${limit} / 已用 ${usedUsd.toFixed(2)}`, used: usedUsd }
  } catch (error) {
    tried.push(`openai-billing: ${error?.message ?? error}`)
  }

  // 3) 自研网关：自定义路径 + 可选方法/请求头/JSONPath。
  //    默认探 /v1/usage，并从返回 JSON 里按字段名找余额。
  const customPath = site.path !== '' ? site.path : '/v1/usage'
  try {
    // 有人会把完整 URL 贴进「路径」框：能直接用就直接用。
    const target = /^https?:\/\//i.test(customPath)
      ? customPath
      : `${base}${customPath.startsWith('/') ? customPath : `/${customPath}`}`
    const requestHeaders = { accept: 'application/json' }
    if (apiKey !== '') requestHeaders.authorization = `Bearer ${apiKey}`
    for (const line of String(site.headers ?? '').split('\n')) {
      const colon = line.indexOf(':')
      if (colon <= 0) continue
      const name = line.slice(0, colon).trim().toLowerCase()
      const value = line.slice(colon + 1).trim()
      if (name !== '') requestHeaders[name] = value
    }
    const init = { headers: requestHeaders }
    if (site.method === 'POST') {
      init.method = 'POST'
      init.body = '{}'
      requestHeaders['content-type'] = 'application/json'
    }
    const { response, text } = await getText(target, init)
    if (!response.ok) throw new Error(describeFailure(response, text))
    const json = JSON.parse(text)
    const hit = site.jsonPath !== '' ? readPath(json, site.jsonPath) : extractAmount(json)
    if (!hit) {
      throw new Error(
        site.jsonPath !== ''
          ? `JSONPath ${site.jsonPath} 没取到数字（前 120 字：${text.slice(0, 120)}）`
          : `返回里找不到余额字段（前 120 字：${text.slice(0, 120)}）`,
      )
    }
    return { ok: true, protocol: `gateway ${customPath}`, amount: hit.amount, note: `字段 ${hit.field}` }
  } catch (error) {
    tried.push(`gateway(${customPath}): ${error?.message ?? error}`)
  }

  // 都失败了：探一下 /api/status，把「这一站是什么软件」说出来，
  // 比只报一个 404 有用得多。
  let hint = ''
  try {
    const status = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(4000) })
    if (status.ok) {
      const text = await status.text()
      if (text.includes('SidebarModulesAdmin') || text.includes('HeaderNavModules')) {
        const newApiTrial = tried.find((item) => item.startsWith('new-api:')) ?? ''
        if (/401|403/.test(newApiTrial)) {
          hint = '这一站是 new-api，令牌被拒：填控制台里的「访问令牌」，不是 sk- 推理密钥；需要时一并填数字用户 ID'
        } else if (/timeout|aborted|超时/i.test(newApiTrial)) {
          hint = '这一站是 new-api，但 /api/user/self 超时：基地址可能不是这个域名，或站点响应慢，稍后重试'
        } else if (/404/.test(newApiTrial)) {
          hint = '这一站是 new-api，但接口 404：基地址可能要带路径前缀（如 https://x.com/api）'
        } else {
          hint = '这一站是 new-api，但三种接口都没通'
        }
      }
    }
  } catch {
    /* 探路失败不影响主结果 */
  }
  if (hint === '') {
    const triedText = tried.join(' ')
    if (/gateway\(.*\): HTTP 40[13]/.test(triedText)) {
      hint = '这一站是自研网关，令牌被拒（401/403）：确认填的是站点访问令牌；路径填它自己的余额接口（如 /v1/usage）'
    }
  }

  return { ok: false, code: 'unreachable', message: hint || '三种协议都没查通', tried, hint }
}

/** 官方余额：走 account 服务，未登录就明确说未登录。 */
async function queryOfficial(ctx) {
  const account = ctx.get?.('deepseekAccount')
  if (!account) return { ok: false, code: 'unavailable', message: '没有 account 服务' }
  try {
    const view = await account.getState()
    if (view?.status !== 'credential-stored') {
      return { ok: false, code: 'signed-out', message: '未登录 DeepSeek 账号', topUpUrl: view?.links?.topUpUrl }
    }
    const client = { version: '0.0.0', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }
    const balance = await account.getBalance(client)
    if (!balance || balance.status !== 'ready') {
      return { ok: false, code: 'failed', message: '余额查询失败' }
    }
    return {
      ok: true,
      wallets: balance.value.map((wallet) => ({ currency: wallet.currency, amount: Number(wallet.balance) })),
      bonus: Array.isArray(balance.bonusWallets)
        ? balance.bonusWallets.map((wallet) => ({ currency: wallet.currency, amount: Number(wallet.balance) }))
        : [],
      usageUrl: view?.links?.usageUrl,
    }
  } catch (error) {
    return { ok: false, code: 'failed', message: String(error?.message ?? error) }
  }
}
