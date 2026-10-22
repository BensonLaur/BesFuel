# 原油来源与自动切换

## 当前选择

默认按 **Eastmoney → Yahoo Finance → Sina Finance** 自动尝试。两个品种均通过校验后整段替换两条曲线，页面显示实际来源、期货/CFD 口径及切换提示。下一次运行重新优先尝试 Eastmoney，主源恢复后回到主源。访客只读取 BesFuel 快照，切换不会增加上游访问量。

2026-10-19 在本机 Node.js 直连实测，未配置应用代理、未使用登录或用户令牌：

| 平台 | 实测结果 | 定位 |
| --- | --- | --- |
| 东方财富 | 现有主来源，最多 200 条日线 | 连续期货参考 |
| 新浪财经 | WTI `CL` 和布伦特 `OIL` 均 HTTP 200；分别返回 7,689／2,586 条历史，最新日期均为 2026-10-19 | 已实现的备用趋势来源，保存最近 200 条 |
| 腾讯财经 | `qt.gtimg.cn/q=hf_CL,hf_OIL` 返回 HTTP 200，报价时间为 2026-10-19 10:30 左右 | 可作即时报价核对，未验证可替代历史曲线的接口，未接入 |
| Yahoo Finance | `CL=F`／`BZ=F` 本机直连 HTTP 403；显式使用现有本地代理后 HTTP 200 | 已接入首选备用候选；Actions 追加实测见下文 |

2026-10-19 10:43—10:44（北京时间）追加测试：系统代理开关保持关闭，使用 curl 显式指定现有本地代理 `127.0.0.1:7890`，并携带常规浏览器 User-Agent。Yahoo `CL=F`、`BZ=F` 的 `interval=1d&range=6mo` 请求均 HTTP 200，各返回 127 条记录；开高低收为有限数、价格范围关系、时间戳递增及无未来记录检查通过。两者最新记录时间分别为北京时间 10:33:38／10:34:04；最后一点为盘中快照。直连 WTI 仍返回地区限制 HTTP 403。

Yahoo 适配器随后使用 `range=1y` 验证成功，截取最近 200 条，其中 199 条已完成日线及 2026-10-19 的盘中快照。它在当前代理出口可取数，无需开启 Windows 系统代理；此前出现过 HTTP 429，单次成功不保证长期稳定。`BZ=F` 元数据为 NYMEX Brent Crude Oil Last Day Financial Futures，与东方财富的 ICE 布伦特连续期货不是同一合约口径。

一次直连成功不代表各地、各运营商或 GitHub Actions 始终可用。腾讯与新浪的上游数据是否独立未核实，不将其视为完全独立的双重保障。

新浪是运营多年的国内互联网平台，其 [WTI 页面](https://finance.sina.com.cn/futures/quotes/CL.shtml) 和 [布伦特页面](https://finance.sina.com.cn/futures/quotes/OIL.shtml) 明确标注 CFD（差价合约，并非期货）。它们可作原油趋势参考，但不能与东方财富的连续期货逐点等同；合约选择、换月、报价时点等也可能造成差异。

## 检查与切换命令

自动选择并更新本地数据；只检查时加 `--check`：

```powershell
npm run update:crude
npm run update:crude -- --check
```

单独检查某个备用，不修改本站文件：

```powershell
npm run check:crude-backup
npm run check:crude-yahoo
```

本机若需让 Yahoo 请求经过现有代理，在当前 PowerShell 终端设置：

```powershell
$env:BESFUEL_YAHOO_PROXY = 'http://127.0.0.1:7890'
npm run check:crude-yahoo
```

这是当前终端及其子进程的配置，不修改 Windows 系统代理，也不让 Eastmoney 或 Sina 请求经过这个代理。需已启动本地代理服务，开启“系统代理”开关不是必要条件。代理模式调用 curl（Windows 为 curl.exe）；不配置该变量时 Yahoo 使用普通直连请求。遇到 HTTP 403、429 等访问限制不立即重试，网络或服务端暂时错误最多重试一次。不要在 GitHub Actions 设置本机的 `127.0.0.1:7890`。

维护者可为本次运行手动指定来源，不执行后续备用：

```powershell
npm run update:crude -- --source=sina
npm run update:crude -- --source=yahoo
npm run validate:crude
```

恢复东方财富：

```powershell
npm run update:crude -- --source=eastmoney
npm run validate:crude
```

下次普通运行重新自动排序，不永久固定在手动指定的来源。来源标签为 Eastmoney、Yahoo Finance、Sina Finance；价格口径分别显示期货连续日线、NYMEX 期货日线、CFD 差价合约日线。以上命令仅更新本地文件，不创建提交，也不部署站点。

## 切换行为

- 每个候选必须同时取得两条有效曲线，且各有至少 90 条已完成历史、最新参考日期不超过四个自然日、不回退。任一失败就拒绝这个来源整批数据，自动模式继续下一个候选；手动模式保留旧数据。
- 两条曲线整段替换，不把备用源的新点追加到主来源历史中，也不把源间价差算成当日涨跌。涨跌由同一来源的相邻参考点计算。
- 继续使用同一来源时，已完成历史被修订会拒绝该候选；自动模式仍可尝试不同来源的整段曲线。切换不保证能恢复主来源缺失期间的同口径期货记录。
- 全部失败时保留原价格、行情日期、品种采集时间及顶层 updatedAt，仅记录 collection 检查失败状态并退出非零。页面提示本次更新未成功，不能因刚检查过而把旧行情标成新数据。首次没有旧快照且所有来源都失败时不生成数据文件。通过备用源成功更新退出零，失败尝试仍保留在日志和 collection 中。
- 来源 URL、品种、采集时间、美元/桶单位、历史及盘中日期均写入快照，并经浏览器与离线副本校验。
- 新浪 JSONP 只按 JSON 解析，不执行其中的 JavaScript。它返回的部分开盘价与高低范围不一致，因此仅采用收盘参考字段，并检查该值在高低范围内；不使用这些数据绘制开高低收蜡烛图。
- Yahoo 识别日线与实际报价时间，纽约周日晚的最新记录归入周一交易日，冬夏时由 Intl 处理。部分缺失 OHLC、错品种、错市场、未来时间戳、日期倒序等会拒绝；全空价格记录跳过，浮点价格规范到美分。

## GitHub Actions 实测与定时更新

独立直连检查与正式发布分开执行。定时更新、失败状态发布和站点打包统一接入 Pages 工作流，下面记录来源实测结果及维护步骤。

2026-10-22 北京时间 08:28，在独立分支以 `windows-latest`、Node.js 22、不配置代理执行 [三源直连检查](https://github.com/BensonLaur/BesFuel/actions/runs/39699889023)。该工作流只有读取仓库权限，不写快照、不提交、不部署。

| 来源 | 结果 |
| --- | --- |
| Eastmoney | 两个品种均通过；各 199 条已完成日线，截至 10-21，另有 10-22 盘中快照 |
| Yahoo Finance | 能直连返回行情，但两种原油均因 OHLC 不完整被拒绝；本机经代理复核发现 10-21 的 `close` 为 `null` |
| Sina Finance | 两个品种均通过；各 199 条已完成日线，截至 10-21，另有 10-22 盘中快照 |

Yahoo 早间验证失败不等于网络不可达，也不能把 HTTP 成功当作数据可用。保持原有校验：缺少收盘价时不补值、不跳过这条部分缺失记录；自动模式继续尝试 Sina。三源仍按既定顺序尝试，Yahoo 只有在数据恢复完整并通过校验后才会被采用。

2026-10-22 北京时间 20:05，以相同校验规则完成 [晚间三源直连复测](https://github.com/BensonLaur/BesFuel/actions/runs/39775517088)，Eastmoney、Yahoo Finance、Sina Finance 全部通过。Yahoo 的 WTI 和布伦特均取得 199 条已完成日线（截至 10-21），另有 10-22 盘中快照；此前缺失收盘字段的问题已恢复。本次没有放宽 OHLC 校验，后续仍逐次检查，不能由这次成功推定上游长期稳定。

正式流程复用 `.github/workflows/pages.yml` 的北京时间每天 10:00、20:00 定时任务及手动、main 推送触发。原油快照和成品油快照一并提交和打包；定时任务可能延迟，不承诺实时行情。访客不直接访问第三方接口。

2026-10-22 首次完整接入后的 [正式采集与 Pages 发布](https://github.com/BensonLaur/BesFuel/actions/runs/39775549077)成功：Actions 中 251 项测试、更新器故障测试、站点打包和浏览器检查全部通过。实际发布的原油快照由 Eastmoney 于北京时间 20:12 采集；发布后再次验证线上弹窗、曲线、来源标签、手机布局，以及线上 JSON 与离线副本和部署提交的一致性，均通过。

`npm run update:crude:ci` 写入本轮检查摘要。所有来源失败时仅在旧 JSON/JS 一致且有效的条件下继续发布，并记录 Actions 警告和页面失败状态；快照损坏、写入或测试失败时停止部署。普通 `npm run update:crude` 全部失败仍以非零退出。`npm run build` 后可设置 `$env:BESFUEL_SITE_DIR = 'public'` 再执行 `npm run smoke`，直接检查将上传的站点产物。

网页接口不是面向本项目承诺兼容性的正式开放 API，仍可能改版或限制访问。技术备用不代替第三方数据授权，详见 [数据使用边界](RIGHTS.md)。
