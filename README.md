# dsh-foxy-bili

Foxy 的 B 站子插件：它自己刷视频、读字幕、决定要不要评论/记下来，评论与记忆都经过 **foxy3 人设**。

> 这是一个 **DSH 插件**，不是 Koishi 插件。它依赖 `dsh-foxy`（人设/扩展契约）和可选的 `dsh-foxy-memory`（记忆）。

## 它做什么

- 定时从 B 站热门里取几条视频（不做全站爬取）；
- 读标题、简介、UP 主、时长、播放/点赞/评论，能读到字幕时读字幕；
- 用一个 **Foxy 的 DSH agent** 判断：
  - `skip`：无聊/广告/标题党，跳过；
  - `remember`：有点意思但不必公开评论，记一笔；
  - `comment`：值得在评论区说一句。
- 只有 `commentMode: auto` 且当天配额未用完时才发评论；
- 评论正文会按配置带 `@昵称`（B 站只认正文里的 `@`，`at_name_to_mid` 只是辅助）；
- 有趣的视频会写入 Foxy 记忆 provider（默认 `foxyMemory`，`scene: bilibili`）；
- 可选通过 Koishi 的 `foxy-memory-bridge` 给主人发 QQ 私聊，并把这条私聊写入 `scene: private` 的记忆。

**模型永远拿不到 B 站工具、Shell、文件系统。** 它只输出 JSON，网络写入由插件自己做。这样视频标题/字幕里的提示词注入无法越权。

## 安装

```powershell
dsh plugin --profile desktop add file:D:\Documents\deepseek-harness\default-workspace\dsh-foxy-bili
```

装完**完全重启 DSH**。然后可以直接点左侧栏的 **Foxy-bili** 图标，或打开 **设置 → Foxy-bili**；不需要手改 `cordis.patch.yml`。

## 设置页

左侧栏有 **Foxy-bili** 图标，点开就是同一套设置；也可以在 **设置 → Foxy-bili** 打开。

设置页包含：

- **账号与登录**：扫码登录 / 退出登录，显示当前账号；
- **浏览模式**：启用自动浏览、浏览间隔、每轮浏览数量、评论模式、每日评论上限；
- **评论功能**：默认提及账号、提及白名单、回复他人评论、楼中楼回复、立即评论一次；
- **私聊推送**：开关、私聊对象 QQ；推送内容会同时写入私聊记忆；
- **运行与日志**：立即运行、保存设置、上轮统计与逐条浏览记录；
- **记忆与启动**：写入 Foxy 记忆、启动 DSH 后自动运行。

### 扫码登录

点「扫码登录」后，插件会：

1. 调 B 站 passport 生成二维码（`qrcode` 在本地渲染成 data URL，不经过第三方）；
2. 每 2 秒轮询一次，最多约 3 分钟；
3. 登录成功后从轮询响应的 `Set-Cookie` 里提取 `SESSDATA`、`bili_jct`、`DedeUserID`、`buvid3`；
4. 只把凭证写到本机 `~/.dsh/foxy-bili/settings.json`，**不会回传给前端**。

如果二维码过期，重新点一次即可。

## 配置文件

设置页保存到：

```
~/.dsh/foxy-bili/settings.json
```

`cordis.patch.yml` 里的 `foxy-bili.config` 只作为首次默认值；设置页保存后会覆盖它。需要备份/迁移时复制这个 JSON 即可。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关 |
| `ownerUid` | 空 | 被 @ 的 UID，传给 B 站 at 接口 |
| `ownerName` | 空 | 评论正文里的 `@昵称` |
| `presetId` | `foxy3` | 读取的人设 |
| `presetPath` | 空 | 可选，直接指定 foxy3.yml |
| `intervalMinutes` | `90` | 扫描间隔，10–1440 |
| `maxVideosPerRun` | `5` | 每次最多看几条，1–20 |
| `commentMode` | `off` | `off` / `auto` |
| `maxCommentsPerDay` | `1` | 每天最多评论几条，0–10 |
| `enableMemory` | `true` | 是否写 Foxy 记忆 |
| `memoryPresetId` | `foxy3（Character）` | 记忆池 |
| `mentionOwner` | `true` | 评论是否默认 @ 主人 |
| `mentionWhitelist` | `[]` | 允许模型选择 @ 的账号，最多 20 个 |
| `replyOthers` | `false` | 是否允许回复视频下的一级评论 |
| `nestedReplies` | `false` | 是否允许回复楼中楼；需先开启 `replyOthers` |
| `privatePush` | `false` | 是否允许模型把有趣视频私聊推送 |
| `privateTarget` | 空 | 私聊 QQ；留空使用桥接配置的 `userId` |
| `runOnStart` | `false` | 启动 20 秒后先运行一轮 |
| `debug` | `false` | 额外日志 |

`cookie` 只存在于设置文件，设置页只显示「已登录 / 未登录」。

### 私聊推送

私聊推送需要 Koishi 侧安装并启用 `koishi-plugin-foxy-memory-bridge@0.1.15+`，并让 DSH 的 `dsh-foxy-memory` 指向同一个桥。插件会读取 `~/.dsh/foxy/settings.json` 的 `bridgeUrl` 和 `bridgeToken`，调用：

```text
POST <bridgeUrl>/send-private
```

模型必须同时给出 `dm: true` 和 `dmText`；`skip` 的视频不会推送。发送成功后，插件再写一条 `scene: "private"`、`platform: "qq"` 的记忆，内容类似“我在 QQ 私聊里，把刷到的视频发给了主人……”。

默认关闭；建议先在设置页填自己的 QQ，只对“觉得有意思”的视频开启，避免刷屏。

## 建议的安全顺序

1. 扫码登录，`enabled: true`、`commentMode: off`；
2. 先「立即运行」，看日志里它挑了什么、记忆写了什么；
3. 确认它不刷无意义视频后，改成 `commentMode: auto`，`maxCommentsPerDay: 1`；
4. 需要验证评论时用「立即评论一次」；它不占自动评论配额，但仍会真实发布；
5. 公开评论有账号风控风险，别一上来就高频；
6. 不要把 `ownerUid/ownerName` 填成陌生人。

## 限制

- B 站没有官方评论开放 API，使用网页 Cookie；WBI/风控变化可能导致读取或评论失败。
- 字幕接口经常要求登录，读不到字幕时只靠标题/简介判断。
- 评论是否显示受 B 站审核影响，插件只能提交，不能保证公开可见。
- 目前只做热门流，不做全站搜索/关注流。
- 记忆写入走 `dsh-foxy-memory` 的 provider；LivingMemory 桥已支持 `scene: bilibili` 的提示词。

## 开发

```powershell
node --check lib/index.js
node --check lib/client.js
node test/test-bili.cjs
```

## License

MIT
