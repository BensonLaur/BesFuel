# 原油来源与自动切换

## 当前选择

本地默认按 **Eastmoney → Yahoo Finance → Sina Finance** 自动尝试。两个品种均通过校验后整段替换两条曲线，页面显示实际来源、期货/CFD 口径及切换提示。下一次运行重新优先尝试 Eastmoney，主源恢复后回到主源。访客只读取 BesFuel 快照，切换不会增加上游访问量。

2026-10-19 在本机 Node.js 直连实测，未配置应用代理、未使用登录或用户令牌：

| 平台 | 实测结果 | 定位 |
| --- | --- | --- |
| 东方财富 | 现有主来源，最多 200 条日线 | 连续期货参考 |
| 新浪财经 | WTI `CL` 和布伦特 `OIL` 均 HTTP 200；分别返回 7,689／2,586 条历史，最新日期均为 2026-10-19 | 已实现的备用趋势来源，保存最近 200 条 |
| 腾讯财经 | `qt.gtimg.cn/q=hf_CL,hf_OIL` 返回 HTTP 200，报价时间为 2026-10-19 10:30 左右 | 可作即时报价核对，未验证可替代历史曲线的接口，未接入 |
| Yahoo Finance | `CL=F`／`BZ=F` 本机直连 HTTP 403；显式使用现有本地代理后 HTTP 200 | 已接入首选备用；GitHub Actions 直连仍待验证 |

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

## 晚上剩余工作

1. 获准提交后，在独立 GitHub Actions 测试中验证 Yahoo 直连和另两家的采集，避免触发现有价格自动提交及 Pages 部署流程。
2. 验证通过后再接入正式定时任务和站点打包，并检查失败时保留快照、记录状态和发布步骤的配合。本地自动选择已完成，不代表定时任务已经运行或 GitHub Actions 网络已验证。

网页接口不是面向本项目承诺兼容性的正式开放 API，仍可能改版或限制访问。技术备用不代替第三方数据授权，详见 [数据使用边界](RIGHTS.md)。
