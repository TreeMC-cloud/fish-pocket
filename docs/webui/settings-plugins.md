# DSH Web UI 功能清单：设置 / 账号与凭据 / 模型 / 插件管理与插件市场

> 目的：让 SwiftUI 开发者**不读 React 源码**也能 1:1 复刻官方 Web UI 在本范围内的全部功能（手机重排）。
> 版本基线：`@deepseek-ai/*@0.2.1-rc.4`（`engine/node_modules/@deepseek-ai/`）。
> 每条功能有稳定 ID（`S-` 设置外壳、`G-` 通用、`A-` 账号、`M-` 模型、`I-` 内置插件清单、`AP-` Agent 预设、`O-` 首次引导、`P-` 插件管理、`PC-` 官方插件配置页、`MK-` 插件市场、`F-` Schema→表单、`C-` Cordis 面板、`MS-` 会话模型选择）。
> RPC 统一写成 Typert 端点字符串 `namespace/method`（即 `ctx.remote.<ns>.<method>`），参数为**具名参数**（名字即下文签名中的形参名）。传输层细节（`/api` 一元调用、`/api/remote.mux` WebSocket、`$events` 事件流）见同目录的协议文档 / `rpc-methods.json`，此处只写形状。

---

## 0. 读前须知（重要更正与总览）

1. **`dsh-client-ui-cordis` 不是 schema 表单渲染器。** 它是“模型动态定义的 Cordis 插件”的侧栏面板 + 工具卡片（见 §9 `C-*`）。Web UI 0.2.1-rc.4 **没有通用的 schemastery→表单自动渲染器**：
   - 官方插件配置页（子智能体 / 网页搜索 / Agent 循环 / 终端）和模型页都是**手写页面**，但共用 `ui-primitives` 的 `SettingsFormModel / SettingsValueField / settingsNumberField / settingsTextField` 一套“暂存-保存”语义（§8.4 有逐字节还原的算法）。
   - Host 的 `settings/describe` 对每个命名空间都给出 `autoGenerate`（默认 `true`）+ 序列化 schema，**意图**是“没有自定义页面时自动生成”，但 Web 端目前无人消费该标志。
   - 第三方插件的配置页是插件自己的 React 浏览器半部（`plugins.row.config` / `plugins.bundle.config` / `plugins.item` 槽位）——**原生 App 无法运行**。因此 §8 给出完整的 schema→SwiftUI 映射规范，建议 iOS 实现通用 `SchemaForm`，用于 `autoGenerate: true` 且没有原生页的命名空间（这是对 Web 的**增强**，用来替代跑不起来的 React 配置页）。
2. **所有能在设置页改的值都是 “live” 的**：`settings/describe` 只暴露 `.volatile()` 字段（`applies: "live"`），Host 拒绝写非 volatile 路径（`Config field "x" is not volatile`）。因此设置页里**没有“需重启”的字段**；需要重启的只有插件管理操作（`ChangeResult.application === "restart-required"`）。非 volatile 配置只能改 `cordis.patch.yml`（“打开配置文件”）。
3. **需要浏览器 / 无法原生的点**（详见 §12）：DeepSeek 账号登录（浏览器 OAuth + PKCE，回调必须是 loopback HTTP）、Platform 用量/充值页（Web 新开标签页）、插件自带的 React 配置页/详情扩展/自定义 Tab、Cordis 动态插件的 Client 半部、`settings/openSettingsDocument` 在 iOS 上 Host 侧直接抛错。

### 0.1 Web 信息架构 → iOS 导航

| Web 位置 | 内容 | iOS 建议 |
|---|---|---|
| 侧栏底部「设置」按钮 → 800×800 模态 | `settings.section` 按 `order` 排：账号与余额(-10，仅登录后显示) → 通用设置(0) → 模型(10) → 内置插件(15) → Agent 预设(20)；右上 `settings.action`「打开配置文件」 | 根 `NavigationStack` + `List`（`.insetGrouped`），每个 section 一个 `NavigationLink`；iPad 用 `NavigationSplitView` |
| 侧栏「插件」面板（`sidebar.panellist` → 主区） | Tab：已安装 / 发现（插件市场，实验 bundle 提供）；内置插件配置、实验性插件、已安装插件三组卡片；详情页 | 独立 Tab 或设置根下的一级入口「插件」；顶部 `Picker(.segmented)` 切 Tab |
| 侧栏头像/「更多」账号菜单（`settings.launcher`） | 设置、意见反馈、退出登录 / 登录 | 设置根页顶部账号卡片 + `Menu` |
| 首次运行对话框（`settings.onboarding`） | 预览版说明 → DeepSeek API Key / 账号登录选择 | `.sheet` / `.fullScreenCover` 串行 |
| 侧栏底部 Cordis 徽标（`sidebar.footer.action`） | 动态插件面板 | 插件页里的一个 Section 或工具栏按钮 + sheet |
| 会话输入框模型按钮、`/model` | 会话模型/推理等级 | 输入栏 `Menu` / sheet |
| 设置外壳上的连接状态胶囊 | 断开/重连/已连接 | 顶部状态横幅（`safeAreaInset`） |

---

## 1. 通用约定（所有页面共享）

### 1.1 Settings 镜像与写入
- **唯一读取**：`settings/describe()` → `SettingsDescribeValue`（§10.1）。前端维护一个共享镜像，在以下时机重新读取：首次连接、事件 `settings/document-updated(ns, revision)`、`connection/reset`（重连）。iOS：一个 `@Observable SettingsMirror`，所有页面从中派生。
- **字段写入**：一律用 `settings/mutate(ns, ops, expectedRevision)`（路径式；不会误删未下发的 secret）。`settings/update`（合并补丁）仅 Agent 预设默认值使用；`settings/replace` Web 不用。
  - `ops`: `[{op:"set", path:[...], value}, {op:"unset", path:[...]}]`；`unset` 移除用户覆盖、恢复继承值（base/default）；对数组索引 `unset` 删除元素。
  - `expectedRevision` = 读到的 `revision`；并发改动返回错误码 `settings/conflict {ns, expected, actual}`；其它拒绝 `settings/rejected {ns}`（消息原样展示）。成功返回该命名空间新的 redacted 视图（直接折叠进镜像）。
  - `ConfigForm` 写队列语义（`dsh-client-ui-settings`）：同一命名空间写入串行排队；失败后自动 `describe` 重读恢复；返回 bool（是否被接受）。iOS 用一个 per-ns `actor` 串行化。
- **可写性**：`describe.writable === false` → 所有写控件禁用（文案“本部署的设置为只读。”/“This deployment stores settings read-only.”）。
- **值的三层**：`value`（解析后：默认 → 组合 base → 用户层）、`base`（组合层，含默认）、`user`（原始用户段；**字段出现在 user 里即“已覆盖”**）。
- **Secret**：`role("secret")` 字段从 `value/base/user` 中被删除；`secrets: [{path, set}]` 告诉你槽位存在及是否已设。永远不回显 secret。
- **`whileServed(namespaces)`**：页面/行仅当 Host 当前提供该命名空间时才出现（命名空间消失则页面撤回）。iOS：`describe.namespaces.contains { $0.ns == X }` 决定是否显示。

### 1.2 RemoteResult 与错误
- 每个一元调用结果为 `{ok:true,value}` 或 `{ok:false,error:{code,message,details}}`，载体断开折叠为错误分支（`gateway/cancelled` 等）。iOS：`Result<T, RemoteError>`，`code` 字符串驱动本地化。
- 账号相关操作需带 `AccountClientMetadata`：`{version: <客户端版本>, locale: <当前 UI 语言>, timezoneOffsetSeconds: <调用时刻 UTC 偏移秒>}`（每次调用时采样）。

### 1.3 本地化
- 所有字符串都有 zh/en 两套（下文“关键字符串”表），语言切换即时生效（`G-02`）。
- 插件元数据 `LocalizedText = string | {en: string, [locale]: string}`：按当前语言 → 回退链 → `en` 取值。
- 占位符 `{name}` 形式，自行替换。

---

## 2. 设置外壳（ui-settings-general）

| ID | 功能 | 细节 | RPC / 事件 | iOS |
|---|---|---|---|---|
| S-01 | 打开/关闭设置 | 侧栏「设置」；快捷键 Desktop `Mod+,`，Web(Win/mac) `Mod+Alt+,`；Esc 关闭 | — | 根导航入口；iPad 硬件键盘 `.keyboardShortcut(",", modifiers: .command)` |
| S-02 | 分区导航 | 由 `settings.section` 条目按 `order` 生成；导航过长独立滚动 | — | `List` + `NavigationLink` |
| S-03 | 连接状态指示 | 黄色「连接异常，刷新重试 / Disconnected」可点击立即重连；重连中显示 loader + `重新连接中`（1–3 个点每 500ms），最短可见 800ms；恢复后绿色「连接成功」2 秒后淡出；首次启动及健康运行时静默 | 客户端连接状态；点击 = `connection.reconnect()` | 顶部横幅 `safeAreaInset(edge:.top)`；点按重连 |
| S-04 | 服务版本变化对话框 | 重连到不同 release 的 Host 时：两行“服务：旧→新（绿色实线箭头）”“页面：本页→Host（灰虚线）”；按钮「刷新以加载新版本」/「暂不刷新」；Host 回到原版本时自动关闭 | `ctx.modules.entries.releaseChange` | 原生 App 内嵌引擎时通常不出现；远程引擎时可用 `.alert` 提示“重新加载界面数据” |
| S-05 | 打开配置文件 | **仅 loopback 页面** 且 `describe.hasDocument === true` 时显示；调用后 Host 用原生文本编辑器打开 profile 的 `cordis.patch.yml`（macOS `open -t`）；失败显示「无法打开配置文件」并保留按钮 | `settings/openSettingsDocument()` → `{opened:true}` | **iOS 引擎内嵌：Host 侧在 `process.platform==='ios'` 抛 `native path opener is unsupported on ios`**。改为 App 内实现：直接读写 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（`TextEditor` 等宽 + 保存；HMR 会自动应用），另给 `ShareLink`/「在“文件”中打开」。远程引擎：可提供“在主机上打开”调用该 RPC |
| S-06 | 当前版本 | 通用设置底部「当前版本：{version}」（构建元数据 `DSH_CLIENT_VERSION`，无则不显示） | — | `LabeledContent` |
| S-07 | 桌面端更新指示 | 仅 Desktop（Electron）| — | 不适用（App Store 更新） |

关键字符串（`settings` 命名空间）：

| key | zh | en |
|---|---|---|
| title / trigger | 设置 | Settings |
| openDocument | 打开配置文件 | Open configuration file |
| openDocument.error | 无法打开配置文件 | Could not open configuration file |
| general.nav | 通用设置 | General |
| general.currentVersion | 当前版本：{version} | Current version: {version} |
| connection.error | 连接异常，刷新重试 | Disconnected |
| connection.connecting | 重新连接中 | Reconnecting |
| connection.connected | 连接成功 | Connected |
| connection.reconnect | 连接异常，点击立即重连 | Disconnected, reconnect now |
| connection.restart | 连接中断，正在重试，点击立即重连 | Reconnecting, reconnect now |
| hostRelease.title / description | 服务版本变化 / 服务版本已变化，本页面已暂停热更新，刷新后加载新版本。 | Service version changed / The service version changed. This page paused live updates; reload to load the new version. |
| hostRelease.service / page / unknown | 服务 / 页面 / 未解析 | Service / Page / Unknown |
| hostRelease.reload / later | 刷新以加载新版本 / 暂不刷新 | Reload to load the new version / Not now |

---

## 3. 通用设置（General）的每一行

`settings.general.item` 按 `order` 升序排列。所有行**即时保存**（无保存按钮），写入失败显示错误/Toast 并回滚到已接受值。

| ID | order | 行 | 控件 / 选项 / 默认 | 存储（ns.path） | 生效 | iOS 控件 |
|---|---|---|---|---|---|---|
| G-01 | -20 | 权限 Permission：「选择新会话的默认权限模式」 | 下拉；选项来自 `permissionPresets/catalog().defaultOptions`（Web 默认：`read-only` 仅可查看 / `workspace-write` 工作区内修改 / `full-access` 完全权限；不含仅当前会话的 `auto`）；默认 `catalog.defaultPreset`；选 Full access 需二次确认（勾选“我已了解风险，并愿意继续”后「启用完全权限」） | `permission.defaultPreset`（`settings/mutate`） | 仅影响**之后新建**的会话 | `Picker(.menu)` + 确认 `.sheet`（含 `Toggle` 确认勾选） |
| G-02 | 0 | 语言 Language | 菜单；选项=已注册语言（内置 `zh`、`en`，可被语言包扩展）；首次按系统语言匹配，回退英文 | `locale.preference` | 即时 | `Picker`；首次用 `Locale.preferredLanguages` |
| G-03 | 10 | 外观 Appearance | `light` 浅色 / `dark` 深色 / `system` 跟随系统；默认 `system` | `ui-theme.preference` | 即时 | `Picker(.segmented)` + `.preferredColorScheme` |
| G-04 | 11 | 字号大小（仅影响会话内容） | 步进 ±1，10–22，默认 14，单位 px；「更多字体设置」展开：代码字号 10–16 默认 11、终端字号 10–20 默认 13、正文字体/代码字体/终端字体（逗号分隔字体族，空=默认） | `ui-theme.fontSize` / `codeFontSize` / `terminalFontSize` / `textFontFamily` / `codeFontFamily` / `terminalFontFamily` | 即时 | `Stepper`；字体族 `TextField`（或映射到 Dynamic Type，保留数值存储以同步桌面） |
| G-05 | 12 | 工作步骤展示 Work details + 收起时机 | 展示：`compact` 简洁 / `standard` 标准 / `detailed` 详细 / `verbose` 完全展开（Web 非桌面默认 `detailed`；旧值 `normal`/`expanded` 兼容）；收起时机：`completion` 回答结束后（默认）/ `next-input` 下次有新消息时 | `ui-chat.transcriptView`、`ui-chat.collapseTiming` | 即时 | 两个 `Picker` |
| G-06 | 15 | 显示代码工作视图（Coding Tools） | 开关，默认 `true`；描述“开启后，显示轨迹、本轮代码差异，可选择完整的 Agent 预设切换”；写入中禁用；失败“保存失败，请重试” | `ui-settings.enabled` | 即时（关闭会把已保存的内置 PTC/Minimal 默认预设重置为 Standard，见 AP-03） | `Toggle` |
| G-07 | 16 | 快捷键（速查） | 打开快捷键参考 | 客户端 | — | 仅 iPad 硬件键盘时显示，或省略 |
| G-08 | 17 | 网页链接默认打开方式 | `sidebar` 应用内侧边栏（默认）/ `new-tab` 默认浏览器；仅当内置浏览器可用时出现 | `ui-chat.linkOpening` | 即时 | `Picker`：`sidebar`→`SFSafariViewController`，`new-tab`→`UIApplication.open` |
| G-09 | 20 | 繁忙时的发送行为 | `queue` 排队发送（默认）/ `steer` 插话发送；Cmd/Ctrl+Enter 用另一种 | `ui-conversation.busyEnter` | 即时 | `Picker`；手机上“长按发送=另一行为” |
| G-10 | 30 | 性能与用量 | `compact` 简洁 / `detailed` 详细（默认） | `ui-chat.performanceUsage` | 即时 | `Picker` |
| G-11 | 90 | 在使用官方模型 API 时上传 Session Log | 开关；仅当 Host 提供 `session-log-deepseek` 命名空间时出现；`!writable` 或未就绪时禁用；保存成功 Toast「设置已保存」，失败「无法保存设置」（Toast 关闭设置后仍显示） | `session-log-deepseek.enabled`（`ConfigForm.set`） | 即时 | `Toggle` + 全局 toast |
| G-12 | 100 | 当前版本 | 见 S-06 | — | — | `LabeledContent` |

G-01 额外：当前会话的权限切换在输入框（`conversation.input.permission`）与 `/permission` 命令，含实验性 `auto`（自动审查，`EXP` 徽章，单独风险确认）——属会话范围，见会话文档；`permission-presets/catalog-changed`（无参）事件时重读 catalog。

关键字符串（摘）：

| key | zh | en |
|---|---|---|
| permission title / description | 权限 / 选择新会话的默认权限模式 | Permission / Choose the default permission mode for new sessions |
| preset.readOnly / workspaceWrite / fullAccess | 仅可查看 / 工作区内修改 / 完全权限 | Read Only / Workspace Write / Full access |
| confirm.title | 确认启用完全权限？ | Enable Full access? |
| confirm.description | 启用完全权限后，新会话将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。 | Full access lets new sessions reduce confirmation steps and perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust subsequent tasks. |
| confirm.acknowledge / enable / cancel | 我已了解风险，并愿意继续 / 启用完全权限 / 取消 | I understand the risks and want to continue / Enable Full access / Cancel |
| language.title | 语言 | Language |
| appearance.* | 外观 / 浅色 / 深色 / 跟随系统 | Appearance / Light / Dark / System |
| fontSize.text.title/description | 字号大小 / 仅影响会话内容的字号 | Font size / Only affects conversation content |
| fontSize.code.* | 代码字号 / 用于代码块、行内代码与工具输出 | Code font size / Used for code blocks, inline code, and tool output |
| fontSize.terminal.* | 终端字号 / 用于侧栏终端 | Terminal font size / Used for the sidebar terminal |
| fontFamily.text.title / placeholder / fontSize.more | 正文字体 / 默认 / 更多字体设置 | Text font / Default / More font settings |
| settings.transcript.title/description | 工作步骤展示 / 选择希望看到多少工具调用细节 | Work details / Choose how much detail to show for tool calls |
| settings.transcript.compact/standard/detailed/verbose | 简洁 / 标准 / 详细 / 完全展开 | Compact / Standard / Detailed / Verbose |
| settings.collapse.title / completion / nextInput | 工作步骤收起时机 / 回答结束后 / 下次有新消息时 | When to Collapse Work Details / On completion / On next message |
| developerTools.title / description / error | 显示代码工作视图 / 开启后，显示轨迹、本轮代码差异，可选择完整的 Agent 预设切换 / 保存失败，请重试 | Show coding view / Shows trajectory, code diffs, and all Agent presets / Could not save. Please try again. |
| settings.links.title / sidebar / newTab | 网页链接默认打开方式 / 应用内侧边栏 / 默认浏览器 | Open chat links in / In-App Sidebar / Default Browser |
| settings.enter.title / queue / steer | 繁忙时的发送行为 / 排队发送 / 插话发送 | Send behavior while busy / Queue / Steer |
| settings.performance.title / compact / detailed | 性能与用量 / 简洁 / 详细 | Performance & usage / Compact / Detailed |
| sessionLog title / description | 在使用官方模型 API 时上传 Session Log / 帮助改进 DeepSeek 模型与产品 | Upload Session Log when using the official model API / Help improve DeepSeek models and products. |
| sessionLog saved / failed | 设置已保存 / 无法保存设置 | Preference saved / Could not save preference |

---

## 4. 账号与余额（DeepSeek 账号，ui-settings-account）

### 4.1 状态模型
`account/getState()` / `account/watch()`（流，首帧为完整快照，之后每次变化推完整快照）返回 `AccountView`：

```ts
{ status: "signed-out" | "credential-stored",
  links: { usageUrl: string, topUpUrl: string },          // 来自 Host platformOrigin
  attempt: null | { id: string,
    phase: "initializing"|"waiting-browser"|"exchanging"|"committing"|"succeeded"|"cancelled"|"expired"|"failed",
    authorizeUrl?: string, expiresAt?: number /*ms*/,
    errorCode?: "expired"|"no-response"|"network"|"protocol"|"storage" } }
```
流在载体重连后自动重开（watch 断开不会取消登录尝试）。

### 4.2 功能清单

| ID | 功能 | 细节 | RPC | iOS |
|---|---|---|---|---|
| A-01 | 账号分区可见性 | 设置导航中「账号与余额」**仅登录后显示**（`order:-10`，排第一）；状态未加载/登出后隐藏 | `account/watch` | 根页顶部账号 Section，未登录显示“登录”卡片 |
| A-02 | 账号卡片 | 32px 圆形头像（无 URL/加载中/失败显示账号图标；每次进入设置对失败头像重试一次）；姓名（无则「已登录 DeepSeek」）；状态行：联系方式（Platform 已打码手机号/邮箱）或「加载中…」/「账号资料暂不可用」；登录中显示阶段文案；右上「更多账号信息 ↗」打开 `new URL("/", usageUrl)` | `account/getProfile(client)` → `null \| {status:"ready", value:{id,name,contact,avatarUrl?}} \| {status:"failed"}` | `AsyncImage` 圆形；`Link` |
| A-03 | 余额卡片 | 「充值余额」：每种货币一行（CNY `¥` / USD `$`）；「赠金余额」：仅在加载中、读取失败、或有正数赠金时显示；读取失败显示链接「前往开放平台查看」（=用量页）；未登录「登录后查看」 | `account/getBalance(client)` → `null \| {status:"ready", value:[{currency,balance}], bonusWallets:[...]} \| {status:"failed"}` | `LabeledContent` 行 |
| A-04 | 金额格式 | Platform 规则：0 → `¥0.00`；负数四舍五入至少显示 0.01（`-¥0.01`）；0<x<0.01 → `<¥0.01`；正数**截断**到分，千分位 | — | 用 `Decimal` 实现同规则（不要用 Double） |
| A-05 | 查询用量 / 充值 | 「更多」行两个按钮：「查询用量」→`links.usageUrl`，「充值」→`links.topUpUrl`；Desktop 内嵌原生页（带 48px “返回 DeepSeek Harness” 条），Web 新开标签页；**链接从不携带 DSH token**；从充值页返回后重读 profile/balance/bonus | — | `SFSafariViewController`（sheet）；`onDismiss` 重读 A-02/A-03/A-08 |
| A-06 | 登录（浏览器 OAuth + PKCE） | 见 §4.3 | `account/startSignIn` / `account/cancelSignIn` / `account/watch` | `ASWebAuthenticationSession` |
| A-07 | 退出登录 | 先查运行中任务 → 确认对话框：有任务「当前有进程正在执行中，点击“退出登录”，将会打断进程，是否即刻退出登录？」/ 无任务「退出登录不会丢失任何数据，你仍可以登录此账号。」/ 查询失败「暂时无法确认任务状态…是否继续？」；取消/Esc 关闭；失败保持对话框可重试；**不删除 API Key** | `account/hasRunningAccountTasks()` → `boolean`；`account/signOut(client)` → `AccountView` | `.confirmationDialog`（destructive） |
| A-08 | 赠金到账通知 | 账号激活时及每次进入设置读取一次（不轮询）；服务端排序与文案（`message` 原样渲染，`title` 缺省用「赠金已到账」）；堆叠卡片，仅最前一张可交互；**卡片绘制即视为已展示**并发送确认（失败指数退避 1s→60s 重试）；关闭推出下一张（250ms 动画，减少动态时关闭） | `account/getUnnotifiedBonuses(client)` → `null \| {accountId, bonuses:[{title?,orderId,campaign?,amount?,currency?,grantedAt?,expiresAt,message}]}`；`account/ackBonusNotified(accountId, orderId, client)` → `boolean` | 顶部浮层卡片栈（`ZStack` + `.transition`）；`onAppear` 发 ack |
| A-09 | 余额不足提示（配额） | 会话请求失败 `ACCOUNT_QUOTA` 时：已登录弹「当前无可用余额」Modal（取消 / 去充值），未登录显示中性 Toast | 会话错误 | `.alert` + 打开 topUp |
| A-10 | 模型需要登录提示 | 事件 `deepseek-account/model-sign-in-required` → Toast「当前模型暂不可用，请登录后再试」（不重放） | `$on` | toast |
| A-11 | 登录失效提示 | 事件 `deepseek-account/session-expired` → Toast「登录信息已失效，请重新登录」；（另有流 `account/watchExpiry` 产出 `"session-expired"`，Desktop 用） | `$on` | toast |
| A-12 | 登录后默认模型 | 登录成功帧被接受后调用一次：当没有任何提供商配置 API Key 时，把第一个可用的 `deepseek-account` 模型设为默认；失败仅记日志 | `session/initializeDefaultModel()` | 同样在 watch 首个 `credential-stored` 帧后调用 |
| A-13 | 账号菜单 | 已登录：设置、意见反馈、退出登录；未登录：「更多」行 → 设置、意见反馈、登录；侧栏显示 24px 头像 + 姓名（回退打码联系方式，加载中空白） | — | 设置根页顶部 `Menu` |
| A-14 | 意见反馈 | 打开飞书问卷（`contactFormUrl`，默认 `https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1`）；每次点击采样：`prefill_uid`（profile ready 且有 id 才带）、`prefill_harness_version`、`prefill_device_info`（UA 或设备信息 + `; screen_resolution=WxH`，W/H=屏幕点×scale 取整），每个字段加 `hide_<name>=1`；删除 `os_version/device_brand/app_locale/screen_resolution/app_version/device_model` 的 prefill/hide 参数；绝不带 token | — | `UIApplication.open`；device_info 用 `UIDevice` 型号+系统版本 |
| A-15 | 首次登录选择 | 模型首次引导（O-02）前，未登录且无可用提供商时弹「开始使用」对话框：「登录」/「添加 API Key」 | 同 A-06 | `.sheet` |
| A-16 | Desktop 引导（欢迎/充值/用途/详细程度） | 仅 Desktop（`dshDesktop` 预加载桥）；进度存 `ui-settings-account.{version:1, step:"welcome"\|"credit"\|"purpose"\|"process"\|"done", purpose:"office"\|"development"\|"both"\|null, process:"compact"\|"standard"\|"detailed"\|null, completion:"completed"\|"skipped"\|"api-key"\|null, usage:"compact"\|"detailed", developerTools:boolean}`；完成时写 `ui-chat.transcriptView`+`ui-chat.performanceUsage`，再写 `ui-settings.enabled`，最后写 done | `settings/mutate` | 可选：iOS 首启引导可复用该状态机（不要求，Web 不显示） |

### 4.3 登录流程（A-06）——浏览器 OAuth，**不是**设备码

Host 侧（`dsh-deepseek-account-platform`）：
1. `account/startSignIn(client, callbackOrigin, loginSource)`：`callbackOrigin` **必须**匹配 `^http://(localhost|127\.0\.0\.1|\[::1\]):<非0端口>/?$`（否则 `errorCode:"protocol"`）；`loginSource ∈ {"web","desktop"}`。返回（或已有的进行中）`AccountView`，`attempt.phase="initializing"`。
2. Host 在**自己的 webServer** 注册精确路由 `GET /oauth/callback`，生成 PKCE(S256) + state，向 Platform `auth_init(redirect_uri = <callbackOrigin>/oauth/callback, login_source, locale)`，得到 `authorize_url`（必须是 Platform 源 `/dsh/authorize`）→ `phase="waiting-browser"`, `authorizeUrl`, `expiresAt`（`attemptTimeoutMs` 与服务端 TTL 取小）。
3. 用户在浏览器登录；Platform 302 到 `http://127.0.0.1:<port>/oauth/callback?code=…&state=…`。Host 校验 state（一次性），`phase="exchanging"` → `auth_exchange(code, code_verifier, device_id, device_model, os_version)` → `phase="committing"` → 存 grant → `phase="succeeded"`, `status="credential-stored"`。
4. 回调响应：成功 → **302 到 Platform `/dsh/authorized?login_source=…`**（两种 loginSource 都是）；失败 → `web` 返回一个尝试 `window.close()` 的 HTML 页，`desktop` 返回 204。
5. 取消：`account/cancelSignIn(attemptId)`（以 id 防止旧界面取消新尝试）。

Web 客户端行为：点击「登录」同步 `window.open("about:blank")` 预开标签（防拦截），拿到 `authorizeUrl` 后导航过去并追加 `theme=light|dark`（当前主题）；失败/过期/取消时关闭该标签；被拦截则提供「复制登录链接」（复制成功 2 秒恢复文案，失败显示「复制失败」2 秒）和「打开浏览器」链接。关闭等待中的对话框 = `cancelSignIn`。仅 `errorCode === "no-response"` 显示网络排查文案。

对话框状态 → 文案：
| 状态 | 标题 | 正文 | 按钮 |
|---|---|---|---|
| 初始 | 开始使用 | 登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。 | 添加 API Key / 登录 |
| initializing / waiting / exchanging / committing | 等待登录 | 没有自动打开新页面？[复制登录链接]，手动打开登录页完成登录。 | 取消（committing 时禁用） |
| expired | 登录已超时 | 请重新登录后继续操作。 | 重新登录 |
| failed | 登录失败 | 操作未完成，请重试。／no-response：操作未完成，可能是网络异常，请检查你的网络状况后重试 | 重新登录 |

**iOS 原生方案**：
- **内嵌引擎（推荐路径）**：`callbackOrigin = "http://127.0.0.1:<引擎 webServer 端口>"`，`loginSource = "web"`（拿到 Platform 的“已授权”完成页；`desktop` 失败时只得到空白 204）。
  1. 调 `startSignIn`，同时订阅 `account/watch`；
  2. 收到 `attempt.authorizeUrl`（`waiting-browser`）后：`URLComponents` 追加 `theme=<light|dark>`，启动 `ASWebAuthenticationSession(url:, callbackURLScheme: nil)`（`prefersEphemeralWebBrowserSession = false`，复用 Safari 的 Platform 登录 Cookie）；
  3. 浏览器重定向到 `http://127.0.0.1:<port>/oauth/callback` 时由**同设备 App 进程内的引擎**应答（设备 loopback 跨进程可达；ATS 不作用于 Safari 视图）；
  4. watch 到 `phase == "succeeded"`/`status == "credential-stored"` → 调 `session.cancel()` 程序化关闭授权页（因为回调是 http，不会触发 custom scheme 完成回调）；
  5. 用户手动关闭（`ASWebAuthenticationSessionError.canceledLogin`）且 attempt 仍活跃 → `cancelSignIn(attempt.id)`；
  6. 不要用 `UIApplication.open` 跳 Safari App 作为主路径：App 进入后台后引擎线程可能被挂起，回调将超时；它只作为“复制登录链接”的兜底。
- **远程引擎（Mac/云）**：Host 只接受 loopback 回调源，手机浏览器访问不到远端 loopback。方案：App 在本机起一个 `127.0.0.1:<p>` 的极简 HTTP 转发器，仅把 `GET /oauth/callback?…` 原样转发到远程 Host 的同路径并回传响应（302/204/HTML），`callbackOrigin` 填 `http://127.0.0.1:<p>`（redirect_uri 在 init/exchange 中一致即可）；或 SSH 端口转发；否则引导用户改用 API Key（Web 文档明确：通过 `--trusted-host`/HTTPS 反代访问时登录会失败，应添加 API Key）。

关键字符串（`ui-settings-account`）：

| key | zh | en |
|---|---|---|
| nav | 账号与余额 | Account |
| signedIn / signedOut | 已登录 DeepSeek / 尚未登录 | Signed in to DeepSeek / Not signed in |
| signIn / signOut / cancel / open | 登录 / 退出登录 / 取消 / 打开浏览器 | Sign in / Sign out / Cancel / Open browser |
| settingsSignedOutTitle | 当前未登录 DeepSeek Harness 账号 | You are not signed in to DeepSeek Harness |
| settingsSignedOutDescription | 登录 DeepSeek Harness 账号获取专属 API Key | Sign in to DeepSeek Harness to get your dedicated API Key |
| signInDescription | 登录 DeepSeek 账号以开始使用 | Use your DeepSeek account to get started. |
| initializing / waiting / completing | 正在发起登录… / 请在浏览器中继续 / 正在完成登录… | Starting sign in… / Continue in your browser / Completing sign in… |
| expired / failed / noResponse | 登录已过期，请重试。/ 操作未完成，请重试。/ 操作未完成，可能是网络异常，请检查你的网络状况后重试 | Sign in expired. Try again. / Could not complete the operation. Try again. / Something went wrong. Please check your network connection and try again. |
| loginTitle / loginDescription | 开始使用 / 登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。 | Get started / Sign in to your DeepSeek account or add an API Key to get started. Your projects and files are stored locally. |
| browserTitle / browserPrompt / copyLink / copiedLink / copyFailed / browserDescription | 等待登录 / 没有自动打开新页面？/ 复制登录链接 / 链接已复制 / 复制失败 / ，手动打开登录页完成登录。 | Waiting for sign in / Page did not open automatically? / Copy sign-in link / Link copied / Copy failed / , then open it in your browser to finish signing in. |
| timeoutTitle / timeoutDescription / failureTitle / retry | 登录已超时 / 请重新登录后继续操作。/ 登录失败 / 重新登录 | Sign in timed out / Sign in again to continue. / Could not sign in / Sign in again |
| addApiKey | 添加 API Key | Add API Key |
| profileUnavailable / loading | 账号资料暂不可用 / 加载中… | Account details are not available yet. / Loading… |
| balance / bonusBalance / balanceUnavailable / balanceSignedOut | 充值余额 / 赠金余额 / 前往开放平台查看 / 登录后查看 | Topped-up balance / Granted balance / View on Platform / Sign in to view |
| accountInfo / more / usage / topUp | 更多账号信息 / 更多 / 查询用量 / 充值 | More account information / More / View usage / Top up |
| signOutDescription | 退出登录不会丢失任何数据，你仍可以登录此账号。 | Signing out will not delete any data. You can sign in to this account again. |
| signOutRunningDescription | 当前有进程正在执行中，点击“退出登录”，将会打断进程，是否即刻退出登录？ | Tasks are currently running. Signing out will interrupt them. Sign out now? |
| signOutUnknownDescription | 暂时无法确认任务状态。退出登录可能会中断使用此账号的任务，是否继续？ | Could not check running tasks. Signing out may interrupt tasks using this account. Sign out now? |
| quotaTitle / quotaDescription / quotaTopUp | 当前无可用余额 / 没有可用额度时，DeepSeek Harness 无法开始新的任务，是否前往充值？或者可以稍后前往 设置 → 账号与余额 进行充值。/ 去充值 | No balance available / DeepSeek Harness cannot start a new task with this account when no balance is available. Would you like to top up? You can also top up later in Settings → Account. / Top up |
| bonusNoticeTitle | 赠金已到账 | Bonus credited |
| modelSignInRequired / sessionExpired | 当前模型暂不可用，请登录后再试 / 登录信息已失效，请重新登录 | Model unavailable. Please sign in and try again. / You have signed out of your account, please log in again. |
| contactUs / settings / menu | 意见反馈 / 设置 / 账号菜单 | Feedback / Settings / Account menu |
| platformFailed / platformRetry / backToHarness | 操作未完成，请重试 / 重试 / 返回 DeepSeek Harness | Could not complete the operation. Try again. / Retry / Back to DeepSeek Harness |

---

## 5. 模型（Models，ui-settings-models）

### 5.1 数据装配（一次“快照”）
并行：`llm/listProviders()`（已注册路由 `[{id,name}]`）+ `llm/listConfigurableProviders()`（可配置目录）+ `settings/describe()`；若含 `deepseek-account` 再调 `session/modelCatalog()` 判断账号是否有模型；然后对所有凭据引用分批（≤64）`credentials/describe(refs)`。

- `LlmConfigurableProvider`：`{provider, displayName, settingsNs, settingsPath[], declared?, defaultBaseURL?, baseURLEnv?[], nativeAuth?:{env[], oauth}, error?}`。`settingsPath` 为空表示整个命名空间就是该 profile（`llm-deepseek`）；pi-ai 为 `["providers", <route>]`。`declared:true` = 手工声明的自定义路由。
- 行合并：目录行 + 仅注册未声明的路由（`settingsNs:""`，无编辑器）。排序：`deepseek-account` 第一、`deepseek-official` 第二，其余保持目录顺序。
- 行状态：`configured`（ns 存在且 `getPath(value, settingsPath)` 非空）、`removable`（user 层有该路径且 base 层没有）、`apiKeyEnv`（profile 的 `apiKeyEnv`）、`credential`（命名引用的 `CredentialInfo`）、`derivedCredential`（`<ROUTE>_API_KEY` 的信息）、`credentialChecks`（`nativeAuth.env` 各变量的信息）。
- 派生凭据名：`provider.toUpperCase().replace(/[^A-Z0-9]+/g,"_") + "_API_KEY"`（如 `moonshotai` → `MOONSHOTAI_API_KEY`）。
- 订阅：`settings/document-updated`、`credentials/reference-updated(ref)`、`llm/adapters-updated`（无参）、`connection/reset` → 重新装配（保留打开中的草稿）。

### 5.2 功能清单

| ID | 功能 | 细节 | RPC | iOS |
|---|---|---|---|---|
| M-01 | 提供商列表 | 标题「模型」+ 引言；每行：显示名、状态点（绿=引用凭据已确认配置「API 密钥已配置」，红=命名引用确认缺失「API 密钥缺失」）、「编辑」「删除」；目录错误行显示诊断但仍可编辑/删除；只读部署提示 | §5.1 | `List`，行内 `Circle().fill(.green/.red)` + `swipeActions` |
| M-02 | DeepSeek 账号行 | `deepseek-account`「DeepSeek 账号」：仅当账号模型目录非空时显示，状态「已登录」，**无编辑器**（覆盖项在 `cordis.patch.yml` 的 `modelOverrides`） | `session/modelCatalog` | 只读行 |
| M-03 | 一次只开一张编辑卡 | 首次运行时，未配置 key 的整段提供商（如 DeepSeek）直接以“展开的设置卡”出现，直到关闭；不同卡片草稿互不影响；保存后等待新快照再显示“已保存 {provider}。” | — | 编辑卡 → push 详情 `Form` 或 `.sheet` |
| M-04 | API Key 输入 | 一个「API 密钥」输入框（从不读回已存值；`autocomplete=new-password`）；非空时出现眼睛按钮「显示密钥/隐藏密钥」，改动后重新遮罩；**校验**：空=保持原值；仅空白→「请输入 API 密钥；留空则保持已存储的密钥。」；`NAME=value` 形式（`/^[A-Z][A-Z0-9_]*=[^=]/`）或被成对引号包裹，或含非可打印 ASCII（须匹配 `/^[\x21-\x7E]+$/`，trim 后）→「该 API 密钥格式错误，请检查。」 | `credentials/set(ref, value)`；ref = profile `apiKeyEnv` ?? 派生名 | `SecureField` ↔ `TextField` 切换（眼睛按钮）；`.textContentType(.password)` 不要，改 `.textContentType(.oneTimeCode)`/`nil` 并 `.autocorrectionDisabled()`、`.textInputAutocapitalization(.never)` |
| M-05 | 认证提示（占位符/帮助） | 占位符：有已存凭据「留空使用已保存凭据」；否则若有环境变量回退「留空使用环境认证（{hint}）」；否则「输入 API 密钥」。下方提示：检测到环境变量（绿）「已检测到环境变量（{hint}）」/ 未检测到（警告色）「未检测到环境变量。请填写 API 密钥，或设置环境变量 {hint}。」/ 未确认「环境凭据状态尚未确认」。显示名单排除含 `oauth`（不区分大小写）的变量与 `baseURLEnv` 地址变量；无 key 认证的原生路由不显示 key 字段；「?」帮助「认证说明」：`keyHelp`（顺序：保存的凭据 → 启动环境 → `$cwd/.env` → `$DSH_HOME/.env`） | `credentials/describe` | 输入下 `Text` footnote（`.foregroundStyle(.green/.orange)`），`?` → `.popover` |
| M-06 | 自定义设置折叠（自定义设置 / Customized settings） | `baseURL`「API 地址」（占位符：DeepSeek=`https://api.deepseek.com/anthropic（默认使用环境 DEEPSEEK_BASE_URL）`；pi-ai 目录路由=`defaultBaseURL`；无则「没有默认地址」或「由提供方配置地址」，并在下方列 `baseURLEnv`「提供方地址配置：{env}」）；DeepSeek 卡提示「请填写兼容 Anthropic Messages 协议的 API 地址。」；pi-ai 未内置路由另有「显示名称」「API 协议」；**Provider ID 不可改**；无提供商级推理强度字段；`headers` 等其余字段只能改 `cordis.patch.yml`（`advancedHint`） | — | `DisclosureGroup` |
| M-07 | 模型目录编辑 | 标题「模型目录」，状态「正在使用适配器默认模型」/「已自定义模型目录」+「恢复默认模型」（unset 整个 `models`）；每个模型行：模型 ID（必填、唯一）、显示名称（可空=用 ID；显式空串不允许）、展开「模型选项」：上下文窗口 / 最大输出 token 数（两列；正数，支持 `K`=1000、`M`=1e6 后缀，正则 `/^(\d+(?:\.\d+)?)([km])?$/i`；空=提供商默认）、输入类型「文本」「图片」复选（至少一个；DeepSeek 写 `inputModalities`，pi-ai 写 `input`；DeepSeek 取消图片同时删除 `imagePixelBudget`、`imageMaxBytes`）；「添加模型」「删除模型」；空目录提示「模型选择器中将不显示任何模型；目录外 ID 仍可直接发送。」；未展示的模型字段原样保留；首次编辑会把继承的完整数组物化进 user 层 | `settings/mutate` | `ForEach` + `DisclosureGroup`；容量用 `TextField` + 自定义 parser；输入类型用两个 `Toggle` |
| M-08 | 推理等级（仅手工声明的 pi-ai 路由） | 开关「推理等级」+「?」；关=字段缺省（不推理）；开=从 off/low/medium/high 四行开始；每行「档位」选择（取自 schema `providers.<probe>.models.0.reasoningEfforts` dict 的 key 枚举：今为 `off,minimal,low,medium,high,xhigh,max`，每个仅用一次）+「API 参数值」（默认=档位名；Off 的值禁用）；增删行；校验「至少添加一个 Off 以外的档位…」「Off 以外的档位都需要填写 API 参数值…」 | — | 子 `Form` Section，`Picker` + `TextField` 行 |
| M-09 | 保存（Apply/保存） | 先写设置（`settings/mutate`，路径 ops：每个变化字段一个 `set`，清空字段一个 `unset`，携带卡片的 `revision`），成功后采用返回的 user 子树与 revision，再写凭据（失败只重试凭据阶段）；pi-ai 且无 `apiKeyEnv` 且填了 key → 同时写入 `apiKeyEnv: <派生名>`；冲突 →「这张卡片打开期间，这些设置已被其他地方改动。请关闭后重新打开，在当前值上编辑。」；被拒 → 原样显示 Host 消息、卡片保持打开 | `settings/mutate` → `credentials/set` | `.toolbar` 保存按钮 + `ProgressView` |
| M-10 | 删除提供商 | 仅 `removable` 行；确认「删除 {provider}？」：若 profile 引用的正是派生 `<ROUTE>_API_KEY` 且可写 → 文案含“和存储的 API 密钥”并先 `credentials/unset(ref)`；然后 `settings/mutate(ns,[{op:"unset", path: settingsPath}])` | `credentials/unset` / `settings/mutate` | `.confirmationDialog` |
| M-11 | 添加模型提供商 | 单入口按钮；卡片顶部分段「添加方式」：**第三方模型提供商**（从休眠目录选 provider，下拉列出 route id；随后同 M-04..M-09 编辑器）/ **自定义模型 API**（见 M-12）；某模式不可用时禁用并以 hover 文案说明（「目录中的提供商都已添加。」「没有可用的 API 协议。」）；两个面板草稿互不丢失；有写入/探测进行中时锁定切换 | — | `Picker(.segmented)` + 两个子视图（保持 `@State` 存活） |
| M-12 | 自定义模型 API（写入 `llm-pi-ai`） | 字段：Provider ID（`/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`，唯一）、显示名称（可选）、API 协议（`openai-completions`→“OpenAI Chat Completions”、`openai-responses`→“OpenAI Responses”、`anthropic-messages`→“Anthropic Messages”；实际选项取自 schema `providers.<probe>.api` union；未知值显示原 id）、API 地址（必须可解析 http/https；占位符随协议：OpenAI `https://gateway.example/v1`，Anthropic `https://gateway.example`）、API Key（可空=无引用，保留原生认证）、至少一个模型；创建=`settings/mutate("llm-pi-ai",[{op:"set",path:["providers",route],value:{displayName?, apiKeyEnv?, api, baseURL, models}}], revision)` 再 `credentials/set` | `settings/mutate`、`credentials/set` | `Form`；协议 `Picker` |
| M-13 | 获取可用模型 | 「获取可用模型」：用当前草稿探测 → 可搜索勾选列表（等宽显示原始 id，单行，长按/悬停显示名称）；「全选」只选可见结果，「取消全选」清空全部；「添加所选」把 id/name/contextWindow/maxTokens/input 复制进行（已有行保留用户值）；空结果「该提供商没有列出任何模型，请手动添加。」；未填地址「请先填写 API 地址，再获取。」；仅 OpenAI 兼容与 Anthropic Messages 协议可探测 | `llm/discoverModels(settingsNs, {provider?, baseURL?, api?, apiKey?})` → `[{id,name?,contextWindow?,maxTokens?,inputModalities?}]` | `.sheet` + `.searchable` + 多选 `List(selection:)` |
| M-14 | 扩展槽 | `settings.models.provider-card`（按 settingsNs 键入，渲染在卡片内）与 `settings.models.footer`（列表后）——第三方 React 扩展 | — | 原生无法渲染；忽略或 WebView（§12） |
| M-15 | 首次引导 | 见 O-01/O-02 | | |

模型页关键字符串见源码 `dsh-client-ui-settings-models/lib/client.js` `locales.js` 区（约 L3225–3500，含完整 zh/en）。高频项：

| key | zh | en |
|---|---|---|
| nav/title / intro | 模型 / 填入各提供商的 API 密钥即可使用其模型。 | Models / Enter your API keys to use models from the following providers. |
| edit / remove / apply / applying / cancel / close | 编辑 / 删除 / 保存 / 保存中… / 取消 / 关闭 | Edit / Delete / Apply / Applying… / Cancel / Close |
| savedProvider | 已保存 {provider}。 | Saved {provider}. |
| deleteTitle / deleteDescription / deleteDescriptionWithCredential | 删除 {provider}？/ 删除 {provider} 会移除其配置；其使用的凭证（如有）由其他位置管理，将会保留。/ 删除 {provider} 会移除其配置和存储的 API 密钥。 | Delete {provider}? / Deleting {provider} removes its configuration. Any credential it uses is managed elsewhere and will be kept. / Deleting {provider} removes its configuration and stored API key. |
| add / addMode / addCatalog / addCustom | 添加模型提供商 / 添加方式 / 第三方模型提供商 / 自定义模型 API | Add model provider / How to add / Third-party model provider / Custom model API |
| addCatalogHint | 从内置目录中选择 OpenAI、Anthropic、Kimi 等提供商，填入其 API 密钥即可使用。 | Pick OpenAI, Anthropic, Kimi, or another provider from the built-in catalog and enter its API key. |
| addCustomHint | 连接中转站、自部署服务或其他兼容 OpenAI / Anthropic 协议的接口，需填写 API 地址、协议和模型。 | Connect a relay, a self-hosted server, or any other OpenAI- or Anthropic-compatible endpoint by its base URL, protocol, and models. |
| credentialConfigured / credentialMissing / accountSignedIn | API 密钥已配置 / API 密钥缺失 / 已登录 | API key configured / API key missing / Signed in |
| keyInput / keyReveal / keyHide / keyPlaceholder | API 密钥 / 显示密钥 / 隐藏密钥 / 输入 API 密钥 | API key / Show secret / Hide secret / Enter your API key |
| customized / baseUrl / models / resetModels | 自定义设置 / API 地址 / 模型目录 / 恢复默认模型 | Customized settings / Base URL / Models / Restore defaults |
| modelId / modelName / contextWindow / maxTokens / modelInputTypes | 模型 ID / 显示名称 / 上下文窗口 / 最大输出 token 数 / 输入类型 | Model ID / Display name / Context window / Max output tokens / Input types |
| fetchModels / fetching / fetchTitle / fetchAdopt | 获取可用模型 / 正在询问提供商… / 选择要添加的模型 / 添加所选 | Fetch available models / Asking the provider… / Choose models to add / Add selected |
| customRoute / customApi / create / creating | Provider ID / API 协议 / 创建提供商 / 创建中… | Provider ID / API protocol / Create provider / Creating… |
| readOnly / loadFailed / retry | 当前部署的设置文档为只读。/ 加载提供商目录失败 / 重试 | The settings document is read-only in this deployment. / Loading the provider directory failed / Retry |

---

## 6. 内置插件（设置 → Built-in plugins，只读清单）

| ID | 功能 | 细节 | RPC | iOS |
|---|---|---|---|---|
| I-01 | 分区外壳 | 「内置插件」导航项（order 15）；仅一个 Tab（插件列表）时直接显示该页，≥2 个才显示 Tab 行；无 Tab「本部署没有开放任何插件视图。」 | — | `NavigationLink` |
| I-02 | 首次选中才读取 | 懒加载，每次挂载/重试一个快照（不订阅变化） | `pluginInventory/list()` → `{managementAvailable?, entries:[{entryId, moduleName, meta?, enabled, fiberPhase}], agentPresets?:[{id,name?,isDefault,broken?,rows:[{entryId\|null, moduleName, meta?, enabled: boolean\|"conditional", condition?, fiberPhase}]}]}` | `.task` on appear；下拉刷新 |
| I-03 | 两组 | 「会话插件 / 由 Agent 预设按会话组成」（默认展开，带预设切换器：默认预设加「（默认）」，坏的加「（加载失败）」，坏预设显示原因；切换器不写设置）+「全局插件 / 系统与所有会话共用」（默认折叠）；搜索时两组都展开，并提示「其他预设中还有 {count} 个匹配：」 | — | 两个 `Section`（`DisclosureGroup`）；切换器 `Picker(.menu)` |
| I-04 | 卡片 | 标题（本地化 meta；否则去 npm scope 与 `cordis:`/`cordis-plugin-`/`dsh-`/`dsh-host-`/`dsh-client-` 前缀的短名）；描述最多 2 行（展开显示全部）；标签仅在非“普通启用”时显示：已停用 / 条件启用 / 预设中启用 / 启动失败；状态点：`pending`=idle，`loading`/`unloading`=ongoing；entryId 代码 chip（与标题不同才显示，去掉 `include:` 前缀）；展开详情：完整名称（module）、entryId、来自（预设）、运行状态、禁用条件、全局行“全局已停用，由 Agent 预设按会话提供”+「启用于」预设名 | — | `DisclosureGroup` 行 |
| I-05 | 搜索 | 本地过滤：本地化标题、描述、模块名、entryId | — | `.searchable` |
| I-06 | 状态 | 加载骨架；错误「暂时无法读取插件。」+ 重试；空「暂无插件。」；无匹配「没有匹配的插件。」；客户端同步失败（Web 模块图）——iOS 不适用 | — | `ContentUnavailableView` |

字符串：`tab` 插件列表/Plugin list；`presetTitle` 会话插件/Session plugins；`globalTitle` 全局插件/Global plugins；`enabledTag/disabledTag/conditionalTag/presetEnabledTag/failedTag` 已启用/已停用/条件启用/预设中启用/启动失败 ↔ Enabled/Disabled/Conditional/Via presets/Failed；`pending/loadingPhase/active/failed/unloading/unobserved` 等待依赖/加载中/运行中/启动失败/卸载中/未运行 ↔ Waiting for dependencies/Loading/Running/Failed to start/Unloading/Not running；`moduleLabel` 完整名称/Module；`condition` 禁用条件/Disabled when；`search` 搜索插件/Search plugins。

---

## 7. Agent 预设（设置分区，order 20，简述）

| ID | 功能 | RPC |
|---|---|---|
| AP-01 | 列出内置/自定义两组卡片（名称、描述、id、默认徽章「新任务默认」、坏预设「加载失败」）；空组省略（自定义组保留“让 Agent 帮我创建预设”入口） | `agentPresets/list()` → `{presets:[{id,isDefault,name?,description?,broken?}]}` |
| AP-02 | 「设为新任务默认」 | `settings/update("agent-preset-registry", {selectedDefault: id}, revision)` |
| AP-03 | Coding Tools 关闭时仅显示 Standard/Creator/自定义（隐藏 PTC、Minimal），并把已保存的内置 PTC/Minimal 默认重置为 Standard | 同上 |
| AP-04 | 「查看配置」只读 YAML 查看器 | `agentPresets/read(agentPreset)` → `{agentPreset, content, name?, description?}` |
| AP-05 | 已知内置预设的说明/示例对话框；Creator 入口（`cordis` 预设在 roster 时）开新任务 | `agentPresets/select(agentId, agentPreset)` |

内置名称：标准模式/Standard mode、PTC 模式/PTC mode、极简模式/Minimal mode、创造模式/Creator mode。详细文案见 `dsh-client-ui-agent-preset` 的 locales（会话/预设文档应已覆盖）。iOS：`List` + `.contextMenu`，YAML 用等宽 `ScrollView { Text }`。

---

## 8. 首次运行引导（settings.onboarding）

| ID | 步骤 | 细节 | RPC | iOS |
|---|---|---|---|---|
| O-01 | 预览版说明（order -100，非 Desktop） | 标题「预览版说明」+ 长正文 + 「继续」；仅点继续时写 `ui-settings-general.welcomeNoticeVersion = "2026-09-28.1"`（精确比较，版本变化会再次显示）；写失败「暂时无法保存确认状态，请重试。」 | `settings/mutate("ui-settings-general",[{op:"set",path:["welcomeNoticeVersion"],value:"2026-09-28.1"}])` | `.fullScreenCover` |
| O-02 | DeepSeek 凭据（order 0） | 由模型快照判断：任一提供商可用（账号有模型 / 有引用且已配置 / 无引用路由）→ 跳过；否则若 `deepseek-official`（`llm-deepseek`、整段）存在且可写 → 先显示 A-15 登录选择（`settings.models.sign-in` 槽，由账号插件提供），再显示「添加一个 API Key 开始使用 / 配置 DeepSeek 官方模型，即可开始使用。」+ API Key 输入 +「稍后配置」「保存并继续」；只写 `credentials.set`（`DEEPSEEK_API_KEY` 或 profile 引用），不改设置；空值「请输入 API 密钥后继续。」 | `credentials/set` | `.sheet`（`interactiveDismissDisabled`） |
| O-03 | Host 开关 | `ui-settings-models` 的 Host 配置 `credentialOnboarding`（默认 true）经页面注入 `__DSH_MODELS_ONBOARDING__` 下发；Desktop 预加载存在时禁用 O-01/O-02 自动弹出 | — | 原生：读 `describe` 中 `ui-settings-models` 或直接按 App 自身策略 |

---

## 9. 插件管理（侧栏「插件」页，ui-plugin-manager）

### 9.1 数据装配
每次读取：先 `pluginInventory/list()` 判断 `managementAvailable`（false → 整页「本部署没有可管理的 profile，无法安装或启停插件。」），再并行 `pluginManager/listBundles()` + `pluginManager/listPlugins()`，按包合并：每个 bundle 的 `rows[].entryId` 关联 `PluginInfo`（得到 enabled、fiberPhase、patchId/readOnlyReason）。合并读取，操作后、`plugin-manager/changed`、重连时刷新。

`BundleInfo`（§10.4）关键字段：`name, official, availability("installation"|"profile"|"missing"), installTarget?{spec,version}, version?, meta?, description?, enabled, installed, source?, optional, removable, readOnlyReason?, error?, rows[{rowId,moduleName,meta?,entryId?}], overrides[]`。

### 9.2 分组与排序
- 列表集合：排除内置 profile bundle（`@deepseek-ai/dsh-base`、`dsh-web-app`、`dsh-headless`、`dsh-sdk-app`、`dsh-acp-app`、`dsh-sdk-minimal`），保留 `installed || official || error`。
- **内置插件配置**（`basicTitle`）：官方配置页卡片（`plugins.item`，按 order）：子智能体(10) → 网页搜索(20) → Agent 循环(30) → 终端(40)；卡片显示插图（Subagent/Search/Loop/Terminal artwork）+ 标题 + summary 文案。
- **实验性插件**（`extensionsTitle`）：`official` 包按固定顺序：主列表 `dsh-experimental-agent-team-profile`、`voice-input-bundle`、`auto-review`、`inspector-profile`；「更多」页额外（主列表上只在**已启用**时出现）：`experimental-tool-worktree`、`cot-translation-bundle`、`terminal-bundle`、`session-search`、`session-titles-bundle`、`badge-skill-bundle`、`ralph-bundle`、`plugin-market-bundle`、`dsh-subagent-codex`、`dsh-subagent-claude-code`（Codex/Claude Code 最后）；包名以 `@deepseek-ai/dsh-experimental-` 开头的显示「实验性」标签。
- **已安装插件**（`bundlesTitle`）：非官方包。
- 首次加载：分组标题占位 + 4 张骨架卡；刷新保留旧列表。

### 9.3 功能清单

| ID | 功能 | 细节 | RPC | iOS |
|---|---|---|---|---|
| P-01 | 页头 | 标题「插件」、副标题「安装、启用和配置插件」、ⓘ 说明（「在这里配置官方插件，安装和管理其他插件。内置插件列表及运行状态可在「设置 → 内置插件」中查看」）；「刷新」（悬停 500ms 提示；手动刷新时转圈且至少 400ms，失败保留缓存并 Toast「刷新失败，请重试」；首次失败原位「可能由于网络问题，无法读取全部插件」+ 重试）；「添加插件」主按钮 + 箭头菜单 | §9.1 | `.navigationTitle` + `.toolbar`（刷新、`+` 菜单）；`.refreshable` |
| P-02 | 添加插件菜单 | 「安装第三方插件 / 支持 npm 包、Git 仓库和本地目录」；「让 Agent 创建插件」（Agent 预设插件贡献：进入 Creator 模式，roster 加载中或不可用时禁用并说明）；`plugins.add.actions` 槽可再追加 | — | `Menu` |
| P-03 | Tab | 「已安装」+ 其它插件注册的 `plugins.tab`（如「发现」MK-*）；所选 Tab 跨离开保持；详情页隐藏 Tab；非“已安装” Tab 隐藏刷新/添加按钮 | — | `Picker(.segmented)` |
| P-04 | 卡片 | 图标（manifest `icon` data URL，失败用默认插图）、本地化标题（回退包名）、描述、版本 `v{version}`、标签（实验性 / 异常 / 未安装 / 包不可用 / 可更新）、开关；点击进详情 | — | `List` 行 + `Toggle` |
| P-05 | 启用/停用 bundle | 开关 → `setBundleEnabled(name, enabled)`；结果 `application`：`applied`（HMR 已重组）/ `restart-required`（Toast「请重启 DSH 使更改生效。{reason}」）/ `overridden`（Toast「{name} 已保存，但被更高优先级的配置覆盖，当前未生效」）/ `failed`（Toast「启用失败：{reason}」/「停用失败：{reason}」）；有 error 的包不可启用；提供管理组件的包锁定；未安装的按需官方包“打开”= 走 P-10 安装其 `installTarget` 并选中 | `pluginManager/setBundleEnabled(name, enabled)` → `ChangeResult` | `Toggle` 乐观更新 + 失败回滚 + toast |
| P-06 | 启用后引导 | `plugins.bundle.activation` 槽：从列表显式启用后由 bundle 提供的引导（React）| — | 原生忽略 |
| P-07 | 详情页 | 面包屑「插件 › 名称」/「返回插件」；标题 + 完整包名 + 版本/实验性/异常标签 + `plugins.detail.badge` 扩展；动作区：`plugins.detail.actions` 扩展 → 开关 →「更新」→「卸载」；描述；功能预览图（仅 badge-skill、voice-input 内置 SVG，按语言；解码失败「无法显示功能配图」）；`plugins.bundle.config`（bundle 自带配置，React）；组件列表；「来源信息」：「代码来源」=`source`（pnpm add 可接受的 spec）或「内置」，「当前版本」；按需官方包另显示「当前 DSH 对应来源」「当前 DSH 对应版本」；`plugins.detail.section` 扩展；问题包显示「原因」+ 诊断 | — | push `Form`/`List` 详情 |
| P-08 | 组件（rows）列表 | 计数「共 {count} 个」「{count} 运行中」「{count} 已停用」「{count} 异常」；每行：图标、本地化标题（回退 moduleName）、描述、状态点（pending/disabled=idle、loading/unloading=ongoing、active=done、failed=error）、开关（**仅 bundle 已启用时显示**；无 live entry 或 `readOnlyReason` → 锁定并显示原因）；有 `plugins.row.config` 的行有「配置 {name}」进入行页；>10 行显示「筛选组件」（标题/描述/rowId/moduleName）；空「这个插件包不包含任何组件。」 | `pluginManager/setPluginEnabled(entryId, enabled)` → `ChangeResult`（写 `cordis.patch.yml`，HMR 时即时生效） | `Section` + 行 `Toggle`；`.searchable` 仅 >10 |
| P-09 | 卸载 | 确认「卸载「{name}」？/ 卸载后它提供的功能会消失。」→ 卸载；安装随附的可选包无卸载；被选中但未持有的包“卸载”仅从列表移除 | `pluginManager/removeBundle(name)` → `ChangeResult` | `.confirmationDialog(role:.destructive)` |
| P-10 | 安装（对话框状态机） | `idle → checking → starting → running → done \| failed`，外加 `cancelling`、`applying`（Host 报告，不回退）、`unconfirmed`（结果/取消响应丢失）、`unknown`（Host 无该请求）。见 §9.4 | 见 §9.4 | `.sheet`（`presentationDetents([.large])`） |
| P-11 | 更新（按需官方包） | 安装版本/来源与 `installTarget` 不同 → 「更新」：先 `removeBundle` 再以相同选中状态 `installBundle(installTarget.spec, {saveExact:true(非 link:), enabled})`；安装失败则保持已卸载；报告是否需重启 | `removeBundle` + `installBundle` | 详情页按钮 |
| P-12 | 重启提示原因 | `restartReason`：`no-hmr` 这个 profile 只在启动时应用更改。/ `package-moved` 已安装的插件包解析到了另一个目录…/ `host-module` 更改涉及 DSH 自身已加载的模块。/ `unmanaged-plugin` 更改涉及一个不受插件列表管理的插件。/ `module-comparison` DSH 无法将已加载的插件与磁盘上的文件进行比较。 | — | toast 文案；**iOS 内嵌引擎可提供“重启引擎”按钮**（App 重建 Worker） |
| P-13 | 错误码文案 | `ManagementError.code` → 文案（见下表“reason*”）；`incompatible-version` 逐个列出 `{plugin} 与 DSH {runtime} 不兼容（要求 {requirements}）…` + 安装/已安装后缀；`operation-error` 显示 Host diagnostic | — | 本地化表 |
| P-14 | 官方插件配置页 | `plugins.item` 卡片 → 页面（标题/图标/面包屑由外壳画），见 §10 PC-* | | push |
| P-15 | 后台安装任务 | 关闭对话框（×/Esc/背景）立即隐藏并尽可能请求取消；隐藏任务以 Toast 报告结果（「插件安装已完成，可查看安装结果。」等），「查看安装任务」重新打开；结果未决时不能开始另一安装 | — | 全局安装任务 `@Observable`；toast 带“查看”按钮 |
| P-16 | 版本兼容豁免 | Web **没有 UI**；RPC 存在：列出/授予/撤销 `package@version` × DSH runtime 豁免（授予需 `acceptRisk:true` 并先警告“可能崩溃或数据丢失”）| `pluginManager/listVersionExemptions()` → `{exemptions: Record<"name@version", runtimeVersion[]>, warnings: string[]}`；`pluginManager/setVersionExemption(packageVersion, runtimeVersion, enabled, acceptRisk)` → `ChangeResult` | 可选增强：在 `incompatible-version` 错误旁提供“仍要运行（风险）”→ 二次确认 |

### 9.4 安装流程细节（P-10）

**表单（idle）**
- 输入「包名或地址」（占位「例如 dsh-plugin-whale-pet」）：npm 包名（可带版本）、Git 地址、tarball、绝对本地路径；回车提交（输入法组字中的回车不提交）。
- 「插件安装引导和示例」折叠：说明 npm 包名即 README 中 `dsh plugin add` / `pnpm add` 之后的部分，示例 `dsh-plugin-whale-pet` +「填入示例」；原样粘贴 Git/路径模板会提示「请替换为实际的 Git 仓库地址」/「请替换为本机插件目录的实际路径」。
- 常驻安全提示（`installGuideSafety`）与升级提示（`installUpgradeNotice`）。
- **安装源（Registry）**选择器：
  - 选项：pnpm 自身默认源（名字按其实际 URL：`registry.npmjs.org`→「npm 官方源」，`registry.npmmirror.com`→「中国大陆镜像源」，否则 host；Host 未读出前显示「默认安装源」）；Host 配置的镜像（`pluginManager/registries().fallbackRegistries` / `registry`）；npmmirror `https://registry.npmmirror.com/`；「自定义地址」（http/https，占位 `https://npm.example.com/`，提示私有源凭据放 `~/.npmrc`；非法「请输入以 http:// 或 https:// 开头的地址」阻止安装并聚焦）。
  - 初值：记忆值（`localStorage["dsh.plugin-manager.install-registry"]`，`{kind:"offered", registry}` 或 `{kind:"custom", url}`）> 手动 > 显式配置；当 pnpm 用未配置的官方 npm 且提供 npmmirror 时，首次调用 `pluginRegistryProbe/fastest()`（Host 并发 ping 两源 `/-/ping`，1500ms 超时，缓存 5 分钟）选更快者。
- 点击「安装」→ `checking`：`pluginManager/inspect(spec, {registry}, signal)`（返回/后退可 abort）。
  - `refused` → 字段下一句话：`invalid-spec` 无法识别这个包名或地址：{reason} / `already-installed` 该插件已安装。如需升级，请卸载后重新安装（DSH 自带包：该插件随 DSH 提供，升级 DSH 即可获得新版本）/ `not-found` 未找到相关插件 / `not-a-package` 该路径不存在或不是有效的插件包 / `not-a-bundle` 这个包没有声明组合包，无法作为插件安装：{reason} / `network` 无法连接插件源…（有 `registries` 时：所有安装源都无法连接（已尝试：{registries}）…）/ `unknown` 无法获取插件信息：{reason}。
  - `accepted {kind, name?, version?, description?, bundle, registry, host?}` → 开始安装，使用回答的那个 registry。

**安装中（starting/running）**
- 生成 `requestId = UUID`；调用 `pluginManager/installBundle(spec, {enabled:false, requestId, registry, saveExact?, approvedBuilds?})`（**长时一元调用**，安装完成才返回 `ChangeResult`；iOS 不要设请求超时）。
- 同时订阅事件并按 `requestId` 过滤：
  - `plugin-manager/install-state {requestId, phase:"installing"|"cancelling"|"applying", attempt?:{registry, index, total}}` → `installing` 每换一个源一次：「{previous} 不可用，正在改用 {registry} 重试（第 {index} 个源，共 {total} 个）」；`applying` 后不可取消（「正在应用配置，请稍候…」）。
  - `plugin-manager/install-log {requestId?, jobId, argv[], cwd, stream:"stdout"|"stderr", text, exitCode?}` → 按 `jobId` 分组成“终端块”：命令行（单行横向滚动）、输出（折叠「… 其余 {n} 行」）、状态（运行中/失败/已完成、退出码 {code}/信号/未正常退出）、徽章「第 {index} 次 · {registry}」、复制按钮。默认折叠在「查看安装详情」后。
- 显示 Host 读到的包名、简介、版本（`installVersion`）；`kind` 为 path/git/tarball 时显示「本地目录/Git 仓库/压缩包」。
- 「取消安装」（仅准备/下载阶段）：`pluginManager/cancelInstall(requestId)` → `{status:"cancelled"|"too-late"|"not-running"}`；确认取消后回到表单并 Toast「已取消安装，插件未启用，下载的文件可能保留」；取消早于 Host 接收时自动等待重试；失败可手动重试。
- 响应丢失 → `unconfirmed`：「未收到安装结果，请核对安装状态。{reason}」+「核对安装状态」→ `pluginManager/waitForInstall(requestId)` → `ChangeResult | null`（null = Host 无此活动请求 → 「未能获取安装结果 / 后端当前没有此安装任务。请检查插件列表后再尝试安装。」）。重连时自动重试。

**完成（done）**：`ChangeResult.application`：
- `applied` + `bundle` → 显示 pnpm 实际安装版本；若与 inspect 读到的版本不同（且只问了一个源）→ `installDoneOtherVersion`（minimumReleaseAge 说明 + `name@version`）；`approvedBuilds` 非空 →「已允许运行安装脚本：{names}」；`changed:false` →「安装完成，没有新增依赖。」；`restart-required` →「已安装，请重启 DSH 加载它。{reason}」。
- 「立即启用」→ `setBundleEnabled(bundle, true)`，关闭对话框并滚动到该卡片；「完成」关闭（已安装但未启用）。

**失败（failed）**：`packageResult.kind` → 一句话：`network`（`failedAt:"registry"` 且多个源：所有安装源都无法连接（已尝试：…）；`failedAt:"spec-host"`：无法连接 {host}。GitHub 地址和 .tgz 直链不经过安装源…）/ `not-found` / `no-matching-version` / `disk-full` / `permission` / `build-blocked` / `integrity` / `timeout` / `pnpm-missing` / `unknown`（安装过程中出错，原因见安装详情）；按钮「重试」，`failedAt==="registry"` 时加「更换安装源」（回到表单并展开源选择）。
- **构建脚本审批**：`pendingBuilds` 非空 → 「需要允许安装脚本」+ 包名列表 + 后果说明 +「允许这些脚本并重试」→ `installBundle(spec, {..., approvedBuilds: pendingBuilds})`（Host 写入 profile 的 `pnpm-workspace.yaml` allowBuilds）。
- **GitHub 不可达**（Host 归因于 GitHub 网络失败/超时且提供 npmmirror）：标题「无法访问 GitHub」/「连接 GitHub 超时」+「请尝试其他安装来源。」，按钮「改用国内镜像」（清空包名、记住镜像、不自动重装）；若已在用 npmmirror 则为「试试其他方式」（展开引导）。

**市场确认安装入口**（MK-07 调用的 `install({spec, registry?, title, version})`）：直接从 `checking` 开始，不显示表单；标题用 `title`+`version`，spec 小号等宽显示；registry 仅本次有效且不记忆；拒绝时提供「重试」；不提供 GitHub 镜像恢复；返回按钮会取消运行中的安装。

关键字符串（`ui-plugin-manager`，完整见 `dsh-client-ui-plugin-manager/lib/client.js` L75–523）：

| key | zh | en |
|---|---|---|
| title / intro | 插件 / 安装、启用和配置插件 | Plugins / Install, enable, and configure plugins |
| basicTitle / extensionsTitle / bundlesTitle / moreAction | 内置插件配置 / 实验性插件 / 已安装插件 / 更多 | Built-in plugin settings / Experimental plugins / Installed plugins / More |
| installedTab / refresh / addPlugin / chooseAddMethod | 已安装 / 刷新 / 添加插件 / 选择添加插件方式 | Installed / Refresh / Add plugin / Choose how to add a plugin |
| installExisting / installExistingDescription | 安装第三方插件 / 支持 npm 包、Git 仓库和本地目录 | Install a third-party plugin / Supports npm packages, Git repositories, and local directories |
| statusProblem / statusBeta / statusNotInstalled / statusMissingFiles / statusUpdateAvailable | 异常 / 实验性 / 未安装 / 包不可用 / 可更新 | Problem / Experimental / Not installed / Package unavailable / Update available |
| partsLabel / sourceTitle / sourceSpec / sourceBuiltIn / sourceVersion | 包含的组件 / 来源信息 / 代码来源 / 内置 / 当前版本 | Components / Source / Code source / Built in / Current version |
| uninstall / update / confirmUninstallTitle / confirmUninstallDescription | 卸载 / 更新 / 卸载「{name}」？/ 卸载后它提供的功能会消失。 | Uninstall / Update / Uninstall "{name}"? / What it provides goes away once it is uninstalled. |
| installTitle / installDescription / installSpecLabel | 添加插件 / 输入插件的包名、GitHub 仓库地址或本地目录路径。/ 包名或地址 | Add plugin / Enter the plugin's package name, GitHub repository address, or local directory path. / Package name or address |
| installGuideSafety | 请确认插件来源可信。插件在本机以你的权限运行，来源不明的插件可能损坏 DeepSeek Harness，或读取和泄露你的数据。 | Install only plugins you trust: they run with your permissions and can damage DeepSeek Harness or leak your data. |
| registryToggle / registryDefault / registryOfficial / registryNpmmirror / registryCustom | 安装源 / 默认安装源 / npm 官方源 / 中国大陆镜像源 / 自定义地址 | Registry / Default registry / Official npm registry / Mainland China mirror / Custom address |
| installRun / installChecking / installingTitle / installedTitle / installFailedTitle | 安装 / 正在检查… / 插件安装中… / 已安装 / 插件安装失败 | Install / Checking… / Installing the plugin… / Installed / The plugin could not be installed |
| installCancel / installEnableNow / installClose / installRetry / installChangeRegistry | 取消安装 / 立即启用 / 完成 / 重试 / 更换安装源 | Cancel install / Enable now / Done / Retry / Change registry |
| installApprovalTitle / installApproveAndRetry | 需要允许安装脚本 / 允许这些脚本并重试 | Install scripts need permission / Allow these scripts and retry |
| restartNotice | 请重启 DSH 使更改生效。{reason} | Restart DSH to apply the change. {reason} |
| overriddenNotice | {name} 已保存，但被更高优先级的配置覆盖，当前未生效 | {name} was saved, but a higher-priority configuration overrides it, so it is not in effect |
| unavailable | 本部署没有可管理的 profile，无法安装或启停插件。 | This deployment runs without a manageable profile, so plugins cannot be installed or switched here. |
| reasonManagementRequired / reasonUnaddressable | 插件管理所需，不能停用或卸载 / 当前 profile 的 patch 无法唯一定位这一项 | Plugin management needs it; it cannot be switched off or uninstalled. / The profile patch cannot address this one uniquely. |
| reasonNotRemovable / reasonStopProfile / reasonBundleInUse / reasonStaleApproval | 这个包不属于当前 profile，或者是插件管理所需的组件 / 这个 profile 没有启用 HMR，正在使用的包要停止后用 dsh plugin 卸载 / 其他配置仍在使用这个组合包的组件，请先停用它们 / 待允许的安装脚本列表已变化，请重新安装以刷新 | This package is not owned by the profile, or plugin management needs it. / This profile runs without HMR; stop it and uninstall the package with dsh plugin. / Other configuration still uses this bundle's components; switch them off first. / The pending script approvals changed; install again to refresh them. |

---

## 10. 官方插件配置页（plugins.item）

共同外壳（`SettingsForm`）：未加载「该插件当前未加载，暂时无法配置。」；只读「本部署的设置为只读。」；底部「保存 / 保存中…」+ 放弃（离开页面即丢弃草稿）；保存失败「本部署没有接受这些值，已保留供你修改。」。字段（`SettingsValueField`）：标签、提示、显示**有效值**，用户覆盖时显示「已覆盖」徽章 +「恢复默认」；清空=恢复默认（unset）；非数字「请填数字；留空表示使用默认值。」。语义见 §11.4。

| ID | 页面（order） | 字段 / 控件 | 存储 | iOS |
|---|---|---|---|---|
| PC-01 | 子智能体 Subagent（10）「设置子智能体的递归层级、数量和模型。」 | **运行限制**：最大递归深度（整数 ≥0，默认 1；ⓘ 说明 + 示例：0=禁用子智能体，1=仅允许主 Agent 创建子智能体；工具自定义深度优先）、子智能体并行数量上限（整数 ≥1，默认 8；ⓘ 主 Agent 不计入，达上限拒绝）；**模型选择**：开关「允许 Agent 为子智能体选择模型」（开启须至少选 1 个路由「Select at least one model before saving.」/「请至少选择一个模型后再保存。」；关闭保留已选）+ 按提供商分组的模型多选（来自 `session/modelCatalog().groups`），已存但当前不可用的列在「Saved but currently unavailable / 已保存但当前不可用」仍可移除；部分提供商失败提示；加载失败「重试」；一个「保存」分别写两个命名空间（各自 revision 栅栏，互相独立；模型草稿冲突→「Settings changed elsewhere. Discard your draft and try again.」） | `subagent.maxDepth`、`subagent.maxActiveSubagents`；`subagent-model-selection-settings.enabled`、`.allowedModels: [{provider, model}]`（`mutate` 两个 `set`） | `Form`：`TextField(.numberPad)` ×2（或 `Stepper`）；`Toggle`；`ForEach(groups){ Section { Toggle per model } }` |
| PC-02 | 网页搜索 Web search（20）「设置 DeepSeek 的搜索提供方。」 | 开关「启用新版 Web 搜索 API」（默认关；仅 Host 同时提供 `web`、`web-deepseek-api` 时显示；提示链接「网页搜索与抓取指南」→ zh `https://api-docs.deepseek.com/zh-cn/guides/search` / en `https://api-docs.deepseek.com/guides/search`；有非法草稿或保存失败时禁用）；API Key（每次加载为空；「已配置密钥。」/「未配置密钥；仅使用 DeepSeek 账号模型的对话可以通过默认接口地址搜索。」；空=保持；凭据不可写时禁用）；基础地址：关时「Messages API 基础地址」（`web-search-deepseek.baseURL`）/开时「Search / Fetch API 基础地址」（`web-deepseek-api.baseURL`，默认 `https://api.deepseek.com/v1/tools`）；关时「单次请求最多搜索次数」（`web-search-deepseek.maxUses` ≥1 默认 5）/开时「每次搜索结果数」（`web-deepseek-api.count` 1–50 默认 10，非法「请填 1–50 的整数；留空表示使用默认值。」）。保存顺序：先写提供商设置，再写选择：开=`web.searchProvider="deepseek-search-api"`,`web.fetchProvider="deepseek-fetch-api"`；关=unset 两者（若部署默认就是 API，则写 `deepseek-official` / `http`）；Key → `credentials/set(apiKeyEnv ?? "DEEPSEEK_API_KEY", key)`；监听 `credentials/reference-updated` 刷新 key 状态 | `web.*`、`web-search-deepseek.*`、`web-deepseek-api.*`；`credentials/describe([ref])`、`credentials/set` | `Form` + `Toggle` + `SecureField` + `TextField(.URL)` + `Link` |
| PC-03 | Agent 循环 Agent loop（30）「控制 Agent 派发工具调用的方式。」 | 并行工具调用数（≥1 整数，默认 10；「同一步内最多同时运行多少个可并行的调用。」） | `agent-loop.maxParallelToolCalls` | `TextField(.numberPad)` |
| PC-04 | 终端 Shell（40）「限制每条命令最多能跑多久、最多输出多少内容。」 | 命令超时（毫秒，默认 120000）、单流输出上限（字节，默认 64000；超出转存临时文件）；Host 提供 `pwsh-sandbox` 时编辑它，否则 `bash-sandbox` | `bash-sandbox.timeoutMs` / `.maxOutputBytes`（或 `pwsh-sandbox.*`） | 同上 |

卡片 summary（`view:"summary"`）= 各页描述文案。PC-01/PC-02/PC-03/PC-04 都是 `whileServed` 条件显示。

关键字符串（PC 公共 + 各页标题）：

| key | zh | en |
|---|---|---|
| overridden / reset | 已覆盖 / 恢复默认 | Overridden / Reset to default |
| save / saving / saveFailed | 保存 / 保存中… / 本部署没有接受这些值，已保留供你修改。 | Save / Saving… / The deployment did not accept these values; they were left for you to correct. |
| unavailable / readOnly / invalidNumber | 该插件当前未加载，暂时无法配置。/ 本部署的设置为只读。/ 请填数字；留空表示使用默认值。 | This plugin is not loaded, so it cannot be configured right now. / This deployment stores settings read-only. / Enter a number, or leave blank to use the default. |
| subagentTitle / subagentLimitsTitle / subagentMaxDepth / subagentMaxActive | 子智能体 / 运行限制 / 最大递归深度 / 子智能体并行数量上限 | Subagent / Limits / Maximum recursion depth / Subagent parallelism limit |
| subagentModelSelectionTitle / Toggle | 模型选择 / 允许 Agent 为子智能体选择模型 | Model selection / Allow agents to choose models for Subagents |
| webSearch title / useSearchApi / apiKey | 网页搜索 / 启用新版 Web 搜索 API / API Key | Web search / Use the new Web Search API / API key |
| maxUses / count | 单次请求最多搜索次数 / 每次搜索结果数 | Max searches per request / Results per search |
| agentLoop title / maxParallel | Agent 循环 / 并行工具调用数 | Agent loop / Parallel tool calls |
| shell title / timeoutMs / maxOutputBytes | 终端 / 命令超时（毫秒）/ 单流输出上限（字节） | Shell / Command timeout (ms) / Output cap per stream (bytes) |

---

## 11. Schema → 表单映射（通用 SchemaForm 规范，`F-*`）

### 11.1 线上格式（`settings/describe().namespaces[].schema`）
`schema` 是 schemastery `toJSON()` 信封：

```json
{ "uid": 12, "refs": {
    "12": {"type":"object","meta":{"default":{}},"dict":{"enabled":13,"maxUses":14}},
    "13": {"type":"boolean","meta":{"default":true}},
    "14": {"type":"number","meta":{"default":5,"min":1,"step":1}} } }
```
- 子节点引用是 **uid 数字**（字段 `dict`/`inner`/`sKey`/`list` 中的值），需从 `refs` 解析（可能共享/递归）。
- Host 已做处理（`volatileForm` + `plainSchema`）：**只包含 volatile 字段**（最近的 volatile 祖先之下整棵子树），`meta.volatile` 已被删除；`role:"secret"` 节点的 `default`/`required` 被删；其它 `default` 中的 secret 被 redact。
- `transform` 节点的 `callback` 可能是函数源码字符串——**原生端忽略**，按 `inner` 渲染。

### 11.2 节点类型 → SwiftUI
| ID | `type` | 判别 / meta | SwiftUI 控件 | 写入 |
|---|---|---|---|---|
| F-01 | `boolean` | — | `Toggle` | `set [path] Bool` |
| F-02 | `string` | 默认 | `TextField`（`meta.pattern{source,flags}` 用 `NSRegularExpression` 校验；`min/max` 视为长度） | 空串 → `unset`（与 `settingsTextField` 一致） |
| F-03 | `string` + `role:"secret"` | 值永不下发；`secrets[]` 中 `{path,set}` 告知是否已设 | `SecureField`，占位「已设置（留空保持）」/「未设置」；不回显 | 非空才 `set`；“清除”按钮 → `unset` |
| F-04 | `string` + `role:"credential-ref"` | 值是**凭据引用名**（如 `DEEPSEEK_API_KEY`），不是密钥 | 两段式：引用名 `TextField`（高级，可折叠）+ 关联的密钥 `SecureField`，状态来自 `credentials/describe([value ?? default])`（`configured/source("file"\|"env"\|dotenv)/writable`） | 引用名走 `settings/mutate`；密钥走 `credentials/set(ref, value)`（不可写时禁用） |
| F-05 | `string` + `role:"textarea"` / `"markdown"` | — | `TextEditor` | 同 F-02 |
| F-06 | `string` + `role:"link"` / `meta.link` | `meta.link` 为说明链接 | `TextField(.URL)`；`meta.link` 渲染 `Link("了解更多")` | — |
| F-07 | `string` + `role:"datetime"`/`"date"`/`"time"` | `Schema.date()` | `DatePicker` | ISO 字符串 |
| F-08 | `string` + `role:"regexp"` | `extra.flag` | `TextField` 等宽 + 校验 | — |
| F-09 | `number` | `min/max/step`；`role:"slider"`（`Schema.percent()`：0–1 step .01）；`role:"ms"` 毫秒 | 默认 `TextField(.decimalPad)`（空=unset，非有限数=invalid，与 `settingsNumberField` 一致）；`step` 为整数且有 `min/max` → `Stepper`；`slider` → `Slider`；`ms` 显示单位 | `set Number` |
| F-10 | `natural`（实为 `number` + `step:1,min:0`） | — | 同 F-09 整数 | — |
| F-11 | `const` | `value` | 只读 `Text`，或作为 union 选项 | — |
| F-12 | `union` 且全部为 `const` | 字符串/数字枚举 | `Picker`（≤3 用 `.segmented`，否则 `.menu`）；选项标签：`const` 节点的 `meta.description`（i18n）或值本身 | `set value` |
| F-13 | `union` 混合 | 如 `[const(null), string]`、`[is(Date), transform(string)]` | 选择第一个“可渲染”分支；含 `const(null)` → 增加“无”选项 | — |
| F-14 | `object` | `dict` | `Section`（顶层）/ `DisclosureGroup`（嵌套；`meta.collapse:true` 时默认折叠） | 子字段路径 `[...path, key]` |
| F-15 | `dict` | `inner`、`sKey`（键 schema，可能是 union 枚举） | 可增删的键值列表：`ForEach` + `.onDelete` + “添加”（键用 `TextField` 或 `Picker`（sKey 为枚举））；`role:"table"` 表格样式 | 增 `set [..., key]`；删 `unset [..., key]` |
| F-16 | `array` | `inner`；`role:"table"`（如字符串数组）| 可重排列表（`.onMove`/`.onDelete`）+ 添加；原子类型数组可用 token 输入 | 数组视为整体值：`set [path] [...]`（Web 模型页亦整体替换） |
| F-17 | `tuple` | `list` | 固定位置字段组 | `set [path] [...]` |
| F-18 | `intersect` | `list` | 合并各分支 `object` 的 dict 渲染 | — |
| F-19 | `bitset` | `bits: {name: bit}` | 多个 `Toggle` | `set` 整数位掩码 |
| F-20 | `any` / `is` / `function` / `never` | — | 不渲染（显示“请在配置文件中编辑”） | — |
| F-21 | `lazy` | — | 线上一般已展开；否则跳过 | — |

### 11.3 meta 字段 → 呈现
| ID | meta | 含义 | 呈现 |
|---|---|---|---|
| F-30 | `description: string \| {"": 默认, zh: …, en: …, "zh-CN"…}` | i18n 描述（`.i18n()` 合并；键 `""` 为未本地化原文） | 字段标签/说明：按当前语言 → 主语言子标签 → `en` → `""` 取值；Section footer 显示长描述 |
| F-31 | `default` | 默认值 | 空白字段的占位符；“已覆盖”判定看 `user` 是否含该键 |
| F-32 | `required` | 必填 | 空值时阻止保存并标红 |
| F-33 | `hidden` | 隐藏 | 不渲染 |
| F-34 | `disabled` | 禁用 | `.disabled(true)` |
| F-35 | `collapse` | 默认折叠 | `DisclosureGroup(isExpanded: false)` |
| F-36 | `badges: [{text:"experimental", type:"warning"} \| {text:"deprecated", type:"danger"}]` | 徽章 | 标签旁 `Text` 胶囊（橙/红） |
| F-37 | `role` / `extra` | 渲染角色（secret, credential-ref, table, ms, slider, textarea, link, datetime, regexp…）| 见 11.2；未知 role 回退到 type 默认控件 |
| F-38 | `link` | 外链 | `Link` |
| F-39 | `comment` | 注释 | 灰色小字 |
| F-40 | `pattern` / `min` / `max` / `step` | 约束 | 本地预校验（Host 仍做完整校验，拒绝时显示 `settings/rejected` 消息） |
| F-41 | `loose` | 宽松（允许 schema 外值） | 未知值原样显示并保留 |
| F-42 | `volatile` | 线上已剥离；出现即代表 live | 无需处理——describe 中的一切都是 live |

已知 role 实际使用（本版本）：`secret`（`web-search-deepseek.apiKey`、`web-deepseek-api.apiKey`、`deepseek-account.requestHeaders.*`）、`credential-ref`（`*.apiKeyEnv`）、`table`（hmr `root`/`ignored`）、`ms`（hmr `debounce`）。

### 11.4 暂存-保存语义（与 Web `SettingsFormModel` 字节级一致，F-50）
- 每字段状态 `{text, overridden, invalid}`；未暂存时 `text = format(value[field])`，`overridden = user 含该键`。
- 编辑：暂存 `{text, clear:false}`（首次暂存时记下 baseline 快照/revision）。“恢复默认”：暂存 `{text: format(base[field]), clear:true}`。
- 保存计划：对每个暂存字段——clear 且用户层有 → `unset`；text 未变 → 跳过；parse 结果 invalid → 阻止保存；parse 为 clear（空白）→ `unset`；否则 `set`。secret 字段（`secretSpecs`）只有非空才调用其 `write`（如 `credentials/set`），不进 mutate。
- 一次 `settings/mutate(ns, ops, baseline.revision)`；成功后依次执行 secret 写入；全部成功清空暂存；失败置 `failed`（保留草稿）。放弃 = 清空暂存。
- 数字 parse：`trim()` 空 → clear；`Number(x)` 有限 → set；否则 invalid。文本 parse：`trim()` 空 → clear，否则 set（trim 后值）。

### 11.5 何时使用通用 SchemaForm（建议）
- `autoGenerate === true` 且 iOS 无原生页的命名空间（`describe` 中除已知 ns 外的全部：已知 = `ui-*`, `locale`, `permission`, `session-log-deepseek`, `subagent*`, `web*`, `agent-loop`, `bash-sandbox`, `pwsh-sandbox`, `llm-*`, `agent-preset-registry`, `plugin-market` 等）。入口：插件详情页（按 bundle 的 `rows[].entryId` 关联 ns = Loader entry id）中的“配置”行。
- 插件调用 `ctx.settings.configure({auto:false})` 时 `autoGenerate:false`，表示它有自定义页（React）→ iOS 显示“此插件的配置页需要在桌面/网页端打开”或 WebView 兜底（§12）。

---

## 12. 插件市场（「发现」Tab，ui-plugin-market；由实验包 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 提供）

只在该 bundle 启用后出现（`plugins.tab` 注册）。Host 配置 `plugin-market.indexes: string[]`（默认 `[]`），`cacheTtlMs` 600000。

| ID | 功能 | 细节 | RPC | iOS |
|---|---|---|---|---|
| MK-01 | 索引源列表 | 读取已配置源（不抓取） | `pluginMarket/listIndexes()` → `[{url, title?: LocalizedText, description?, error?}]` | — |
| MK-02 | 空状态 | 「还没有插件市场 / 添加一个插件市场索引，即可在这里浏览和安装其中的插件」+「添加索引源」；源列表读取失败 → 「无法读取索引源」+ 重试 | — | `ContentUnavailableView` + 按钮 |
| MK-03 | 管理索引源对话框 | 「索引源」+ 说明；列表：市场标题（首次读取前用 host）、URL、上次失败原因、「移除」；输入「索引 URL」（占位 `https://example.com/index.json`）+「添加」；信任提示；拒绝时保留草稿并说明：非 http(s)/含凭据/含 `#`「请使用 http 或 https 地址，且不要包含用户名、密码或 # 片段」、重复「已添加过这个索引源」、部署不能保存「当前环境无法保存索引源」、其它「无法保存索引源」；新加的源自动成为当前市场 | `pluginMarket/setIndexes(urls)`（整体替换；错误码 `plugin-market/invalid-index-url {url,reason}`、`plugin-market/settings-unavailable`）| `.sheet` + `List(.onDelete)` + `TextField(.URL)` |
| MK-04 | 工具栏 | 市场菜单（切换市场，末项「管理索引源…」）、搜索框（停止输入 250ms 后发送）、「标签」多选菜单（仅市场声明 labels 时；`标签 · {count}`）、「排序」菜单、刷新；分类胶囊（「全部」在前，仅声明 categories 时） | — | `.toolbar` `Menu`；`.searchable`；分类用横向 `ScrollView` 胶囊 |
| MK-05 | 搜索/筛选/排序/分页 | `query = {text?, category?, labels?[] (须全部匹配), sort, offset, limit(1–100), refresh?, fetchedAt?}`；`sort`：有文字时默认 `{kind:"relevance"}`「最佳匹配」，否则 `{kind:"index"}`「默认顺序」；`{kind:"published", direction}`「发布时间」；每个声明的 sortKey `{kind:"key", id, direction}`（初始为声明的 `order`）；有方向的排序加一行「改为升序/改为降序」；输入文字自动从“默认顺序”切到“最佳匹配”，清空切回；分类/标签/排序键按本地化标题 `Intl.Collator` 排序；首屏 50 条，「显示更多」每次再 50（后续页带首页 `fetchedAt`，文档被替换则整列表重载一次，再次替换报错「此索引在加载过程中发生了变化」）；未声明的 id 自动移出查询 | `pluginMarket/search(url, query)` → `MarketSearchResult {url, title, description?, metadata:{categories, labels, sortKeys}, fetchedAt, entries:[MarketListingEntry], total, nextOffset}` | `List` + 底部“显示更多”按钮（或 `onAppear` 触底加载）；`Task` debounce 250ms |
| MK-06 | 卡片 | 图标（data URL 或绝对 URL，懒加载，`no-referrer`，失败默认插图）、本地化标题、标签 tag、一行描述、`{version} · {author} · {date}`；单一动作：可安装→「安装」；无默认版本且最高版本既不兼容也未豁免 → 禁用「安装」+ 提示「没有与当前 DSH {runtime} 兼容的版本」；`installation.status`：`installed`「已安装」/`update-available`「有新版本」/`provided`「随 DSH 提供」（点击切到“已安装”Tab 并打开该包详情，`openPackage(name)`）；`different-version` 视为可安装 | — | 行 + 尾部按钮 |
| MK-07 | 详情页 | 返回「发现」（保留搜索/筛选/排序）；完整描述、兼容性提示（`incompatible` 此版本与当前的 DSH {runtime} 不兼容，它要求 DSH {range} / `exempted`）；默认版本事实：作者、主页、源代码（仓库链接 + 目录）、软件包与注册表（npm）或仓库/完整提交/目录（git）、发布时间、分类、标签、插件市场；「版本」列表（SemVer 降序），标记：推荐（默认版本）/预发布/当前已安装/不兼容/已豁免，非当前且可安装的版本提供「安装」（DSH 自带的包除外） | — | push `Form`；`Link` 打开 homepage/repo |
| MK-08 | 安装确认 | 默认版本 → 确认框「安装「{name}」？」：图标、标题、版本、作者、来源事实、豁免提示、信任提示「插件在本机以你的权限运行。请确认你信任它的来源」→ 确认后调用插件管理器 `install({spec: version.install.spec, registry: version.install.registry, title, version})`，进入 P-10 的 checking 屏（无表单） | 走 P-10：`inspect` → `installBundle` | `.confirmationDialog` 或 `.sheet` → 复用安装 sheet |
| MK-09 | 状态 | 读取中骨架卡；失败短句 +「重试」（重试失败的那次读取），并保留上次列表；「此索引没有插件」/「没有符合条件的插件」；`plugin-market/changed` 与重连 → 重读源；`plugin-manager/changed` → 重载已加载页以刷新安装状态 | 事件 | `.refreshable` |

`MarketListingEntry`：`{name, title?, description?, icon?, author?, homepage?, repository?:{url, directory?}, metadata:{category?, keywords[], labels[], sortKeys:{id:number}}, versions:[{version, publishTimestamp(秒), source:{type:"npm",registry?}|{type:"git",url,commit,path?}, engines:{dsh?}, install:{spec, registry?}, compatibility:{compatible:true}|{compatible:false, runtimeVersion, requirements, exempted}}], defaultVersion?, installation:{status:"not-installed"|"installed"|"update-available"|"different-version"|"provided", installedVersion?}}`。已知限制：无“升级”动作（仅显示状态）；远程图标会暴露 IP。

关键字符串（`ui-plugin-market`，完整见 `dsh-client-ui-plugin-market/lib/client.js` L1108–1270）：

| key | zh | en |
|---|---|---|
| title / refresh / loading / retry | 发现 / 刷新 / 正在读取索引 / 重试 | Discover / Refresh / Reading the index / Retry |
| emptyTitle / emptyDescription / addFirstSource | 还没有插件市场 / 添加一个插件市场索引，即可在这里浏览和安装其中的插件 / 添加索引源 | No plugin markets yet / Add a plugin market index to browse and install its plugins here. / Add index source |
| manageSources / sourcesTitle / sourcesDescription | 管理索引源… / 索引源 / 插件市场以一个索引文件的 URL 提供，「发现」从这里列出的索引浏览插件 | Manage index sources… / Index sources / A plugin market is published as the URL of one index file. Discover browses the indexes listed here. |
| sourcesTrust | 索引由第三方提供。只添加你信任的来源：其中的插件安装后以你的权限运行 | Indexes come from third parties. Add only sources you trust: their plugins run with your permissions once installed. |
| search / filter / sortBy / sortRelevance / sortDefault / sortPublished | 搜索插件 / 标签 / 排序：{sort} / 最佳匹配 / 默认顺序 / 发布时间 | Search plugins / Labels / Sort: {sort} / Best match / Default order / Publish date |
| allCategories / showMore / noMatches / emptyIndex | 全部 / 显示更多 / 没有符合条件的插件 / 此索引没有插件 | All / Show more / No plugins match. / This index lists no plugins. |
| install / statusInstalled / statusUpdate / statusProvided | 安装 / 已安装 / 有新版本 / 随 DSH 提供 | Install / Installed / Update available / Provided by DSH |
| versionsTitle / versionDefault / versionInstalled / versionIncompatible / versionExempted / versionPrerelease | 版本 / 推荐 / 当前已安装 / 不兼容 / 已豁免 / 预发布 | Versions / Recommended / Installed / Incompatible / Exempted / Prerelease |
| confirmTitle / installTrust | 安装「{name}」？/ 插件在本机以你的权限运行。请确认你信任它的来源 | Install "{name}"? / Plugins run on this machine with your permissions. Make sure you trust where this one comes from. |
| readFailed / readInvalid / readChanged | 无法读取此索引 / 此索引的格式无效 / 此索引在加载过程中发生了变化 | Could not read this index. / This index is not in a valid format. / This index changed while loading. |

---

## 13. 会话模型选择（MS-*，与模型设置强相关，简述）

| ID | 功能 | RPC |
|---|---|---|
| MS-01 | 输入框模型按钮 / `/model`：按提供商分组（DeepSeek 账号第一、DeepSeek 第二）、>4 个模型显示搜索（不区分大小写子序列匹配，前缀优先）、选模型后可选推理等级（无元数据则无该行；`effort.providerDefault`「Default」）；未选/不在目录 → 「请选择模型」 | `session/modelCatalog()` → `{default:{provider,model,reasoningEffort?}, routableProviders[], groups:[{id,name,models:[{id,name,description?,reasoning?:{efforts:[{id,name,description?}], defaultEffort?}}]}], failures:[{id,name,message}]}` |
| MS-02 | 选择应用到下一个请求，并后台保存为默认 | `session/selectModel({sessionId, provider, model, reasoningEffort?})` → `{selected}`；错误「模型操作失败：{message}」；会话被其它 DSH 占用 `error.sessionInUse` |
| MS-03 | 目录刷新触发 | 事件 `llm/adapters-updated`、`settings/document-updated`、`credentials/record-updated(key)`、`credentials/reference-updated(ref)`；失败组「{name} 加载失败：{message}」+「重新加载」 |

iOS：输入栏 `Menu`（分组 `Section`），>4 个时用 `.sheet` + `.searchable`；推理等级二级 `Picker`。

---

## 14. Cordis 动态插件面板（C-*，`dsh-client-ui-cordis`）

| ID | 功能 | 细节 | RPC / 事件 |
|---|---|---|---|
| C-01 | 侧栏底部徽标「Cordis Plugin」+ `{count} running` | 计数=运行中+待审批 | `dynamicCordisRunner/inventory()` |
| C-02 | 面板列表 | 当前会话组「当前会话」在前、「其他会话」；每行：名称、用途（缺省「(未填写用途)」）、状态（待激活/待审批/运行失败/Client 待激活/运行中/已移除/已有更新）、版本「当前：{packageId}」「待切换：{packageId}」；动作：运行/停止/移除/重试/回退/查看；审批：允许 / 仅允许此版本 / 允许此插件的后续版本 / 拒绝；渲染失败内联显示 | `dynamicCordisRunner/stopFromPanel(agent, pluginId)`、`undefineFromPanel(agent, pluginId)`、`runHostHalf(...)`、`settleUserRun(...)`、`resolveRequestRun(...)` |
| C-03 | 刷新 | 事件 `cordis/dynamic-package`、`cordis/dynamic-retract`、`cordis/request-run`、`cordis/request-run-resolved`、`connection/reset` → 重读 inventory | |
| C-04 | 工具卡片 | `cordis_define`（名称/用途/源码 Host/Client 分栏 + 复制）、`cordis_run`（模式、ids、结果，`tool.view.cordis` 业务视图） | `dynamicCordisRunner/getClientCode(agent, pluginId, pluginRunId)` |

**iOS 限制**：Cordis 插件的 **Client 半部是浏览器 JS/React**，原生无法执行。iOS 可完整实现 Host 侧控制（列表、停止、移除、审批、只看 Host 运行），对需要 Client 半部的运行显示“需要网页端加载 Client 部分”，或在隐藏 `WKWebView` 中托管 Web 客户端运行时（成本高，建议 v2）。

---

## 15. RPC 方法总表（本范围）

| 端点 | 参数（具名） | 结果 | 使用处 |
|---|---|---|---|
| `settings/describe` | — | `{writable, hasDocument, namespaces:[{autoGenerate, ns, schema, value, base?, user?, applies:"live", secrets:[{path[],set}], revision}]}` | 全部 |
| `settings/mutate` | `ns: string, ops: ({op:"set",path:string[],value:any}\|{op:"unset",path:string[]})[], expectedRevision?: number` | `SettingsNamespaceView` | 全部写入 |
| `settings/update` | `ns, patch: object, expectedRevision?` | `SettingsNamespaceView` | AP-02 |
| `settings/replace` | `ns, section: object, expectedRevision?` | `SettingsNamespaceView` | （Web 未用） |
| `settings/openSettingsDocument` | —（可取消） | `{opened:true}` | S-05 |
| `credentials/describe` | `refs: string[]`（≤64） | `Record<ref, {configured, source?, writable}>` | M-*, PC-02, F-04 |
| `credentials/set` | `ref: string, value: string`（非空） | `void` | M-04, O-02, PC-02 |
| `credentials/unset` | `ref: string` | `void` | M-10 |
| `account/getState` | — | `AccountView` | A-* |
| `account/watch` | —（**流**，可取消） | `AccountView`（首帧快照 + 变更） | A-* |
| `account/watchExpiry` | —（**流**） | `"session-expired"` | A-11（Desktop） |
| `account/startSignIn` | `client: AccountClientMetadata, callbackOrigin: string, loginSource: "web"\|"desktop"` | `AccountView` | A-06 |
| `account/cancelSignIn` | `attemptId: string` | `AccountView` | A-06 |
| `account/signOut` | `client` | `AccountView` | A-07 |
| `account/hasRunningAccountTasks` | — | `boolean` | A-07 |
| `account/getProfile` | `client` | `null \| {status:"ready", value:{id\|null, name\|null, contact\|null, avatarUrl?}} \| {status:"failed"}` | A-02 |
| `account/getBalance` | `client` | `null \| {status:"ready", value:[{currency:"CNY"\|"USD", balance:string}], bonusWallets:[…]} \| {status:"failed"}` | A-03 |
| `account/getUnnotifiedBonuses` | `client` | `null \| {accountId, bonuses:[…]}` | A-08 |
| `account/ackBonusNotified` | `accountId, orderId, client` | `boolean` | A-08 |
| `session/initializeDefaultModel` | — | (void) | A-12 |
| `session/modelCatalog` | — | 见 MS-01 | M-02, PC-01, MS-01 |
| `session/selectModel` | `request:{sessionId, provider, model, reasoningEffort?}` | `{selected:{provider,model,reasoningEffort?}}` | MS-02 |
| `llm/listProviders` | — | `[{id,name}]` | M-* |
| `llm/listConfigurableProviders` | — | `[LlmConfigurableProvider]` | M-* |
| `llm/discoverModels` | `settingsNs: string, request:{provider?, baseURL?, api?, apiKey?}` | `[{id, name?, contextWindow?, maxTokens?, inputModalities?:("text"\|"image")[]}]` | M-13 |
| `permissionPresets/catalog` | — | `{options:[{value,name,description?}], defaultOptions:[…], defaultPreset}` | G-01 |
| `agentPresets/list` | — | `{presets:[{id,isDefault,name?,description?,broken?}]}` | AP-01 |
| `agentPresets/read` | `agentPreset` | `{agentPreset, content, name?, description?}` | AP-04 |
| `agentPresets/select` | `agentId, agentPreset` | `string` | AP-05 |
| `pluginInventory/list` | — | `PluginInventorySnapshot` | I-*, P-* |
| `pluginManager/listBundles` | — | `BundleInfo[]` | P-* |
| `pluginManager/listPlugins` | — | `PluginInfo[]`（= `PluginInventoryEntry & ({patchId} \| {readOnlyReason})`） | P-08 |
| `pluginManager/registries` | — | `{registry: string\|null, fallbackRegistries: string[], resolved: string\|null}` | P-10 |
| `pluginManager/inspect` | `spec: string, options:{registry?: string\|null}`（可取消） | `{status:"accepted", kind:"registry"\|"path"\|"git"\|"tarball", name?, version?, description?, bundle: boolean\|null, registry: string\|null, host?} \| {status:"refused", problem, reason, registries?}` | P-10 |
| `pluginManager/installBundle` | `spec, options:{enabled?, saveExact?, requestId?, approvedBuilds?: string[], registry?: string\|null}` | `ChangeResult`（长时） | P-10, P-11, MK-08 |
| `pluginManager/waitForInstall` | `requestId` | `ChangeResult \| null` | P-10 |
| `pluginManager/cancelInstall` | `requestId` | `{status:"cancelled"\|"not-running"\|"too-late"}` | P-10 |
| `pluginManager/setBundleEnabled` | `name, enabled` | `ChangeResult` | P-05 |
| `pluginManager/setPluginEnabled` | `id (entryId), enabled` | `ChangeResult` | P-08 |
| `pluginManager/removeBundle` | `name` | `ChangeResult` | P-09, P-11 |
| `pluginManager/listVersionExemptions` | — | `{exemptions: Record<string,string[]>, warnings: string[]}` | P-16 |
| `pluginManager/setVersionExemption` | `packageVersion, runtimeVersion, enabled, acceptRisk` | `ChangeResult` | P-16 |
| `pluginRegistryProbe/fastest` | — | `string \| null` | P-10 |
| `pluginMarket/listIndexes` | — | `[{url, title?, description?, error?}]` | MK-01 |
| `pluginMarket/setIndexes` | `urls: string[]` | `void` | MK-03 |
| `pluginMarket/search` | `url: string, query: MarketQuery` | `MarketSearchResult` | MK-05 |
| `dynamicCordisRunner/inventory` 等 | 见 §14 | | C-* |

`ChangeResult`：
```ts
{ changed: boolean,
  application: "applied"|"restart-required"|"overridden"|"failed"|"cancelled",
  restartReason?: "no-hmr"|"package-moved"|"host-module"|"unmanaged-plugin"|"module-comparison",
  stage: "install"|"enable"|"remove", target: string, enabled?: boolean,
  error?: { code: "management-required"|"unaddressable"|"unknown-plugin"|"invalid-spec"|"already-installed"|"ambiguous-install"|"not-bundle"|"not-removable"|"stop-profile"|"bundle-in-use"|"stale-approval"|"incompatible-version"|"operation-error",
            diagnostic?: string, incompatible?: [{name, version, runtimeVersion, requirements: Record<string,string>}] },
  warnings?: string[],
  packageResult?: { exitCode, output, truncated, logPath, kind?: "pnpm-missing"|"timeout"|"not-found"|"no-matching-version"|"network"|"disk-full"|"permission"|"build-blocked"|"integrity"|"unknown", timedOut?, incompatible? },
  bundle?: string, version?: string, pendingBuilds?: string[], approvedBuilds?: string[],
  registries?: (string|null)[], failedAt?: "registry"|"spec-host" }
```

### 15.1 事件（经 `$events` 流转发，`ctx.remote.$on`）
| 事件 | 载荷 | 用途 |
|---|---|---|
| `settings/document-updated` | `(ns: string, revision: number)` | 重读 describe（S/G/M/PC） |
| `credentials/reference-updated` | `(ref: string)` | 凭据状态刷新（M, PC-02, MS） |
| `credentials/record-updated` | `(key: string)` | MS 目录刷新 |
| `llm/adapters-updated` | `()` | 模型页/目录刷新 |
| `deepseek-account/session-expired` | `()` | A-11 |
| `deepseek-account/model-sign-in-required` | `()` | A-10 |
| `permission-presets/catalog-changed` | `()` | G-01 |
| `plugin-manager/changed` | `({reason:"plugin"\|"bundle"\|"install"\|"remove"})` | P 列表、MK 安装状态刷新 |
| `plugin-manager/install-log` | `(PluginInstallLogChunk)` | P-10 日志流 |
| `plugin-manager/install-state` | `(PluginInstallProgress)` | P-10 阶段 |
| `plugin-market/changed` | `()` | MK 源刷新 |
| `cordis/dynamic-package` / `cordis/dynamic-retract` / `cordis/request-run` / `cordis/request-run-resolved` | — | C-03 |
| `connection/reset`（客户端本地） | — | 所有页面重读 |

### 15.2 错误码（UI 需要区分的）
`settings/conflict {ns, expected, actual}`、`settings/rejected {ns}`、`credential/rejected {ref}`、`gateway/bad-request`、`gateway/cancelled`、`plugin-market/invalid-index-url {url, reason}`、`plugin-market/unknown-index {url}`、`plugin-market/fetch-failed {url, reason}`、`plugin-market/invalid-index {url, path, reason}`、`plugin-market/invalid-query {field, reason}`、`plugin-market/settings-unavailable`；账号 `attempt.errorCode`；会话模型 `CLIENT_UPGRADE_REQUIRED` / `MODEL_UNSUPPORTED` / `ACCOUNT_SIGN_IN_REQUIRED` / `ACCOUNT_QUOTA` / `ACCOUNT_TOKEN_INVALID`。

---

## 16. 需要浏览器 / 无法原生的功能与对策

| # | 功能 | 原因 | iOS 对策 |
|---|---|---|---|
| B-1 | DeepSeek 账号登录 A-06 | Platform 网页授权 + PKCE；回调 `http://<loopback>:<port>/oauth/callback` 由 Host 应答 | `ASWebAuthenticationSession(callbackURLScheme:nil)` 打开 `authorizeUrl&theme=…`；监听 `account/watch` 成功后 `cancel()`；远程引擎需本机 loopback 转发器（§4.3） |
| B-2 | 用量 / 充值 A-05、问卷 A-14、市场主页/仓库链接、搜索指南链接 | 外部网页 | `SFSafariViewController` / `Link` |
| B-3 | 插件自带配置页（`plugins.row.config`、`plugins.bundle.config`、第三方 `plugins.item`）、详情扩展（`plugins.detail.actions/badge/section`）、自定义 Tab（`plugins.tab`，市场除外）、`plugins.bundle.activation`、`settings.models.provider-card/footer` | 插件的 React 浏览器半部 | 优先：通用 SchemaForm（§11）覆盖 `autoGenerate` 命名空间；其次：提示“请在网页/桌面端配置”；可选：内嵌 `WKWebView` 加载引擎自带 Web UI 并深链到 `pluginNavigation.openBundle(pkg)` |
| B-4 | Cordis 动态插件 Client 半部（C-*） | 浏览器 JS | 仅 Host 控制；Client 部分标注不支持或 WKWebView |
| B-5 | 打开配置文件 S-05 | Host `openNativeTextFile` 在 iOS 抛错 | App 内 YAML 编辑器直接读写 `profiles/<profile>/cordis.patch.yml` |
| B-6 | 插件安装 pnpm（P-10） | 不是浏览器问题，但 iOS 引擎需 Worker 内 pnpm（已在可行性文档中跑通）；部分包返回 `restart-required` | 提供“重启引擎”按钮；长时 RPC 无超时 |

---

## 17. 实现检查清单（按优先级）

- [ ] 基础：`SettingsMirror`（describe + 3 种刷新触发）、per-ns 写队列、`RemoteResult` 错误本地化、事件总线订阅（§15.1）
- [ ] S-01…S-06（S-05 用 App 内编辑器）
- [ ] G-01…G-12（全部即时保存、失败回滚）
- [ ] A-01…A-15（A-06 ASWebAuthenticationSession；A-08 卡片栈 + ack 退避；A-04 Decimal 格式化）
- [ ] M-01…M-13（校验规则、路径 ops、revision 冲突、凭据分批 describe、发现模型 sheet）
- [ ] I-01…I-06、AP-01…AP-05、O-01…O-03
- [ ] P-01…P-15（安装状态机 + 日志流 + 取消/恢复 + 构建审批 + GitHub 镜像 + 注册表探测/记忆用 `UserDefaults` 键 `dsh.plugin-manager.install-registry`）；P-16 可选
- [ ] PC-01…PC-04（共用 §11.4 暂存-保存模型）
- [ ] F-01…F-50 通用 SchemaForm（用于 autoGenerate 命名空间）
- [ ] MK-01…MK-09（仅当 `plugins.tab`/实验包启用：检测 `listBundles` 中 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 的 `enabled` 且 `plugin-market` ns 可用）
- [ ] MS-01…MS-03；C-01…C-04（Host 侧）

### 源码定位速查
| 内容 | 文件（`engine/node_modules/@deepseek-ai/…`） |
|---|---|
| 设置外壳 + 通用行 + 字符串 | `dsh-client-ui-settings-general/lib/client.js`（locales L964） |
| ConfigForm 写队列 | `dsh-client-ui-settings/lib/client.js` L1120–1215 |
| SettingsFormModel（压缩） | `dsh-web-frontend/dist/assets/index-*.js`（`var gR=class{scope;specs;secretSpecs…`） |
| 账号 UI + 字符串 | `dsh-client-ui-settings-account/lib/client.js`（locales L2894；AccountSection L2451；browser-login L969） |
| 登录 Host 实现 | `dsh-deepseek-account-platform/lib/index.js` L307–325（callbackOrigin 校验）、L985–1140（流程） |
| 模型页 | `dsh-client-ui-settings-models/lib/client.js`（store L1176；ProviderEditor L1783；CustomProviderCard L1507；locales L3225） |
| 插件管理页 | `dsh-client-ui-plugin-manager/lib/client.js`（locales L75；manager-store L731；分组常量 L2170） |
| 插件市场 | `dsh-client-ui-plugin-market/lib/client.js`（locales L1108） |
| 官方配置页 | `dsh-client-ui-settings-{subagent,web-search,agent-loop,shell}/lib/client.js` |
| Schema 线上格式 | `schemastery/src/index.ts`（toJSON L311、meta L113）；`dsh-settings/lib/index.js` L100–160（volatileForm/plainSchema） |
| RPC 生成描述符 | 各包 `lib/typert.remote-client.js`（`TYPERT_REMOTE.spec.methods`） |
| 数据类型 | `dsh-plugin-manager/lib/types/types.d.ts`、`dsh-plugin-market/lib/types/types.d.ts`、`dsh-plugin-market-index/lib/types/types.d.ts`、`dsh-host-plugin-inventory/lib/types/types.d.ts`、`dsh-settings/lib/types/types.d.ts`、`dsh-llm/lib/types/types.d.ts` |
