# 超级管理员保护与受控恢复

Guardian 把“可用超级管理员”定义为同时满足以下条件的账户：

- 角色是 `super_admin`；
- 用户名和密码哈希均存在；
- 账户未锁定，或临时锁定已经到期。

用户管理中的降级、删除、解锁、改密、会话撤销和审计写入由同一个 SQLite `BEGIN IMMEDIATE` 事务保护。任何操作如果会让可用超级管理员数量变为零，都会返回冲突错误并写入 `auth.user_mutation_rejected` 审计；用户和会话状态不会改变。WebUI 也会禁用当前账户和最后一名可用超级管理员的删除按钮，但服务器事务才是最终安全边界。

## 何时使用恢复流程

仅在所有超级管理员都因锁定、缺失密码或错误角色而无法登录，并且等待临时锁定到期也不能解决问题时使用。自动首次初始化只允许在用户表为空时运行；只要用户表非空，正常启动就不会自动重置或新建管理员，日志只会提示需要人工恢复。

恢复开关是显式授权边界。设置 `QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY=1` 时，用户名和密码两个环境变量都必须显式提供并通过校验；缺失、空值、只提供一项或格式无效都会让启动在密码哈希、一次性文件生成/读取、数据库变更、会话撤销和审计写入之前失败。恢复模式绝不会回退使用 `bootstrap-credentials.json`。

恢复会产生高影响变更：

- 如果指定用户名已存在，Guardian 会把该账户提升为 `super_admin`、设置新密码、清除锁定和失败次数，并撤销该账户的全部活动会话。
- 如果用户名不存在，Guardian 会创建新的超级管理员。
- 成功操作写入 `auth.super_admin_recovered` 审计，包含恢复模式和撤销的会话数量，但不记录密码。
- 如果在启动锁内已经出现另一名可用超级管理员，恢复会安全地变成无操作。

## 通用恢复步骤

1. 停止所有使用同一 Guardian 数据目录的实例。不要让 NapCat 插件和 SnowLuma sidecar 同时打开同一个 SQLite 数据库。
2. 在服务停止状态下备份完整的 Guardian 数据目录和配置目录；确认备份包含 `qqadmin.db`，并把备份保存在部署目录以外。
3. 只在一次启动的受保护环境中设置：

   ```text
   QQ_GUARDIAN_BOOTSTRAP_USERNAME=recovery-admin
   QQ_GUARDIAN_BOOTSTRAP_PASSWORD=<新的唯一强密码，至少 12 位且含大小写、数字和特殊字符>
   QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY=1
   ```

4. 只启动一个 Guardian 实例。确认日志出现“Break-glass super-administrator recovery completed and audited”。
5. 使用新凭据登录，在“审计日志”中确认 `auth.super_admin_recovered`，然后创建或验证第二名可用超级管理员。
6. 停止 Guardian，删除两个临时凭据变量，并删除或改回 `QQ_GUARDIAN_FORCE_BOOTSTRAP_RECOVERY`（建议完全移除；`0` 也表示关闭）。
7. 正常启动并再次登录，确认恢复开关未留在服务环境中。

如果恢复失败，停止服务并保留日志与当前数据。不要直接编辑 `users` 表，也不要删除数据库或持久卷；先修正环境变量、目录权限或磁盘问题。需要回滚时，保持服务停止并成对还原刚才备份的数据与配置。

## Docker Compose

在未跟踪的 `deploy/.env` 中临时加入三个恢复变量，然后只重建 Guardian 服务：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml stop guardian
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --force-recreate guardian
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=100 guardian
```

验证恢复后，从 `deploy/.env` 删除三个变量，再次使用 `--force-recreate guardian` 创建不带恢复权限的新容器。不要执行 `docker compose down -v`。

## NapCat 与原生 SnowLuma

NapCat 插件从 NapCat 进程环境读取恢复变量，因此必须完全退出 NapCat，给下一次启动注入三个变量，并在恢复成功后再次完全退出、移除变量再启动。

原生 SnowLuma sidecar 可在其私有环境文件中临时加入三个变量。使用同一个服务管理器或仓库提供的启动脚本启动一次；恢复成功后停止服务、从环境文件移除变量，再正常启动。环境文件应继续只允许服务身份和本机管理员读取。
