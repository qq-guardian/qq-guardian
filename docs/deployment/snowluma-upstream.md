# SnowLuma 与 QQ Guardian 的发行边界

QQ Guardian 的 SnowLuma provider 包不是 SnowLuma 官方发行包的替代品。

官方 SnowLuma v1.14.20 的 release 由 SnowLuma 自己的发布流水线生成，Windows x64、Linux x64、Linux arm64 分别提供 full/lite 发行包。官方 full 包携带 Node.js，lite 包使用系统 Node.js 22.13+（23 系需要 23.4+）。

QQ Guardian 的公开 provider 包采用相同的 platform + full/lite 发行模型，但只负责 Guardian 自身运行时。它不会复制官方 SnowLuma 的 snowluma-*.node、snowluma-*.dll 或 snowluma-*.so。

## 为什么大小不会与官方 SnowLuma 相同

这是有意且必要的。SnowLuma 官方包包含平台相关原生组件，这些组件不属于 QQ Guardian 的运行时代码。Guardian 不能通过重新打包 Guardian JS 代码获得这些文件，也不应该伪造或重新分发这些官方专有组件。

部署时请先取得对应平台的官方 SnowLuma v1.14.20 release，解压到独立目录，再让 Guardian 连接其 OneBot 服务。

## 无人值守启动

官方 SnowLuma release 已提供协议确认的无人值守环境变量：

SNOWLUMA_ACCEPT_EULA=1
SNOWLUMA_ACCEPT_PRIVACY=1

Guardian provider 包提供平台对应的启动脚本，用于启动一个已经由运营者取得的官方 SnowLuma 目录：

Windows：deploy/native/unattended-start.ps1
Linux：deploy/native/unattended-start.sh

这些脚本不会下载、复制或重新打包 SnowLuma 官方原生模块。

## Docker

Compose 使用官方 SnowLuma 镜像作为独立 service，默认验证版本为 motricseven7/snowluma:1.14.20。生产环境应进一步固定为不可变 digest。

Guardian 自身镜像只包含 Guardian runtime；SnowLuma 与 Guardian 保持两个独立的容器边界。

## 官方发行包与 Guardian provider 的关系

官方 SnowLuma 资产：
- SnowLuma-v1.14.20-win-x64.zip
- SnowLuma-v1.14.20-win-x64-lite.zip
- SnowLuma-v1.14.20-linux-x64.tar.gz
- SnowLuma-v1.14.20-linux-x64-lite.tar.gz
- SnowLuma-v1.14.20-linux-arm64.tar.gz
- SnowLuma-v1.14.20-linux-arm64-lite.tar.gz

Guardian provider 资产：
- qq-guardian-snowluma-vX.Y.Z-win-x64.zip
- qq-guardian-snowluma-vX.Y.Z-win-x64-lite.zip
- qq-guardian-snowluma-vX.Y.Z-linux-x64.tar.gz
- qq-guardian-snowluma-vX.Y.Z-linux-x64-lite.tar.gz
- qq-guardian-snowluma-vX.Y.Z-linux-arm64.tar.gz
- qq-guardian-snowluma-vX.Y.Z-linux-arm64-lite.tar.gz

后者只是 Guardian 的 provider 运行时与部署工具，不能声称与前者二进制字节级一致。
