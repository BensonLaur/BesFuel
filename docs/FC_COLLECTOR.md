# 阿里云 FC 地区采集与发布

FC 在杭州采集 11 个自动来源、监测 32 个公告来源，将经过解析校验的公告、价表和逐项状态写入私有 OSS。GitHub Actions 下载最新结果，针对仓库当前快照再次校验并合并，随后执行测试和 Pages 发布。广东 PowerShell 采集、原油三源采集继续在原 Windows 发布任务中执行。

2026-10-23 已完成正式接入：杭州 FC 写入私有 OSS，GitHub Actions 通过 OIDC 读取并校验结果，合并数据后发布 Pages。[首次完整发布验证](https://github.com/BensonLaur/BesFuel/actions/runs/39815255231)全部通过，线上数据与仓库提交 `bea1ff1` 的油价、原油 JSON 和浏览器数据文件逐字节一致。

## 正式运行验收

本次 FC 结果生成于北京时间 2026-10-23 00:31:45（`2026-10-22T16:31:45.339Z`），运行时为 Node.js 22.23.3，部署代码为 `aa04a48`。

| 检查项 | 本次结果 |
| --- | --- |
| FC 自动来源 | 11 项通过，0 项失败 |
| FC 公告监测 | 29 项通过，0 项失败，3 项待人工复核 |
| OSS 写入及 Actions 只读访问 | 成功，私有对象 74,219 字节 |
| 广东独立采集 | 成功，核对日期 2026-10-23 |
| 原油趋势 | Eastmoney 更新成功 |
| 发布校验 | 280 项测试、更新器故障测试、构建和浏览器检查通过 |
| Pages 发布 | 北京时间 2026-10-23 00:47 成功 |

本次对象为 `regions/20261022T163106213Z-ad2ed2a3-788a-408e-a303-f6428c67c91b.json`。待复核项是湖南、辽宁、浙江；程序保留人工核价边界，未将其计为采集失败或自动确认新的每升价格。

2026-10-23 随后完成湖南 XLS 升价及浙江不调整延续关系的人工核验，仓库据此重放上述原始结果时，公告监测为 31 项通过、1 项待复核（辽宁缺少官方升价或折算依据）。FC 部署包内的基线仍可能报告原来的 3 项待复核，发布端会针对当前仓库重新判定；本次只更新核价数据和人工导入器，采集规则摘要保持一致，无需重新部署 FC。核验依据见 [数据说明](DATA.md)。

FC 定时器已启用，每天北京时间 09:45、19:45 采集；Actions 已启用 FC 接入，计划于 10:00、20:00 发布。此处已验证手动采集和完整发布；首次自然定时触发仍需在到点后查看执行记录。2026-10-23 已在 OSS 控制台确认生命周期规则 `besfuel-regions-7d` 创建并启用：匹配 `regions/`，文件最后修改 7 天后删除，碎片清理不启用。控制台提示规则在 48 小时内生效，实际到期清理尚未发生。

## 数据边界

- FC 结果包含全部已接入来源的成功或失败状态。成功的自动来源携带官方价表，失败来源保留错误详情。湖南、辽宁等每升价尚未人工确认的公告继续列为待复核。
- Actions 重放官方价表，并根据当前仓库重新判断公告是否需要人工复核。打包时的基线不会整体替换仓库快照，广东、全国调价参考和新近人工核验的信息不会被云端旧基线覆盖。
- 超过 18 小时的结果、未来时间、缺项/重复来源、错误官网域名、同日价格冲突、回退日期或不同采集规则会阻止本次发布，线上保留此前已发布的站点。部分来源失败时只更新通过校验的地区，并在 Actions 摘要中报告失败和待复核项目。
- 每次运行写入 `regions/` 下一个带开始时间和随机标识的 JSON。消费者选择开始时间最新的对象，避免较早启动但较晚完成的任务覆盖新结果。[OSS PutObject 不支持 If-Match](https://help.aliyun.com/zh/oss/user-guide/0017-00000245)，因此不使用覆盖式 `latest.json`。
- 数据包大小上限为 5 MB；OSS 原始结果通过生命周期规则设置为 7 天后删除，Actions 下载的结果 artifact 保留 14 天。

## 生成部署包与权限文件

在提交完成、工作区干净的仓库中运行。需要 Node.js、npm、Python 3、curl 和 tar；部署包内带经过 SHA256 校验的官方 Node.js 22.23.3 Linux x64 运行时。

```powershell
npm ci --ignore-scripts
npm test
npm run package:fc -- "$env:TEMP/besfuel-fc-release"
node scripts/fc-config.cjs <阿里云账号ID> <专用Bucket名称> "$env:TEMP/besfuel-fc-settings"
```

打包输出 `besfuel-fc-collector.zip` 和 `manifest.json`。权限生成器只写本地 JSON，不创建云资源，不包含 AccessKey 或密码。正式运行使用自定义运行时，避免继续依赖已结束社区支持的 Node.js 20。[Node.js 发布状态](https://nodejs.org/en/about/previous-releases)

## 配置私有 OSS

创建专用 Bucket，地域为华东1（杭州），标准存储、本地冗余、私有读写，保留阻止公共访问，关闭版本控制。给 `regions/` 前缀配置 7 天后删除的生命周期规则。小型 JSON 不需要低频存储、传输加速、固定公网 IP 或 NAT 网关。

当前 Bucket 为 `besfuel-collector-benson-20261022`。在 Bucket 左侧的“数据管理 → 生命周期”中设置规则 `besfuel-regions-7d`：前缀填写 `regions/`（不加通配符），以最后修改时间为准，7 天后删除文件，启用规则。无需转换存储类型或配置标签、文件大小、碎片清理条件。当前列表的操作栏显示“禁用”，表示规则已开启；列表展示可能延迟 15 分钟，生效以控制台提示的 48 小时内为准。加载及删除异步进行，不表示精确到第 168 小时立即删除。该规则只清理 OSS 原始结果，GitHub 已提交的可信价格及历史仍保留。[生命周期规则说明](https://help.aliyun.com/zh/oss/user-guide/lifecycle-rules-based-on-the-last-modified-time)

FC 通过同地域 OSS 内网地址写入；Actions 通过 HTTPS 公网地址读取。两边分别使用只写和只读临时身份。Bucket、日志、请求和公网流量依照相应云产品计费。

## 配置 FC 写入角色

1. 创建 RAM 角色 `besfuel-fc-collector`，可信实体为阿里云服务，选择函数计算；信任策略对应生成的 `fc-role-trust.json`。
2. 创建自定义权限策略 `BesFuelFcWriteSnapshots`，内容为 `fc-oss-policy.json`，附加到上述角色。权限只有对专用 Bucket 的 `regions/*` 执行 `oss:PutObject`。
3. 在正式函数配置中选择该角色。FC 在每次调用中提供临时凭证，无需填写长期密钥。[FC 临时凭证说明](https://help.aliyun.com/en/landing-zone/solution-242)

## 部署正式函数

探测函数 `besfuel-source-probe` 可以保留供诊断。在控制台选择创建 **Web 函数**，新建正式函数 `besfuel-collector`，使用代码包和自定义运行时 Debian 11，上传 `besfuel-fc-collector.zip`。Web 函数提供自定义启动命令；本任务通过控制台/API 和定时器调用。控制台可能自动创建 HTTP 触发器 `defaultTrigger`，创建完成后在“触发器”页删除这一项。[创建入口说明](https://help.aliyun.com/zh/functioncompute/creating-a-web-function)

| 配置 | 值 |
| --- | --- |
| 地域 | 华东1（杭州） |
| CPU / 内存 / 磁盘 | 0.35 vCPU / 512 MB / 512 MB |
| 最小实例数 / 单实例并发 | 0 / 1 |
| 执行超时 | 900 秒 |
| 监听端口 | 9000 |
| 启动命令 | 数组模式，Command 仅一项 `/code/runtime/node` |
| 启动参数 | Args 仅一项 `/code/cloud/fc/server.cjs` |
| 函数角色 | `besfuel-fc-collector` |
| 允许默认网卡访问公网 | 开启 |
| VPC / NAS / OSS 挂载 | 不配置 |
| HTTP 触发器 | 删除控制台自动创建的 `defaultTrigger` |

数组模式是逐项输入表单，每个输入框直接填写上述路径，不加引号或方括号。部署包已保留 Node.js 的可执行权限，直接启动即可。FC 会拼接 Command 和 Args；旧配置的 `bash -c` 脚本被拆分后会出现 `chmod: missing operand`。已上传 `aa04a48` 版本部署包时，只需修改启动配置，无需重新上传。[自定义运行时启动规则](https://help.aliyun.com/zh/functioncompute/principles-1)

将 `fc-environment.json` 中的 Bucket 和地域填入函数环境变量。Debian 11 的临时角色凭证由 FC 注入 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET` 和 `ALIBABA_CLOUD_SECURITY_TOKEN`，无需手填密钥。程序兼容完整的旧版凭证请求头；请求头缺项时整体使用环境变量，避免混用不同会话的密钥和 Token。成功或异常通过 `x-fc-status` 告知平台。[自定义运行时调用协议](https://help.aliyun.com/zh/functioncompute/web-functions)、[Debian 11 凭证说明](https://help.aliyun.com/zh/functioncompute/context-and-log-format-1)、[系统环境变量](https://help.aliyun.com/zh/functioncompute/environment-variables)

先用 `{}` 手动调用一次；空测试请求会自动按 `{}` 处理。返回 `storage.written: true` 后，确认 OSS 出现对应 `regions/...json`。`healthy: false` 表示部分官网本轮失败，具体失败仍保存在结果内；写入 OSS 本身失败则函数报错，不产生新的结果对象。

再添加定时触发器 `besfuel-regions-twice-daily`，触发消息 `{}`，表达式：

```text
CRON_TZ=Asia/Shanghai 0 45 9,19 * * *
```

即北京时间每天 09:45 和 19:45，给 10:00、20:00 的 Actions 发布留出 15 分钟。若界面只接受 UTC 表达式，等价配置为 `0 45 1,11 * * *`。[FC 定时规则](https://help.aliyun.com/zh/functioncompute/time-triggers)

## 配置 GitHub 只读身份

在 RAM 的 OIDC 身份提供商中创建 `besfuel-github`：颁发者 URL 为 `https://token.actions.githubusercontent.com`，客户端 ID 为 `sts.aliyuncs.com`。通过控制台获取并核对当前证书指纹，不复制旧文档中的固定指纹。[OIDC 身份提供商说明](https://help.aliyun.com/zh/ram/manage-an-oidc-idp)

创建角色 `besfuel-github-read`，信任策略使用 `github-role-trust.json`。该策略限定 BesFuel 仓库的 `main` 分支。创建自定义策略 `BesFuelGithubReadSnapshots`，内容为 `github-oss-policy.json`，附加到该角色：只能列举 `regions/` 并读取该前缀内的对象，不能写入、删除或修改 Bucket。

Actions 取数任务单独运行，不绑定 `github-pages` environment。此仓库已启用 GitHub 的不可变主体格式，经 `gh api repos/BensonLaur/BesFuel/actions/oidc/customization/sub` 核验，`sub_claim_prefix` 为 `repo:BensonLaur@11558955/BesFuel@1392534028`，因此信任策略中的 `oidc:sub` 必须精确填写 `repo:BensonLaur@11558955/BesFuel@1392534028:ref:refs/heads/main`。旧的不带数字 ID 的格式会触发 `AuthenticationFail.NoPermission`。迁移或重命名仓库后，应重新查询实际主体配置；不要把角色信任条件扩大到任意仓库或任意分支。[GitHub 不可变主体说明](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)

在仓库 Actions Variables 中填入 `github-variables.json` 的配置：

| 变量 | 内容 |
| --- | --- |
| `BESFUEL_OSS_BUCKET` | 专用 Bucket 名 |
| `BESFUEL_ALIYUN_OIDC_PROVIDER_ARN` | OIDC 提供商 ARN |
| `BESFUEL_ALIYUN_READ_ROLE_ARN` | 只读角色 ARN |
| `BESFUEL_FC_ENABLED` | 所有云端配置完成后设为 `true` |

启用前仍执行原来的来源采集。启用后，手动运行 Pages 工作流，核对 `fetch-regions` 成功、导入摘要完整、测试和 Pages 发布成功，并检查线上数据与此次产物一致。官方凭证 Action 固定到已核对的提交版本，使用 OIDC 换取 900 秒临时凭证。[Action 源码](https://github.com/aliyun/configure-aliyun-credentials-action)

## 维护与排障

2026-10-23 第一轮自动核价升级已验收：代码包 `5b57820` 额外获取海南、江西 HTML 价表和湖南原始 XLS，正式执行返回 `counts.extra` 为 3/3 通过，GitHub 已成功读取并发布。

第二轮新增西藏、浙江、四川第二价区、吉林及云南五价区的原始正文/Word/PDF 证据。上传本轮新 ZIP 后，沿用原数组启动命令、环境变量、角色和定时器，用 `{}` 测试一次；返回结果应同时有 `counts.extra` 的 3/3 通过，以及 `counts.evidence` 的 5/5 通过、0 失败，且 `storage.written: true`。5 是证据组数，对应 11 个价区，最终核价要看发布报告。旧包继续可用，新增能力须部署后验收；详见 [自动核验](AUTO_REVIEW.md)。

2026-10-23 03:26 已完成第二轮正式部署验收：FC 运行版本 `f518e05`，上述两组计数全部通过，OSS 写入 539836 字节新快照。GitHub 运行 `39840151670` 确认新增 11 个价区全部自动核价成功并发布。后续仅调整发布端文字解析规则，不需要重新上传当前原始附件采集包。

- 官网规则变更后重新打包并部署 FC，再启用新的仓库校验规则；摘要中的“采集代码与仓库校验规则不一致”意味着两端代码需要同步。
- `AccessDenied`：检查所选函数角色或 OIDC 角色，以及 Bucket 名、前缀和授权策略。
- `OSS 尚未生成地区快照`：先执行正式 FC 函数，确认 `storage.written` 和 Bucket 内的结果对象。
- `快照已过期`：检查 FC 定时触发器最近运行、函数异常和 OSS 写入状态。不要通过修改时间字段掩盖采集故障。
- 广东独立采集偶发失败时保留此前可信价格和原核对日期，并在 Actions 摘要中显示失败；该回退步骤显式正常结束，让后续 FC 合并和发布继续进行。
- `OSS 快照超过 1000 份`：检查 `regions/` 的 7 天生命周期规则。读取器不会在清单不完整时猜测最新结果。
- 临时回退：将 `BESFUEL_FC_ENABLED` 改为 `false`，恢复原托管采集流程；其网络限制仍然存在。此前可信快照继续保留。
