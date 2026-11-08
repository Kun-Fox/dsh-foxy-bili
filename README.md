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
- 主动评论正文会按配置带 `@昵称`；回复别人时 B 站已经显示回复关系，正文不再重复加 `@`；
- 同一个视频 24 小时内只自动回复一次，避免一条视频下被多条 @ 通知刷出多条回复；
- 有趣的视频会写入 Foxy 记忆 provider（默认 `foxyMemory`，`scene: bilibili`）；
- 可选通过 Koishi 的 `foxy-memory-bridge` 发 QQ 私聊，或直接用当前 B 站账号发站内私聊，并把这条私聊写入 `scene: private` 的记忆。

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
- **AI 模型**：跟随 DSH 当前模型，或填 Base URL、模型名、API Key 直连 OpenAI 兼容接口；
- **浏览模式**：启用自动浏览、浏览间隔、每轮浏览数量、兴趣关键词、兴趣分区、评论模式、每日评论上限；
- **评论功能**：默认提及账号、提及白名单、回复他人评论、楼中楼回复、立即评论一次；
- **私聊推送**：QQ 私聊 / B站私聊开关与对象；推送内容会同时写入私聊记忆；
- **评论回复**：检查「回复我的」「@我的」，查看原视频后回复；可配置间隔和每轮最多回复；
- **运行与日志**：立即运行、立即检查评论通知、保存设置、上轮统计与逐条浏览记录；
- **记忆与启动**：写入 Foxy 记忆、启动 DSH 后自动运行；
- **调试**：记录模型决策、记忆写入结果和通知处理，排查“为什么没写记忆/为什么跳过”。

### 扫码登录

点「扫码登录」后，插件会：

1. 调 B 站 passport 生成二维码（`qrcode` 在本地渲染成 data URL，不经过第三方）；
2. 每 2 秒轮询一次，最多约 3 分钟；
3. 登录成功后从轮询响应的 `Set-Cookie` 里提取 `SESSDATA`、`bili_jct`、`DedeUserID`、`buvid3`；
4. 只把凭证写到本机 `~/.dsh/foxy-bili/settings.json`，**不会回传给前端**。

如果二维码过期，重新点一次即可。

### 直连模型

默认 `llmMode: dsh`，B 站判断使用 DSH 当前选中的模型。若 DSH 的 provider 持续报传输错误，可以在设置页把调用方式改成 **直接 API**，填写：

- 接口地址，默认 `https://api.deepseek.com`；
- 模型名，默认 `deepseek-chat`；
- 自己的 API Key。

插件会直接请求 `<接口地址>/chat/completions`，不经过 DSH 的模型层。API Key 只保存在本机 `settings.json`，设置页只显示“已配置/未配置”，不会回传明文；留空保存表示保留原 Key。

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
| `interestKeywords` | `[]` | 标题/简介命中任一关键词才浏览；空数组不筛选 |
| `interestCategories` | `[]` | 只浏览命中的分区（`tname`）；空数组不筛选 |
| `commentMode` | `off` | `off` / `auto` |
| `maxCommentsPerDay` | `1` | 每天最多评论几条，0–10 |
| `replyInbox` | `false` | 是否检查「回复我的」「@我的」 |
| `replyIntervalMinutes` | `10` | 通知检查间隔，2–1440 分钟 |
| `maxRepliesPerRun` | `1` | 每轮最多回复几条，1–5 |
| `enableMemory` | `true` | 是否写 Foxy 记忆 |
| `memoryPresetId` | `foxy3（Character）` | 记忆池 |
| `mentionOwner` | `true` | 评论是否默认 @ 主人 |
| `mentionWhitelist` | `[]` | 允许模型选择 @ 的账号，最多 20 个 |
| `replyOthers` | `false` | 是否允许回复视频下的一级评论 |
| `nestedReplies` | `false` | 是否允许回复楼中楼；需先开启 `replyOthers` |
| `privatePush` | `false` | 是否允许模型把有趣视频通过 QQ 私聊推送 |
| `privateTarget` | 空 | 私聊 QQ；留空使用桥接配置的 `userId` |
| `biliDmPush` | `false` | 是否允许模型把有趣视频通过 B站站内私聊推送 |
| `biliDmTarget` | 空 | B站接收者 UID；留空使用 `ownerUid` |
| `llmMode` | `dsh` | `dsh` 跟随 DSH；`direct` 直连 API |
| `llmBaseUrl` | `https://api.deepseek.com` | 直连模式的 OpenAI 兼容地址 |
| `llmModel` | `deepseek-chat` | 直连模式的模型名 |
| `runOnStart` | `false` | 启动 20 秒后先运行一轮 |
| `debug` | `false` | 记录模型决策/记忆写入调试事件，设置页可查看 |

`cookie` 与 `llmApiKey` 只存在于设置文件，设置页只显示「已登录 / 未登录」「已配置 / 未配置」。

### 私聊推送

私聊推送支持两条通道，可以单独开，也可以同时开：

- **QQ 私聊**：需要 Koishi 侧安装并启用 `koishi-plugin-foxy-memory-bridge@0.1.16+`，并让 DSH 的 `dsh-foxy-memory` 指向同一个桥。插件会读取 `~/.dsh/foxy/settings.json` 的 `bridgeUrl` 和 `bridgeToken`，调用 `POST <bridgeUrl>/send-private`。
- **B站私聊**：直接使用当前扫码登录的 B 站 Cookie，调用网页私信接口。只有接口返回 `msg_key`（投递回执）才算成功；没有回执通常是对方不收陌生人私信或触发风控。

模型必须同时给出 `dm: true` 和 `dmText`；`skip` 的视频不会推送。发送成功后，插件再写一条 `scene: "private"` 的记忆，内容类似“我在 QQ 私聊/B站私聊里，把刷到的视频发给了主人……”。

默认关闭；建议只对“觉得有意思”的视频开启，避免刷屏。B站私聊要求接收者允许陌生人私信，第一次测试最好用自己的小号或已互关账号。

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
- 记忆写入走 `dsh-foxy-memory` 的 provider；LivingMemory 桥已支持 `scene: bilibili` 与 `scene: private` 的提示词。
- `skip` 的视频不写记忆；评论、手动评论和评论回复会写一条对应记忆。若写入失败，设置页“调试”会显示原因。
- B站站内私信要求对方允许陌生人私信；没有 `msg_key` 回执时插件会报失败，不会把“已提交”当成“已送达”。

## 开发

```powershell
node --check lib/index.js
node --check lib/client.js
node test/test-bili.cjs
```

## License

MIT
