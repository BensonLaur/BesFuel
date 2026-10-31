# BesFuel · 油价随行

面向国内燃油车主的免费、无广告单页看板：查看已接入地区的参考油价、调价观察与历史趋势，并计算每公里和本次行程的油费。

**在线使用：[打开 BesFuel](https://bensonlaur.github.io/BesFuel/)**

## 页面预览

![BesFuel 桌面看板：地区油价、调价观察、行程油费和历史趋势](docs/images/besfuel-dashboard.png)

截图使用 2026-09-29 的数据快照，以广东 92 号汽油和 120 公里行程为例；截图价格不代表当前价格。

## 如何使用

1. 打开在线页面；也可以下载仓库后直接双击 `index.html`，无需安装依赖或启动服务。
2. 选择地区和油号。价格卡片会显示参考价、适用范围、数据来源和核对日期；历史图可查看已核实的价格变化。
3. 输入本次里程和百公里油耗，即可查看每公里与全程油费。默认使用已收录的参考价，也可输入加油站实际成交价。

常用地区、油号和百公里油耗保存在当前浏览器本地。直接打开本地文件时，页面使用仓库内置的数据快照；通过 HTTP(S) 访问时，页面还会在后台检查本站的 `data/prices.json`，有更新就刷新报价和趋势。

油费仅计算燃油成本：每公里油费 = 百公里油耗 × 每升油价 ÷ 100；全程油费 = 每公里油费 × 本次里程，不包括停车费、过路费等。

## 主要功能

- 展示已接入地区或价区的 92、95 号汽油及 0 号柴油官方参考价，并附公告来源和核对日期；缺少可靠价格时明确显示缺价。
- 根据已核实的公告绘制历史阶梯趋势图，支持鼠标、触摸和键盘查看节点日期与价格。
- 分开显示已生效地区价格、推算的下次调价窗口和第三方全国市场估算；本轮估算超过两天后保留数值、日期和来源，弱化显示并标注仅作历史参考，跨周期后隐藏。
- 在“调价观察”中打开原油趋势参考，查看 WTI、布伦特近期走势、盘中快照、实际来源和采集时间。
- 根据里程、油耗和每升油价计算行程成本。所有功能免费；自愿支持入口仅在点击后显示。

## 数据说明

页面采用各地公布的最高零售价作为参考，并非加油站实时成交价。98 号及尚未核实的地区不使用邻近地区或其他油号推算；实际油费可用手动输入的成交价计算。已接入地区、价区和历史记录的范围见 [数据维护说明](docs/DATA.md)，仓库数据主文件是 [data/prices.json](data/prices.json)。

下次调价窗口按工作日规则与放假安排推算；涨跌估算来自独立第三方，属于全国参考信息，不是官方公布的当地每升调幅。页面会标明来源与计算日期；超过两天的本轮估算标注陈旧提示，等待本轮更新，跨周期后隐藏旧估算。GitHub Actions 定时执行[数据核对与发布](.github/workflows/pages.yml)，但任务可能延迟，部分图片、PDF 公告仍需人工核价；访客浏览器只读取本站的数据文件，不直接抓取政府网站。

## 开发与验证

“原油趋势参考”：在“调价观察”右上角打开，切换 WTI／布伦特及近 1／3／6 个月走势。运行 `npm run preview` 后访问 `http://127.0.0.1:4173/`，或直接打开 `index.html`。页面读取本站快照，`file://` 可离线查看；盘中记录与已完成日线分别展示。运行 `npm run update:crude` 更新原油快照，`npm run validate:crude` 校验 JSON 与离线副本。原油采集接入现有 Pages 工作流，在北京时间每天 10:00、20:00 运行；`npm run build` 生成包含原油功能的 `public/` 站点并校验两套快照。第三方行情不属于代码的 MIT 许可，详见 [使用边界](docs/RIGHTS.md)。

`npm run update:crude` 每次按 **Eastmoney → Yahoo Finance → Sina Finance** 自动选择来源；两个品种均通过校验才整体更新，主源恢复后自动优先使用主源。全部失败保留原价格和采集时间，仅记录本次检查失败，页面显示提示。`npm run update:crude -- --check` 只检查、不改快照。需要单独测试时运行 `npm run check:crude-yahoo` 或 `npm run check:crude-backup`，手动指定来源用 `--source=eastmoney/yahoo/sina`。Yahoo 在本机可显式配置 `BESFUEL_YAHOO_PROXY` 使用现有本地代理；不改 Windows 系统代理。Yahoo 的 NYMEX 布伦特期货和 Sina 的 CFD 均与主源口径有别，页面会显示来源、价格口径及切换提示。2026-10-22 晚间 Actions 直连检查中三家均通过两个品种的完整校验；Yahoo 早间曾缺失历史收盘价，晚间复测已恢复。自动模式仅采用当次通过校验的来源。使用步骤和运行证据见 [原油来源与自动切换](docs/CRUDE_SOURCES.md)。

直接使用页面不需要 Node.js。运行验证脚本建议使用与 CI 相同的 Node.js 22；`npm run test:updater` 需要 PowerShell，`npm run smoke` 默认使用 Windows Edge，也可通过 `BROWSER_PATH` 指定 Chromium 浏览器。

```powershell
npm test
npm run test:updater
npm run validate:data
npm run validate:crude
npm run build
npm run smoke
```

运行 `npm run check:sources` 可只读检查真实官网来源；采集失败会非零退出，详细结果和网络限制见 [来源健康检查](docs/SOURCE_HEALTH.md)。

业务测试通过 `tests/helpers/snapshot.cjs` 构造独立样本，模拟的浏览器场景同时固定数据和时钟；仓库快照的一致性校验与真实页面冒烟仍使用实际数据。CI 在采集前后运行测试，失败时也上传 `automatic-review` 和 `ci-diagnostics-<attempt>` 产物，包含检查退出码、日志、输入快照和 FC 原始证据。

调查历史 FC 失败时，下载对应运行的 `fc-regions.json`，并准备该运行提交中的 `data/prices.json` 作为采集前快照。安装 `npm ci --ignore-scripts` 及 `scripts/review-requirements.txt` 中经哈希锁定的 Python 依赖后，可以执行：

```powershell
node scripts/replay-fc.cjs <fc-regions.json> <prices-before.json> <仓库外的空目录>
```

重放在隔离副本中执行采集前后的完整检查（Node、Python、PowerShell、快照校验、构建及浏览器冒烟），同时验证重复应用幂等和旧核验记录不能覆盖新价格。采集只读取所提供的 FC 证据，保留原始时间戳并在证据捕获时刻校验时效；不会抓取实时来源、修改工作区数据或发布。输出目录保留全部结果，便于复查。

地区采集可通过阿里云杭州 FC 执行，结果保存到私有 OSS，由 Actions 使用 OIDC 临时身份读取、校验并发布。部署包、最小权限和定时配置见 [FC 采集接入](docs/FC_COLLECTOR.md)。完成云端配置并启用 `BESFUEL_FC_ENABLED` 后切换；广东和原油继续使用原发布任务。

更新地区价格和核验来源的方法见 [数据维护说明](docs/DATA.md)；部署流程与实现边界见 [实施方案](docs/IMPLEMENTATION_PLAN.md)。

## 项目结构

```text
BesFuel/
├─ index.html           页面结构
├─ styles.css           响应式样式
├─ app.js               页面交互与历史图
├─ lib/calc.js          计算与输入校验
├─ data/                带来源的价格快照及浏览器副本
├─ resources/support/   微信、支付宝收款原图
├─ scripts/             数据更新和校验脚本
├─ tests/               计算、数据和浏览器验证
├─ docs/                数据维护、使用边界、实施方案和截图
└─ .github/workflows/   定时核对和 Pages 发布
```

## 后续方向

继续接入有可靠官方每升价格的地区、补齐已接入地区的历史记录，并核验市场估算来源的稳定性。收款图片仍需用真实手机持续确认识别结果和收款主体。

## 许可

自编写代码与文档采用 [MIT License](LICENSE)。收款图片、政府公告和其他第三方数据的权利不随代码许可证转移，详情见 [使用边界](docs/RIGHTS.md)。
