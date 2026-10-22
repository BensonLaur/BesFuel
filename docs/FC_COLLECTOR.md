# 阿里云 FC 地区采集与发布

FC 在杭州采集 11 个自动来源、监测 32 个公告来源，将经过解析校验的公告、价表和逐项状态写入私有 OSS。GitHub Actions 下载最新结果，针对仓库当前快照再次校验并合并，随后执行测试和 Pages 发布。广东 PowerShell 采集、原油三源采集继续在原 Windows 发布任务中执行。

2026-10-22 22:03 北京时间的杭州探测取得 215 次成功请求：自动来源 11 项通过，监测 29 项通过、3 项待复核、0 项失败，耗时 35.647 秒，采样峰值内存 53 MiB。该次使用只读探测函数；正式接入需要完成下面的 OSS、角色、部署和 Actions 配置。

## 数据边界

- FC 结果包含全部已接入来源的成功或失败状态。成功的自动来源携带官方价表，失败来源保留错误详情。湖南、辽宁等每升价尚未人工确认的公告继续列为待复核。
- Actions 重放官方价表，并根据当前仓库重新判断公告是否需要人工复核。打包时的基线不会整体替换仓库快照，广东、全国调价参考和新近人工核验的信息不会被云端旧基线覆盖。
- 超过 18 小时的结果、未来时间、缺项/重复来源、错误官网域名、同日价格冲突、回退日期或不同采集规则会阻止本次发布，线上保留此前已发布的站点。部分来源失败时只更新通过校验的地区，并在 Actions 摘要中报告失败和待复核项目。
- 每次运行写入 `regions/` 下一个带开始时间和随机标识的 JSON。消费者选择开始时间最新的对象，避免较早启动但较晚完成的任务覆盖新结果。[OSS PutObject 不支持 If-Match](https://help.aliyun.com/zh/oss/user-guide/0017-00000245)，因此不使用覆盖式 `latest.json`。
- 数据包大小上限为 5 MB；OSS 原始结果保留 7 天，Actions 下载的结果 artifact 保留 14 天。

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

FC 通过同地域 OSS 内网地址写入；Actions 通过 HTTPS 公网地址读取。两边分别使用只写和只读临时身份。Bucket、日志、请求和公网流量依照相应云产品计费。

## 配置 FC 写入角色

1. 创建 RAM 角色 `besfuel-fc-collector`，可信实体为阿里云服务，选择函数计算；信任策略对应生成的 `fc-role-trust.json`。
2. 创建自定义权限策略 `BesFuelFcWriteSnapshots`，内容为 `fc-oss-policy.json`，附加到上述角色。权限只有对专用 Bucket 的 `regions/*` 执行 `oss:PutObject`。
3. 在正式函数配置中选择该角色。FC 在每次调用中提供临时凭证，无需填写长期密钥。[FC 临时凭证说明](https://help.aliyun.com/en/landing-zone/solution-242)

## 部署正式函数

探测函数 `besfuel-source-probe` 可以保留供诊断。新建正式函数 `besfuel-collector`，使用代码包和自定义运行时 Debian 11，上传 `besfuel-fc-collector.zip`。

| 配置 | 值 |
| --- | --- |
| 地域 | 华东1（杭州） |
| CPU / 内存 / 磁盘 | 0.35 vCPU / 512 MB / 512 MB |
| 最小实例数 / 单实例并发 | 0 / 1 |
| 执行超时 | 900 秒 |
| 监听端口 | 9000 |
| 启动命令 | `/bin/bash` |
| 启动参数 | 第一项 `-c`；第二项见下面的命令 |
| 函数角色 | `besfuel-fc-collector` |
| 允许默认网卡访问公网 | 开启 |
| VPC / NAS / OSS 挂载 | 不配置 |
| HTTP 触发器 | 不创建 |

第二项启动参数：

```sh
chmod 755 /code/runtime/node && exec /code/runtime/node /code/cloud/fc/server.cjs
```

将 `fc-environment.json` 中的 Bucket 和地域填入函数环境变量。运行时从 FC 的请求头取得临时凭证，成功或异常通过 `x-fc-status` 告知平台。[自定义运行时调用协议](https://help.aliyun.com/zh/functioncompute/web-functions)、[凭证请求头](https://help.aliyun.com/zh/functioncompute/context-and-log-format-1)

先用 `{}` 手动调用一次。返回 `storage.written: true` 后，确认 OSS 出现对应 `regions/...json`。`healthy: false` 表示部分官网本轮失败，具体失败仍保存在结果内；写入 OSS 本身失败则函数报错，不产生新的结果对象。

再添加定时触发器 `besfuel-regions-twice-daily`，触发消息 `{}`，表达式：

```text
CRON_TZ=Asia/Shanghai 0 45 9,19 * * *
```

即北京时间每天 09:45 和 19:45，给 10:00、20:00 的 Actions 发布留出 15 分钟。若界面只接受 UTC 表达式，等价配置为 `0 45 1,11 * * *`。[FC 定时规则](https://help.aliyun.com/zh/functioncompute/time-triggers)

## 配置 GitHub 只读身份

在 RAM 的 OIDC 身份提供商中创建 `besfuel-github`：颁发者 URL 为 `https://token.actions.githubusercontent.com`，客户端 ID 为 `sts.aliyuncs.com`。通过控制台获取并核对当前证书指纹，不复制旧文档中的固定指纹。[OIDC 身份提供商说明](https://help.aliyun.com/zh/ram/manage-an-oidc-idp)

创建角色 `besfuel-github-read`，信任策略使用 `github-role-trust.json`。该策略限定 BesFuel 仓库的 `main` 分支。创建自定义策略 `BesFuelGithubReadSnapshots`，内容为 `github-oss-policy.json`，附加到该角色：只能列举 `regions/` 并读取该前缀内的对象，不能写入、删除或修改 Bucket。

Actions 取数任务单独运行，不绑定 `github-pages` environment，因此 OIDC 主体为 `repo:BensonLaur/BesFuel:ref:refs/heads/main`。不要把角色信任条件扩大到任意仓库或任意分支。

在仓库 Actions Variables 中填入 `github-variables.json` 的配置：

| 变量 | 内容 |
| --- | --- |
| `BESFUEL_OSS_BUCKET` | 专用 Bucket 名 |
| `BESFUEL_ALIYUN_OIDC_PROVIDER_ARN` | OIDC 提供商 ARN |
| `BESFUEL_ALIYUN_READ_ROLE_ARN` | 只读角色 ARN |
| `BESFUEL_FC_ENABLED` | 所有云端配置完成后设为 `true` |

启用前仍执行原来的来源采集。启用后，手动运行 Pages 工作流，核对 `fetch-regions` 成功、导入摘要完整、测试和 Pages 发布成功，并检查线上数据与此次产物一致。官方凭证 Action 固定到已核对的提交版本，使用 OIDC 换取 900 秒临时凭证。[Action 源码](https://github.com/aliyun/configure-aliyun-credentials-action)

## 维护与排障

- 官网规则变更后重新打包并部署 FC，再启用新的仓库校验规则；摘要中的“采集代码与仓库校验规则不一致”意味着两端代码需要同步。
- `AccessDenied`：检查所选函数角色或 OIDC 角色，以及 Bucket 名、前缀和授权策略。
- `OSS 尚未生成地区快照`：先执行正式 FC 函数，确认 `storage.written` 和 Bucket 内的结果对象。
- `快照已过期`：检查 FC 定时触发器最近运行、函数异常和 OSS 写入状态。不要通过修改时间字段掩盖采集故障。
- `OSS 快照超过 1000 份`：检查 `regions/` 的 7 天生命周期规则。读取器不会在清单不完整时猜测最新结果。
- 临时回退：将 `BESFUEL_FC_ENABLED` 改为 `false`，恢复原托管采集流程；其网络限制仍然存在。此前可信快照继续保留。
