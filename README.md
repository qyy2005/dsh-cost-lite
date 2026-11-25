# dsh-cost-lite

把「这次会话花了多少钱」做成一个数字。**不是仪表盘。**

DeepSeek Harness 的费用精简版插件：本会话消耗、今日/本月、区间消耗、每回合费用、官方与中转站余额、官方峰谷倒计时、价格自动同步。没有图表、没有多币种、没有侧栏多布局。

## 它做什么

| 位置 | 内容 |
|---|---|
| 输入框下方一行 | `¥0.83 · 今日 ¥12.40 · 余 ¥28.36 · 谷 17h` |
| 每个回合末尾（`用量 4M tok` 左边） | `¥0.1417` |
| 点开上面那一行 | 面板：本会话/今日/本月、缓存命中率、区间消耗（按模型分组）、余额卡 |
| 设置 → 费用 | 价目表、预算、峰谷、余额站点、会话行末金额开关 |

## 数据从哪来

- **用量**：会话日志里 `assistant/message` 的 `usage`（input / output / cacheRead / cacheWrite / reasoning）。
  `usage.outputTokens` 不含思考过程，思考 token 从流式 `reasoning-chunks` 按字符估算（约 2.6 字符/token），面板上标为估算。
- **冷会话**：`ctx.sessionQuery.readSession`，只读，不改写任何日志。
- **回收站**：`<DSH_HOME>/session-trash` 里的已删除会话照样计费，插件会解这些「拼接式 zstd 日志」（逐帧 magic 解压）并计入。
- **不建账本**：只在 `<DSH_HOME>/cost-lite/index.json` 里按「会话 × 天 × 模型 × 峰谷 × 价目版本」累计 token 数量，金额永远按当前价目表现算。索引删掉可重建。

## 计价

- 官方口径（2026-09-10 起）：工作日 09:00–12:00、14:00–18:00 为峰时，其余含周末与法定节假日为谷时；价目表填峰时价，谷时乘模型的谷价倍率。
- 中转站**没有峰谷**，只有倍率；插件对非 DeepSeek 渠道一律按倍率计价。
- 非 token 计费：`web_search` / `web_fetch` 按官方 ¥5 / 1000 次计入，面板上单列。
- **价格自动同步**：每 6 小时（及启动时）拉官方中文价格页并核对；也可手动同步。
- **锁价（可选）**：开启后改价目表只影响之后的调用，历史按改价前的版本固化。

## 余额

- 官方：`ctx.deepseekAccount.getBalance`，未登录显示未登录。
- 中转站：依次尝试
  1. `GET {root}/api/user/self`（new-api，需要访问令牌，部分站还要数字用户 ID）
  2. `GET {root}/v1/dashboard/billing/subscription` + `/usage`（OpenAI 兼容账单，用 `sk-` 密钥）
  3. `GET {root}{路径 或 /v1/usage}`（自研网关，从 JSON 里按字段名找余额）

  基地址填不填 `/v1` 都行。三种都不通会探 `/api/status` 判断站点类型并给出具体原因。
- 部分站返回 `99999999` 表示「未限额」，插件显示「未限额」而不是当钱显示。
- 部分站返回美元（`quota / 500000`），用每个站点的「换算倍率」换算成人民币。

## 已知限制

- 中转站能否查余额取决于站点是否开放接口，与插件无关。
- 与非 token 计费、失败重试、已被彻底删除的会话相关的差额，无法从本地日志完全还原；插件不乘校准系数。
- 思考 token 为估算值，单日误差约 2–5%。

## 安装

```bash
plugin_manager install_bundle  target: file:<本仓库路径>
```

或放到 profile 的 `node_modules` 下并在 `cordis.patch.yml` 里插入：

```yaml
- insert:
    - id: dsh-cost-lite
      name: 'dsh-cost-lite'
```

## 卸载

```bash
plugin_manager set_plugin  target: cost-lite  enabled: false
```

或直接删除 `node_modules/dsh-cost-lite` 与 `cordis.patch.yml` 里对应行。索引与配置在 `<DSH_HOME>/cost-lite/`，可一并删除。

## License

MIT
