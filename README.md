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
- 评论正文会带 `@主人昵称`（B 站只认正文里的 `@`，`at_name_to_mid` 只是辅助）；
- 有趣的视频会写入 Foxy 记忆 provider（默认 `foxyMemory`）。

**模型永远拿不到 B 站工具、Shell、文件系统。** 它只输出 JSON，网络写入由插件自己做。这样视频标题/字幕里的提示词注入无法越权。

## 安装

```powershell
dsh plugin --profile desktop add file:D:\Documents\deepseek-harness\default-workspace\dsh-foxy-bili
```

装完**完全重启 DSH**。然后在 `C:\Users\MECHREV\.dsh\profiles\desktop\cordis.patch.yml` 里找到/追加 `foxy-bili` 配置：

```yaml
- id: foxy-bili
  name: dsh-foxy-bili
  config:
    enabled: true
    cookie: 'SESSDATA=...; bili_jct=...; DedeUserID=...'
    ownerUid: '82588812'
    ownerName: '你的B站昵称'
    intervalMinutes: 90
    maxVideosPerRun: 5
    commentMode: 'off'        # 先 off；确认后再 auto
    maxCommentsPerRun: 1
    enableMemory: true
    memoryPresetId: 'foxy3（Character）'
```

没有 `cookie` 时只能读热门/视频信息，不能发评论。`bili_jct` 就是 CSRF token，发评论必需。

## 建议的安全顺序

1. `enabled: true`、`commentMode: off`，先看日志里它挑了什么、记忆写了什么；
2. 确认它不刷无意义视频后，改成 `commentMode: auto`，`maxCommentsPerRun: 1`；
3. 公开评论有账号风控风险，别一上来就高频；
4. 不要把 `ownerUid/ownerName` 填成陌生人。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 总开关 |
| `cookie` | 空 | B 站 Cookie；写评论必须含 `bili_jct` |
| `ownerUid` | 空 | 被 @ 的 UID，辅助字段 |
| `ownerName` | 空 | 评论正文里的 `@昵称` |
| `presetId` | `foxy3` | 读取的人设 |
| `presetPath` | 空 | 可选，直接指定 foxy3.yml |
| `intervalMinutes` | `90` | 扫描间隔 |
| `maxVideosPerRun` | `5` | 每次最多看几条 |
| `commentMode` | `off` | `off` / `auto` |
| `maxCommentsPerRun` | `1` | 每天最多评论几条 |
| `enableMemory` | `true` | 是否写 Foxy 记忆 |
| `memoryPresetId` | `foxy3（Character）` | 记忆池 |
| `runOnStart` | `false` | 启动 20 秒后先跑一轮 |
| `debug` | `false` | 额外日志 |

## 限制

- B 站没有官方评论开放 API，使用网页 Cookie；WBI/风控变化可能导致读取或评论失败。
- 字幕接口经常要求登录，读不到字幕时只靠标题/简介判断。
- 评论是否显示受 B 站审核影响，插件只能提交，不能保证公开可见。
- 目前只做热门流，不做全站搜索/关注流；后续可以加。
- 记忆写入走 `dsh-foxy-memory` 的 provider；如果 provider 是 LivingMemory 桥，B 站场景的提示词还需要桥侧支持（见 TODO）。

## 开发

```powershell
node --check lib/index.js
node test/test-bili.cjs
```

## License

MIT
