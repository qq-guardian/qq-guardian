# 在 SnowLuma 中部署 QQ Guardian

本教程说明如何把 QQ Guardian 作为独立 OneBot v11 服务接入 SnowLuma。SnowLuma 负责运行 QQ、提供 OneBot 事件和动作；Guardian 通过 SnowLuma 的正向 WebSocket 接收事件、执行群管理动作，并提供自己的 WebUI。

不要把 Guardian 安装到 SnowLuma 进程或 QQ 目录中。二者是独立服务：SnowLuma 需要 QQ 注入权限，Guardian 不需要，也不应拥有这些权限。

## 选择部署方式

| 环境 | 推荐方式 | 适用说明 |
| --- | --- | --- |
| Linux 服务器或 NAS | Docker Compose | 最省事的正式支持路径；本教程的完整首次部署以此为例。 |
| Windows 电脑 | 原生 Windows 或 Docker Desktop | 想使用 Windows QQ.exe 选原生；想使用容器中的 Linux QQ 选 Docker Desktop。 |
| Windows + WSL2 | Docker Desktop 的 WSL 集成或 WSL 内 Docker | 两种 Docker 引擎只能选一种。 |
| Linux 无 Docker | 原生 Linux 手动部署 | 进阶方案；需要自行维护 QQ、Xvfb、noVNC 与 ptrace。 |
| Android / Termux | Termux + proot Ubuntu | 实验性方案；不建议作为生产环境。 |
| 宝塔、1Panel、其他面板 | 导入本项目的 Compose 栈 | 需保留发布包目录结构和全部持久卷。 |

SnowLuma 的当前平台要求和 QQ 兼容性以其官方文档为准：

- [Docker 部署](https://snowluma.github.io/en/guide/deploy/docker.html)
- [原生 Windows](https://snowluma.github.io/en/guide/deploy/windows.html)
- [Windows Docker Desktop](https://snowluma.github.io/en/guide/deploy/windows-docker.html)
- [WSL2](https://snowluma.github.io/en/guide/deploy/wsl2.html)
- [原生 Linux 手动部署](https://snowluma.github.io/guide/deploy/linux-manual.html)
- [Android / Termux](https://snowluma.github.io/en/guide/deploy/mobile.html)

## 部署前先理解连接、端口和凭据

```text
QQ 客户端
   │
   ▼
SnowLuma
   ├── noVNC / VNC：首次查看 QQ 窗口并扫码
   ├── SnowLuma WebUI：管理 SnowLuma 和 OneBot 配置
   └── OneBot 正向 WebSocket ─────► QQ Guardian
                                      └── Guardian WebUI：管理群规和数据
```

本项目的 Compose 文件只把管理页面发布到宿主机回环地址，OneBot 端口保持在内部 Compose 网络中。

| 端口 | 服务 | 用途 | 本项目 Compose 的处理 |
| --- | --- | --- | --- |
| 6081 | SnowLuma | noVNC，查看 QQ 并扫码 | 仅映射到宿主机 127.0.0.1。 |
| 5099 | SnowLuma | SnowLuma WebUI | 仅映射到宿主机 127.0.0.1。 |
| 3000 | SnowLuma | OneBot HTTP | 不映射到宿主机。 |
| 3001 | SnowLuma | OneBot 正向 WebSocket | 不映射到宿主机；Guardian 通过内部服务名访问。 |
| 6099 | Guardian | Guardian WebUI | 仅映射到宿主机 127.0.0.1。 |

有三套彼此不同的凭据，不要混用：

| 凭据 | 用于 | 保存位置 |
| --- | --- | --- |
| VNC_PASSWD | 登录 noVNC，查看容器里的 QQ 桌面 | deploy/.env。 |
| SnowLuma WebUI 初始密码 | 首次登录 SnowLuma WebUI | 只会在全新 SnowLuma 数据卷的首次启动输出中出现一次。 |
| Guardian 管理员凭据 | 登录 Guardian WebUI | 部署环境变量，或 Guardian 数据目录的一次性凭据文件。 |

> **安全提示：** 不要把 6081、5099、3000、3001 或 6099 裸露到公网。远程管理请使用 VPN、SSH 隧道，或带身份验证的反向代理。OneBot token、.env、Guardian 的 config.json、SQLite 数据和备份都属于敏感数据。

## 获取并校验 Guardian SnowLuma 发布包

1. 打开 [QQ Guardian Releases](https://github.com/ShiYuPIay/napcat-plugin-qq-guardian/releases/latest)。
2. 下载 qq-guardian-snowluma.zip 与同名的 .sha256 文件。
3. 在解压前校验 SHA-256。校验失败时删除下载文件并重新下载，不要继续部署。

在 Linux、macOS 或 WSL 中：

```bash
sha256sum -c qq-guardian-snowluma.zip.sha256
unzip qq-guardian-snowluma.zip -d qq-guardian-snowluma
cd qq-guardian-snowluma
```

在 PowerShell 中：

```powershell
$archive = '.\qq-guardian-snowluma.zip'
$expected = (Get-Content "$archive.sha256").Split()[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'SHA-256 校验失败，请重新下载发布包。' }
Expand-Archive -LiteralPath $archive -DestinationPath '.\qq-guardian-snowluma'
Set-Location '.\qq-guardian-snowluma'
```

解压后的根目录必须同时包含：

```text
dist-snowluma/    Guardian 独立运行时
deploy/           Compose、Windows、Linux、Termux 和面板部署资产
docs/             本教程
```

不要把 Guardian 的持久化数据放进这个解压目录。发布包可以替换，数据目录和 Docker 卷不能随发布包一起删除。

## 推荐路径：Linux Docker Compose 首次部署

### 前提条件

- 已安装 Docker Engine 和 Docker Compose v2。
- 主机可运行 Linux amd64 或 arm64 容器。
- 有可访问的浏览器或安全隧道，以便首次访问 noVNC 完成 QQ 扫码。
- 计划使用的宿主机端口 6081、5099、6099 未被占用，或准备在 deploy/.env 中更换主机侧端口。

SnowLuma 容器需要 SYS_PTRACE、seccomp=unconfined 和至少 1g 共享内存，原因是它需要向容器内的 QQ 进程注入 hook。项目的 deploy/compose.yaml 只把这些权限授予 snowluma 服务；Guardian 保持非 root、只读根文件系统、移除 Linux capabilities 的状态。

### 创建本地环境文件

从发布包根目录执行：

```bash
cp deploy/.env.example deploy/.env
```

编辑 deploy/.env，至少修改：

```text
VNC_PASSWD=替换为足够长且唯一的密码
SNOWLUMA_ACCESS_TOKEN=
```

首次启动时保持 SNOWLUMA_ACCESS_TOKEN 为空。这让 SnowLuma 先生成 OneBot 配置并允许完成 QQ 登录；配置好 OneBot 后再填入 token 并仅重建 Guardian。

生产环境还应把 SNOWLUMA_IMAGE 固定为经过验证的 SnowLuma 镜像标签，而不是长期依赖 latest。所有卷名必须在后续重启、升级和面板导入时保持不变。

### 启动 SnowLuma 与 Guardian

先验证 Compose 变量和路径：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml config
```

确认无误后启动：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

guardian-storage-init 是一次性的卷权限初始化服务。它只创建 Guardian 的两个持久目录并把它们交给非 root 运行用户；不要移除该服务，也不要把 Guardian 改为特权容器来绕过它。

### 首次扫码登录 QQ

1. 在部署机器本地浏览器打开 http://127.0.0.1:6081/。
2. 用 deploy/.env 中的 VNC_PASSWD 登录 noVNC。
3. 在显示的 QQ 窗口中用手机 QQ 扫码登录。
4. 打开 http://127.0.0.1:5099/ 进入 SnowLuma WebUI。

全新的 SnowLuma 数据卷首次启动会产生一次性 WebUI 管理员密码。可从 Compose 输出中查找；同一数据卷重启后不会重新生成：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml logs snowluma
```

如果错过了首次密码，不要为了让它重新出现而删除 snowluma-data 卷。应按照 SnowLuma 的管理员恢复流程处理，并保留已有 QQ 登录状态和配置。

### 配置 SnowLuma OneBot WebSocket

Guardian 默认使用 SnowLuma 的 **正向 WebSocket 服务端**，即 networks.wsServers 中一个已启用、角色为 Universal 的条目。也可按网络拓扑选择 HTTP webhook 或反向 WebSocket；三种模式共享同一应用层，不会复制 Guardian 业务逻辑。

| `SNOWLUMA_TRANSPORT` | SnowLuma 网络配置 | 动作 | 事件 |
| --- | --- | --- | --- |
| `forward-websocket`（默认） | `wsServers`，Guardian 主动连接 | 同一 WebSocket | 同一 WebSocket |
| `http` | `httpServers` + 指向 Guardian 的 `httpClients` webhook | `SNOWLUMA_HTTP_URL` | `SNOWLUMA_WEBHOOK_HOST/PORT/PATH` |
| `reverse-websocket` | 指向 Guardian 的 `wsClients` | 反向连接 | 反向连接 |

HTTP 和反向 WebSocket 监听默认只绑定 `127.0.0.1`。容器网络需要绑定 `0.0.0.0` 时，必须同时配置 `SNOWLUMA_ACCESS_TOKEN`，并且仅在受信任的内部网络开放对应端口。HTTP 模式不会在动作超时后通过另一传输重放有副作用的操作。

在 SnowLuma WebUI 中打开当前 QQ 账号的 OneBot 配置，确认或新增一个 wsServers 条目。配置结构应遵循 SnowLuma 的 [OneBot 配置说明](https://snowluma.github.io/en/guide/configuration.html)，核心字段如下：

```json
{
  "networks": {
    "wsServers": [
      {
        "name": "guardian",
        "enabled": true,
        "host": "0.0.0.0",
        "port": 3001,
        "path": "/",
        "role": "Universal",
        "accessToken": "<为本服务生成的强 token>"
      }
    ]
  }
}
```

把这个条目的 `accessToken` 原样填入 `deploy/.env`：

```text
SNOWLUMA_ACCESS_TOKEN=<同一个 token>
SNOWLUMA_WS_URL=ws://snowluma:3001/
```

`ws://snowluma:3001/` 是 Compose 内部服务地址。不要把它改成 `ws://127.0.0.1:3001/` 或 `ws://localhost:3001/`：在 Guardian 容器里，localhost 指向 Guardian 容器本身，而不是 SnowLuma。

### 傻瓜式反向 WebSocket 配置

反向 WebSocket 是 SnowLuma 主动连向 Guardian 的模式，适合不能从 Guardian 访问 SnowLuma 的网络拓扑。下面是按步骤操作的完整示例：

1. 在 `deploy/.env` 中把传输模式改为反向 WebSocket：

```text
SNOWLUMA_TRANSPORT=reverse-websocket
SNOWLUMA_REVERSE_WS_HOST=0.0.0.0
SNOWLUMA_REVERSE_WS_PORT=6101
SNOWLUMA_REVERSE_WS_PATH=/onebot
```

2. 在 SnowLuma WebUI 的 OneBot 配置中，不要新增 `wsServers`，而是把 Guardian 当作反向客户端接入。让 SnowLuma 连接 `http://guardian:6101/onebot` 这一条已存在的反向服务端点。这样 SnowLuma 主动发起连接，Guardian 只负责监听本地端口。

3. 只重建 Guardian：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --no-deps --force-recreate guardian
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=100 guardian
```

4. 在 Guardian 日志里确认看到 `OneBot reverse-websocket provider ready`。如果没看到，按顺序检查：
   - `SNOWLUMA_REVERSE_WS_HOST` 是否为 `0.0.0.0`
   - `SNOWLUMA_REVERSE_WS_PORT` 是否为 `6101`
   - `SNOWLUMA_REVERSE_WS_PATH` 是否为 `/onebot`
   - SnowLuma 的 `wsClients` 是否指向 Guardian 服务名和端口
   - 两端 `accessToken` 是否完全一致

5. 打开浏览器访问：

```text
http://127.0.0.1:6099/plugin/napcat-plugin-qq-guardian/page/guardian
```

6. 在“群组管理”刷新群列表、开启需要保护的群，并以一次低风险测试操作确认 Guardian 能收到事件并调用 OneBot。连接正常时，Guardian 输出会显示已连接到 OneBot；token 不应出现在输出中。

## 仅重建 Guardian 并完成初始登录

填入 OneBot token 后，只重建 Guardian：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --no-deps --force-recreate guardian
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=100 guardian
```

浏览器打开：

```text
http://127.0.0.1:6099/plugin/napcat-plugin-qq-guardian/page/guardian
```

仅在用户表为空的新安装中，Guardian 管理员有两种初始化方式：

1. 在 deploy/.env 中提前设置 QQ_GUARDIAN_BOOTSTRAP_USERNAME 和 QQ_GUARDIAN_BOOTSTRAP_PASSWORD，然后重建 Guardian。
2. 保持两项为空。Guardian 会在自己的数据卷中生成 bootstrap-credentials.json；读取该文件中的随机凭据完成首次登录后，文件会自动删除。

只要用户表非空，Guardian 就不会通过首次初始化路径新增特权账户。现有安装没有可用超级管理员时，必须执行显式、受审计的[受控恢复流程](../security/super-admin-recovery.md)。

登录后，在“群组管理”刷新群列表、开启需要保护的群，并以一次低风险测试操作确认 Guardian 能收到事件并调用 OneBot。连接正常时，Guardian 输出会显示已连接到 OneBot；token 不应出现在输出中。

## Windows 原生 SnowLuma

原生 Windows 方式运行的是 Windows QQ.exe，不使用 Docker 或 WSL2。SnowLuma 与 QQ 必须使用**同一个 Windows 用户和相同的权限级别**运行；一个以管理员启动而另一个不是管理员，可能导致 hook 无法注入。

1. 按 SnowLuma 的 [原生 Windows 教程](https://snowluma.github.io/en/guide/deploy/windows.html) 安装 NTQQ，并从 SnowLuma Releases 下载与 Windows x64 对应的发布包。完整包自带 Node；轻量包需要 Node.js >=22。
2. 启动 QQ 和 SnowLuma，扫码登录 QQ，在 http://127.0.0.1:5099/ 登录 SnowLuma WebUI。
3. 按本教程的 [配置 SnowLuma OneBot WebSocket](#配置-snowluma-onebot-websocket) 创建或确认 wsServers 的 Universal 条目和 token。
4. 解压 qq-guardian-snowluma.zip 到固定的应用目录，例如 C:\QQGuardian\app。Guardian 独立服务需要系统 PATH 中的 Node.js >=22.6.0；不要假设 SnowLuma 打包的 Node 会自动提供给 Guardian。
5. 以管理员 PowerShell 创建并收紧 Guardian 状态目录。将下面的身份替换为实际运行 Guardian 的 Windows 账号：

   ```powershell
   $app = 'C:\QQGuardian\app'
   $state = 'C:\ProgramData\QQGuardian'
   $identity = "$env:USERDOMAIN\$env:USERNAME"
   New-Item -ItemType Directory -Force -Path $state | Out-Null
   Copy-Item "$app\deploy\native\guardian.env.example" "$state\guardian.env" -Force
   & "$app\deploy\native\initialize-guardian-state.ps1" -ServiceIdentity $identity -StateRoot $state
   notepad "$state\guardian.env"
   ```

6. 在 guardian.env 中填写 token 和 Windows 绝对路径：

   ```text
   SNOWLUMA_WS_URL=ws://127.0.0.1:3001/
   SNOWLUMA_ACCESS_TOKEN=<SnowLuma OneBot token>
   QQ_GUARDIAN_HTTP_HOST=127.0.0.1
   QQ_GUARDIAN_HTTP_PORT=6099
   QQ_GUARDIAN_DATA_DIR=C:\ProgramData\QQGuardian\data
   QQ_GUARDIAN_CONFIG_DIR=C:\ProgramData\QQGuardian\config
   ```

7. 使用同一账号启动 Guardian：

   ```powershell
   & "$app\deploy\native\start-guardian.ps1" -EnvironmentFile "$state\guardian.env" -RuntimeFile "$app\dist-snowluma\index.mjs"
   ```

8. 在 http://127.0.0.1:6099/plugin/napcat-plugin-qq-guardian/page/guardian 完成 Guardian 首次登录并配置群规则。

如需开机自启，使用 Task Scheduler、NSSM 或等价的服务托管器运行同一条 Guardian 启动命令。不要把环境文件、数据或配置放到共享用户目录；状态初始化脚本会将它们限制给指定服务身份、SYSTEM 和本地管理员。

## Windows Docker Desktop

Docker Desktop 运行的是 SnowLuma 的 Linux 容器和 Linux QQ，并不使用本机的 Windows QQ.exe。如果要管理本机 QQ.exe，请使用上一节的原生 Windows 方式。

1. 安装 Docker Desktop，确认启用 WSL2 引擎。SnowLuma 官方教程列出的基础条件包括支持虚拟化、WSL2 和足够的内存。
2. 在 PowerShell 中按“[推荐路径：Linux Docker Compose 首次部署](#推荐路径linux-docker-compose-首次部署)”执行相同的发布包校验、.env、docker compose 和扫码步骤。
3. Docker Desktop 会把本项目回环发布的端口转发到 Windows localhost，因此可在 Windows 浏览器访问 http://127.0.0.1:6081/、5099 和 6099。
4. 保留 Docker Desktop 的五个命名卷；删除应用时选择删除卷等同于删除 QQ 登录状态和 Guardian 数据。

## WSL2

WSL2 适合希望在 Windows 上使用 Linux 命令行与 Docker 的用户。

1. 用管理员 PowerShell 安装并确认 WSL2：

   ```powershell
   wsl --install
   wsl -l -v
   wsl --set-default-version 2
   ```

2. 在以下两种 Docker 路线中选择一种：

   - **推荐：** Docker Desktop 的 WSL Integration，启用目标 Ubuntu 发行版后直接在该发行版中使用 docker。
   - **替代：** 在 WSL 发行版中安装原生 Docker Engine。

   不要同时运行 Docker Desktop 集成和发行版内的 dockerd；两个引擎会发生冲突。

3. 在 Linux 文件系统目录（例如 ~/qq-guardian）中解压发布包，并按 Docker Compose 首次部署步骤执行。避免把持续写入的数据放在临时目录中。
4. 正常情况下可从 Windows 浏览器通过 localhost 访问回环端口。若 localhost 转发在你的系统上不可用，可在 WSL 中运行 wsl hostname -I 获取地址，并通过受控防火墙/隧道访问；不要为图方便把 OneBot 端口公开到公网。

## 原生 Linux

Linux 上 SnowLuma 的 Docker 路线是官方推荐且正式支持的方式。原生手动部署适合无法使用 Docker 的进阶场景，需要自行维护 Linux QQ、无头桌面、VNC/noVNC、Node 的 ptrace capability、QQ 热更新策略以及服务守护。

请先完整执行 SnowLuma 的[原生 Linux 手动教程](https://snowluma.github.io/guide/deploy/linux-manual.html)。其核心步骤是：安装 Node 24 或兼容运行时、安装 Linux QQ 与依赖、建立 Xvfb/fluxbox/noVNC 扫码环境、为实际 Node 二进制设置 cap_sys_ptrace、启动 SnowLuma 与 QQ，并从 WebUI 配置 OneBot。

SnowLuma 的 OneBot 正常工作后，部署 Guardian：

```bash
sudo useradd --system --home-dir /var/lib/qq-guardian --create-home \
  --shell /usr/sbin/nologin qq-guardian
sudo install -d -o qq-guardian -g qq-guardian /var/lib/qq-guardian/data
sudo install -d -o qq-guardian -g qq-guardian /etc/qq-guardian
sudo install -m 600 -o qq-guardian -g qq-guardian \
  deploy/native/guardian.env.example /etc/qq-guardian/guardian.env
sudo install -m 644 deploy/native/qq-guardian.service /etc/systemd/system/qq-guardian.service
```

编辑 /etc/qq-guardian/guardian.env，至少设置 SNOWLUMA_WS_URL=ws://127.0.0.1:3001/、SNOWLUMA_ACCESS_TOKEN、QQ_GUARDIAN_DATA_DIR=/var/lib/qq-guardian/data 和 QQ_GUARDIAN_CONFIG_DIR=/etc/qq-guardian。随后启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now qq-guardian
sudo systemctl status qq-guardian
```

系统服务使用系统 Node 路径。先验证服务账号实际能找到足够新的 Node：

```bash
sudo -u qq-guardian env PATH=/usr/local/bin:/usr/bin:/bin node --version
```

## Android / Termux / proot

Android 路线是实验性的。SnowLuma 官方明确指出：proot 环境不具备 Docker 所需的 namespace、cgroup 和网络能力，手机上不应把 Docker 当作常规方案；SnowLuma hook 又依赖 ptrace，可能与 proot 冲突。若你有电脑或服务器，应优先使用 Docker。

1. 从 [F-Droid](https://f-droid.org/packages/com.termux/) 或 [Termux GitHub Releases](https://github.com/termux/termux-app/releases) 安装 Termux；不要使用已废弃的 Google Play 版本。
2. 在 Termux 中创建 Ubuntu 用户空间：

   ```sh
   pkg update && pkg upgrade
   pkg install proot-distro
   proot-distro install ubuntu
   proot-distro login ubuntu
   ```

3. 在该 Ubuntu 用户空间内按 SnowLuma 的[手机/原生 Linux 教程](https://snowluma.github.io/en/guide/deploy/mobile.html)完成 Node、Linux QQ、Xvfb/noVNC、SnowLuma lite 和扫码配置。
4. 在同一个用户空间内解压 Guardian 发布包，创建持久的实际绝对路径，并在 Guardian 环境文件中写入这些路径。`deploy/native/start-guardian.sh` 将环境文件按字面 KEY=value 读取，不能在值中依赖 `$HOME` 展开。
5. 使用启动器运行：

   ```sh
   sh deploy/native/start-guardian.sh /实际路径/guardian.env /实际路径/dist-snowluma/index.mjs
   ```

6. 需要长期运行时，按设备情况使用 termux-wake-lock、关闭电池优化并做好外部备份。设备休眠、厂商后台限制、QQ 更新或 ptrace 限制都可能中断服务。

不要把手机方案宣称为稳定生产部署。迁移到服务器时，保留 Guardian 的 config.json 与 SQLite 数据对，并按本教程的迁移流程处理。

## 宝塔、1Panel 和其他 Compose 面板

面板应导入同一份 Compose 设计，而不是把 SnowLuma 和 Guardian 放进不相关的网络或随意拼接容器。

### 宝塔

1. 上传或克隆完整发布包，保留根目录中的 dist-snowluma/ 与 deploy/。
2. 在宝塔的 Docker Compose 应用中选择 deploy/compose.yaml。
3. 导入 deploy/.env.example 的变量，至少设置强 VNC_PASSWD；首次部署可暂时留空 SNOWLUMA_ACCESS_TOKEN。
4. 确认 Guardian 的构建上下文仍指向发布包根目录。若面板复制了 Compose 文件，必须让 guardian.build.context 能看到同级的 dist-snowluma/。
5. 部署、通过受保护的本地浏览器或 SSH 隧道访问 noVNC 扫码、配置 Universal WebSocket token，然后只重建 Guardian。
6. 升级或删除应用时保留五个命名卷，特别是两个 Guardian 卷和三个 SnowLuma/QQ 卷。

本项目的 [宝塔说明](../../deploy/baota/README.md) 是面板内的简短入口；具体数据、安全和回滚规则以本教程为准。

### 1Panel

1. 创建 **Compose** 类型应用，并将 Compose 文件指向 deploy/compose.yaml。
2. 确认应用工作目录保留发布包根目录；Guardian 镜像构建依赖 dist-snowluma/。
3. 将 deploy/.env.example 的变量填入 1Panel 环境设置，保留卷名并设置强 VNC_PASSWD。
4. 按 Docker Compose 首次部署流程完成 QQ 扫码、SnowLuma wsServers / Universal 配置和 Guardian 重建。
5. 需要远程 WebUI 时，只为 Guardian 的 HTTP 端口配置已鉴权反向代理；不要公开 OneBot、noVNC 或 SnowLuma WebUI。

本项目的 [1Panel 说明](../../deploy/1panel/README.md) 可在发布包内直接查看。

### 其他 Docker、Podman 或容器平台

可以将 Guardian 作为现有 SnowLuma 部署的独立服务，但必须显式提供：

- 从 Guardian 容器可达的 SNOWLUMA_WS_URL。
- 对应 Universal WebSocket 的 SNOWLUMA_ACCESS_TOKEN，并通过平台 Secret 管理。
- 两个单独、可持久化、可写的 Guardian 路径或卷。
- 私有的服务网络、明确的 WebUI 入口和访问控制。

ws://snowluma:3001/ 只在本项目 Compose 网络中有效。跨项目、跨主机或跨集群时，请使用平台 DNS 名称或已经验证的 wss:// 地址，而不是猜测 localhost。

## Guardian 环境变量与 SDK 备用连接

### SnowLuma SDK 文档速览
- 包名：`@snowluma/sdk`
- 类型完备的 OneBot v11 客户端，纯 ESM，自带类型声明
- 要求 Node.js ≥ 22；官方推荐 Node 24 LTS
- 与 SnowLuma 核心共享 action 类型，调用参数和返回值不会随版本漂移

| 传输 | 客户端类 | 默认端点 |
| --- | --- | --- |
| HTTP（POST JSON） | `SnowLumaHttpClient` | `http://127.0.0.1:3000/` |
| WebSocket（正向 / 反向，含事件） | `SnowLumaWebSocketClient` | `ws://127.0.0.1:3001/` |

两个客户端都继承自抽象基类 `SnowLumaApiClient`，因此 `call()` / `request()` 以及所有 camelCase action 快捷方法在两种传输上一致。HTTP 适合纯请求-响应的脚本；WebSocket 在此之上还能实时接收事件。

#### HTTP 客户端
```ts
import { SnowLumaHttpClient } from '@snowluma/sdk';

const bot = new SnowLumaHttpClient({
  baseUrl: 'http://127.0.0.1:3000/', // 默认值
  accessToken: process.env.SNOWLUMA_TOKEN,
  requestTimeoutMs: 30_000,            // 默认 30s
});
```

`SnowLumaHttpClientOptions`：
- `baseUrl?` —— OneBot HTTP 端点，默认 `http://127.0.0.1:3000/`
- `accessToken?` —— OneBot 配置里的 token；存在时自动加 `Authorization: Bearer <token>`
- `requestTimeoutMs?` —— 默认超时（毫秒），默认 `30000`
- `fetch?` —— 自定义 `fetch` 实现（测试或非标准运行时用）
- `headers?` —— 每次请求附带的额外请求头

#### WebSocket 客户端
```ts
import { SnowLumaWebSocketClient } from '@snowluma/sdk';

const bot = new SnowLumaWebSocketClient({
  url: 'ws://127.0.0.1:3001/', // 默认值
  accessToken: process.env.SNOWLUMA_TOKEN,
  reconnect: true,              // 开启自动重连
});
```

`SnowLumaWebSocketClientOptions`：
- `url?` —— OneBot WebSocket 端点，默认 `ws://127.0.0.1:3001/`
- `accessToken?` —— 通过查询参数附加到连接 URL
- `requestTimeoutMs?` —— 默认请求超时，默认 `30000`
- `role?` —— 客户端声明的角色：`'Api'` | `'Event'` | `'Universal'`（默认 `'Universal'`）
- `reconnect?` —— `true` 或一个 `ReconnectOptions`（`retries` / `minDelayMs` / `maxDelayMs`），开启意外断开后的自动重连
- `protocols?` / `webSocket?` —— 可选子协议、可选自定义 `WebSocket` 构造器（Node 运行时或测试用）

> **Node 自定义 WebSocket**：浏览器和 Node 24 都自带全局 `WebSocket`，可直接用。若想用 `ws` 包等实现，把它传给 `webSocket` 选项即可。

项目中的 native transport 与 SDK fallback 采用相同的有界重连策略，且不会因 WebSocket 超时而自动重放有副作用的操作。若需排查备用路径，可在 Guardian 的实际启动环境中设置 `SNOWLUMA_SDK_FALLBACK=off` 并重启；正常部署不需要手动设置该变量。

文档主页：https://snowluma.github.io/sdk/index.html

| 变量 | 说明 |
| --- | --- |
| SNOWLUMA_WS_URL | 从 Guardian 所在网络命名空间访问 SnowLuma 正向 WebSocket 的地址。原生同机通常是 ws://127.0.0.1:3001/；本项目 Compose 通常是 ws://snowluma:3001/。 |
| SNOWLUMA_ACCESS_TOKEN | SnowLuma wsServers / Universal 条目的同一 token。 |
| SNOWLUMA_TRANSPORT | `forward-websocket`（默认）、`http` 或 `reverse-websocket`。 |
| SNOWLUMA_HTTP_URL | HTTP 模式的 OneBot 动作端点。 |
| SNOWLUMA_WEBHOOK_HOST / PORT / PATH | HTTP 模式接收 SnowLuma `httpClients` 事件的监听地址。 |
| SNOWLUMA_REVERSE_WS_HOST / PORT / PATH | 反向 WebSocket 模式接收 SnowLuma `wsClients` 连接的监听地址。 |
| SNOWLUMA_SDK_FALLBACK | auto（默认）或 off。控制官方 @snowluma/sdk WebSocket 备用传输。 |
| SNOWLUMA_MAX_FRAME_BYTES | 单个 WebSocket 入站帧上限，默认 1048576（1 MiB），允许 1024–16777216。超限时使用关闭码 1009 终止该连接。 |
| SNOWLUMA_RAW_QUEUE_LIMIT | 原生传输保留的原始帧总数上限（包含正在解码的帧），默认 64，允许 1–4096。 |
| SNOWLUMA_RAW_QUEUE_BYTES | 原生传输保留的原始帧总字节上限（包含正在解码的帧），默认 8388608（8 MiB），允许 1024–67108864。 |
| QQ_GUARDIAN_HTTP_HOST | Guardian WebUI 的绑定地址；原生部署应保持 127.0.0.1，容器内由 Compose 映射到回环端口。 |
| QQ_GUARDIAN_HTTP_PORT | Guardian WebUI 端口，默认 6099。 |
| QQ_GUARDIAN_DATA_DIR | Guardian SQLite、迁移状态、备份和一次性管理员凭据目录。 |
| QQ_GUARDIAN_CONFIG_DIR | Guardian config.json 所在目录。 |
| QQ_GUARDIAN_BOOTSTRAP_USERNAME / QQ_GUARDIAN_BOOTSTRAP_PASSWORD | 可选的无人值守首次管理员凭据；仅用户表为空时用于初始化。恢复模式必须同时显式提供两项。只应存放在受保护的环境文件或 Secret 中。 |
| QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY | 高风险、一次性恢复开关；仅 `1` 启用，并要求两项显式凭据均有效，否则启动会在任何恢复副作用前失败。恢复成功后必须移除。完整步骤见[超级管理员保护与受控恢复](../security/super-admin-recovery.md)。 |

Guardian 默认先使用自己的原生 SnowLuma WebSocket 传输。只有该传输在**启动阶段**的有限连接尝试全部失败时，才会在 `SNOWLUMA_SDK_FALLBACK=auto` 下改用打包的官方 `@snowluma/sdk` WebSocket 客户端。

- 原生传输一旦连通，SDK 不会被创建或连接。
- SDK 接管前原生传输会关闭；两个传输不会并行消费事件。
- 选定一种传输后，本进程不会在运行中来回切换。
- Guardian 不会因 WebSocket 超时而改用 HTTP 自动重放踢人、禁言、审批等动作，避免重复执行有副作用的操作。
- 需要排查备用路径时，可在 Guardian 的实际启动环境中设置 `SNOWLUMA_SDK_FALLBACK=off` 并重启。正常部署不需要手动设置该变量。

SDK 备用不解决错误 token、错误网络地址、SnowLuma 未启用 wsServers 或 QQ/hook 未就绪的问题。先修正 OneBot 配置和网络，再判断是否需要备用传输。

### WebSocket 入站资源边界

原生传输在复制或解析数据前读取 string、ArrayBuffer、TypedArray/DataView 与 Blob 的字节长度。单帧超过 `SNOWLUMA_MAX_FRAME_BYTES` 时不会进入解析队列，Guardian 会清空该连接的原始帧、事件和待处理请求状态，并以 WebSocket 关闭码 1009 断开。队列达到帧数或总字节上限时丢弃最新帧；正在解码的帧同时计入两个上限，因此慢 Blob 解码不会绕过边界。断线和重连会使旧连接的排队帧失效。

`malformed_json`、`invalid_packet`、`unknown_packet`、`unsupported_frame_type`、`frame_too_large` 和 `raw_ingress_saturated` 会作为限频的传输诊断输出。诊断只包含类别、出现次数和字节计数，不包含原始载荷、token 或 URL 凭据。若修改默认值，应同时监控 1009 断线和 `raw_ingress_saturated`；先确认上游事件大小与消费延迟，再逐步调高，不能用无上限值绕过保护。无效或超出表中范围的环境变量会回退到默认值。

官方 SDK 备用路径订阅 SDK 提供的 raw/open/close/error 钩子，并在 Guardian 的事件队列前再次执行单帧上限。SDK 的 raw 钩子在 SDK 已收到当前帧后触发，因此 Guardian 能阻止该帧进入自己的事件队列并关闭连接，但不能撤销 SDK 对当前帧已经发生的一次接收或解析分配；原生传输提供完整的解析前队列帧数与字节边界。两条路径都会在连接关闭时清空 Guardian 的事件队列；启用重连时，SDK 因超限而关闭后由 Guardian 使用同一有界退避策略重新连接。

## 持久化、迁移、备份与回滚

### Docker 卷

本项目的 Compose 栈使用五个持久卷：

| 环境变量 | 容器路径 | 内容 |
| --- | --- | --- |
| SNOWLUMA_DATA_VOLUME | SnowLuma /app/data | SnowLuma 配置、OneBot 配置和缓存。 |
| QQ_CLIENT_CONFIG_VOLUME | SnowLuma /app/.config | QQ 客户端配置。 |
| QQ_CLIENT_DATA_VOLUME | SnowLuma /app/.local/share | QQ 登录状态与客户端数据。 |
| GUARDIAN_DATA_VOLUME | Guardian /guardian/data | SQLite、迁移状态、阶段文件和备份。 |
| GUARDIAN_CONFIG_VOLUME | Guardian /guardian/config | Guardian config.json。 |

不要在升级、重启或面板重新部署时执行 docker compose down -v。-v 会删除命名卷，等同于删除 QQ 登录状态、Guardian 配置和业务数据。

### 首次迁移

当 Guardian 在目标目录中发现旧版 config.json 和/或 SQLite 数据库时，会执行版本化的一次性影子迁移：

1. 取得迁移锁，只读检查现有数据。
2. 在修改活动数据前创建并校验备份。
3. 生成独立的配置与数据库候选文件，校验配置、SQLite 完整性、结构和关键业务记录。
4. 只有两个候选都验证通过才切换活动文件，并再次校验。
5. 写入已完成的版本记录；后续启动不会重复迁移。

有效的群设置、防护开关、审批规则、黑名单、处罚、审计/历史、用户和统计数据会被保留。迁移失败时 Guardian 会停止并保留原始活动数据、迁移状态和备份；不要删除 config.json、qqadmin.db、migration-state.json 或卷来“重置”问题。

当前迁移会把 OneBot 的 QQ、群、消息和操作人标识符统一为十进制字符串，并在 SQLite 中使用 `TEXT` 保存。旧数据库的 64 位整数由 SQLite 在影子候选库中直接转换，不经过 JavaScript `Number`；迁移后的 WebUI 和 API 也按字符串传递这些值。自动化脚本应发送 JSON 字符串，例如 `"9223372036854775807"`，不要发送可能已经被客户端舍入的 JSON 数字。

从 NapCat 或其他旧 Guardian 部署迁移到 SnowLuma 时：

1. 停止所有指向旧数据路径的 Guardian 实例。
2. 先做站外备份，再把旧 config.json 与匹配的 SQLite 数据库作为一对放入新的 Guardian 配置/数据位置。
3. 只启动一个 Guardian 实例，让其完成迁移和验证。
4. 登录 WebUI，核对一个已配置群、黑名单、处罚记录、审批/审计记录和统计数据后再恢复正常流量。

不要只复制配置或只复制数据库，也不要用一个新的空数据库搭配旧配置。

### Docker 的操作员备份

在 Linux 或 WSL 中，可先停止 Guardian，再对两个 Guardian 卷创建归档。下面假定你使用 deploy/.env.example 中的默认卷名；如果改过卷名，请替换为实际名称：

```bash
mkdir -p guardian-backups
docker compose --env-file deploy/.env -f deploy/compose.yaml stop guardian
docker run --rm \
  --mount type=volume,source=qq-guardian-data,target=/source,readonly \
  --mount type=bind,source="$PWD/guardian-backups",target=/backup \
  alpine tar -C /source -czf /backup/guardian-data-backup.tar.gz .
docker run --rm \
  --mount type=volume,source=qq-guardian-config,target=/source,readonly \
  --mount type=bind,source="$PWD/guardian-backups",target=/backup \
  alpine tar -C /source -czf /backup/guardian-config-backup.tar.gz .
```

确认两个归档能正常打开，再重新启动 Guardian。Windows Docker Desktop 可使用同样的命令（从 WSL 目录执行）或使用经过验证的卷备份工具；备份文件不应只保存在将被重装的 Docker 数据目录中。

### 回滚

回滚是人工、显式操作，不是 Guardian 自动执行的动作：

1. 完全停止 Guardian，确保没有进程打开 SQLite。
2. 先备份当前迁移后的配置与数据，以便保留迁移后新增的业务记录。
3. 选择完整、已验证的迁移备份，核对其 manifest.json 中的哈希。
4. 将同一份备份中的 config.json 和 qqadmin.db 一起还原到 Guardian 的配置/数据路径；需要时在服务停止状态下处理 SQLite 的 -wal 与 -shm 辅助文件。
5. 使用与旧数据匹配的 Guardian 发布包重新启动，并在恢复业务前检查群设置与代表性记录。

完整的迁移状态、失败恢复语义和文件布局见[迁移与恢复说明](../architecture/migration.md)。

## 升级与日常检查

Docker Compose 升级应保留卷并重建服务：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml pull snowluma
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=100 guardian
```

升级或迁移后，至少确认：

1. SnowLuma 已登录目标 QQ，SnowLuma WebUI 和 Guardian WebUI 都可达。
2. Guardian 已连接 OneBot，且没有把 token 写入输出。
3. 在 Guardian WebUI 中能看到已有的群设置、黑名单、处罚和审计数据。
4. “群组管理”刷新可以返回机器人账号和群列表。
5. 重启 Guardian 后数据仍然存在，证明状态位于持久卷/持久目录而非发布包目录。

## 常见问题

### Guardian 一直无法连接 OneBot

按顺序检查：

1. SnowLuma 中当前账号已登录，hook 已工作。
2. 实际账号的 OneBot 配置中存在已启用的 networks.wsServers 条目。
3. 该条目的 role 是 Universal，而不是 Api、Event 或反向 wsClients。
4. SNOWLUMA_ACCESS_TOKEN 与该条目的 token 完全一致。
5. 容器内 Guardian 使用 ws://snowluma:3001/；原生同机服务使用 ws://127.0.0.1:3001/。
6. Guardian 容器与 SnowLuma 容器位于同一网络，或已配置实际可达的 DNS/TLS 端点。

### noVNC、WebUI 或 Guardian 页面无法从另一台机器访问

这是本项目的安全默认行为：端口只绑定在宿主机 127.0.0.1。使用 SSH 隧道、VPN 或有鉴权的反向代理；不要把 Compose 端口映射直接改为 0.0.0.0 后暴露到互联网。

### SnowLuma WebUI 初始密码找不到

它只在新数据卷第一次启动时产生。不要删除数据卷来强制重新生成密码，因为这会丢失 QQ 登录和 OneBot 配置。使用 SnowLuma 的恢复流程，并保留现有数据卷。

### Guardian 首次管理员凭据找不到

检查 Guardian 的实际 QQ_GUARDIAN_DATA_DIR 或 Guardian 数据卷中的 bootstrap-credentials.json。若已成功使用该凭据登录，该文件按设计会被删除。部署自动化场景应改用受保护的 QQ_GUARDIAN_BOOTSTRAP_USERNAME 和 QQ_GUARDIAN_BOOTSTRAP_PASSWORD。

### Guardian 的超级管理员全部无法登录

临时锁定尚未到期时优先等待。若所有超级管理员都不可用，停止全部 Guardian 实例、备份数据与配置，然后严格执行[受控超级管理员恢复流程](../security/super-admin-recovery.md)。不要删除持久卷或直接编辑 SQLite；恢复开关必须与两项显式有效凭据同时设置，并且只保留一次启动。

### 迁移失败

停止重复启动，保留原始数据、备份和迁移状态，阅读错误信息后修正权限、磁盘空间或输入数据问题。不要删除活动数据或用空文件覆盖它们；迁移重试是幂等的，只有验证通过才会切换。

## 参考资料

- [SnowLuma 快速开始与环境选择](https://snowluma.github.io/en/guide/quickstart.html)
- [SnowLuma Docker 部署与持久卷说明](https://snowluma.github.io/en/guide/deploy/docker.html)
- [SnowLuma OneBot 网络配置](https://snowluma.github.io/en/guide/configuration.html)
- [SnowLuma SDK](https://snowluma.github.io/sdk/index.html)
- [QQ Guardian 迁移与恢复说明](../architecture/migration.md)
- [QQ Guardian 超级管理员保护与受控恢复](../security/super-admin-recovery.md)
