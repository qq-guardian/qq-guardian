# SnowLuma 与 QQ Guardian 的发行边界

QQ Guardian 的 SnowLuma provider 包不是 SnowLuma 官方发行包的替代品。

官方 SnowLuma v1.14.20 的 release 由 SnowLuma 自己的发布流水线生成，Windows x64、Linux x64、Linux arm64 分别提供 full/lite 发行包。官方 full 包携带 Node.js，lite 包使用系统 Node.js 22.13+（23 系需要 23.4+）。

QQ Guardian 的公开 provider 包采用相同的 platform + full/lite 发行模型，但只负责 Guardian 自身运行时。它不会复制官方 SnowLuma 的 snowluma-*.node、snowluma-*.dll 或 snowluma-*.so。

## 为什么大小不会与官方 SnowLuma 相同

这放发边界

Qݘ\ٚX[ȹc幯ŹkƹŮHۛݓ[XHٛX\و9c亯ι壂