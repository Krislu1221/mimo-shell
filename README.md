# Mimo Shell

**Mimo Shell** —— 给 [MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code) 引擎（`mimo serve`）套的浏览器 / macOS 桌面外壳。

上游官方的 `mimo web` 命令被临时下线，所以现成界面用不了。本项目直接架在 `mimo serve` 的
headless HTTP API 之上，自己写一个外壳——架构和 DSH 一样：**引擎在后，GUI 在前**。

## 功能一览

- **一体窗口**（`hiddenInset`）：左侧会话列表，右侧对话，无系统标题栏
- **纸面双主题**：浅色 / 深色，跟随系统，黑体字 + 斜体思考块
- **设置面板**：通用、会话行为（压缩/权限）、工具开关、飞书、引擎状态
- **发送队列**：任务进行中继续发消息，可编辑 / 删除 / 插队，回合结束自动发下一条
- **按会话草稿**：输入框文案跟会话走，切换不串、切回还在
- **图片粘贴 / 拖拽**、自动短名、右侧轮次索引条、会话统计条、下一步建议
- **飞书机器人桥**：飞书私聊 → `mimo serve` → 回复（本地长连接，无需公网 Webhook）
- **飞书 MCP**：设置里填 App ID/Secret，Agent 可调用飞书 OpenAPI

---

## 快速开始

```bash
# 1. 装 MiMo Code（如果还没装）
curl -fsSL https://mimo.xiaomi.com/install | bash -s -- --no-modify-path

# 2. 依赖
git clone https://github.com/YOUR_NAME/mimo-shell.git
cd mimo-shell
npm install
(cd vendor/feishu && npm i)   # 飞书机器人桥用的 SDK

# 3. 启动（二选一）
./start.sh /path/to/your/project     # Web 网关：http://127.0.0.1:5178
npm run app                          # macOS 桌面壳（开发模式）

# 打包装进 /Applications
npm run dist:mac
```

打开 <http://127.0.0.1:5178> 或启动「Mimo Shell」。

**密钥**：Coding Plan Key 优先读 macOS 钥匙链 `mimo-coding-plan`；也可用 `.env`（见 `.env.example`，勿提交真实 `.env`）。

`start.sh` 会拉起两个进程：`mimo serve`（引擎，端口 4096）和 Web 网关（端口 5178）。Ctrl-C 一起停。

---

## 快速上手

```bash
cd mimo-shell
./start.sh ~/你的项目目录      # 起引擎 + Web UI（引擎绑这一个目录）
```

浏览器打开 <http://127.0.0.1:5178>：

| 操作 | 怎么做 |
|---|---|
| 选模型 | 左下角第一个下拉框 → `MiMo Coding Plan / MiMo-V2.6-Pro` |
| 选 Agent | 第二个下拉框 → `build`（能改文件）/ `plan`（只读分析） |
| 发消息 | 输入框 **Enter** 发送，**Shift+Enter** 换行 |
| 看推理 | 点「思考过程」展开思维链 |
| 看命令 | 点工具条展开，能看到完整命令、输出、退出状态 |
| 中断 | 发送后变成「停止」按钮，点它中断当前回合 |
| 换项目 | 重新跑 `./start.sh 另一个目录`（自动重启引擎） |
| 停 | `./scripts/mimo-engine.sh stop` |

顶栏实时显示 `模型 · ttft · 输入/输出 tokens`，每条消息下方显示缓存命中与单步花费。

## 提问与授权弹窗

Agent 调 `question` 工具反问、或等权限确认时，会**一直停在 running** 直到有回复。
没有这个面板的话，除了「停止」没有任何出路。

实现要点（都是踩出来的）：

- **逐题作答**。一次请求可以带多个问题，答案数组要**按位置对齐**：
  `{answers: [[问题原文, 回答], ...]}`。把一个选项当成所有问题的答案是错的。
- **事件名是 `question.asked`，不是 `question.updated`**。按后者写的话计数器永远不涨，
  弹窗永远不出现，而 Agent 在后台一直等着——现象和「卡死」一模一样。
  所以匹配用前缀 `^(question|permission)\.`。
- **轮询兜底**。面板每 4 秒重读一次 `GET /question` / `GET /permission`
  （页面可见时）。少一个事件不至于让用户对着一个沉默的 Agent 干瞪眼。
- 契约：
  - 提问 `POST /question/:id/reply` → `{answers: [[q, a], ...]}`；`/reject` 可跳过
  - 授权 `POST /permission/:id/reply` → `{reply: 'once' | 'always' | 'reject'}`

---

## Agent 选择器

只显示 `mode === 'primary'` 且未隐藏的 agent，也就是 `build` / `plan` / `compose`。

`GET /agent` 混了三类：primary（可切换的会话模式）、subagent + hidden
（checkpoint-writer、compaction、distill、dream、summary、title，引擎内部用）、
subagent + 可见（explore、general，由主 agent 派生）。全倒出来会让下拉框变成垃圾场。

---

## 「下一步」预测

每轮结束后，下方出现 2-3 张「下一步」卡片，点一下就把那条完整指令填进输入框。
按 `1` / `2` / `3` 同样可以快速选中。

链路在网关的 `POST /api/suggest`：

1. 把会话最近的对话读出来，**等引擎把这一轮的消息落盘**（SSE 事件比持久化快，
   读早了拿到的是半截对话，预测会变空）
2. 直接问模型要 2-3 条完整指令，一次调用出全部
3. 模型调用失败时，才退回引擎自带的 `POST /session/:id/predict`（它也是一次模型调用，
   只出一条）

两个实测得到的调参：

| 做法 | 耗时 | 思维链 |
|---|---|---|
| 基线 | 5.4s | 84 token |
| `reasoning_effort: 'none'` | 15.2s | 0 |
| `thinking: {type:'disabled'}` | 28.4s | 0 |
| **`chat_template_kwargs: {enable_thinking: false}`** | **2.6s** | **0** |

所以用 `chat_template_kwargs`。端到端 4-8 秒出结果。

> 引擎的 `/predict` 本身命中率 6/6、质量也好，但它慢且只出一条，所以只当兜底。

---

## 断线与恢复

引擎一重启（换项目、换 key、崩溃），`GET /event` 这条 SSE 就断了。处理方式：

- **自己管重连**。浏览器的 `EventSource` 只在「连上之后掉线」时才会自动重试；上游挂掉时网关返回 **502**，
  而非 2xx 会让浏览器把 `readyState` 置为 `CLOSED` 并**永久放弃**。所以 `useEventStream` 自己维护
  重连循环（2s 间隔），并在标签页重新可见时立即重试。
- **重连后补数据**。断线窗口里推的事件是收不到的，所以重连成功后会重新拉一次会话历史，
  否则对话记录会静默少掉几轮。
- **报错条会自己消失**。发送失败 8 秒后自动收起，点 × 立即关，发送新消息时立即清掉，
  事件流恢复时清掉残留的「发送失败」。第一版那个卡住不消失的红条是最误导人的东西。
- 断线时顶栏的连接点变红，写着「○ 事件流断开」，恢复后自动变绿。

---

## 设计 token

样式直接取自 DeepSeek Harness，所以两边观感一致：

```
@deepseek-ai/dsh-client-ui-theme/lib/client.js
  body[data-ds-dark-theme] → --dsw-alias-*
    → --dsw-static-neutral-bluish-950  #151517  背景
      --dsw-static-neutral-bluish-875  #232324  侧栏/输入框
      --dsw-static-neutral-bluish-50   #f9fafb  主文字
      --dsw-static-neutral-bluish-300  #cfd3d6  次文字
      --dsw-static-neutral-bluish-400  #adb2b8  三级文字
      --dsw-static-deepseek-450        #5686fe  品牌蓝
      --dsw-static-deepseek-900        #283142  用户气泡
      --dsw-static-red-400             #f25a5a  错误
```

边框用 `rgba(255,255,255,.06/.12)` 这种极低透明度白，和 dsh 一样不画实线灰。

---

## 桌面应用（.app）

和 dsh 同款的 Electron 外壳：原生窗口 + 自己的图标 + 自己管引擎的生死。
**Web 层跑在主进程里**（Electron 内置 Node），所以打包产物不需要任何运行时。

```bash
npm run app        # 开发模式，直接开窗口
npm run dist:mac   # 打包 → release/
```

产物是**一个** app：

```
/Applications/Mimo Shell.app
  Contents/MacOS/launch                    编译出的 arm64 Mach-O 启动器（launcher.c）
  Contents/Resources/icon.icns              像素 Mi 图标
  Contents/Resources/engine/Mimo Shell.app  真正的 Electron 应用（嵌套）
```

**为什么入口必须是**编译出的二进制**而不是 shell 脚本：macOS 靠主可执行文件的
Mach-O 头判断 app 架构，`#!/bin/sh` 脚本没有这个头，判不出来就按「可能是
Intel app」处理，弹「即将结束对 Intel 芯片 App 的支持」。
`scripts/launcher.c` 用 clang 编成 arm64 再 exec 引擎，Info.plist 里再加
`LSRequiresNativeExecution = true`，双重保险。

为什么不是两个**：这台机器上 ad-hoc 签名的 Electron app 过不了 LaunchServices
（`codesign_util.cc: task_name_for_pid: (os/kern) failure (5)`，Electron 官方
的 `Electron.app` 同样失败），而机器上没有任何可用签名身份（`security find-identity`
是 0），所以没法换成正签。shell 脚本的 app 反而能正常启动，于是用它做入口。

把真身**嵌在 Resources 里**是关键：嵌套 bundle 不进 Launchpad 索引
（包内那 4 个 helper 也从没出现在那里），所以外面只有一个 "Mimo Shell"。

应用启动时：读钥匙链 → 若 4096 没有引擎就自己拉起 → 在主进程起网关（OS 分配端口）
→ 打开窗口；退出时只关自己拉起的那个引擎。

> ⚠️ 打包输出走临时目录（`$TMPDIR/mimocode-build`），**绝不能**把 `rmSync(dir, {recursive:true})`
> 指向 `~/Applications` 或 `/Applications` ——**那会连目录本身和里面所有别的 app 一起删掉**。
> 安装位置可用 `MIMO_INSTALL_DIR` 覆盖，默认 `/Applications`。

---

## 打包踩的坑（都是实际卡住过的）

1. **`ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成纯 Node**。DSH 在共享 shell 里设了这个变量，
   直接 `electron .` 会静默地不开窗口。所有启动路径都要先 `unset`（`scripts/electron.mjs` 负责）。
2. **ad-hoc 签名的 Electron app 在这台机器上起不来**。LaunchServices 启动报
   `codesign_util.cc: task_name_for_pid: (os/kern) failure (5)`，
   **Electron 官方下载的 `Electron.app` 也一样**（对照组实测），所以是环境特性，不是应用缺陷。
   直接执行二进制能跑 → 因此额外做了启动器包装，双击它由 shell 拉起二进制。
3. **`CFBundleName` 不能改**。Electron 按它去找 `Contents/Frameworks/<CFBundleName> Helper.app`，
   改名会导致 `FATAL: Unable to find helper app`。只改 `CFBundleDisplayName`——Finder / Dock /
   聚焦搜索读的都是它，所以用户看到的仍然是 "Mimo Shell"。
4. **签名必须由内到外**：`*.dylib` → `*.framework` → 嵌套 `*.app`（由深到浅）→ 外层。
   不能用 `codesign --deep`，对嵌套 bundle 不可靠；也不能先删 `_CodeSignature` 再 `--deep`，
   helper 会失效。
5. **`@electron/packager` 的 `ignore` 正则以 `/` 开头**。写成 `^node_modules/` 会一条都匹配不到，
   于是整个 `node_modules`（1.2 GB）被打进包里。正确写法 `^/node_modules`。
6. **`paths[0]` 返回的是外层目录**（`…-darwin-arm64`），不是里面的 `.app`，要自己找。

---

## 窗口标题栏

两种模式，`MIMO_TITLEBAR` 环境变量切换：

| 模式 | 设置 | 行为 |
|---|---|---|
| `default`（默认） | 不设或 `MIMO_TITLEBAR=default` | **原生标题栏**——有边框、拖标题栏即可移动、交通灯在 macOS 该在的位置 |
| `inset` | `MIMO_TITLEBAR=inset` | 隐藏标题栏的现代样式，内容顶到屏幕边缘 |

```bash
MIMO_TITLEBAR=inset ~/Applications/Mimo\ Shell.app/Contents/MacOS/Mimo\ Shell
```

inset 模式要自己补两件事，否则窗口是坏的：

1. **必须声明拖拽区**。`hiddenInset` 藏掉标题栏后，系统就没有原生拖拽条了，
   页面不写 `-webkit-app-region: drag` 的话窗口**完全拖不动**。
   这里给 `.topbar` 和 `.sidebar-head` 两个横条声明了 drag，其中的按钮/下拉框
   显式 `no-drag` 排除。
2. **必须给交通灯让位**。交通灯浮在内容之上，大约占 `x∈[14,66]`，会把左上角的
   品牌文字压住，所以 `.sidebar-head` 的左内边距改成 78px。

两套规则都挂在 `body.inset-titlebar` 下，默认模式完全不受影响。

---

## 架构

```
浏览器
  │  fetch('/api/...')  +  EventSource('/api/event')
  ▼
Node 网关  server/index.mjs      ← 静态托管 + 反向代理 + SSE 透传（零依赖）
  │
  ▼
MiMo 引擎  mimo serve --port 4096
```

网关是必要的，不是摆设：

- **SSE 必须透传不能缓冲。** `/event` 是长连接，攒够再发的话打字效果全没了。
- **`/api` 前缀剥离**，让前端和网关同源，不用处理 CORS。
- **可选访问令牌**（`MIMO_WEBUI_TOKEN`），方便在局域网里分享。

### 关键协议（踩过的坑，都写在这了）

| 事实 | 影响 |
|---|---|
| `POST /session/:id/message` **不是 SSE** | 响应是 `application/json`，整个回合结束时才一次性写出；期间用空格心跳保活 |
| 增量内容全在 `GET /event` | UI 靠 SSE 渲染，POST 只用来"发出去"和捕获硬错误 |
| `POST` 忙时返回 **202 + receiptId** | 排队语义，不能当错误处理 |
| `/event` 是标准 SSE（只有 `data:` 帧） | `EventSource.onmessage` 直接用，无需具名事件 |
| 空闲时 `GET /` 返回 **503** | 官方 Web UI 确实没打包，不是我们的问题 |
| `/config` 明文返回 API Key | 别把 4096 端口暴露到公网 |

---

## 凭证管理：钥匙链是唯一真源

MiMo **Coding Plan** 的 API Key（`tp-` 开头）**不落磁盘明文**。整条链路：

```
macOS 钥匙链  service="mimo-coding-plan"
   ↓  启动时读出 → export MIMO_API_KEY / MIMO_BASE_URL
   ├─→ Mimo Shell  配置里 apiKey: "{env:MIMO_API_KEY}"   ← 引擎启动时插值
   └─→ DSH         配置里 apiKeyEnv: MIMO_API_KEY        ← 进程环境
```

### ⚠ 读取命令有个坑

钥匙链这条目的 **account 属性是空的（`acct=NULL`）**，所以带着 `-a` 反而读不到：

```bash
# ❌ 读不到
security find-generic-password -a "$USER" -s "mimo-coding-plan" -w
# ✅ 能读到
security find-generic-password -s "mimo-coding-plan" -w
```

`scripts/mimo-key.sh` 两种查法都试，带 `-a` 的先试，所以不用管这个差异。

### ⚠ 两套 key 不要混用

| 前缀 | 是什么 | 端点 |
|---|---|---|
| `tp-` | **Coding Plan**（本项目用的） | `https://token-plan-cn.xiaomimimo.com/v1` |
| `sk-` | 平台 key（另一套账） | `https://api.xiaomimimo.com/v1` |

脚本在读到 `sk-` 开头时会直接警告。

### 读取优先级（钥匙链优先，明文只作兜底）

1. 钥匙链 `service="mimo-coding-plan"`
2. `~/.nanobot/env/mimo.env`（明文，仅兜底）
3. 本仓库 `.env`（明文，仅兜底 / 粘贴新 key 用）

### 用法

```bash
./scripts/mimo-key.sh status            # 看状态，不打印 key
./scripts/mimo-key.sh get               # 打印 key
./scripts/mimo-key.sh env               # 打印 export 语句
./scripts/mimo-key.sh save [--keep]     # .env → 钥匙链（默认清空 .env 明文）
./scripts/mimo-key.sh launchctl         # 写进 launchd，让 GUI 版 DSH 也能用
./scripts/mimo-key.sh clear             # 从钥匙链删除
```

### 引擎管理

```bash
./scripts/mimo-engine.sh start  [工作目录]   # 起 mimo serve，自动注入钥匙链环境
./scripts/mimo-engine.sh restart             # 重启（不传目录则沿用上次的）
./scripts/mimo-engine.sh stop / status
```

### 可用模型（Coding Plan 对话模型）

`mimo-v2.6-pro` / `mimo-v2.6-flash` / `mimo-v2.5-pro` / `mimo-v2.5`

> ⚠ 官方公告：`mimo-v2.5` / `mimo-v2.5-pro` 于 **2026-10-21 10:00 (UTC+8)** 下线，就在这两天。
> ASR / TTS（`mimo-v2.5-asr`、`mimo-v2.5-tts`、`tts-voiceclone`、`tts-voicedesign`）走的是不同接口
> （MiMoCode 的 `voice` 配置），不是对话模型，所以没配进来。

### 让 DSH 用上 MiMo

```bash
# 方式一：直接用包装脚本起 DSH（key 从钥匙链注入）
./scripts/dsh-with-mimo.sh web --no-open

# 方式二：给 GUI 版 DSH（从启动台打开的）注入
./scripts/mimo-key.sh launchctl   # 然后完全退出并重开 DeepSeek Harness
```

模型选 `MiMo Coding Plan / MiMo-V2.6-Pro`。DSH 侧 provider 由 `scripts/patch-configs.py`
幂等写入 `~/.dsh/profiles/<profile>/cordis.patch.yml`，带备份 + 写入后 YAML 结构校验。

DSH 侧 provider 配在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的 `llm-pi-ai.providers` 下，
由 `scripts/patch-configs.py` 幂等写入（带备份 + 写入后 YAML 结构校验，保证纯增量）。

---

## 已实现

- 会话列表 / 新建 / 删除 / 切换
- 实时流式对话（文本 + 思考过程 + 工具调用展开）
- 模型选择、Agent 选择、Harness 模式（auto / 默认 schema / Codex）
- 停止（abort）、顶栏 token 与 ttft 指标
- 工具调用折叠查看输入输出
- 引擎报错横幅（接 `session.error` 事件，失败时显示真实原因）
- **提问弹窗 / 授权弹窗**（见下）
- **「下一步」预测速选**：每轮结束后给出 2-3 条可直接发的下一步指令，按 `1`/`2`/`3` 快速选中
- **设置面板**（侧栏底部「设置」或 `⌘,`，见下）

### 设置面板

仿 DeepSeek Harness 的覆盖式设置：左侧导航四区，右侧表单，底部「放弃修改 / 保存」。

| 区 | 写什么 | 生效时机 |
|---|---|---|
| 通用 | 默认 / 小 / 视觉模型、默认 Agent、share、autoupdate、logLevel | 多数新会话生效；logLevel 需重启引擎 |
| 会话行为 | compaction（auto / prune / tail_turns / max_context）、permission（read/edit/bash） | 下一条消息 |
| 工具 | invocation_style、按工具开关 | 下一条消息 |
| 引擎 | 只读：版本 / 工作目录 / 端口 / 归属 / 配置路径；可一键重启引擎 | — |

- 配置真源是 `~/.config/mimocode/mimocode.jsonc`；每次保存前写 `.bak-<时间戳>`。
- **不碰 provider / API Key**（Coding Plan key 继续走钥匙链）。
- 引擎不是本应用拉起时（例如你先手动跑了 `mimo serve`），「重启引擎」禁用——本应用不会替你杀外部进程。
- 后端是网关本地路由 `GET/PUT /api/settings`、`POST /api/shell/restart-engine`，不转发给 `mimo serve`。

## 还没做

- 文件树浏览
- 终端（`/pty` WebSocket + xterm.js）
- 会话重命名、多项目切换
- 设置里的 experimental / workflow / checkpoint 全量字段（刻意只做高频四区）

---

## 用 MiMo 模型：两条路当前都不通，需要先登录

模型下拉框里能看到 `xiaomi/mimo-v2.6-pro` / `-flash` / `-pro-ultraspeed`，但**开箱即用不了**：

| 模型 | 状态 | 原因 |
|---|---|---|
| `mimo/mimo-auto`（匿名免费） | ❌ **已下线** | 引擎报 `MiMo free API service has ended. Sign in or configure a third-party API.` |
| `xiaomi/*` | ❌ **未登录** | `session.error` → HTTP 401 `Invalid API Key` |
| `deepseek/*` | ✅ 可用 | 本机 config 里已有 Key |

想让 `xiaomi/*` 跑起来，先在终端登录一次（OAuth，走浏览器）：

```bash
mimo providers login          # 选 "Xiaomi MiMo Platform"
mimo providers whoami         # 确认
```

登录后凭证落在 `~/.local/share/mimocode/auth.json`，`mimo serve` 会自动读到，Web UI 不用重配。

> 匿名免费通道下线这件事很关键：README 里写的 "MiMo Auto (free), zero configuration" 已经不成立了，
> 现在默认能跑通的只有你自己配的 provider。

---

## 目录

```
server/index.mjs        零依赖网关（静态 + 代理 + SSE）
web/src/lib/store.js    SSE 事件归约器（核心）
web/src/lib/api.js      API 客户端
web/src/components/     Sidebar / MessageItem / PartView / Composer
scripts/mimo-key.sh     钥匙链 ↔ .env
scripts/mimo-engine.sh  引擎启停（带钥匙链环境注入）
scripts/patch-configs.py 幂等写入 MiMo Code / DSH 的 provider 配置
scripts/dsh-with-mimo.sh 用钥匙链 key 起 DSH
```

---

## 已知限制

- 引擎绑**单个工作目录**（启动时的 cwd）。多项目要起多实例。
- **别用 `/tmp` 当工作目录**。macOS 上 `/tmp` 是 `/private/tmp` 软链，MiMo Code 的路径映射会错，
  工具调用会去读一个不存在的 `~/Desktop/<something>/` 路径然后卡住。用 `~/...` 下的正常目录。
- **工作目录的父目录里不能有叫 `mimocode.json` / `mimocode.jsonc` 的杂文件**。MiMo Code 会向上找项目级
  配置，命中就整台引擎的配置加载直接报错（`ConfigInvalidError`）。
- 官方 Web UI 下线前，MiMo 的会话历史、Skills 列表等 UI 专属接口不完整，深度功能以 CLI 为准。
- `/config` 会把 API Key 明文返回，所以网关默认只监听 `127.0.0.1`。

## 许可

本项目 MIT。MiMo Code 本身也是 MIT（XiaomiMiMo/MiMo-Code）。
