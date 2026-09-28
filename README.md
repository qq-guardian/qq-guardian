<p align="center">
  <img src="./plugin-icon.png" alt="QQ Guardian 图标" width="180" />
</p>

# QQ Guardian

QQ Guardian 是一个面向 QQ 群管理的安全守护工具。它可作为 NapCat 插件运行，也可作为独立 OneBot v11 服务与 SnowLuma 配合运行；两种方式使用相同的业务模型和 WebUI，并支持迁移既有群规与 SQLite 业务数据。

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.6.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue)](LICENSE)
[![NapCat](https://img.shields.io/badge/NapCat-Plugin-orange)](https://github.com/NapNeko/NapCatQQ)
[![SnowLuma](https://img.shields.io/badge/SnowLuma-OneBot%20v11-6D5DFB)](https://snowluma.github.io/)

## 功能

- 按群独立配置防护、提醒、入群审批方式和群规；新发现的群默认不启用高影响防护。
- 支持人工审核、自动通过、自动拒绝和验证码入群验证，以及关键词、正则和云端情报筛查。
- 识别广告、诈骗、赌博、短链接、重复消息、刷屏等风险内容，并按群规执行撤回、禁言、踢出、通知或留档。
- 提供黑名单、处罚记录、反规避处理、审计记录、统计和健康状态。
- 支持入群欢迎、定时宵禁，以及群主/管理员可直接使用的群内管理命令。
- 通过 WebUI 管理群组、审批、黑名单、处罚、风险规则和系统设置。
- 支持保留现有 `config.json` 与 SQLite 数据的一次性影子迁移；迁移前会创建校验过的备份，验证失败时不会重置或静默丢弃数据。
- NapCat 与 SnowLuma 的 OneBot 标识符统一使用十进制字符串；64 位 QQ、群、消息与操作人 ID 不会经过 JavaScript 浮点数转换或在 WebUI 中被舍入。

## 选择部署方式 / Deployment policy

SnowLuma is the preferred modern standalone provider for new deployments.
NapCat remains fully supported as a legacy-compatible in-process provider for
existing NapCat installations. Both routes use the same Guardian business
logic; choose the provider that matches the host you already operate.

| 使用场景 | 选择 | 入口 |
| --- | --- | --- |
| 新部署、SnowLuma、Docker、Windows 原生、WSL2、宝塔或 1Panel | SnowLuma 独立服务（首选） | [SnowLuma 完整部署教程](docs/deployment/snowluma.md) |
| 已运行 NapCat，想把 Guardian 作为插件启用 | NapCat 插件（兼容路径） | [NapCat 安装与使用](#napcat-插件) |

## NapCat 插件

### 安装

1. 从 [Releases](https://github.com/ShiYuPIay/qq-guardian/releases/latest) 下载 `napcat-plugin-qq-guardian.zip`。
2. 在 NapCat 插件目录创建 `napcat-plugin-qq-guardian` 文件夹，并把 ZIP 内容解压到该文件夹。
3. 在 NapCat 的插件管理界面启用 QQ Guardian，然后按 NapCat 的方式重载或重启。

安装后的目录应直接包含 `index.mjs`、`package.json`、`plugin.json` 和 `webui/`；不要额外套一层同名目录。

### 首次使用

1. 从 NapCat 的插件页面打开 **QQ Guardian** WebUI。
2. 仅当用户表为空时，首次启动才会创建管理员：可提供 `QQ_GUARDIAN_BOOTSTRAP_USERNAME` 和 `QQ_GUARDIAN_BOOTSTRAP_PASSWORD`，未提供时 Guardian 会在自己的数据目录创建一次性 `bootstrap-credentials.json`，使用它登录后该文件会被删除。非空安装若没有可用超级管理员，不会自动新增特权账户，必须执行[受控恢复流程](docs/security/super-admin-recovery.md)。
3. 在“群组管理”中刷新群列表，逐个确认需要启用防护的群，再保存设置。
4. 在“群规则”中选择审批方式、风险处理动作、欢迎语和宵禁时间；在黑名单、处罚和审计页面核对日常操作。

## SnowLuma 独立服务

SnowLuma 部署使用单独的发布包 `qq-guardian-snowluma.zip`。推荐从本仓库提供的 Docker Compose sidecar 开始：SnowLuma 负责 QQ 与 OneBot，Guardian 以低权限独立服务连接其 WebSocket，不需要把 OneBot 端口暴露到公网。

完整教程覆盖以下环境：

- Linux Docker / Docker Compose；
- Windows 原生 SnowLuma；
- Windows + Docker Desktop；
- WSL2；
- 原生 Linux；
- Android / Termux（实验性）；
- BT Panel（宝塔）、1Panel 与其他兼容 Compose 的面板。

请从 [SnowLuma 完整部署教程](docs/deployment/snowluma.md) 开始。它包含发布包校验、首次扫码登录、SnowLuma OneBot `wsServers` 的 `Universal` 配置、持久卷、备份、迁移、回滚和 SDK 备用连接说明。

## 日常使用

### WebUI

使用 WebUI 完成绝大多数管理工作：

1. 在“群组管理”确认机器人账号与群列表，并开启目标群的防护。
2. 在“群规则”设置入群审批、关键词/正则、风险动作、欢迎语和宵禁。
3. 在“入群审批”“黑名单”“处罚记录”“审计日志”中处理日常事件并追溯操作。
4. 修改规则后使用页面提供的保存操作，再通过一条低风险测试消息或测试申请确认结果。

### 群内命令

群主、群管理员和配置中的超级管理员可在已启用防护的群内使用默认前缀 `/guard`：

| 命令 | 用途 |
| --- | --- |
| `/guard help` | 查看可用命令。 |
| `/guard status` | 查看本群防护状态。 |
| `/guard mute <@成员或QQ号> [分钟]` | 禁言成员。 |
| `/guard unmute <@成员或QQ号>` | 解除禁言。 |
| `/guard kick <@成员或QQ号>` | 踢出成员。 |
| `/guard ban <@成员或QQ号> [原因]` | 加入本群黑名单并踢出。 |
| `/guard unban <@成员或QQ号>` | 移出本群黑名单并撤销相应踢出记录。 |

命令权限由 QQ 群角色与 Guardian 的超级管理员配置共同控制。非管理员消息不会因以命令前缀开头而绕过风险检测。
`mute`、`kick` 和 `ban` 只会在 OneBot 返回与目标群和账号一致的有效成员角色后执行；查询失败、超时、响应异常或无法确认目标仍在群内时均会安全拒绝。当前 `ban` 是“踢出后加入本群黑名单”的组合操作，不会为已离群账号隐式创建预先拉黑记录。

自动处罚升级采用两套独立计数：`escalateToKickAfter` 只统计尚未撤销且尚未过期的有效处罚，`escalateToBlacklistAfter` 只统计尚未撤销且尚未过期的踢出记录，禁言绝不会计入拉黑阈值。任一阈值设为 `0` 表示禁用对应的自动升级；普通踢出记录没有到期时间，因此在明确撤销前持续计数。每次自动升级都会在审计记录中写入实际计数和阈值。

## 数据与安全

- 不要将 SnowLuma WebUI、noVNC/VNC、OneBot HTTP/WS 或 Guardian WebUI 直接暴露到公网；远程访问应使用受保护的 VPN、SSH 隧道或已鉴权的反向代理。
- 不要把 OneBot token、Guardian 管理员密码、`.env`、`config.json`、SQLite 数据库或迁移备份提交到仓库或发送到不可信位置。
- 用户管理会阻止删除或降级最后一名未锁定且已设置密码的超级管理员；管理员全部不可用时，使用[受控恢复流程](docs/security/super-admin-recovery.md)，不要直接修改 SQLite。
- 人工审核默认不会信任申请人填写的“朋友推荐”等通用话术。内置通过关键词是高风险显式选项；优先使用每群自定义的可信准入规则。
- 远端情报默认仅观察。只有超级管理员为每个 Feed 固定精确 SHA-256 并显式切换到 `enforce` 后，远端数据才可触发审核或处罚；详见 [远端情报信任策略](docs/security/intel-feeds.md)。
- WebUI 只把符合 SemVer 的发布标签和受限的 GitHub HTTPS 地址视为可安装版本；发布说明按纯文本处理，自动下载还必须同时提供可校验的 `.sha256` 文件。
- 升级、迁移或重建前保留 Guardian 的配置与数据；Docker 环境不要使用 `docker compose down -v`，它会删除持久卷。
- 需要从旧安装迁移时，保留同一对 `config.json` 和 SQLite 数据，不要通过新建空目录来绕过启动问题。详见 [迁移与恢复说明](docs/architecture/migration.md)。
- 在 API、配置文件或脚本中传递 QQ/群/消息 ID 时使用 JSON 字符串（例如 `"9223372036854775807"`）。QQ、群与操作人 ID 必须是无符号十进制值；消息句柄还兼容提供方使用的有符号 64 位十进制值。Guardian 只兼容仍可精确表示的旧数字输入，并拒绝已舍入数字、小数和指数形式。

## 开发

维护者发布流程见 [Release operations](docs/operations/release.md)。正式发布除 NapCat/SnowLuma 专用运行包外，还生成包含完整可审计源码、部署资产、环境示例、两个构建目标与匹配 Node.js 运行时的 `releaseDownload.zip`，而不是只打包 `dist/`。

发布包面向最终用户，不需要额外安装依赖。只有从源码开发时才需要 Node.js `>=22.6.0` 与 pnpm：

```bash
corepack pnpm@10.17.1 install --frozen-lockfile
corepack pnpm@10.17.1 run build
corepack pnpm@10.17.1 test
```

## 文档与许可

- [Architecture and provider matrix](ARCHITECTURE.md)
- [Deployment, release, and rollback runbook](DEPLOYMENT.md)
- [SnowLuma 部署教程](docs/deployment/snowluma.md)
- [迁移与恢复说明](docs/architecture/migration.md)
- [超级管理员保护与受控恢复](docs/security/super-admin-recovery.md)
- [SnowLuma SDK 备用传输说明](docs/architecture/snowluma-sdk-fallback.md)
- [发布维护流程](docs/operations/release.md)
- [许可证](LICENSE)
