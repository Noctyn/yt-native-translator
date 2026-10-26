# yt-native-translator

基于 Tampermonkey 的 YouTube 网页端评论区增强翻译脚本。直接复用官方评论区自带的翻译接口，无需配置第三方 API Key 或自建代理。

设计沿用同门的 [x-native-translator](https://github.com/Noctyn/x-native-translator)（Twitter/X 版）：同源 `fetch` + 当前登录会话 + 本地 LRU 缓存 + 悬停/自动触发 + 三视图切换。

## 安装

使用前需在浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey 扩展，通过以下任一途径安装：

- **[Greasy Fork 安装](https://greasyfork.org/zh-CN/scripts/602312)**（推荐）
- **[GitHub 直接安装](https://raw.githubusercontent.com/Noctyn/yt-native-translator/main/yt-native-translator.user.js)**

脚本只申请 5 个 `GM_*` 权限（读写存储、注入样式、注册菜单、跨标签同步），网络请求全部走 `www.youtube.com` 同源 `fetch`，因此不需要 `@connect`，也不会把数据发给第三方。样式优先用 `GM_addStyle` / 构造样式表（`adoptedStyleSheets`）注入，以避开 YouTube 的 CSP。

页面上不再放悬浮按钮。设置入口：油猴菜单里的「YouTube 评论翻译设置」，或快捷键 `Alt+Shift+S`。

## 主要功能

- **免 API Key**：复用 YouTube 网页端自己的评论翻译接口（也就是评论下方「翻译成中文（中国）」那个按钮背后的服务；该按钮默认被脚本隐藏），译文由 Google 翻译产出。
- **触发灵活**：
  - **悬停翻译**：鼠标停在评论上自动翻译，延迟可调（0–1000ms），可加 `Alt` / `Ctrl` / `Shift` 修饰键防误触。
  - **自动翻译**：滚动评论流时翻译可视区域内的评论与回复（`IntersectionObserver` + 停留判定）。
  - **隐藏原生按钮**：默认隐藏每条评论下方的「翻译成…」，避免和脚本译文框重复；关闭该选项即恢复网页自带按钮。
- **视图切换**：切换入口收在译文框底部，与「Google 翻译」同一行；点某条评论的「译文 / 对照 / 原文」只影响该条，全局默认（面板或 `Alt+Shift+T`）仍统一切换。
- **三款外观**：色条引述（默认）、轻盈卡片、极简竖线；深浅色主题自适应（直接采样评论正文前景色判定，不猜背景色）。
- **长评论分片**：超过 1200 字的评论按行切成多段分别请求再拼接，避开接口对超长文本的分段截断。
- **同语言跳过**：按 Unicode 书写系统判定（假名/谚文/西里尔/汉字…），与目标语言相同就不发请求。
- **缓存与限流**：本地 LRU 缓存（1000 条 / 3 天，可持久化，关页面前同步落盘）、并发 2 的队列（按离视口中线距离优先）、429/401 分级熔断与静默重试。
- **接口容错**：400/404/405 时先用兜底 `clientVersion` + 兼容上下文自动重试一次，不会因为单条失败全局停摆；连续 3 条失败才暂停 2 分钟（提示原因），点任意「重试」立即解除。
- **快捷键**：`Alt+Shift+S` 打开设置、`T` 切换显示方式、`A` 翻译可视评论、`P` 开关自动翻译、`C` 清空缓存。

## 界面预览

### 色条引述（默认）
![色条引述](https://raw.githubusercontent.com/Noctyn/yt-native-translator/main/assets/style-quote.png)

### 轻盈卡片
![轻盈卡片](https://raw.githubusercontent.com/Noctyn/yt-native-translator/main/assets/style-card.png)

### 极简竖线
![极简竖线](https://raw.githubusercontent.com/Noctyn/yt-native-translator/main/assets/style-minimal.png)

## 性能

评论区是 YouTube 上 DOM 最活跃的区域之一，脚本为此做了几件事，避免拖慢视频页：

- **单一长驻 `IntersectionObserver`**：只在初始化 / SPA 导航 / 设置变更时重建，新评论增量 `observe`；不在每次 DOM 变动时重建（评论多时重建会不断产生观察回调和重复入队）。
- **变更发现合并**：`MutationObserver` 对新增节点只做 O(1) 归属判断，每批变动最多对评论区扫描一次，避免逐节点 `querySelectorAll`。
- **队列不读布局**：入队时记录一次离视口中线的距离，`pump` 调度时不再 `getBoundingClientRect`，避免批量入队触发 O(n²) 强制重排。
- **失败标记**：同一条评论在同一目标语言下失败后，不再被自动触发反复重试，避免 429 时形成请求风暴。
- **缓存合并落盘**：脏标记 + 15s 去抖 + `pagehide` 同步，不再每条译文都写一次存储。
- **视图写入去重**：切换显示方式只写一次设置，不在每次挂载译文框时写存储。

`probe/perf.mjs` 是性能探针：在真实 watch 页滚动评论区，统计长任务、掉帧、观察器创建/重建、布局读取与 CPU 采样热点。用法：

```bash
node probe/perf.mjs dQw4w9WgXcQ --tag=after --scenario=auto-bilingual
node probe/perf.mjs dQw4w9WgXcQ --tag=before --script=probe/perf/before.user.js --scenario=auto-bilingual
```

场景：`baseline`、`auto-bilingual`、`auto-translation`、`visible-all`、`auto-long`、`baseline-long`。结果写到 `probe/perf/<tag>-<scenario>.json` 并打印摘要。


## 逆向出来的接口契约

结论全部经 cURL 与 patchright 实测复核（见下方「探针」）：

```
POST https://www.youtube.com/youtubei/v1/comment/perform_comment_action?prettyPrint=false
Content-Type: application/json
（Cookie 即可，无需 Authorization / SAPISIDHASH）

{
  "context": {
    "client": { "hl": "zh-CN", "gl": "US", "clientName": "WEB",
                "clientVersion": "2.20261023.01.00", "visitorData": "..." },
    "user":    { "lockedSafetyMode": false },
    "request": { "useSsl": true, "consistencyTokenJars": [] }
  },
  "actions": [ "<base64url protobuf>" ]
}
```

`actions[0]` 的 protobuf 结构（可直接自行构造，无需抓包）：

```
f1  varint  22                 # 动作类型：翻译评论（0/1/3 均返回 400）
f31 message
    f2 bytes   commentId       # 例如 Ugw1tpIYg_PAwdPneep4AaABAg
    f3 message { f1 { f1 string 原文 } }
    f4 bytes   目标语言        # zh-CN / zh-TW / en / ja / ko / ru ...
    f5 varint  0
```

响应里取 `frameworkUpdates.entityBatchUpdate.mutations[].payload.commentEntityPayload.translatedContent.content`。

网页端首屏评论响应中每条 `commentEntityPayload` 会带 `isTranslationAvailable: true` 与 `translateData.translateComment`（内含上面这个 action token）。脚本不依赖该下发字段，而是自己用「DOM 里的 commentId + 评论原文 + 目标语言」构造 token，因此不受首屏是否下发翻译数据的影响。

commentId 从 `span#published-time-text a[href*="&lc="]` 的链接里解析；接口**不校验** commentId 与文本是否匹配（实测伪造 ID 照样返回译文），所以解析失败时会退化成文本哈希占位。

已验证的边界：

| 场景 | 结果 |
| --- | --- |
| 省略 commentId / 省略原文 | 400 `invalid argument` |
| commentId 伪造 | 200，正常翻译 |
| 目标语言非法（`xx`） | 200 但译文为空串（脚本按失败处理） |
| 目标语言留空 | 200，按 `context.client.hl` 翻译 |
| 省略 / 留空 `context.client.clientVersion` | 404 `Requested entity was not found`（脚本从 ytcfg 取值并带兜底常量） |
| 省略 `context.client.clientName` | 400 `invalid value` |
| `clientName` 非 `WEB`（如 `WEB_MUSIC`） | 404 |
| `visitorData` 留空 | 200，正常翻译（脚本自愈时利用这一点） |
| 约 1300 字以内 | 完整翻译 |
| 约 8000 字 | 出现分段省略（故脚本按 1200 字切片） |
| `actions` 放多个 token | 只返回第一条（无法批量） |
| 连发 14 次 | 全部 200，未观测到限流 |

## 探针（本仓库的 `probe/`）

`probe/` 下是复现上述结论的脚本，需要本机有 `curl` 和 Node（`npm i` 装 patchright，浏览器可复用已缓存的 chromium）。

会话 Cookie 请写到 `probe/cookies.txt`（该文件与所有抓包产物都已在 `.gitignore` 里，不会入库）：

```bash
node probe/capture3.mjs dQw4w9WgXcQ   # 打开视频页、点原生翻译按钮、抓完整请求/响应
node probe/translate2.mjs             # 用 cURL 复现 perform_comment_action
node probe/limits.mjs                 # 语言/长度/字段边界矩阵
node probe/burst.mjs                  # 连发限流测试
node probe/verify.mjs                 # 注入油猴脚本做端到端功能+视觉验证
node probe/interact.mjs               # 快捷键 / 错误态重试 / 清缓存 / SPA 重置
node probe/longtest.mjs               # 超长评论分片是否丢字
node probe/themetest.mjs              # 深浅主题分支验证
node probe/perf.mjs                   # 滚动评论区的性能探针（长任务/掉帧/观察器/布局读取）
node probe/repro-jp.mjs [vid]         # 日文视频端到端回归（抓请求/译文/错误态）
node probe/self-heal.mjs              # 模拟上下文被拒，验证兼容上下文自愈
node probe/endpoint-fails.mjs         # 强制接口 404，验证三振熔断与点击重试恢复
node probe/ui-check.mjs               # 无悬浮按钮/原生按钮隐藏/单条视图切换/设置快捷键
node probe/error-ui.mjs               # 「原文」模式下错误信息与重试按钮仍可见
node probe/inspect-native.mjs         # 抓原生「翻译成…」按钮的 DOM 结构
node probe/decode-action.mjs          # 解码 perform_comment_action 的 protobuf
```

一个已知坑：patchright 的 `addInitScript` 只在页面的**第一次**导航生效，所以 `verify.mjs` 每步都开新页面，而不是在同一页面里反复 `goto`。

## 许可

MIT
