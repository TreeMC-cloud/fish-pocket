# DSH Web UI 功能清单 · 壳层 / 导航 / 工作区 / 侧栏（iOS SwiftUI 重写用）

> 版本基线：`@deepseek-ai/*` `0.2.1-rc.4`（`engine/node_modules/@deepseek-ai/`，MIT，未压缩 React bundle `lib/client.js`）。引擎已升级到 `0.2.2-rc.1`，本文只同步了版本号字面量；`0.2.2-rc.1` 的上游新增功能见 [parity.md](parity.md) §3.2，协议层差异见 [protocol.md](protocol.md) §0.1。
> 范围：应用外壳、左侧栏、会话列表与工作区、目录选择、会话顶栏与 Hero、右侧栏（开始页 / 文件 / 文档预览 / 浏览器 / 在应用中打开 / 终端）、自动化任务、主题 / 语言 / 字号 / 快捷键、登录 / API Key / 首启引导、Toast 与连接状态、Web UI 传输协议。
> **不在本文**：消息流 / 输入框 / 工具卡片 / 审批卡片 / 模型与插件设置的内部细节（另有文档）；本文只记录它们挂到壳上的入口。
>
> 结构：**第一部分**是汇总（导航模型、布局、功能总表 S-xx、RPC 总索引、持久化映射、手机布局方案、风险）；**第二部分**是按子系统的逐项细节（A–E 章，含完整 RPC 形状、状态机、locale 原文 zh/en），总表每行都指向细节章节。
> 约定：标识符、JSON、locale 原文均原样保留；`Mod` = primary（macOS ⌘ / Windows·Linux Ctrl）；"Host" = 运行 `dsh web` 的引擎进程；**[iOS 不适用]** = 语义绑定 Host 桌面或 Electron；**[Web 未实现]** = 代码里有类型/文案但 Web UI 没接上；**[增强]** = 建议 iOS 新增、Web 没有。

---

# 第一部分 汇总

## 1. 总体导航模型

### 1.1 Web 的三栏外壳（`dsh-client-ui-layout` → `AppFrame`，注册在 `root` slot）

```
┌──────────────┬─────────────────────────────────────────┬────────────────────────┐
│ sidebar      │ main（keyed）                            │ rightbar（track）        │
│ (ui-sidebar) │  ├ "conversation"（默认，activePanelId=null）│ (ui-sidebar-right)     │
│              │  │   ConversationHeader（会话顶栏）         │  每会话一个停靠面          │
│ 品牌/折叠      │  │   └ Hero（空白会话） | 消息流 + 输入框     │  tab 条 + 1~2 格 + 浮窗    │
│ 新会话         │  ├ "plugins"   插件管理全局面板             │  开始 / 文件 / 预览 /     │
│ 全局面板列表     │  └ "schedules" 自动化任务全局面板           │  浏览器 / 终端 / 计划 /    │
│  + 更多        │                                         │  改动对比 / 子智能体 / 任务 │
│ 工作区/会话区    │                                         │                        │
│ 底部：Cordis/账号 │                                         │                        │
│   菜单/连接状态   │                                         │                        │
├──────────────┴─────────────────────────────────────────┴────────────────────────┤
│ shell.bottom（仅实验 inspector）     shell.overlay（全局浮层列表）  shell.leading（macOS 隐藏侧栏时的红绿灯旁按钮）│
└───────────────────────────────────────────────────────────────────────────────────┘
```

root 声明的子 slot：`sidebar`(single) / `main`(keyed) / `rightbar`(single) / `shell.bottom`(single) / `shell.overlay`(list) / `shell.leading`(single)。

**布局常量（`computeColumns` / `createLayoutStore`，iPad 自适应可参考）**

| 常量 | 值 | 含义 |
|---|---|---|
| sidebar 宽度 | 默认 280，拖拽范围 264–420 | 关闭时 = rail 56px（macOS Desktop / Windows 自绘标题栏为 0） |
| `SIDEBAR_AUTO_COLLAPSE` | 1024 | 视口 <1024 时侧栏自动收成 rail；此时手动展开是"覆盖式"（`narrowExpanded`），打开右栏会清掉该展开 |
| center 最小宽 | 400 | 有右栏 track 时保证；放不下右栏（可用 <300）就不给右栏 track |
| rightbar | 最小 300，最大 视口×0.7，首次打开 视口×0.45 | 宽度偏好跨关闭保留（px） |
| 右栏自动全屏 | 视口 <768 | 打开即 `fullscreen`；窄屏退出全屏 = 收起（见 C 章 §0） |
| 动画 | grid-template-columns 过渡，`prefers-reduced-motion` 关闭 | 拖拽中无动画 |

layout store：`panelInfo.activePanelId`（null = 会话）+ `layoutInfo {sidebar, viewportWidth, narrowExpanded, rightbar, rightbarShown, rightbarTrack, rightbarFullscreen, rightbarInstant}`，全部内存态（不持久化）。`ctx.layout` 服务：`selectPanel(id|null)`、`toggleSidebar()`、`openRightbar(track, fullscreen)`、`closeRightbar()`、`beginNavigation()`（返回 AbortSignal，新导航取消旧导航）。浏览器标题 = `"<会话标题> — DeepSeek Harness"`（主区为会话时）否则 `DeepSeek Harness`。

### 1.2 左侧栏结构（`dsh-client-ui-sidebar` → `SidebarRoot`）

自上而下：
1. **品牌行**：`sidebar.brand.mark`（官方鲸鱼 FishLogo）+ `sidebar.brand.name`（"DeepSeek Harness" 字标；未装 brand-official 时显示 `brand.localBuild` "DSH 本地构建" + 构建号 `0.2.2-rc.1-<commit>`）。非 macOS Desktop 时品牌本身是"新建会话"按钮。右侧折叠按钮（`toggle.open` / `toggle.collapse`，快捷键 `sidebar.left.toggle`）。rail 态折叠按钮叠品牌 mark + `sidebar.toggle.badge`（桌面更新蓝点，iOS 永不显示）。
2. **新会话**按钮（`session.new` "新会话"，显示 `session.new` 快捷键键帽）→ `uiWorkspace.startSession()`。
3. **全局面板列表**（`nav`，aria `panels.label`）：`sidebar.panellist` 注册项按 order —— `plugins`「插件」(0) / `schedules`「自动化任务」(10)；点击 `ctx.layout.selectPanel(id)`；选中项 `aria-current=page`。再之后是 **「更多」**（`panels.more`，`IconAppsAddOutlineRegular`）菜单：内容由 `sidebar.panellist.actions` 渲染（entry-customization：「浏览更多插件」「创建你的插件」）；面板可 pin/unpin（`plugins` 永远固定；pin 状态仅内存）。
4. **工作区 / 会话区**：`sidebar.workspaces`（ui-workspace `WorkspaceBrowser`）—— 见 A 章。
5. **底部**：`sidebar.footer.action`（ui-cordis「Cordis Plugin」开发者面板，带运行中/待审批计数）+ `sidebar.settings`（settings-general `SettingsRoot`：账号菜单 `settings.launcher` + 连接状态药丸 `ConnectionIndicator` + 桌面更新指示）。
6. 指针离开侧栏 2s 后隐藏滚动条（`SCROLLBAR_LINGER_MS`）；折叠动画 150ms。

locale ns `sidebar`：

| key | zh | en |
|---|---|---|
| `session.new` | 新会话 | New Session |
| `session.new.label` | 新建会话 | New session |
| `toggle.open` | 打开侧边栏 | Open sidebar |
| `toggle.collapse` | 收起侧边栏 | Collapse sidebar |
| `panels.label` | 全局面板 | Global panels |
| `panels.more` | 更多 | More |

`shortcuts.layout`：`toggle` = 展开／收起左侧栏 / Toggle left sidebar。埋点 `sidebar_menu_click {menu_name:"new_session"|"plugin"|"cron"|"more", position:"sidebar"|"titlebar"|"sidebar_more"}`（iOS 可忽略）。

### 1.3 主区（`main`）与会话页

- `activePanelId === null` → `conversation`：`ConversationHeader`（会话顶栏，D 章 §1.12）+ 内容（空白会话 → Hero，D 章 §1.13；否则消息流 + 输入框，另有文档）。
- `plugins` / `schedules` → 全局面板整页替换中间栏（侧栏会话行此时不高亮任何行）。打开任一会话会关闭面板（`clearMain`/`reveal`）。
- 会话顶栏插槽：`conversation.session.header.lineage`（子智能体面包屑切换器）/ `.actions`（智能体团队、Agent 预设标签、子智能体目录、后台任务）/ `.utilities`（在应用中打开、定时提醒、⋯更多：下载 Session 日志 / 反馈）/ `.corner`（打开右侧栏）/ 第二行 View 标签（`chat` / `trajectory`）+ `.views.actions`（更多视图）。**标题在顶栏不可编辑**。

### 1.4 右侧栏（`rightbar`）

每会话一个停靠面（布局存 `localStorage["dsh.sidebar-right.v1.<sessionId>"]`），最多左右两格 + 浮窗；tab 种类：`guide`(开始) / `files` / `text`(文档预览) / `browser` / `terminal` / `changes-review` / `plan` / `subagentchat` / `scheduleTask` / `session-inspector-log`（实验）。两种呈现 `push` / `fullscreen`。详见 C 章。

### 1.5 浮层（`shell.overlay` 注册总表）

| overlay id | 注册包 | 内容 |
|---|---|---|
| `workspace.session-rename` / `workspace.session-archive` / `workspace.row-toast` | ui-workspace | 会话重命名框、停止并归档确认、侧栏 toast（A 章） |
| `schedule.delete-toast` | ui-schedule | 删除任务结果 toast |
| `chat.quota-notice` | ui-chat | 额度用尽提示（Toast 或「当前无可用余额」Modal） |
| `plugin-manager.refresh-toast` | ui-plugin-manager | 插件列表刷新失败 |
| `session-log-upload-toast` | ui-settings-session-log | Session Log 开关保存结果 |
| `shortcuts` | ui-shortcuts | 快捷键速查 / 编辑面板 |
| `host-release-change` | ui-settings-general | 「服务版本变化」Modal |
| 设置面板 | ui-settings-general | 760×500 设置 modal |
| `desktop-onboarding`、`account.platform-page` | ui-settings-account | [iOS 不适用] Desktop 全屏引导 / 原生平台页 |
| 账号菜单内 Toast / 登录框 / 退出确认 / 赠金卡片栈 | ui-settings-account | D 章 §1.1–1.3 |
| `settings.onboarding` 步骤 | ui-settings-models | `welcome-notice` → `deepseek-official`（D 章 §1.6–1.7） |

### 1.6 首启与登录路径（Web 流，iOS 照此）

```
连接 Host（cookie 鉴权，E 章 §2.3）→ $events ready
 └ 会话/工作区列表 ready → 恢复 dsh.sessions.current；都空 → workspace/initializeDefault
     └ 停在空白新会话首页（Hero）时激活 settings.onboarding：
         1) welcome-notice「预览版说明」（ui-settings-general.welcomeNoticeVersion ≠ "2026-09-28.1"）
         2) deepseek-official（无可用模型）→ 先 SignInDialog「开始使用」：[添加 API Key] [登录]
              登录 = account/startSignIn → 浏览器 OAuth（PKCE）→ account/watch 流 succeeded
              API Key = credentials/set("DEEPSEEK_API_KEY", key)
```

---

## 2. 功能总表（S-xx）

列说明：**Web 行为**只写要点；**RPC/数据**写主要方法（完整形状见第二部分）；**手机方案**分号前 iPhone、分号后 iPad（无分号 = 通用）；**详见**指向第二部分章节（A=工作区与会话列表，B=终端与自动化任务，C=右侧栏，D=壳层浮层/设置/顶栏，E=主题/语言/快捷键/传输）。

### 2.1 外壳与左侧栏

| ID | 功能 | Web 行为 | RPC/数据 | 手机方案 | 详见 |
|---|---|---|---|---|---|
| S-01 | 三栏外壳 | sidebar / main / rightbar 三列，列宽求解见 §1.1 | layout store（内存） | `NavigationStack`（根=会话列表）；`NavigationSplitView(sidebar:content?:detail:)` + `.inspector` 承载右栏 | §1.1 |
| S-02 | 左侧栏折叠/展开 | 按钮 + `sidebar.left.toggle`（desktop Mod+B / web Mod+Alt+B）；<1024 自动 rail | — | iPhone 无 rail（列表即根页）；iPad `columnVisibility` 切换，⌘B | §1.2、E §3 |
| S-03 | 侧栏宽度拖拽 | 264–420 | — | iPad 由系统分栏决定，不做 | §1.1 |
| S-04 | 品牌区 | 鲸鱼 mark + 字标；点击 = 新建会话 | — | 导航栏标题/Logo，可不可点 | §1.2 |
| S-05 | 新会话 | 侧栏按钮 / 品牌 / 组头"+" / `session.new`；目标工作区推断 + 空白会话复用 + 并发去重 | `session/create` | 导航栏 `square.and.pencil`；⌘N | A §1.8 |
| S-06 | 全局面板列表 | `plugins`(0)「插件」、`schedules`(10)「自动化任务」，选中替换主区 | `ctx.layout.selectPanel` | 会话列表顶部两行 NavigationLink（或 iPhone 底部 TabView：会话 / 自动化 / 插件 / 设置）；iPad sidebar Section | D §3 |
| S-07 | 「更多」菜单 | 面板 pin/unpin（内存）+「浏览更多插件」「创建你的插件」（新会话预填草稿 `agentPreset:"cordis"`，不发送） | `uiWorkspace.startSession(undefined,{agentPreset:"cordis",prompt,whenDraftExists:"append"})` | toolbar `Menu` | C §1.6 |
| S-08 | Cordis 插件面板 | 侧栏底部「Cordis Plugin」+ 计数；列出动态插件，允许/拒绝/运行/停止/移除/重试/回退 | `dynamicCordisRunner/*` | 设置或"更多"里的列表页；插件 Client 视图（JS）无法原生渲染 → 只读卡片或 WKWebView | E §1.5 |
| S-09 | 账号菜单（设置入口） | 头像/名字（未登录「更多」）→ 设置 / 意见反馈（飞书问卷）/ 登录或退出登录 | `account/*` | 列表页右上头像 `Menu`；iPad sidebar 底部 | D §1.1 |
| S-10 | 连接状态药丸 | 断开「连接异常，刷新重试」/ 重连中（≥800ms）/「连接成功」2s；点击立即重连 | `$events` 代、`connection.reconnect()` | 顶部 `safeAreaInset` 横幅或导航栏副标题；回前台立即重连 | D §1.10、E §2.6 |
| S-11 | 服务版本变化提示 | Host release 变化弹 Modal：[暂不刷新][刷新以加载新版本] | SSE `/plugins/events` 或 `__DSH_BOOT__.release` | `.alert`：提示"服务已升级"，动作=重连/重载缓存 | D §1.11、E §2.9 |
| S-12 | 窗口标题 | `<会话标题> — DeepSeek Harness` | — | iPad 多窗口 `navigationTitle` / scene title | §1.1 |

### 2.2 会话列表（左栏工作区区域）

| ID | 功能 | Web 行为 | RPC/数据 | 手机方案 | 详见 |
|---|---|---|---|---|---|
| S-13 | 会话列表数据源 | `session/list` + `$events` `api-session/*` 增量；`workspace/follow` 流（工作区/置顶/归档集合） | `session/list`、`workspace/follow` | `@Observable` store，断线保留旧投影，重连以 baseline 整体替换 | A §2、§3 |
| S-14 | 区头标题 | groupBy=flat →「会话」，否则「工作区」 | 本地 | `navigationTitle` | A §1.1 |
| S-15 | 视图选项菜单 | 分组：按工作区 / 按工作区树 / 单列表；排序：手动 / 最近更新；筛选：隐藏已归档 / 全部（含归档）/ 仅已归档 | `dsh.workspace.view.v5` | toolbar `Menu` 内三个 inline `Picker` + Section 标题 | A §1.1 |
| S-16 | 搜索会话 | 本地标题/工作区名匹配 + 远端内容搜索（防抖 250ms，可取消），合并 ≤20 条，snippet；Esc 清空；骨架行；空态「无匹配会话」 | `session/search` | `.searchable` + `.task(id:)` 防抖；⌘K 聚焦 | A §1.2 |
| S-17 | 搜索结果打开 / reveal | 归档结果 → toast 不打开；否则打开并在树里展开、滚动定位 | — | 清空搜索后 `ScrollViewReader.scrollTo` | A §1.2 |
| S-18 | 按工作区分组树 | 每工作区一组（Host 顺序），末尾「未分组」；组头点击展开/收起；展开默认值规则 | `groupExpansion` | `List` + `DisclosureGroup(isExpanded:)` 绑定 groupExpansion | A §1.3 |
| S-19 | 工作区树模式 | 路径嵌套于另一工作区目录下者作为子级，缩进 12px | 本地推导 | 嵌套 `DisclosureGroup` | A §1.3 |
| S-20 | 单列表模式 | 所有可见会话平铺，可拖拽排序，无组头 | `__flat_session_order__` | 平铺 `List` | A §1.4 |
| S-21 | 可见性规则 | subagent 会话永不显示；空白会话只显示当前那个（"新会话"）；归档按筛选 | 本地 | 纯函数移植 + 单测 | A §1.3 |
| S-22 | 组内排序 | updated：updatedAt 降序；manual：本地顺序 + 置顶→已存→最近→归档补齐，fork 插源会话前；当前空白置顶；置顶分段在前 | 本地 | 同上 | A §1.3 |
| S-23 | 水位线 show more | 每组默认 5 条；运行中/待交互/未读完成/当前会话自动抬升（≤50）；「展开其余 {n} 个会话」/「收起」 | 本地 | 组尾按钮行 | A §1.3 |
| S-24 | 会话行 | 前导状态点（或定时任务时钟）+ 标题（截断 marquee）+ 尾部（待审批/计划待审/待回答 或 相对时间）+ 置顶图钉；归档行变淡 | `useSessionStatus`、`subagentCatalog` | `HStack` 行；不做 marquee；归档 `.opacity(0.5)` | A §1.5 |
| S-25 | 状态优先级 | 待交互 > 运行中 > 子智能体运行数 > 未读完成 > 空闲 | — | 状态点颜色映射 token（warn / business / success / idle） | A §1.5 |
| S-26 | 行 hover 卡片 | 完整标题、"N 前"、定时任务（≤2）、状态行、已归档、复制标题 | — | `.contextMenu(menuItems:preview:)` 的 preview | A §1.5、B §B35 |
| S-27 | 行「…」菜单 | 置顶/取消置顶（归档行无）→ 重命名 → 分叉会话（有 `session/fork` 权限）→ 归档/取消归档 → 复制 Session ID | `workspace/pinSession|unpinSession`、`session/fork`+`session/rename`、`workspace/archiveSession|unarchiveSession` | `.contextMenu` 同序 | A §1.5 |
| S-28 | 行 hover 按钮 | 归档（order 100）、置顶（order 200） | 同上 | `.swipeActions(edge:.trailing)` 归档；`.leading` 置顶 | A §1.5 |
| S-29 | 双击标题重命名 | 打开会话重命名框 | `session/rename` | 用 contextMenu「重命名」替代 | A §1.6 |
| S-30 | 会话重命名框 | 仅空串禁用；未改也可提交；请求中不可关；错误原文 | `session/rename` | 小 sheet + Form（alert 无法禁用按钮/显示错误） | A §1.6 |
| S-31 | 归档流程 | 成功 toast「会话已归档，可 [撤销] 或 [筛选已归档会话]」6s；当前会话被归档 → 回 Hero；`workspace/session-active` → 停止并归档确认（列出将停止的工作）→ `stopActivity:true` | `workspace/archiveSession` | toast banner + sheet 确认 | A §1.7 |
| S-32 | 取消归档 | 菜单/hover/搜索结果行；失败只打 console | `workspace/unarchiveSession` | swipe / contextMenu；**[增强]** 失败给 toast | A §1.5 |
| S-33 | 置顶 | 全局集合，与归档互斥；manual 模式下置顶移到最前；失败 toast | `workspace/pinSession` | leading swipe | A §1.5 |
| S-34 | 分叉会话 | 菜单（allowMigration:false）/ 快捷键；子会话递增标题 `X (1)`；不切换当前；`session/migration-required` → toast + [打开原会话] | `session/fork`、`session/rename` | contextMenu；⌘⌥F | A §1.5、§1.10 |
| S-35 | 复制 Session ID | 剪贴板 + toast | — | `UIPasteboard` + toast | A §1.5 |
| S-36 | 会话拖拽排序 | 同组同置顶分区内；写本地 `sessionOrderByAccount` 并自动切到 manual；**不调 RPC** | 本地 | `.onMove` / `draggable`；空白与归档行 `.moveDisabled` | A §1.3 |
| S-37 | 空 / 加载 / 错误态 | 「暂无会话」；仅已归档筛选「暂无已归档会话」+[查看其他会话]；无骨架；流错误不提示 | — | `ContentUnavailableView`；**[增强]** 骨架与错误提示 | A §1.3 |
| S-38 | 列表动画 | 新行淡入 100ms、移动 200ms、删除淡出 100ms，reduced-motion 关闭 | — | `List` 默认动画 / `withAnimation` | A §1.3 |
| S-39 | 删除会话 | **不存在**（没有 `session/delete`）；只能归档 | — | 不做；文档告知 | A 关键结论 |
| S-40 | 启动恢复 | 读 `dsh.sessions.current`；空白会话 `restoreBlank`；都空 → `workspace/initializeDefault`（`<Documents>/deepseek-harness/default-workspace`）；失败 toast | `session/projections`、`session/create`、`workspace/initializeDefault` | 同逻辑，UserDefaults 同 key | A §1.8 |
| S-41 | 会话侧快捷键 | `session.new`/`session.search`/`workspace.add`/`session.rename`/`session.fork`/`session.archive`（含阻断文案） | — | iPad `.keyboardShortcut`（用 desktop:macos 列） | A §1.10、E §3 |
| S-42 | 侧栏 toast | 11 种 key，同时只一条，新替旧；带动作时 6s | — | 顶部 overlay banner（单槽） | A §1.11 |

### 2.3 工作区与目录选择

| ID | 功能 | Web 行为 | RPC/数据 | 手机方案 | 详见 |
|---|---|---|---|---|---|
| S-43 | 工作区列表 / 实时同步 | follow 帧 baseline/replace/upsert/remove/order/archived/pinned；remove 后 id 不复活 | `workspace/follow` | 同 store 逻辑 | A §2.1 |
| S-44 | 添加工作区 | 区头按钮 / `workspace.add`（Mod+O）/ Hero 菜单「添加工作区…」→ 目录流程 → 创建 → 自动新会话 | `workspace/create` | 远程目录浏览 sheet（**不能**用 `fileImporter` / `directoryPicker/pick`） | A §1.9 |
| S-45 | 目录浏览对话框 | 面包屑（主目录起头）、Miller 两列、慢加载提示(>300ms)、截断提示、隐藏文件开关、路径编辑（前缀过滤、防抖跳转）、新建文件夹、打开 | `directoryPicker/list`、`directoryPicker/createDirectory` | sheet 内 `NavigationStack` 逐级 push；横向面包屑；底栏 新建文件夹 / 显示隐藏 Toggle；右上「打开」采纳当前层 | A §1.9、§2.2 |
| S-46 | 原生目录选择 | Host 本机弹系统对话框 | `directoryPicker/pick` | **[iOS 不适用]**；Host 只开 native 能力时 list 返回 `directory-picker/unavailable` → 提示 | A §1.9 |
| S-47 | 目录错误对话框 | 「无法打开文件夹」+ 错误原文 + [重新选择] | — | `.alert` | A §1.6 |
| S-48 | 工作区组头 | 文件夹图标、显示标题（`default-workspace` → 「默认工作区」）、高亮规则；hover「…」菜单 + 「新会话」按钮 | — | Section header + 尾部"+"按钮 + `.contextMenu` | A §1.3 |
| S-49 | 工作区 hover 卡片 | 标题 / 路径（`~` 缩写，home 来自 `$events` ready）/ 创建时间 / 复制路径 | `$events` ready `host.home` | contextMenu preview 或信息 sheet | A §1.3 |
| S-50 | 重命名工作区 | 预填显示标题；空/未改/与其它工作区重名（内联提示）时禁用；错误原文 | `workspace/rename` | sheet + Form | A §1.6 |
| S-51 | 删除工作区 | 「将把…移除。文件夹与会话记录会保留…」；进行中不可关；删默认工作区后 Host 不再自动创建 | `workspace/delete` | `.confirmationDialog(role:.destructive)` | A §1.6 |
| S-52 | 工作区拖拽排序 | 仅兄弟间；乐观更新失败回滚；失败只 console | `workspace/insertBefore` | "编辑工作区顺序" sheet + `.onMove` | A §1.3 |
| S-53 | 会话在工作区间移动 | RPC 存在但 **[Web 未实现]** | `workspace/insertSessionBefore` | 不做（或 **[增强]**） | A §2.1 |
| S-54 | Hero 工作区选择器 | chip 菜单：工作区列表（当前打勾）+「添加工作区…」；无工作区时直接拉目录流程；切换迁移草稿与附件 | `uiWorkspace.openWorkspace` | Hero 内 `Menu` | A §1.8、D §1.13 |
| S-55 | 默认工作区 | 首次使用自动创建；仅首次有资格 | `workspace/initializeDefault` | 同 | A §1.8 |
| S-56 | 工作区文件浏览 | 见右栏「文件」 | `workspaceFiles/*` | 见 S-74 | C §1.2 |
| S-57 | 工作区改动 / diff | 不在文件树；在聊天轮尾「改动文件」卡片 → 右栏 `changes-review`（文件选择、+N/-M、分栏/统一、换行、打开整个文件） | HTTP `api/changes.summary|diff|open` | push 页：文件 `Picker` + diff `LazyVStack`；iPhone 只做统一视图，iPad 可分栏 | C §1.7、§2.4 |

### 2.4 会话顶栏与 Hero

| ID | 功能 | Web 行为 | RPC/数据 | 手机方案 | 详见 |
|---|---|---|---|---|---|
| S-58 | 面包屑标题 | 沿 subagent `parentId` 推祖先链 `a / b / c`，非末项可点；不可编辑；空白首页隐藏 | 会话 summary | `navigationTitle` + `.toolbarTitleMenu`（列祖先/同级） | D §1.12 |
| S-59 | 子智能体面包屑切换器 | 标题+▾ 切换同级子会话 | ui-subagent | `toolbarTitleMenu` | D §1.12 |
| S-60 | 顶栏 actions | 智能体团队（实验）/ Agent 预设标签 / 子智能体目录 / 后台任务下拉（进行中、已结束、清空、终止） | 各自 RPC（另文） | 导航栏 `ToolbarItemGroup`，超出折入 `Menu` | D §1.12 |
| S-61 | 定时提醒按钮 | 会话头时钟：0 个不显示；1 个直接打开任务；多个弹层列表（逾期在前、1s 刷新相对时间、无确认删除） | `schedule/list` | toolbar 按钮 → `popover`/sheet | B §B31 |
| S-62 | ⋯更多操作 | 「下载 Session 日志」（`api/session.export?sessionId=…&includeDescendants=true` → zip）/「反馈」 | HTTP | `Menu`；下载后 `ShareLink`/`fileExporter` | D §1.12 |
| S-63 | 在应用中打开（会话 cwd） | Host 桌面应用打开目录；记忆选择 | HTTP `open-in-app/*` | **[iOS 不适用]**（可保留为"在电脑上打开"，SSH/无桌面时隐藏） | C §1.5 |
| S-64 | 打开右侧栏按钮 | 右栏收起时在顶栏最右角；`sidebar.right.toggle` | — | toolbar 按钮（`sidebar.right` 图标）；iPad 切 inspector | C §1.1 R1 |
| S-65 | View 标签行 | `chat` / `trajectory`（开启"显示代码工作视图"时），超宽折入「更多会话视图」；pin 内存 | — | 顶部 `Picker(.segmented)` 或 toolbar `Menu` | D §1.12 |
| S-66 | Hero 首页 | 鲸鱼 + 「探索未至之境」+「预览版」；工作区 chip + Agent 预设；输入框（未选工作区禁用「选择一个工作区开始」） | — | 会话页空态 VStack | D §1.13 |

### 2.5 右侧栏容器

| ID | 功能 | Web 行为 | RPC/数据 | 手机方案 | 详见 |
|---|---|---|---|---|---|
| S-67 | 每会话停靠面 | layout 树（pane/split/tabs/floats/activePaneId/expanded/mode）存 `dsh.sidebar-right.v1.<sid>`，zod 校验 | 本地 | 同构模型存 UserDefaults/文件 | C §0、§3 |
| S-68 | tab 条 | chip 聚焦/关闭、`+` 新标签页（开始页）、键盘导航、右键菜单「关闭」+扩展项 | — | 横向滚动 chip 条；长按 `contextMenu` | C §1.1 R3 |
| S-69 | 打开 / 去重 / 关闭规则 | 资源 tab 跨格去重聚焦；页 tab 本格去重；`multiple` 每次新建；唯一停靠 guide 不可关；其它唯一 tab 关闭 = 收起 | — | 同规则 | C §0 |
| S-70 | 分栏 / 拖拽 / 浮窗 / 分隔条 | 最多 2 格（20–80%）；拖到左右生成分栏；拖出成 380×300 浮窗 | — | iPhone 不支持（单格）；iPad 可选两格，浮窗用多窗口替代 | C §1.1 R4–R7 |
| S-71 | push / 全屏 | 全屏切换按钮 + `pane.fullscreen.toggle`；<768 自动全屏 | — | iPhone 恒全屏（sheet `.large` 或 push）；iPad inspector ↔ fullScreenCover | C §0 |
| S-72 | 开始页（guide） | 卡片：文件(10) / 终端(20) / 浏览器(30) / 会话数据诊断(60，实验)；≤4 张显示描述；「更多工具」菜单 | — | 卡片网格 + `Menu` | C §1.1 R8–R9 |
| S-73 | 右栏快捷键 | `sidebar.right.toggle` / `pane.split` / `pane.fullscreen.toggle` / `page.close` / `page.refresh` | — | iPad `.keyboardShortcut` | C §1.1 |

### 2.6 文件 / 预览 / 浏览器 / 在应用中打开

| ID | 功能 | Web 行为 | RPC/数据 | 手机方案 | 详见 |
|---|---|---|---|---|---|
| S-74 | 文件树 | 根=会话 cwd；懒加载展开；目录优先自然序；`other` 灰显；每层 加载/空/截断/错误行；`workspace.files`（Mod+P） | `workspaceFiles/list` | `List` + 递归 `DisclosureGroup`；⌘P | C §1.2 |
| S-75 | 文件树自动刷新 | 每个展开目录一条 changes 流；`watch-unsupported` 静默降级 | `workspaceFiles/changes` | `AsyncThrowingStream` 订阅 | C §1.2 |
| S-76 | 重新读取 / 滚动保存 | 按钮或 `page.refresh`；按 tab 保存滚动位置 | — | `.refreshable` + 刷新按钮 | C §1.2 |
| S-77 | 文件树无的功能 | 搜索、右键、重命名、diff 标记都 **没有** | — | 可选 **[增强]**：`.searchable` 本地过滤、复制路径 | C §1.2 |
| S-78 | 文档预览框架 | 头部路径 + 打开方式（多渲染器）+ 换行 + 专属动作 + 刷新 + 在应用中打开；变更横幅「文件已更新…」 | `workspaceFiles/stat|read|readBytes` | push 页 + toolbar `Menu`；横幅 `safeAreaInset` | C §1.3 |
| S-79 | 文本 / 代码 / Markdown | 分页读取（offset 行号，自动加载更多到 eof）；代码高亮 + 行号 + 复制；Markdown + frontmatter 键值表 + 本地图片 `api/file` | `workspaceFiles/read`、HTTP `api/file` | `LazyVStack` 行渲染；Highlightr/tree-sitter；swift-markdown 或 WKWebView | C §1.3、§4 |
| S-80 | 行号导航 | `openResource(addr,{params:{line}})`，文本/代码有锚点 | — | `ScrollViewReader.scrollTo(line)` | C §1.3 |
| S-81 | 图片预览 | png/jpg/jpeg/gif/webp/bmp/ico/svg；缩放（适应宽度、25–400%） | `readBytes` | `UIScrollView` zoom；SVG 用 WKWebView；**[增强]** HEIC/TIFF/AVIF | C §1.3 |
| S-82 | PDF 预览 | PDF.js；文字可选；密码 PDF 提示；缩放 | `readBytes` | `PDFKit.PDFView` | C §1.3 |
| S-83 | 表格预览 | xlsx/xls/csv/tsv：工作表标签、选择、复制、只读公式栏；不重算公式；限额 16MiB/25 万格/15s | `readBytes` | WKWebView 嵌 FortuneSheet 或 QuickLook；CSV 原生 `Table`（iPad） | C §1.3 |
| S-84 | Office 预览 | doc/docx/ppt/pptx → Host LibreOffice 转 PDF；缺字体警告 | `officeToPdf/render`（multipart） | PDFKit；缺字体 popover；QuickLook 兜底 | C §1.3、§2.2 |
| S-85 | HTML 预览 | 静态（DOMPurify + CSP，无脚本）/ 交互（开启"代码工作视图"时：sandbox allow-scripts + 打包相对 js/css） | `readBytes(baseFile)` | WKWebView；交互模式用 `WKURLSchemeHandler` 拦截相对资源 | C §1.3 |
| S-86 | 不可预览兜底 | 已知二进制后缀不读取，显示「该格式文件暂时无法预览」+ 打开/显示文件位置 | — | 同 + **[增强]** `ShareLink` 下载到本机 | C §4 |
| S-87 | 内置浏览器 tab | 地址栏（补 https、拒凭据/非 http(s)/应用自身 origin）、前进后退刷新、系统浏览器打开、沙箱开关、恢复上次页面；Web profile 默认禁用 | 无 RPC；`dsh.sidebar-browser.v1` | WKWebView；**localhost 指手机本身**，需改写为 Host 地址 | C §1.4 |
| S-88 | 在应用中打开（文件/目录） | 分体按钮：默认应用 / 应用列表 / 显示文件位置；均在 Host 桌面执行 | `session/canOpenWorkspacePath|workspacePathApplications|openWorkspacePath`、HTTP `open-in-app/*` | **[iOS 不适用]**（可保留"在电脑上打开"） | C §1.5 |
| S-89 | 计划 / 子智能体 / 诊断 tab | `plan`（计划审阅自动打开一次）、`subagentchat`（优先新分栏，内嵌完整会话）、`session-inspector-log`（实验） | 另文 | push / sheet | C §1.7 |

### 2.7 终端

| ID | 功能 | Web 行为 | RPC/数据 | 手机方案 | 详见 |
|---|---|---|---|---|---|
| S-90 | 新建终端 | 开始页卡片 / `terminal.new`（Ctrl+\`）/ `+`；每会话 ≤8（已退出也计） | `terminal/environment`→`shells`→`create`→`retain`→`attach` | SwiftTerm；⌃\` | B §A1–A5 |
| S-91 | 选择 Shell | 卡片旁 ▼，菜单展开时才拉列表；记忆 `dsh.terminal.shell` | `terminal/shells` | `Menu` / 长按"+" | B §A2 |
| S-92 | 输出协议 | 首帧 `snapshot`（ANSI 串）→ `output` 序号 +1；渲染后才 ack（背压） | `terminal/attach` 下行 | `feed(text:)` 同步渲染 | B §A.2 |
| S-93 | 输入 / resize | `write`（UTF-8 原文）/ `resize`（cols≤500, rows≤200）；字节窗口；`inputFull` 断开 | `terminal/attach` 上行 | 附加键栏 Esc/Ctrl/Alt/Tab/方向；粘贴分块 **[增强]** | B §A7–A8 |
| S-94 | 只读 / 接管输入 | 最新 attach 独占输入；其它显示「此页面当前只读。」+[接管输入] | 重新 attach | 状态条 + 按钮 | B §A9 |
| S-95 | 断线 / 退出 / 失败 / 丢失 | 「连接已断开。」[重新连接]；「进程已退出（code）」[新建终端]；「此终端已不存在…」 | — | 状态条 / `ContentUnavailableView` | B §A10–A13 |
| S-96 | 重命名 / 关闭 | 双击 chip 内联改名（≤120）；关闭 = 结束进程（先持久化清理请求，启动重试） | `terminal/rename`、`terminal/close` | 长按 chip → alert TextField；**[增强]** 清理失败提示 | B §A14–A15 |
| S-97 | 刷新恢复 / 保活 | binding 找回 Host id；retain 流保活，无人 2h 回收 | `terminal/list`、`terminal/retain` | 回前台按顺序 retain→attach | B §A16–A17 |
| S-98 | 终端外观 | 跟随主题色；终端字体/字号；scrollback 1000；无右键/搜索/链接识别 | `ui-theme.terminalFontSize/terminalFontFamily` | SwiftTerm font/colors | B §A18–A19 |

### 2.8 自动化任务

| ID | 功能 | Web 行为 | RPC/数据 | 手机方案 | 详见 |
|---|---|---|---|---|---|
| S-99 | 全局页 | 「自动化任务」+[新建]（= 新建会话，**没有创建表单**）；状态筛选 全部/已开启/已结束；搜索 title/prompt/sessionId；按 scheduledAt 升序 | `schedule/catalog` | `List` + segmented `Picker` + `.searchable`；iPad split | B §B1–B7 |
| S-100 | 任务详情 | 规则 / 任务运行记录 两页签；关联会话入口；⋯删除；名称、指令（active 可编辑） | — | push 详情 + segmented | B §B8–B14 |
| S-101 | 运行时间编辑器 | 重复：每周/周一至周五/每天/每 N 小时/每 N 分钟/每 N 秒/仅一次/自定义(cron)；星期胶囊、间隔步进（≥60s）、日期月历（周一为首）、时间（时分秒）、时区菜单（最近 5 个 + 全部按偏移） | — | `Form`：Picker、胶囊、Stepper、`DatePicker(.graphical)`（设 timeZone + firstWeekday=2）、3 列 wheel、可搜索时区列表 | B §B15–B22 |
| S-102 | Cron 编辑 | 结构化（每月/每周/每天/每 N 小时/每 N 分钟）或原始表达式；实时中文描述；5 字段方言 | — | Swift 复刻 parse/preview/shape（~300 行） | B §B19、§B.2.4 |
| S-103 | 保存 | 未保存栏「有未保存的修改」[取消][保存修改]；compare-and-set `expected`；snake_case change；草稿与刷新合并 | `schedule/update` | `safeAreaInset` 保存栏；`interactiveDismissDisabled` | B §B23–B25 |
| S-104 | 删除 | 确认 Modal（硬删除含历史）；toast 结果 | `schedule/delete` | `.confirmationDialog` | B §B26–B27 |
| S-105 | 运行记录 | 最新 20 条、加载更多、prompt 折叠、清理提示（保留天数/条数） | `schedule/history` | 分页 List | B §B28–B30 |
| S-106 | 会话关联面 | 会话头时钟（S-61）、右栏 `scheduleTask` tab、轮尾「已创建任务」卡片、会话行时钟标记、hover 卡片任务 | `schedule/catalog`、`schedule/list` | sheet / 消息卡片 / 行图标 / contextMenu preview | B §B31–B35 |
| S-107 | 实时刷新 | `schedule/changed` 事件 + `connection/reset` → 重拉 | `$events` emit | 同 | B §B.0 |
| S-108 | 暂停/恢复/立即运行 | **不存在** | — | 不做 | B §B.0 |

### 2.9 设置、主题、语言、快捷键

| ID | 功能 | Web 行为 | RPC/数据 | 手机方案 | 详见 |
|---|---|---|---|---|---|
| S-109 | 设置面板 | 760×500 modal，分区：账号与余额(-10，仅登录) / 通用设置(0) / 模型(10) / 内置插件(15) / Agent 预设(20)；`settings.open`（Mod+,） | — | `NavigationStack` + `Form`（iPhone sheet / iPad 设置 split）；⌘, | D §1.9、§4 |
| S-110 | 通用设置条目 | 默认权限(-20) / 语言(0) / 外观(10) / 字体大小(11) / 工作步骤展示(12) / 显示代码工作视图(15) / 快捷键(16) / 网页链接打开方式(17) / 繁忙时发送行为(20) / 性能与用量(30) / 上传 Session Log(90) / 当前版本(100) | `settings/describe|mutate` | `Form` 行 | D §4.2 |
| S-111 | 外观 | light/dark/system（默认 system），**存 Host `ui-theme`，所有设备共享** | `settings/mutate {ns:"ui-theme"}` | `.preferredColorScheme`；**[增强]** 可选"仅本设备" | E §1.1 |
| S-112 | 字号 | 正文 10–22(14) / 代码 10–16(11) / 终端 10–20(13)，步进 1；Desktop Mod+= / Mod+- 三档同时调 | `ui-theme.fontSize|codeFontSize|terminalFontSize` | Stepper；与 Dynamic Type 叠加方案见 E §6.2 | E §1.1 |
| S-113 | 字体族 | 正文/代码/终端三字段，逗号分隔，规范化规则；空 = 内置栈 | `ui-theme.*FontFamily` | TextField；iOS 按名称尝试 `UIFont(name:)` 回退系统字体 | E §1.1 |
| S-114 | 语言 | zh / en；无偏好时跟随系统（全标签→主子标签→en），存 Host `locale.preference` | `settings/mutate {ns:"locale"}` | `Picker`；App 内用 `.environment(\.locale)` + 自带字符串表 | E §1.2 |
| S-115 | 快捷键速查 / 编辑 | `shortcuts.open`（Mod+/）面板：搜索、分组、录键、移除、恢复默认、冲突检测；存本地 `dsh.keybindings.v1` | 本地 | iPad：`UIKeyCommand` discoverability（长按 ⌘）；编辑 **[可选]** | E §1.3、§3 |
| S-116 | 打开配置文件 | 仅 loopback 连接显示 | `settings/openSettingsDocument` | **[iOS 不适用]**（Host 本机） | D §1.9 |
| S-117 | 当前版本 / 反馈 | 「当前版本：0.2.2-rc.1」；反馈 = 飞书问卷（带 uid/版本/设备预填） | — | Form 行 + `openURL` | D §1.1、§1.9 |

### 2.10 账号、引导、通知、传输

| ID | 功能 | Web 行为 | RPC/数据 | 手机方案 | 详见 |
|---|---|---|---|---|---|
| S-118 | 登录对话框 | 「开始使用」[添加 API Key][登录] → 「等待登录」（复制登录链接）→ 超时/失败重试；`credential-stored` 自动关 | `account/watch`、`startSignIn`、`cancelSignIn` | sheet；`ASWebAuthenticationSession` 打开 `authorizeUrl`，靠 watch 流 succeeded 主动关闭 | D §1.2、§2.1 |
| S-119 | OAuth 回调约束 | `callbackOrigin` 必须是 `http://localhost|127.0.0.1|[::1]:<端口>`；Host 自己收 `/oauth/callback` | — | 引擎在本机（dsh-ios）可行；远程 Host 时需在 Host 机浏览器完成 | D §0 |
| S-120 | 退出登录 | 先查运行中任务，三种文案；成功即关 | `account/hasRunningAccountTasks`、`account/signOut` | `.confirmationDialog` | D §1.3 |
| S-121 | 账号与余额 | 身份卡、充值余额、赠金余额、查询用量/充值链接 | `account/getProfile|getBalance` | Form；链接 `SFSafariViewController`，返回后刷新 | D §1.4 |
| S-122 | 赠金通知卡片 | 账号按钮上方卡片栈，展示即 ack，失败退避重试 | `account/getUnnotifiedBonuses|ackBonusNotified` | 顶部卡片 / banner | D §1.1 |
| S-123 | 额度不足 | 回合以 `QUOTA`/`ACCOUNT_QUOTA` 结束 → 警告 Toast「当前请求的额度已用尽」或 Modal「当前无可用余额」[去充值] | 会话事件流 | 已登录用 alert + 充值；否则 toast | D §1.5 |
| S-124 | 登录失效 / 需登录 | Host 事件 `deepseek-account/session-expired`、`model-sign-in-required` → Toast | `$events` emit | toast + 登录入口 | D §1.1 |
| S-125 | 首启：预览版说明 | `welcome-notice`，[继续] 写 `ui-settings-general.welcomeNoticeVersion="2026-09-28.1"` | `settings/mutate` | 不可滑动关闭的 sheet | D §1.7 |
| S-126 | 首启：添加 API Key | 无可用模型时；「添加一个 API Key 开始使用」，前端校验（拒 `NAME=value`、引号、非可见 ASCII）；[稍后配置][保存并继续] | `credentials/set("DEEPSEEK_API_KEY")`、`credentials/describe` | sheet + `SecureField`（显示/隐藏） | D §1.6 |
| S-127 | Desktop 4 步引导 | [iOS 不适用]，数据层可移植 | `ui-settings-account` | 可选 | D §1.8 |
| S-128 | Toast 原语 | 顶部居中 top:40px，3s + 1s 淡出，success 对勾，文字动作按钮，无全局队列 | — | 统一 `ToastCenter` overlay（单槽，按 owner 替换） | D §1.14 |
| S-129 | 传输：unary | `POST <base>/api/<ns>/<method>`，信封 `client-request`/`server-response`，`payload.args` 具名参数，严格键集；二进制 multipart | — | `URLSession` + Codable | E §2.4 |
| S-130 | 传输：流 | 单条 WS `/api/remote.mux`，open/item/end/cancel ↔ item/end/error，text frame | — | `URLSessionWebSocketTask` 多路复用 | E §2.5 |
| S-131 | 鉴权 | `/?token=` → 303 + 签名 cookie（30 天，绑定 host:port+协议）；Host/Origin 信任栅栏；401 需重新登录 | — | dsh-ios：引擎在本机，宿主从 0600 文件读启动 URL，每次启动换一次 cookie，只放内存（`EngineClient`），手动加 `Cookie` 头；不发跨源 `Origin` | E §2.2–2.3 |
| S-132 | `$events` 与 waterfall | ready 帧定义连接代 → `connection/reset` 全部重拉；emit 白名单；审批/提问 waterfall 必须 `$events/result` 回答或 `next` | `$events`、`$events/result` | 前台常驻；后台必断，回前台重连 | E §2.6 |
| S-133 | 重连策略 | 抖动指数退避 500ms→10s；握手 3s 警告 15s 超时；Host 2s ping，2 次无活动断开 | `__DSH_CONNECTION_RECOVERY__` | `NWPathMonitor` + scenePhase 驱动 | E §1.4 |

> 合计 **133 项**。其中 **[iOS 不适用]** 7 项（S-46、S-63、S-88、S-116、S-127 及 S-08 的插件业务视图、S-87 的 localhost 语义需改造）；**不存在/未实现** 4 项（S-39 删除会话、S-53 会话跨工作区移动、S-108 暂停/立即运行、S-77 文件树搜索等）——iOS 不必做，但需要知道"没有"。

---

## 3. RPC / 事件 / HTTP 总索引

所有 unary 返回 `RemoteResult<T> = {ok:true,value:T} | {ok:false,error:{code,message,details}}`；wire 参数是具名 `{"args":{…}}`（E §2.4）。"流"在 `/api/remote.mux` 上打开。

### 3.1 RPC 方法

| 方法 | 类型 | 主要用途 | 详见 |
|---|---|---|---|
| `workspace/follow` | 流 | 工作区列表 + 置顶/归档集合 | A §2.1 |
| `workspace/create` | unary | 添加工作区 | A §2.1 |
| `workspace/initializeDefault` | unary | 首次默认工作区 | A §2.1 |
| `workspace/rename` / `workspace/delete` | unary | 工作区重命名/删除 | A §2.1 |
| `workspace/insertBefore` | unary | 工作区排序 | A §2.1 |
| `workspace/insertSessionBefore` | unary | （Web 未用） | A §2.1 |
| `workspace/archiveSession` / `unarchiveSession` | unary | 归档 | A §2.1 |
| `workspace/pinSession` / `unpinSession` | unary | 置顶 | A §2.1 |
| `directoryPicker/list` / `createDirectory` | unary | 远程目录浏览 | A §2.2 |
| `directoryPicker/pick` | unary | Host 原生对话框（iOS 不用） | A §2.2 |
| `session/list` | unary | 会话列表（另文详述） | A §2.3 |
| `session/search` | unary | 侧栏内容搜索 | A §2.3 |
| `session/create` / `session/fork` / `session/rename` / `session/projections` | unary | 新建/分叉/重命名/读投影 | A §2.3 |
| `session/initializeDefaultModel` | unary | 登录成功后 | D §2.2 |
| `session/canOpenWorkspacePath` / `workspacePathApplications` / `openWorkspacePath` | unary | Host 桌面打开文件 | C §2.3 |
| `workspaceFiles/stat` / `read` / `readBytes`(multipart) / `list` | unary | 文件树与预览 | C §2.1 |
| `workspaceFiles/changes` | 流 | 文件/目录变更 | C §2.1 |
| `officeToPdf/generation` / `render`(multipart) | unary | Office 转 PDF | C §2.2 |
| `terminal/environment` / `shells` / `list` / `create` / `rename` / `close` | unary | 终端管理 | B §A.2 |
| `terminal/retain` | 流（仅下行） | 终端保活 | B §A.2 |
| `terminal/attach` | 双工流 | 终端 I/O | B §A.2 |
| `schedule/catalog` / `list` / `update` / `delete` / `history` | unary | 自动化任务 | B §B.2 |
| `account/watch` | 流 | 登录状态 | D §2.1 |
| `account/startSignIn` / `cancelSignIn` / `signOut` / `hasRunningAccountTasks` / `getProfile` / `getBalance` / `getUnnotifiedBonuses` / `ackBonusNotified` | unary | 账号 | D §2.1 |
| `settings/describe` / `mutate`（`update` / `replace` 备用）/ `openSettingsDocument` | unary | 主题/语言/各设置 | D §2.2、E §2.10 |
| `credentials/describe` / `set` / `unset` | unary | API Key | D §2.2 |
| `dynamicCordisRunner/*` | unary | Cordis 面板 | E §2.10 |
| `$events` / `$events/result` | 流 / unary | 事件与 waterfall 应答 | E §2.6 |
| `productAnalytics/*` | — | iOS 忽略 | E §1.5 |

### 3.2 Host → 客户端事件（`$events` emit / waterfall，壳层相关）

`api-session/added|removed|status|activity|error`（会话列表）· `schedule/changed` · `settings/document-updated(ns, revision)` · `credentials/record-updated` · `credentials/reference-updated` · `llm/adapters-updated` · `deepseek-account/session-expired` · `deepseek-account/model-sign-in-required` · `cordis/dynamic-package|dynamic-retract|request-run|request-run-resolved` · `plugin-manager/*` · waterfall `approval/request`、`user-questions/request`（必须应答）。客户端本地事件：`connection/reset`（每个新连接代）、`theme/change`、`locale/change`。完整白名单见 E §2.6。

### 3.3 HTTP 路由（需同一 cookie）

`GET /?token=`（换 cookie）· `GET /plugins/events`（SSE 版本检测）· `GET|HEAD api/file?path=`（Markdown 本地图片）· `GET api/changes.summary|diff`、`GET|POST api/changes.open`（改动对比）· `GET open-in-app/apps`、`open-in-app/icon/<id>`、`POST open-in-app/open` · `HEAD|GET api/session.export?sessionId=&includeDescendants=true`（下载 Session 日志 zip）。

---

## 4. 客户端持久化映射（Web → iOS）

| Web 存储 | 内容 | iOS 建议 |
|---|---|---|
| `localStorage["dsh.workspace.view.v5"]` | groupBy / orderBy / groupExpansion / sessionOrderByAccount / archivedFilter | UserDefaults 同 key、同 JSON |
| `localStorage["dsh.sessions.current"]` | 当前会话 `{sessionId, subagentAddress?}` | UserDefaults + 场景恢复 |
| `localStorage["dsh.sidebar-right.v1.<sid>"]` | 右栏布局 | UserDefaults / 文件（每会话） |
| `localStorage["dsh.sidebar-browser.v1"]` | 浏览器 tab 历史 | 同 |
| `localStorage["dsh.open-in-app.choice"]` | 打开方式 | 仅在实现"在电脑上打开"时需要 |
| `localStorage["dsh.terminal.shell"]`、`dsh.terminal.binding.v1.*`、`dsh.terminal.close.v1.*` | 终端 shell / 绑定 / 待清理 | 同（清理队列必须先落盘再发 close） |
| 自动化任务：最近时区、`scheduleTask` tab 绑定 | 见 B §B.3 | 同 |
| `localStorage["dsh.keybindings.v1"]` | 快捷键覆盖 | 仅实现键位编辑时需要 |
| Host settings `ui-theme` / `locale` / `ui-settings-general` / `ui-settings` / `ui-chat` / `session-log-deepseek` | 主题、语言、欢迎确认、代码工作视图等 | **服务端共享**，用 `settings/describe|mutate`；本地仅缓存首屏 |
| Host 凭证 `DEEPSEEK_API_KEY` | API Key | `credentials/*` |
| cookie `dsh-auth-<hash>` | 连接鉴权 | Keychain（按 base URL） |
| 内存：面板 pin、guide pin、View pin、右栏 undo、设置 open | 不持久 | 不持久 |

---

## 5. 手机端整体布局方案

### 5.1 iPhone（compact）

```
TabView? —— 建议不用底部 TabView 承载会话，而用单一 NavigationStack：
NavigationStack(root: 会话列表页)
 ├ toolbar：左 头像Menu(设置/反馈/登录·退出) ｜ 右 [视图选项 Menu] [添加工作区] [新会话]
 ├ .searchable（S-16）
 ├ List：Section「插件」「自动化任务」入口（S-06）→ push 全局面板
 │       工作区 Section（DisclosureGroup）/ 会话行（swipe + contextMenu）
 └ push → 会话页
      ├ navigationTitle = 面包屑（toolbarTitleMenu）
      ├ toolbar：定时提醒、后台任务、⋯更多（下载日志/反馈/在电脑上打开）、[工具]（=右侧栏）
      ├ 内容：Hero 或 消息流 + 输入框
      └ [工具] → .sheet(detents [.large]) 或 push「工具」页：
            横向 tab chip 条（开始/文件/预览/终端/浏览器/计划/改动/子智能体/任务）
            单格，不支持分栏/浮窗/拖拽；+ = 开始页
全局浮层：ToastCenter（顶部单槽）、连接状态横幅（safeAreaInset top）、
         onboarding sheet（interactiveDismissDisabled）、登录 sheet、alert/confirmationDialog
```

### 5.2 iPad（regular）

- `NavigationSplitView`：sidebar = 会话列表页（同 iPhone 根页内容，含全局面板入口）；detail = 会话页 / 全局面板。
- 右侧栏 = `.inspector(isPresented:)`（宽度 300…视口 70%），可支持两格（HStack + 可拖分隔 20–80%）；全屏模式 = `fullScreenCover` 或替换 detail。浮窗用 `openWindow` 多窗口替代。
- 外接键盘：采用 E §3 中 `desktop:macos` 列键位（⌘N/⌘K/⌘O/⌘B/⌘⌥B/⌘P/⌘T/⌃\`/⌘\/⌘⌥↩/⌘W/⌘R/⌘,/⌘/），用 `.keyboardShortcut` + `UIKeyCommand.discoverabilityTitle`（取 locale label）。
- 窄宽（Slide Over / 分屏 1/3）自动退化为 iPhone 布局（`horizontalSizeClass == .compact`）。

### 5.3 桌面专属 → 手机对照

| 桌面布局 / 交互 | 手机原生替代 |
|---|---|
| 左栏 rail 折叠态 | 不需要（iPhone 根页即列表；iPad 用系统分栏显隐） |
| hover 卡片（会话/工作区） | `.contextMenu(preview:)` 或长按信息 sheet |
| hover 行按钮 | `.swipeActions` |
| 「…」菜单 | `.contextMenu` / `Menu` |
| 双击改名（会话标题、终端 chip） | contextMenu「重命名」→ sheet/alert |
| 拖拽排序 | `List` 编辑模式 `.onMove`；工作区排序单独 sheet |
| Tooltip + 快捷键键帽 | 无；键位只在 iPad 发现面板显示 |
| Modal（760×500 设置、680×500 目录浏览） | sheet（iPhone large / iPad formSheet）+ NavigationStack |
| 右栏 push/fullscreen、分栏、浮窗 | iPhone 全屏 sheet 单格；iPad inspector（两格可选） |
| Miller 两列目录浏览 | 逐级 push 列表 |
| 顶部居中 Toast | 顶部 overlay banner（避开刘海/灵动岛） |
| 侧栏底部连接药丸 | 顶部横幅 / 导航栏副标题 |
| 分体按钮（在应用中打开） | `Menu(primaryAction:)` |
| 滚动条 linger、marquee 标题 | 不做 |

---

## 6. 关键风险与难点（实现优先关注）

1. **传输与鉴权**（E §2）：严格键集的 JSON 信封、具名参数、multipart 二进制、单 WS 多路复用、`$events` 连接代与 `connection/reset` 全量重拉；cookie 绑定 host:port；Host/Origin 信任栅栏（局域网/隧道访问需 `trustedHosts`）；iOS 后台必断线，回前台重连并重开所有流。
2. **waterfall 应答**：审批/用户提问经 `$events` 下发，必须 `$events/result` 回答或回 `next`，否则会卡住其它客户端（多客户端语义待实测）。
3. **会话列表推导规则**（A §1.3）：可见性、排序、置顶分段、水位线、fork 插位、搜索合并——建议逐行移植为纯函数并用 Web 行为做快照测试。拖拽排序只存本地。
4. **目录选择只能远程浏览**（A §1.9）：`fileImporter` 与 `directoryPicker/pick` 都不可用；Host 只开 native 能力时无解，需提示。
5. **终端**（B §A）：retain→attach 时序、严格序号与按序 ack、字节窗口背压、只读/接管、快照 ANSI 与 SwiftTerm 兼容性（需真机回放测试），关闭清理队列持久化。
6. **自动化任务运行时间编辑器**（B §B15–B25）：8 种重复类型的种子值、compare-and-set、snake_case change、草稿合并、cron 方言与中文描述、时区菜单与月历（周一为首、所选时区）。
7. **文档预览**（C §1.3）：多渲染器 + 分页 + 版本对账 + changes 流自动刷新 + 行号导航；表格与交互 HTML 原生成本高，倾向 WKWebView。
8. **右栏布局语义**（C §0）：默认页播种、唯一 tab 关闭即收起、资源/页去重——iPhone 单格降级时要保持这些规则一致，持久化格式最好与 Web 兼容。
9. **OAuth 登录**（D §0）：回调必须回环地址；`ASWebAuthenticationSession` 不会自动结束，需依据 `account/watch` 帧主动关闭；登录期间引擎须在前台。
10. **服务端共享设置**：主题、语言等存在 Host，改动影响所有设备；如需"仅本设备"属 **[增强]**，需明确产品决策。字号与 Dynamic Type 的叠加方式需拍板（E §6.2）。
11. **Host 桌面语义功能**（open-in-app、打开配置文件、浏览器 localhost、Desktop 引导）：iOS 端需逐一决定隐藏/改造；dsh-ios 引擎本机运行时，"Host 桌面"就是手机本身，这些按钮应隐藏。
12. **Web 本身的缺口**（可作为 iOS 增强点）：列表无骨架/流错误无提示、工作区重排与取消归档失败无反馈、重命名/创建错误显示原始字符串、终端关闭失败无提示。

---

# 第二部分 子系统细节

> 以下 A–E 章为逐包源码调研的完整记录（标题层级已下移一级）。行号若出现，指去除超长 CSS 行后的 bundle 副本行号，仅供定位参考。

# A. 工作区 + 左侧栏工作区/会话列表（含目录选择）

调研范围：`dsh-client-ui-workspace`、`dsh-client-ui-directory-picker-browse`、`dsh-client-ui-directory-picker-native`、`dsh-api-workspace-controller`（host + client model）、`dsh-api-session-controller`（被本区 UI 调用的方法）、`dsh-host-directory-picker`（DirectoryListing），以及 `dsh-experimental-session-search`、`dsh-experimental-worktree`。
源文件位置（行号以去除超长 CSS 行的 bundle 副本为准，仅供参考）：
- 快捷键 `installWorkspaceShortcuts` L87；视图 store `createWorkspaceViewStore` L1265；`UiWorkspaceService` L1360；分组/排序/搜索推导 L863–1245；行组件 Rows.js L1789；WorkspacePicker L2563；WorkspaceBrowser L2778–4121；会话动作 L4123–4741；locale L4743；apply L5022。
- 目录浏览器 `s/dsh-client-ui-directory-picker-browse.js` L75–1037；原生选择器 `s/dsh-client-ui-directory-picker-native.js`。
- Host：`dsh-api-workspace-controller/lib/index.js`（命令 L215–346，initializeDefault L881）；client model：`dsh-api-workspace-controller/lib/client.js`。

**先说几个关键结论**
- **不存在“删除会话”功能**。session-controller 没有 `session/delete`，UI 里也没有。会话只能“归档 / 取消归档”。能删的只有**工作区登记**（文件夹和会话都会保留，会话落到“未分组”）。
- **会话拖拽排序只存在浏览器本地**（localStorage `dsh.workspace.view.v5` 的 `sessionOrderByAccount`）。`workspace/insertSessionBefore` 虽然有 RPC，**Web UI 从未调用**。工作区拖拽排序则走 `workspace/insertBefore`，由服务端持久化。
- 置顶 / 归档集合是**全局的**（registry-global），存在服务端，通过 `workspace/follow` 流推送。置顶与归档互斥：归档会顺带取消置顶，已归档的会话不能置顶（Host 返回 `gateway/bad-request`）。
- `dsh-experimental-session-search` / `dsh-experimental-worktree` / `dsh-experimental-tool-worktree` **没有 client.js**，都是纯 Host / Agent 工具，**不给会话列表加任何 UI**。侧栏搜索走的是 `session/search`（session-controller）。
- `sidebar.chat.conversation` 实际位于**右侧栏**的子智能体聊天 tab（`sidebar.right.pane.tab` key=subagent chat），不在左侧栏，见 §0。

---

### 0. 插槽（slot）地图（本区相关）

| 插槽 | 声明者 | 注入者 | 位置/作用 |
|---|---|---|---|
| `sidebar.workspaces` | ui-sidebar（`renderSlot("sidebar.workspaces",{wide, expandSidebar})`） | ui-workspace → `WorkspaceBrowser` | 左侧栏主体：区头 + 搜索 + 树/平铺列表 + 工作区对话框 |
| `sidebar.workspaces.directoryFlow` (single) | ui-workspace（sidebar.workspaces 的 child） | directory-picker-browse **或** directory-picker-native | 侧栏“添加工作区”按钮触发的目录选择流程 |
| `sidebar.workspaces.session.menu.item` (list) | ui-workspace | ui-workspace 自己 5 项（pin 100 / rename 200 / fork 300 / archive 400 / session-id 450） | 会话行 “…” 菜单项；inject hooks: `menuOpenState`、`shortcuts` |
| `sidebar.workspaces.session.row.action` (list) | ui-workspace | ui-workspace 2 项（archive 100 / pin 200） | 会话行 hover 时出现的图标按钮 |
| `sidebar.session.row.leading` (list) | ui-workspace | **ui-schedule**（id `schedule-mark`, order 10） | 会话行最左 16px 格；仅当行状态为 idle、未归档、非空白时渲染（显示“有定时任务”标记）。细节由别人负责 |
| `sidebar.session.row.hover` (list) | ui-workspace | **ui-schedule**（id `schedule-tasks`, order 10） | 会话行 hover 卡片里（时间之下、状态之上）列出该会话的定时任务。细节由别人负责 |
| `conversation.hero.workspace` (single) | ui-conversation（hero 区的工作区 chip 旁） | ui-workspace → `WorkspacePicker` | hero 区工作区选择菜单（chip 本身 `WorkspaceChip` 属于 ui-conversation） |
| `conversation.hero.workspace.directoryFlow` (single) | ui-workspace（conversation.hero.workspace 的 child） | directory-picker-browse **或** native | hero 菜单里“添加工作区…”触发的目录选择流程 |
| `workspace.toast` (keyed) | ui-workspace（shell.overlay 条目 `workspace.row-toast` 的 child） | ui-workspace 11 个 key | 侧栏动作 toast |
| `workspace.toast.content` (factory) | ui-workspace | — | toast 渲染工厂 |
| `shell.overlay` | shell | ui-workspace 3 项：`workspace.session-rename`、`workspace.session-archive`、`workspace.row-toast` | 会话重命名对话框、停止并归档确认框、toast |
| `sidebar.chat.conversation` | **ui-subagent**（右侧栏 tab `sidebar.right.pane.tab` 的 child，scope session） | ui-subagent `ConversationSlotPanel` | **右侧栏**子智能体聊天 tab 内嵌会话视图（不属于左侧栏），细节由别人负责 |

目录流程的提供者同时注册到上面两个 directoryFlow 洞里。Web 部署里，`browse` 和 `native` 二选一（取决于 Host 的 `directoryPicker` capability）。没有任何提供者时，“添加工作区”按钮会隐藏，快捷键返回 `shortcut.noPicker`。

---

### 1. 功能清单（逐条）

格式：**功能** — 交互/触发 — 限制/禁用条件 — RPC

#### 1.1 侧栏区头（Wide 展开态）
- **区头标题** — `groupBy==="flat"` 时显示“会话”(`section.sessions`)，否则显示“工作区”(`section.workspaces`)；搜索展开后标题隐藏 — 无 — 无
- **搜索入口** — 点击搜索区域或放大镜按钮展开输入框并聚焦（tooltip “搜索”+快捷键）；快捷键 `session.search` — 展开搜索时会关闭“添加工作区”流程 — 无
- **视图选项菜单**（滑杆图标 `viewOptions.label`“视图选项”，dense，右对齐，只在 wide 态显示；搜索展开时和右侧按钮一起隐藏）。菜单项依次为：
  1. label “分组方式”
  2. “按工作区” `workspace`（文件夹图标）
  3. “按工作区树” `workspace-tree`
  4. “单列表” `flat`
  5. 分隔线 → label “排序方式”
  6. “手动排序” `manual`
  7. “最近更新” `updated`
  8. 分隔线 → label “筛选会话”
  9. “隐藏已归档”(default)
  10. “全部对话（显示已归档）”(show)
  11. “仅显示已归档”(only)

  三组各自显示当前选中勾；选中后菜单关闭。切到 `manual` 时，把当前显示顺序复制为初始手动顺序；切到 `updated` 时清空所有手动顺序 — 无 — 无（纯本地 store）
- **添加工作区按钮**（`IconProjectAdd`，tooltip “添加工作区”+快捷键）— 点击后**直接**拉起目录流程，中间没有菜单（`addOnly`）— 没有 directoryFlow 提供者时按钮不渲染；目录流程忙碌（打开或采纳中）时快捷键被 blocked（`shortcut.directoryBusy`）— 选定目录后调 `workspace/create`，成功则 `startSession(workspaceId,{clearPreviousDraft:false})`，即 `session/create`
- **Rail 收起态**（`!wide`）— 只显示两个 36px 图标：搜索、添加工作区。点搜索 → 展开侧栏（`expandSidebar`），300ms（`EXPAND_SLIDE_MS`，等侧栏滑出动画）后聚焦输入框；列表区不渲染

#### 1.2 搜索
- 输入：`maxLength=500`，经 `sanitizeSearchQuery` 处理：去掉 `\0`，截断到 500 个 UTF-16 code unit，并避免把代理对切成两半。比较前 `trim()`
- **Esc**：清空并收起。右侧 × 按钮（`search.clear`“清除搜索”）：清空并收起
- 点击搜索区外：输入框 blur；**只有查询为空时才收起**
- 查询非空时，列表区换成 **SearchResults**（树/平铺不显示）：
  - 本地匹配：会话标题或所属工作区标题（无工作区时用 cwd basename）做大小写不敏感的子串匹配；排除空白会话；遵守当前归档筛选；按 updatedAt 新→旧排序
  - 远端内容匹配：防抖 250ms（`SEARCH_DEBOUNCE_MS`）后调 `session/search {query}`；新输入会 abort 上一次请求
  - 合并：本地在前，远端补充（保持后端顺序）。同一会话若远端有命中，带上 `snippet`。最多 `searchResultLimit`=20 条；`hasMore`（远端 hasMore 或合并后超过 20）时底部显示“仅显示前 {n} 条结果，请缩小搜索范围。”
  - 加载态：远端请求中显示骨架行（无结果时 2 行，有结果时 1 行），`aria-label` 为“正在搜索会话历史…”
  - 空态：非加载且 0 条时显示“无匹配会话”
  - 错误态：远端失败时 status=`error`，只显示本地匹配，**不显示错误文案**
  - 结果行：状态点（非 idle 且未归档时显示）+ 标题（空则“未命名”）；第二行是工作区名（空则“未分组”）+ snippet。已归档行在 hover 时显示“取消归档”按钮（`workspace/unarchiveSession`）
  - 点击结果：已归档 → toast `archivedNotOpenable`，不打开；否则清空查询、收起搜索、打开会话，并在树中 **reveal**（展开所属组及祖先、提高水位线使其可见、`scrollIntoView({block:"nearest"})`）

#### 1.3 会话树（groupBy = workspace / workspace-tree）
- **分组**：每个 Host 工作区一个组，顺序 = Host 顺序（`workspace/follow` 的 order）。不属于任何工作区的会话归入末尾的“未分组”组（key `""`，有游离会话才出现）。`only` 筛选下，没有可见成员的组隐藏
- **可见性规则**（`sessionVisible`）：`origin==="subagent"` 的会话永不显示；空白会话（blank）只显示**当前选中**的那一个，显示为“新会话”；归档会话按筛选显示（default 隐藏 / show 全显 / only 只显示归档）。归档会话的位置槽保留，取消归档后回到原位
- **组内顺序**：
  - `updated`：updatedAt 降序，相同时按 id
  - `manual`：本地保存的顺序 + 缺失成员按“置顶 → 已保存 → 普通（按最近）→ 归档”补齐；新出现的 fork 会插到其源会话之前
  - 两种模式下，当前空白会话都排在最前（`pinCurrentBlank`）
  - 渲染时再分段：空白占位 → 置顶（未归档）→ 其余（`sectionMembers`）
- **工作区头行**（treeitem，32px）：
  - 文件夹图标（展开/收起两种）；hover 时换成三角 chevron
  - 标题：显示用 `workspaceDisplayTitle`，存储标题为 `"default-workspace"` 时显示本地化的“默认工作区”
  - **点击整行**切换展开/收起。收起时会重置该组（及子树）的“显示更多”水位线
  - **展开默认值**：`groupExpansion[key]` 优先；没有记录时，树模式下“作为父级的组”默认展开，其余默认收起；当前会话所在组在没有显式记录时自动展开
  - **高亮**：组展开且包含当前会话，或树模式下某个收起的祖先包含当前会话，文件夹图标高亮
  - hover 时右侧出现两个按钮：①“…” → 菜单（仅真实工作区有，“未分组”没有），依次为“重命名”（编辑图标）、“删除工作区”（垃圾桶，danger）；②“新会话”按钮（tooltip“新会话”+`session.new` 快捷键，aria “在“{name}”中新建会话”）→ 展开该组 + `startSession(workspaceId)`（“未分组”组上点了无效果）
  - hover 卡片（800ms 延迟，菜单打开时禁用）：工作区标题 / 路径（POSIX home 缩写为 `~`，home 来自 `$events` 的 ready 帧 `host.home`）/ “创建于 {y年m月d日 HH:mm}”；卡片上有“复制”按钮复制完整路径，复制后提示“已复制”
- **工作区树模式**（`workspace-tree`）：路径位于另一已登记工作区目录之下的工作区作为其子级嵌套（最近祖先；大小写敏感；Windows 路径统一成 `/` 再比较），每层缩进 12px（`--dsh-workspace-indent`）
- **工作区拖拽排序**：拖动头行；只能在**同一父级的兄弟之间**移动；落点按指针在行的上/下半区决定 before/after，列表顶部有专门的插入指示线；落到原位不提交 → `workspace/insertBefore {workspaceId, beforeWorkspaceId?}`（客户端乐观更新，失败时回滚到 committedOrder；只打 `console.warn`，**无 toast**）
- **会话水位线（show more）**：每组默认显示空白行 + 前 5 个非空白行（`SESSION_WATERMARK_BASE=5`）。以下会话会自动抬高水位线（最多到第 50 个，`SESSION_WATERMARK_AUTO_MAX`）以保证可见：运行中、有运行中的子智能体、待交互、未读完成、当前会话；搜索 reveal 的目标不受 50 上限。隐藏数 > 0 时显示按钮“展开其余 {n} 个会话”：剩余 ≤5 个时全部展开，否则每次 +5；完全展开后按钮变为“收起”，点击回到基线
- **会话拖拽排序**：只能在同一组（同一 account）内、同一置顶分区内拖动；空白行和归档行不可拖；落点按上/下半区（落在空白行上一律视为 after）→ 写入本地 `sessionOrderByAccount[accountKey]`，并**自动把 orderBy 切到 `manual`**（`setSessionOrder`）— **不调 RPC**。拖拽期间所有 hover 卡片禁用
- **空态**：普通情况显示队列图标 +“暂无会话”；`only` 筛选下显示归档图标 +“暂无已归档会话”+ 按钮“查看其他会话”（点击切回 default 筛选）
- **加载态**：树**没有骨架屏**。两个列表都还在 pending 时，可能直接看到“暂无会话”或只有空组；`ready` 标志只用来决定是否播放动画
- **错误态**：workspace 流发生 terminal error 时 `state="error"`，**UI 不显示任何错误**；断线时 `state="loading"`，保留最后一次投影，重连后由新的 baseline 整体替换
- **动画**（AnimatedRows）：行成员或顺序变化时，新行淡入 100ms，移动 glide 200ms，删除行克隆后淡出 100ms。只在用户第一次在列表内按指针或键盘之后才启用；`prefers-reduced-motion` 时关闭；切换 groupBy/orderBy/filter 时重置

#### 1.4 平铺列表（groupBy = flat）
- 所有可见会话作为顶层行，account key 为 `__flat_session_order__`；顺序规则同上（updated / manual + 置顶前置 + 当前空白置顶）
- 可拖拽排序（同置顶分区），写本地顺序。没有组头，没有水位线，不显示“新会话”按钮
- 空态同 1.3

#### 1.5 会话行（树和平铺共用 `SessionNodeItem`，32px）
- 布局从左到右：
  - **16px 前导格**：非 idle 时显示状态点；idle 时显示 `sidebar.session.row.leading` 插槽（定时任务标记）；归档行和空白行留空
  - **标题**：空白行显示“新会话”，无标题显示“未命名”。被截断超过 8px 时，hover 以 0.03px/ms 匀速 marquee 滚到末尾，左右有渐隐遮罩；`prefers-reduced-motion` 时直接跳到末尾
  - **尾部**：待交互时显示紧凑标签（“待审批”/“计划待审”/“待回答”），否则显示相对时间（刚刚 / N分钟 / N小时 / N天 / N个月 / N年）；空白行无尾部
  - 置顶且未归档时显示**图钉标记**
  - **hover 动作区**（空白行没有）：“…”菜单按钮 + row.action 按钮（归档、置顶）
- **点击行**：已归档 → toast “已归档对话暂时无法查看，请取消归档后查看”，不打开；否则 `openSession`
- **双击标题**（非空白行）→ 打开“重命名会话”对话框
- **选中高亮**：主视图中保留的会话（`retainedBy.mainView>0`）；有面板（`layout.panelInfo.activePanelId!==null`，如设置页）打开时不高亮任何行
- **归档行**：样式变淡；`aria-description` 为 `toast.archivedNotOpenable`
- **hover 卡片**（800ms，菜单打开或拖拽时禁用）：
  - 完整标题
  - “{t}前”（空白行无）
  - `sidebar.session.row.hover` 插槽（定时任务）
  - 状态行：可多条；归档行会过滤掉 done/idle
  - 归档行显示“已归档”（归档图标）
  - “复制”按钮复制标题（空白行或无标题时没有）
- **状态优先级**（`sessionStatuses`）：
  1. 待交互（approval →“等待审批”/ plan-review →“计划待审”/ question →“等待回答”，state=warning）
  2. 运行中（“进行中”，ongoing）
  3. 子智能体运行数（“{n} 个子智能体运行中”，ongoing）——可与 1 或 2 并列
  4. 未读完成（“已完成”，done）
  5. 空闲（“空闲”，idle）

  数据源：`useSessionStatus`（ui-session 提供：running / pendingInteraction / completionUnread）+ 父会话 `projectionsBySession[id].values.subagentCatalog` 中子会话的 running 计数
- **“…”菜单（按 order 排序）**：
  1. **置顶会话 / 取消置顶**（order 100，图钉图标）——**归档行不显示** → `workspace/pinSession` / `workspace/unpinSession`；失败时 toast“置顶失败，请稍后重试” / “取消置顶失败，请稍后重试”。manual 模式下置顶还会把该会话移到其所在组和平铺 account 本地顺序的最前
  2. **重命名**（order 200，编辑图标，显示 `session.rename` 快捷键）→ 打开会话重命名对话框（初始值为行标题）
  3. **分叉会话**（order 300，分支图标，显示 `session.fork` 快捷键）——只有 access snapshot 允许 `session/fork` 时才出现（`useSessionAccess(sessionId,"session/fork")`，远程访问权限）→ `session/fork {sessionId, allowMigration:false}`。成功后客户端再调 `session/rename` 给子会话设置递增标题（`X` → `X (1)`；`X(2)` → `X(3)`；`X（2）` → `X（3）`）。**不切换当前选中**，子会话经 Host 列表出现在源会话旁。失败码 `session/migration-required` 时 toast“请先打开原会话完成迁移，再创建分支”，带动作“打开原会话”（源已归档时改为 toast archivedNotOpenable）。同时埋点 `branch_session_click {session_id, parent_session_id, click_position:"sidebar"}`
  4. **归档会话 / 取消归档**（order 400；归档时显示 `session.archive` 快捷键，取消归档时不显示）→ 归档流程见 1.7；取消归档调 `workspace/unarchiveSession`，失败只打 console
  5. **复制 Session ID**（order 450，复制图标）→ 写剪贴板；toast“Session ID 已复制” / “复制失败，请重试”

  菜单 hover 离开即关闭（`closeOnPointerLeave`），点选后关闭。归档行的菜单为：重命名 / 分叉（若有权限）/ 取消归档 / 复制 Session ID
- **hover 行按钮**：归档/取消归档（order 100，tooltip “归档会话”/“取消归档”）、置顶/取消置顶（order 200，最右侧，正好落在常态图钉标记的位置；归档行无此按钮）

#### 1.6 对话框
- **重命名工作区**（Modal，`rename.workspace.title`）：
  - 输入框（aria“工作区名称”）预填**显示标题**，聚焦时全选；Enter 确认（有 IME 组字守卫）
  - 按钮：“取消” / “重命名”（primary）
  - 以下情况 **disabled**：空串；与存储标题相同（未改）；与其他工作区的显示标题重名（同时显示内联提示“已存在名为“{name}”的工作区。”）；请求进行中
  - 请求中禁止关闭（也不能按 × 关）
  - 失败时显示原始错误串，例如 `workspace rename failed: workspace/name-conflict: Workspace name 'x' is already in use`
  - RPC：`workspace/rename {workspaceId, title}`（Host 会 trim；空串返回 `gateway/bad-request`；重名返回 `workspace/name-conflict`）
- **删除工作区**（Modal，`delete.workspace`）：
  - 描述：“将把“{name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。”
  - 按钮：“取消” / “删除工作区”（危险样式）
  - 进行中显示“正在删除工作区…”，按钮禁用，不可关闭；等列表里该工作区消失后自动关闭；失败显示原始错误
  - RPC：`workspace/delete {workspaceId}`
  - 注意：删除默认工作区后，Host **永久停用**自动创建默认工作区
- **重命名会话**（shell.overlay，`rename.session.title`）：
  - 输入框（aria“会话名称”），初始值为当前标题；无标题时为空，必须填写
  - **只有空串才禁用**；不做重名检查；**未改也允许提交**（与工作区不同）
  - Enter 确认，有 IME 守卫；请求中不可关闭；失败显示原始错误
  - RPC：`session/rename {sessionId, title}`（经 `sessions.using(..., {source:"workspaceOperation"})` 调 `binding.session.rename`）
  - 触发方式：菜单“重命名”、双击标题、快捷键 `session.rename`
- **停止并归档确认**（shell.overlay，`archive.confirm.title`“停止并归档此会话？”）：
  - 描述 `archive.confirm.desc`（含 {title}）
  - 列表 aria“将被停止的工作”，每个 activity 一行：turn →“进行中的回合”；subagent / job / schedule →“{n} 个运行中的子智能体：{names}”等（names 用 label，没有就用 id，以“、”连接）；未知 kind →“{n} 项其他工作（{kind}）”
  - 按钮：“取消” / “停止并归档”（危险样式）；进行中显示“正在停止并归档…”；失败显示原始错误
  - RPC：`workspace/archiveSession {sessionId, stopActivity:true}`
- **目录选择失败**（WorkspacePicker 内 Modal，`folderError.title`“无法打开文件夹”）：
  - 正文是错误原文（`role=alert`），例如 `workspace create failed: workspace/invalid-path: cannot create a Workspace at "...": ...`，或 native pick 抛出的消息
  - 按钮：“取消” / “重新选择”（重新打开目录流程；没有 flow 提供者时 disabled）

#### 1.7 归档流程
1. 菜单 / hover 按钮 / 快捷键 → `workspace/archiveSession {sessionId}`
2. 成功：toast “会话已归档，可” + 动作 “撤销”（→ `workspace/unarchiveSession`）；若当前筛选是 default，再追加 “ 或 ” + “筛选已归档会话”（→ 切到 `show` 筛选）。hold 6s，tone 为 success。被归档的会话若是当前会话，清空主视图选中（`clearMain`：清除 `dsh.sessions.current`、关闭面板），回到无会话 / hero 状态；follow 流推来新的归档集合时也会触发同样的清理
3. 失败码 `workspace/session-active`（会话还有运行中的工作）→ 弹出 1.6 的确认框，`details.activity` 为 activity 列表；确认后成功的 toast 文案为“已停止并归档，可”+ 撤销/筛选
4. 其他失败：只打 `console.warn`

#### 1.8 新会话 / 打开会话（`uiWorkspace`）
- 入口：组头“新会话”按钮、`session.new` 快捷键、ui-sidebar 导航区“新会话”（`startSession(workspaceId?)`）、添加工作区后自动新建、ui-schedule 等
- 目标工作区 = 显式参数 ?? 当前会话所在工作区 ?? “最近工作区”（各工作区成员会话的最大 updatedAt，没有成员时用 createdAt，按 Host 顺序打破平局）
- 找不到目标时：带草稿（prompt / replace）→ toast “请先选择工作区”；否则 `clearMain`，展示 hero，由用户点工作区 chip 选择
- **复用空白会话**：在目标工作区中找第一个满足以下条件的会话：blank、cwd===workspace.path、在 `sessionIds` 中、未归档、preset 兼容。找到就作为 `sessionId` 传入 → `session/create {workspaceId, sessionId?, agentPreset?}`。Host 可能返回不同的 sessionId（被拒绝复用），此时对原 id 调 `session/projections` 刷新。同一工作区的并发请求合并（preset 相同时）
- 失败：toast “新建会话失败：{code}: {message}”（6s）；被后续导航取代时静默
- 打开：`sessions.retain(target,{source:"mainView"})`，写入 `dsh.sessions.current`，关闭面板（reveal）
- **启动恢复**（`watchNavigation`，两个列表都 ready 后执行一次）：
  1. 读 `dsh.sessions.current`：有 `subagentAddress` → 直接打开
  2. 保存的是非空白会话，或其不属于任何工作区 → 直接打开
  3. 保存的是空白会话且仍有效 → `restoreBlank`：先 `session/projections`，再 `session/create` 带上记录的 agentPreset；遇到 `agent-preset/not-found|invalid` 时去掉 preset 重试
  4. 否则目标 = 所属工作区 ?? 最近工作区
  5. **工作区和会话都为空** → `workspace/initializeDefault`（Host 在 `<Documents>/deepseek-harness/default-workspace` 创建；仅首次使用时才有资格，返回 `undefined` 表示不符合条件）；失败 toast “无法创建默认工作区，请通过“选择工作区”选择文件夹”
  6. 最后 `connectWorkspace` 并打开
- **hero 工作区选择器**（`conversation.hero.workspace`）：
  - 点击 chip 打开菜单：工作区列表（文件夹图标、显示标题、当前选中打勾 `selectedId`）+ footer “添加工作区…”（有 flow 时）
  - 列表 pending 时显示“正在加载工作区…”
  - 工作区为空、列表已 ready、且只剩“添加”一项时，**不显示菜单，直接拉起目录流程**
  - 目录流程忙碌时所有项 disabled
  - 选中工作区 → ui-conversation 的 `selectWorkspace` = `uiWorkspace.openWorkspace(id, beforeOpen)`，把当前草稿文字和附件迁移到新会话；失败时回退 pendingWorkspaceId
  - 新增目录 → `workspace/create` → 视同选中该工作区

#### 1.9 目录选择流程
**Owner 协议**（`WorkspacePickFlow` 传给 flow occupant 的 props）：`{open, busy, onPicked(path), onCancel(), onError(message)}`。`busy`=采纳中（等 `workspace/create` 返回）。

**原生（native）**：
- renderless：`open` 由假变真时只执行一次 pick
- pick 实现：优先用桌面壳注入的 `globalThis.__DSH_DIRECTORY_PICKER__.pick()`，否则走 `directoryPicker/pick`（Host 在本机弹系统对话框）
- 返回 `null` → onCancel；返回路径 → onPicked；抛错 → onError，进而弹“无法打开文件夹”
- Host 只提供 browse 能力时，pick 返回 `directory-picker/unavailable`
- **iOS 不可用**（对话框会弹在 Host 机器上）

**浏览（browse）对话框**（680×500 Modal，标题“选择工作区目录”，locale ns `directory-browser`）：
- 打开时调 `directoryPicker/list {}`（不带 path，即 Host home）
- **面包屑**：位于 home 子树内时以“主目录”起头，否则显示从根开始的完整祖先链（根用路径本身作名字）。每个 crumb 可点击跳转；crumb 栏自动滚到最右
- **Miller 列**：未选中时显示单列（当前层）；选中某行后变两列（当前层 | 选中文件夹的子目录），列间有分隔线，每列最小 256px
  - 点左列行：选中并加载其子目录（立即显示选中态，右列等待加载）
  - 点右列行：整体右移一层（child 变成当前层，并选中被点的行）
  - 选中失败：显示错误，取消选中
- **“落地”（navigate）**：跳转时保持旧视图继续渲染，直到新视图就绪。离显示根至少两层时，并行加载目标层和父层，作为“父层 | 目标”两列一次性落地。父层 200ms（`PARENT_LEG_WAIT_MS`）内没回来就先单列落地，父层到达后原地升级为两列。父层被截断、找不到目标时，保持单列
- **慢加载提示**：扫描超过 300ms（`SLOW_SCAN_DELAY_MS`）才显示浮动的“加载中…”
- **截断**：任一列 `truncated` 时显示“文件夹过多，仅显示开头部分。”
- **错误**：显示 RPC message（`rpcError.message`），`role=alert`
- **路径编辑**：
  - 点 crumb 栏右侧的铅笔区（“编辑路径”）→ 进入输入框，预填“选中项路径或当前层路径 + 末尾分隔符”
  - 输入的目录部分（最后一个分隔符之前）指向的不是当前层时，防抖 250ms 后自动扫描并落地（不关闭编辑器）
  - 最后一段作为大小写不敏感的**前缀过滤**作用于最后一列；以 `.` 开头的前缀会把匹配的隐藏项也显示出来；没有任何匹配时不过滤
  - Enter：非空即提交导航（关闭编辑器，失败显示错误）
  - Esc 或焦点移出对话框：取消编辑，回到面包屑模式（已走到的位置保留）
  - 分隔符根据 `listing.home` 是否含 `\` 推断；Windows 下 `/` 也视为分隔符
- **底栏**（从左到右）：
  - “新建文件夹”（+图标）：`parent===null`、加载中、忙碌、编辑路径中时 disabled
  - “显示隐藏文件”切换（`aria-pressed`，开启时显示 ✓；纯客户端过滤 `hidden`，每次打开对话框重置为关）
  - 占位
  - “取消”（→ onCancel）
  - “打开”（primary）：目标 = 选中项路径 ?? 当前层路径；目标为空、加载中、忙碌、编辑路径中时 disabled；点击 → onPicked(path)
- **新建文件夹子对话框**：
  - 标题“新建文件夹”；副标题“在"{name}"中新建文件夹”（name 为目标文件夹显示名）
  - 输入框 placeholder“未命名文件夹”，aria“文件夹名称”
  - Enter 创建、Esc 关闭；按钮“取消” / “创建”（空串 disabled）
  - → `directoryPicker/createDirectory {path:目标, name}`；成功后重新 list 父层并选中新文件夹；失败在子对话框内显示错误（`directory-picker/exists` / `create-failed`）
- **关闭**：忙碌或子对话框打开时，点外部 / Esc 都不能关闭
- 浏览流程**从不调用 onError**，错误都在对话框内展示。onPicked 之后由 owner 调 `workspace/create`：失败 → 关闭浏览器，弹“无法打开文件夹”；“重新选择”再次打开浏览器（回到 home）

#### 1.10 快捷键（`ctx.shortcuts.register`，regions `["page","editable"]`，`modals: []`）
`primary` 在 mac 上是 Cmd，在 Windows/Linux 上是 Ctrl。desktop 指桌面壳，web 指浏览器（为避开浏览器自带快捷键而换了组合）。

| id | label | desktop | web | 阻断条件 → 原因 |
|---|---|---|---|---|
| `session.new` | 新会话 | primary+N | primary+Alt+N | 无 |
| `session.search` | 搜索会话 | primary+K | primary+Alt+K | 无（会展开侧栏并聚焦搜索） |
| `workspace.add` | 添加工作区 | primary+O | primary+Alt+O | 无 flow →“目录选择器不可用”；忙碌 →“正在选择或添加工作区” |
| `session.rename` | 重命名会话 | primary+Alt+G | primary+Alt+G | 无当前会话 / 当前为空白会话 / 有 modal / 有面板 →“请先选择一个会话” |
| `session.fork` | 分叉会话 | primary+Alt+F | primary+Shift+F | 无当前会话 →“请先选择一个会话”；空白会话 →“当前会话没有已结束的轮次”；运行失败：`session/fork-unavailable` → toast“当前会话没有已结束的轮次”，其他 → “无法分叉会话，请重试”（注意：快捷键 fork 未传 allowMigration） |
| `session.archive` | 归档会话 | primary+Shift+A | primary+Alt+A | 无当前会话 →“请先选择一个会话” |

aliases：`["new session","new chat"]`、`["search sessions"]`、`["add workspace","open folder"]`、`["rename session"]`、`["fork session"]`、`["archive session"]`。

#### 1.11 Toast（`workspace.toast` keyed，同一时刻只显示一条，新的替换旧的；`seq` 递增强制重挂载）
| key | 文案 key | tone | holdMs | 动作 |
|---|---|---|---|---|
| `sessionIdCopied` | toast.sessionIdCopied | success | 默认 | — |
| `sessionIdCopyFailed` | toast.sessionIdCopyFailed | warning | 默认 | — |
| `pinFailed` | toast.pinFailed | warning | 默认 | — |
| `unpinFailed` | toast.unpinFailed | warning | 默认 | — |
| `archivedNotOpenable` | toast.archivedNotOpenable | warning | 默认 | — |
| `defaultWorkspaceFailed` | defaultWorkspace.failed | warning | 默认 | — |
| `shortcutForkFailed` | reason==="unavailable" ? shortcut.noCompletedTurn : shortcut.forkFailed | plain | 默认 | — |
| `createFailed` | toast.createFailed {message} | warning | 6000 | — |
| `forkRequiresOpen` | toast.forkRequiresOpen | warning | 6000 | “打开原会话” |
| `archived` | toast.archived | success | 6000 | “撤销”；filter≠show/only 时追加 prefix“或”+“筛选已归档会话” |
| `stoppedAndArchived` | toast.stoppedAndArchived | success | 6000 | 同上 |

warning tone 带警告图标。notice payload：`{kind, seq, sessionId?, message?, reason?}`。

---

### 2. RPC 方法表

wire 格式（来自实测抓到的帧）：
- 流：`{"type":"open","streamId":"s-ws","endpoint":"workspace/follow","payload":{"args":{}}}`
- 下行：`{"type":"item","streamId":..., "value":<Frame>}`
- 参数一律是**具名 args 对象**：workspace 方法为 `{"args":{"request":{...}}}`；directoryPicker 为 `{"args":{"path":...,"name":...}}`。参数名不对时返回 `gateway/arguments-invalid`
- 返回值都是 `RemoteResult<T>`：`{ok:true,value}` 或 `{ok:false,error:{code,message,details}}`

ID 格式：`WorkspaceId` 是 uuid 字符串（例如 `"8cae5d8f-ebb4-4e28-ab82-a5b5648f7beb"`）；`SessionId` 形如 `"session-<uuid>"`。

#### 2.1 workspace/*（`dsh-api-workspace-controller`）

`WorkspaceView`:
```json
{
  "workspaceId": "uuid",
  "path": "/canonical/realpath",
  "title": "default-workspace",
  "sessionIds": ["session-..."],
  "createdAt": "2026-11-02T23:04:05.352Z",
  "updatedAt": "2026-11-02T23:04:05.352Z"
}
```
`sessionIds` 是 Host 记录的手动顺序（新会话 attach 时 prepend），Web UI 只用它判断成员关系，不用作排序。

| 方法 | args | 返回 value | 何时调用 | 错误码 |
|---|---|---|---|---|
| `workspace/follow` (stream) | `{}` | `WorkspaceFollowFrame` 流（见下） | 客户端启动即开，断线自动重连（RemoteSnapshotStream），每代以 baseline 开头 | — |
| `workspace/create` | `{"request":{"path":"/abs/dir"}}` | `{"workspace":WorkspaceView,"created":true\|false}` | 目录流程选定路径后；已登记的路径幂等返回 `created:false`；新工作区 prepend 到顺序最前 | `workspace/invalid-path {path}` |
| `workspace/initializeDefault` | `{}` | `{"workspace":WorkspaceView}` 或 `undefined` | 启动恢复时，工作区和会话都为空 | 失败时客户端包装为 `WorkspaceCreateError` |
| `workspace/rename` | `{"request":{"workspaceId":"…","title":"…"}}` | `{"workspace":WorkspaceView}` | 工作区重命名对话框确认 | `gateway/bad-request`（空）、`workspace/name-conflict {name}`、`workspace/not-found {workspaceId}` |
| `workspace/delete` | `{"request":{"workspaceId":"…"}}` | `{"deleted":true}` | 删除对话框确认；客户端成功后立即本地移除，且该 id 永不复活 | `workspace/not-found` |
| `workspace/insertBefore` | `{"request":{"workspaceId":"…","beforeWorkspaceId":"…"?}}`（省略 before 表示追加到末尾） | `{"workspaceIds":["…"]}`（完整新顺序） | 拖拽工作区头；客户端乐观更新 | `workspace/not-found` |
| `workspace/insertSessionBefore` | `{"request":{"workspaceId":"…","sessionId":"…","beforeSessionId":"…"?}}` | `{"workspace":WorkspaceView}` | **Web UI 未使用** | `workspace/move-invalid {workspaceId,sessionId,beforeSessionId?}` |
| `workspace/archiveSession` | `{"request":{"sessionId":"…","stopActivity":true?}}` | `{"archivedSessionIds":["…"]}` | 归档；客户端成功后同时把该 id 从本地置顶集合移除 | `session/not-found {sessionId}`、`workspace/session-active {sessionId, activity:[{kind, items?:[{id,label?}]}]}` |
| `workspace/unarchiveSession` | `{"request":{"sessionId":"…"}}` | `{"archivedSessionIds":[…]}` | 取消归档 / 撤销；幂等 | — |
| `workspace/pinSession` | `{"request":{"sessionId":"…"}}` | `{"pinnedSessionIds":[…]}`（最近置顶在前） | 置顶 | `session/not-found`、`gateway/bad-request`（已归档） |
| `workspace/unpinSession` | `{"request":{"sessionId":"…"}}` | `{"pinnedSessionIds":[…]}` | 取消置顶；幂等 | — |

`SessionActivity.kind` 已知取值：`"turn"`（无 items）、`"subagent"`、`"job"`、`"schedule"`。可扩展，未知 kind 走通用文案。

**follow 帧结构**：
```json
{"type":"baseline","value":{"items":[WorkspaceView],"archivedSessionIds":["…"],"pinnedSessionIds":["…"]}}
{"type":"replace","value":{同 baseline.value}}
{"type":"upsert","workspace":WorkspaceView}
{"type":"remove","workspaceId":"…"}
{"type":"order","workspaceIds":["…"]}
{"type":"archived","archivedSessionIds":["…"]}
{"type":"pinned","pinnedSessionIds":["…"]}
```
- 每代恰好一个 baseline 起头
- `replace` 仅在非 owner（远程访问受限）时出现，表示用新的完整过滤状态替换当前代已推送的全部内容，它是一次变更，不是新的一代
- `remove` 表示真实删除，客户端要记住被删的 id，迟到的 upsert 不能复活它
- 客户端合并逻辑：upsert 遇到不在 committedOrder 中的 id 时 prepend；baseline 到达后 state 置为 `idle`、phase 置为 `ready`；断线时 state 置为 `loading`（保留数据）；terminal 失败时 state 置为 `error`
- 竞态处理：unary 返回的集合会被更晚的请求或推送的集合取代（各用 seq 计数）

#### 2.2 directoryPicker/*

`DirectoryEntry`：`{"name":"Documents","path":"/Users/x/Documents","hidden":false}`

`DirectoryListing`:
```json
{
  "path": "/Users/x/Documents",
  "home": "/Users/x",
  "crumbs": [{"name":"/","path":"/","hidden":false},{"name":"Users","path":"/Users","hidden":false},{"name":"x","path":"/Users/x","hidden":false},{"name":"Documents","path":"/Users/x/Documents","hidden":false}],
  "entries": [{"name":".git","path":"/Users/x/Documents/.git","hidden":true}],
  "truncated": false
}
```
`crumbs` 从根到当前层（含当前层），crumb 的 hidden 恒为 false；`entries` 只含子目录（含指向目录的 symlink），按名字排序；`truncated` 表示被截断，缺的是排序后的尾部。

| 方法 | args | 返回 | 何时 | 错误码 |
|---|---|---|---|---|
| `directoryPicker/list` | `{"path":"/abs"}` 或 `{}`（省略 = home） | `DirectoryListing` | 浏览器打开、点击 crumb、选中行、路径编辑、新建后刷新；可 abort | `directory-picker/unreadable {path}`（非绝对路径或无法读取）、`directory-picker/unavailable {capability}` |
| `directoryPicker/createDirectory` | `{"path":"/abs/parent","name":"seg"}` | `string`（新目录绝对路径） | 新建文件夹 | `directory-picker/exists {path}`、`directory-picker/create-failed {path}`、`unavailable` |
| `directoryPicker/pick` | `{}` | `string \| null` | native flow（Host 本机弹窗）；iOS 不要用 | `directory-picker/unavailable` |

Host 只装配一种 capability（`native` 或 `browse`）。不支持的动词返回 `directory-picker/unavailable`。iOS 端应**只用 list / createDirectory**（远程浏览）。

#### 2.3 session/*（`dsh-api-session-controller`，仅本区实际用到的）
| 方法 | args | 返回 value | 本区何时调用 |
|---|---|---|---|
| `session/search` | `{"request":{"query":"…"}}`（query ≤500 UTF-16，不含 NUL） | `{"items":[{"sessionId":"…","snippet":"≤240 code points"}],"hasMore":bool}`，最多 20 条（`SESSION_SEARCH_RESULT_LIMIT`） | 侧栏搜索（防抖 250ms，可 abort） |
| `session/create` | `{"request":{"workspaceId":"…"?,"cwd":"…"?,"sessionId":"…"?,"agentPreset":"…"?}}`（workspaceId 与 cwd 互斥） | `{"sessionId":"…","agentPreset":"…"?}` | 新会话 / 打开工作区 / 恢复空白会话。错误码含 `session/workspace-attach-failed`、`agent-preset/not-found`、`agent-preset/invalid`、`agent-preset/conflict`、`session/conflict` 等 |
| `session/fork` | `{"request":{"sessionId":"…","atSeq":n?,"allowMigration":false?}}` | `{"sessionId":"child"}` | 菜单分叉（allowMigration:false）/ 快捷键分叉（不传）。错误码 `session/fork-unavailable`、`session/migration-required` |
| `session/rename` | `{"request":{"sessionId":"…","title":"…"}}` | `{"title":"normalized","seq":n}` | 会话重命名、fork 后递增标题。错误码 `session/title-invalid` |
| `session/projections` | `{"request":{"sessionId":"…"}}` | `{"kind":"sequenced","asOfSeq":n,"values":{…}}` / `{"kind":"migration-required","values":{…}}` / `null` | 恢复空白会话前读取 agentPreset、新建时空白复用被拒后刷新 |

会话列表数据本身（另有人负责，这里只列依赖）：`session/list {request:{cursor?}}` → `{items:[SessionSummary]}`；`$events` 流推送 `api-session/added|removed|status|activity|error`；`session/control` 流推送 projection（例如 `title`、`subagentCatalog`、`agentPreset`）。

`SessionSummary`（wire）：`{agentAvailable, formatStatus?:"current"|"migration-required", sessionId, updatedAt:number(ms), running, blank, parentSessionId?, origin?:"subagent", cwd?, projections?:{kind:"cached"|"sequenced", asOfSeq, values}}`

客户端 `SessionSummary`：`{id, title?, displayTitle, cwd?, parentId?, origin?, formatStatus?, running, retainedBy:{mainView?:n,…}, blank, updatedAt, projectionValues?}`

`$events` 的 ready 帧：`{"type":"ready","clientId":"…","host":{"home":"/Users/x"}}`，home 用于 hover 卡片里的路径缩写。

---

### 3. 客户端状态模型

#### 3.1 服务端权威（经 `workspace/follow`）`WorkspaceSnapshot`
```
items: WorkspaceView[]          // 按 Host 顺序
archivedSessionIds: SessionId[] // 全局
pinnedSessionIds: SessionId[]   // 全局，最近置顶在前
state: 'idle'|'loading'|'error' // loading=断线重连中
phase: 'pending'|'ready'        // 首个 baseline 到达后为 ready，单调
error: RemoteFailure|null
```
`workspaceReady = phase==="ready" && state!=="loading"`

#### 3.2 本地持久化 localStorage
- **`dsh.workspace.view.v5`**（defineStore，JSON 整体存取；读回时整体替换 state）：
```json
{
  "groupBy": "workspace" | "workspace-tree" | "flat",
  "orderBy": "updated" | "manual",
  "groupExpansion": { "<workspaceId>|\"\"": true|false },
  "sessionOrderByAccount": { "<workspaceId>": ["session-…"], "": ["…"], "__flat_session_order__": ["…"] },
  "archivedFilter": "default" | "show" | "only"
}
```
  默认值：`groupBy:"workspace"`, `orderBy:"updated"`, `groupExpansion:{}`, `sessionOrderByAccount:{}`, `archivedFilter:"default"`。

  actions：`setGroupBy`、`setOrderBy(mode, initialOrders)`、`setGroupExpanded(key, bool)`、`retainAccountKeys(keys)`（工作区列表 ready 后清理已不存在工作区的 key；同时删除旧字段 `sessionUpdatedAtByAccount`）、`syncSessionOrders`、`setSessionOrder(accountKey, order, initialOrders)`（强制切到 manual）、`pinSessionOrder`、`setArchivedFilter`。

  account key：工作区 id；`""` 表示未分组；`"__flat_session_order__"` 表示平铺列表。
- **`dsh.sessions.current`**（`UiWorkspaceService.selection`）：`{"sessionId":"session-…","subagentAddress":{…}?}`，或 `{}`（已清空）。用于启动时恢复上次选中的会话。

#### 3.3 内存态（不持久化）
- shortcut controls：`{searchRequest:number(自增触发), addRequested:bool, directoryBusy:bool, renameTarget:{sessionId,currentTitle}|null}`
- archiveRequest：`{sessionId, displayTitle, activity}|null`
- rowToast：`{kind, seq, …payload}|null`
- 浏览器组件内：`query`、`searchExpanded`、`revealSessionId`、`remoteSearch {query,status:'idle'|'loading'|'ready'|'error',items,hasMore}`、每组水位线 `storedWatermarks`、拖拽状态、重命名 / 删除对话框状态
- `UiWorkspaceService.connecting: Map<workspaceId,{agentPreset, attempt}>`（并发新建去重）、`mainReference`（当前主视图会话的 retain 引用）

#### 3.4 `uiWorkspace` 服务对外接口（其他插件会调用）
- `openSession(target: SessionId | SubagentAddress): void`
- `openWorkspace(workspaceId, beforeOpen?: (sessionId)=>void, options?: {agentPreset?}): Promise<void>`
- `connectWorkspace(workspaceId, options?: {agentPreset?}): Promise<SessionId>`
- `startSession(workspaceId?, options?: {prompt?, clearPreviousDraft?, whenDraftExists?:'replace'|'append'|'keep', agentPreset?}): void`
- `forkSession(sessionId, onCreated?, options?: {allowMigration?}): Promise<SessionId>`
- `archiveSession(sessionId, options?: {stopActivity?}): Promise<void>`
- `unarchiveSession(sessionId): Promise<void>`
- `pinSession(sessionId)` / `unpinSession(sessionId)`
- `pickDirectory(): Promise<string|null>`
- `listDirectory(path?, signal?): Promise<DirectoryListing>`
- `createDirectory(path, name): Promise<string>`

调用者：ui-sidebar（startSession）、ui-conversation（openWorkspace、openSession）、ui-schedule（openSession、startSession）、ui-subagent（openSession(address)）、两个 directory-picker 插件。

---

### 4. Locale 表

#### 4.1 命名空间 `workspace`（ui-workspace，zh / en 原文照抄）
| key | zh | en |
|---|---|---|
| defaultWorkspace.failed | 无法创建默认工作区，请通过“选择工作区”选择文件夹 | Unable to create default workspace. Use Choose workspace to select a folder. |
| draft.workspaceRequired | 请先选择工作区 | Choose a workspace first. |
| draft.initializationFailed | 暂时无法填入草稿，请稍后重试 | Could not fill the draft. Please try again shortly. |
| group.ungrouped | 未分组 | Ungrouped |
| session.new | 新会话 | New Session |
| session.untitled | 未命名 | Untitled |
| shortcut.noSession | 请先选择一个会话 | Select a session first |
| shortcut.noPicker | 目录选择器不可用 | Directory picker unavailable |
| shortcut.directoryBusy | 正在选择或添加工作区 | Selecting or adding a workspace |
| shortcut.noCompletedTurn | 当前会话没有已结束的轮次 | This session has no completed turn |
| shortcut.forkFailed | 无法分叉会话，请重试 | Could not fork the session. Try again. |
| section.workspaces | 工作区 | Workspaces |
| section.sessions | 会话 | Sessions |
| viewOptions.label | 视图选项 | View options |
| groupBy.label | 分组方式 | Group by |
| groupBy.workspace | 按工作区 | WorkSpace |
| groupBy.workspaceTree | 按工作区树 | Workspace Tree |
| groupBy.flat | 单列表 | In one list |
| orderBy.label | 排序方式 | Order by |
| orderBy.manual | 手动排序 | Manual |
| orderBy.updated | 最近更新 | Last updated |
| filterBy.label | 筛选会话 | Filter sessions |
| viewOptions.hideArchived | 隐藏已归档 | Hide archived |
| viewOptions.showArchived | 全部对话（显示已归档） | All conversations (show archived) |
| viewOptions.onlyArchived | 仅显示已归档 | Archived only |
| sessions.expand | 展开其余 {n} 个会话 | Show {n} more sessions |
| sessions.collapse | 收起 | Show less |
| empty.none | 暂无会话 | No sessions yet |
| empty.noneArchived | 暂无已归档会话 | No archived sessions yet |
| empty.viewOthers | 查看其他会话 | View other sessions |
| empty.noMatches | 无匹配结果 | No matches |
| workspace.add | 添加工作区 | Add workspace |
| search.sessions.aria | 搜索会话 | Search sessions |
| search.placeholder | 搜索会话名称 | Search session names |
| search.clear | 清除搜索 | Clear search |
| search.results.aria | 搜索结果 | Search results |
| search.pending | 正在搜索会话历史… | Searching session history… |
| search.noMatches | 无匹配会话 | No matching sessions |
| search.hasMore | 仅显示前 {n} 条结果，请缩小搜索范围。 | Showing the first {n} results. Narrow your search. |
| menu.addWorkspace | 添加工作区… | Add workspace… |
| picker.loading | 正在加载工作区… | Loading workspaces… |
| conflict.named | 已存在名为“{name}”的工作区。 | A workspace named “{name}” already exists. |
| folderError.title | 无法打开文件夹 | Couldn’t open folder |
| folderError.retry | 重新选择 | Choose again |
| rename | 重命名 | Rename |
| rename.workspace.title | 重命名工作区 | Rename workspace |
| rename.session.title | 重命名会话 | Rename session |
| field.workspaceName | 工作区名称 | Workspace name |
| field.sessionName | 会话名称 | Session name |
| delete.workspace | 删除工作区 | Delete workspace |
| delete.desc | 将把“{name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。 | This removes “{name}” from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped. |
| delete.pending | 正在删除工作区… | Deleting workspace… |
| menu.fork | 分叉会话 | Fork session |
| menu.archiveSession | 归档会话 | Archive session |
| menu.unarchiveSession | 取消归档 | Unarchive session |
| menu.pinSession | 置顶会话 | Pin session |
| menu.unpinSession | 取消置顶 | Unpin session |
| menu.sessionId | 复制 Session ID | Copy Session ID |
| toast.sessionIdCopied | Session ID 已复制 | Session ID copied |
| toast.sessionIdCopyFailed | 复制失败，请重试 | Copy failed. Try again. |
| row.archived | 已归档 | Archived |
| row.pinned | 已置顶 | Pinned |
| toast.archivedNotOpenable | 已归档对话暂时无法查看，请取消归档后查看 | Archived sessions cannot be opened. Unarchive it to view. |
| toast.archived | 会话已归档，可 | Session archived. You can␠ |
| toast.stoppedAndArchived | 已停止并归档，可 | Session stopped and archived. You can␠ |
| archive.confirm.title | 停止并归档此会话？ | Stop and archive this session? |
| archive.confirm.desc | “{title}”仍有正在进行的工作。归档会先停止这些工作；之后可在侧栏筛选“全部对话（显示已归档）”中恢复会话，被停止的工作不会自动继续。 | “{title}” still has work in progress. Archiving stops it first; you can restore the session later from the “All conversations (show archived)” filter in the sidebar, and the stopped work will not resume on its own. |
| archive.confirm.activity | 将被停止的工作 | Work that will be stopped |
| archive.confirm.turn | 进行中的回合 | The turn in progress |
| archive.confirm.subagents.one | {n} 个运行中的子智能体：{names} | {n} running subagent: {names} |
| archive.confirm.subagents.other | {n} 个运行中的子智能体：{names} | {n} running subagents: {names} |
| archive.confirm.jobs.one | {n} 个后台任务：{names} | {n} background job: {names} |
| archive.confirm.jobs.other | {n} 个后台任务：{names} | {n} background jobs: {names} |
| archive.confirm.schedules.one | {n} 条定时提醒：{names} | {n} scheduled reminder: {names} |
| archive.confirm.schedules.other | {n} 条定时提醒：{names} | {n} scheduled reminders: {names} |
| archive.confirm.other.one | {n} 项其他工作（{kind}） | {n} other item of work ({kind}) |
| archive.confirm.other.other | {n} 项其他工作（{kind}） | {n} other items of work ({kind}) |
| archive.confirm.listSeparator | 、 | ,␠ |
| archive.confirm.action | 停止并归档 | Stop and archive |
| archive.confirm.pending | 正在停止并归档… | Stopping and archiving… |
| toast.archivedUndo | 撤销 | undo |
| toast.archivedOr | 或 | ␠or␠ |
| toast.archivedFilter | 筛选已归档会话 | filter archived sessions |
| toast.pinFailed | 置顶失败，请稍后重试 | Pin failed. Try again later. |
| toast.unpinFailed | 取消置顶失败，请稍后重试 | Unpin failed. Try again later. |
| toast.createFailed | 新建会话失败：{message} | New session failed: {message} |
| toast.forkRequiresOpen | 请先打开原会话完成迁移，再创建分支 | Open the original session to complete migration before creating a branch. |
| toast.openForkSource | 打开原会话 | Open original session |
| sessions.count.one | {n} 个会话 | {n} session |
| sessions.count.other | {n} 个会话 | {n} sessions |
| actions.workspace.aria | 工作区“{name}”的操作 | Workspace actions for {name} |
| actions.session.aria | 会话“{name}”的操作 | Session actions for {name} |
| actions.archive | 归档会话 | Archive |
| actions.unarchive | 取消归档 | Unarchive |
| actions.pin | 置顶会话 | Pin |
| actions.unpin | 取消置顶 | Unpin |
| actions.newSession | 新会话 | New session |
| actions.newSession.aria | 在“{name}”中新建会话 | New session in {name} |
| status.running | 进行中 | Running |
| status.subagentsRunning.one | {n} 个子智能体运行中 | {n} subagent running |
| status.subagentsRunning.other | {n} 个子智能体运行中 | {n} subagents running |
| status.idle | 空闲 | Idle |
| status.waitingApproval | 等待审批 | Waiting for approval |
| status.planReview | 计划待审 | Plan awaiting review |
| status.waitingAnswer | 等待回答 | Waiting for answer |
| status.compact.approval | 待审批 | Approval |
| status.compact.planReview | 计划待审 | Plan review |
| status.compact.answer | 待回答 | Answer |
| status.completed | 已完成 | Completed |
| hover.created | 创建于 {time} | Created {time} |
| hover.copied | 已复制 | Copied |
| date.ymd | {y}年{m}月{d}日 | {y}-{m}-{d} |
| time.now | 刚刚 | now |
| time.minutes | {n}分钟 | {n}min |
| time.hours | {n}小时 | {n}h |
| time.days | {n}天 | {n}d |
| time.months | {n}个月 | {n}mo |
| time.years | {n}年 | {n}y |
| time.ago | {t}前 | {t} ago |

（表中 `␠` 表示英文原文里该位置有空格：`toast.archived` 结尾的 `"You can "`、`toast.stoppedAndArchived` 结尾的 `"You can "`、`toast.archivedOr` 为 `" or "`、`listSeparator` 为 `", "`。）
（`empty.noMatches`、`sessions.count.*` 已定义，但当前代码没用到。）

**ui-workspace 通过 t() 回退到 common 命名空间（dsh-client-locale）取用的 key**：

| key | zh | en |
|---|---|---|
| cancel | 取消 | Cancel |
| close | 关闭 | Close |
| copy | 复制 | Copy |
| search | 搜索 | Search |
| workspace.defaultName | 默认工作区 | Default workspace |

#### 4.2 命名空间 `directory-browser`（directory-picker-browse）
| key | zh | en |
|---|---|---|
| browser.title | 选择工作区目录 | Select Workspace Directory |
| browser.home | 主目录 | Home |
| browser.newFolder | 新建文件夹 | New folder |
| browser.folderName | 文件夹名称 | Folder name |
| browser.createIn | 在"{name}"中新建文件夹 | New folder in "{name}" |
| browser.untitledFolder | 未命名文件夹 | Untitled folder |
| browser.create | 创建 | Create |
| browser.cancel | 取消 | Cancel |
| browser.open | 打开 | Open |
| browser.editPath | 编辑路径 | Edit path |
| browser.loading | 加载中… | Loading… |
| browser.truncated | 文件夹过多，仅显示开头部分。 | Too many folders to list; only the beginning is shown. |
| browser.showHidden | 显示隐藏文件 | Show hidden files |

directory-picker-native 没有 locale。

#### 4.3 相对时间分桶（primitives `relativeTime`）
差值 = max(0, now − updatedAt)：
- < 60s → now
- < 1h → minutes = ⌊Δ/60000⌋
- < 1d → hours
- < 30d → days
- < 365d → months = ⌊Δ/(30d)⌋
- 否则 years = ⌊Δ/(365d)⌋

Web 端每次渲染时取 `Date.now()`，**没有定时刷新**；iOS 建议用 `TimelineView(.periodic(from:.now, by:60))`。

---

### 5. 手机端 SwiftUI 对应建议

**总体结构**
- iPhone：`NavigationStack`。根视图 = “会话列表”（即侧栏），点会话 push 到会话页（或用 `NavigationSplitView` 的 compact 折叠形态，自动退化为 stack）
- iPad：`NavigationSplitView(sidebar:detail:)`，sidebar 就是本区
- 桌面的 rail 收起态在手机上**不需要**
- 启动恢复逻辑（`dsh.sessions.current` → 打开上次会话 / initializeDefault）照搬，持久化改用 `@AppStorage`/UserDefaults，key 沿用 `dsh.sessions.current`、`dsh.workspace.view.v5`，JSON 结构保持一致，方便对照

**区头**
- 导航栏标题按 groupBy 显示“工作区”/“会话”
- 右上 `ToolbarItem`：
  - “添加工作区”按钮（`folder.badge.plus`）
  - “视图选项”：用 `Menu` 包三个 `Picker`（`.pickerStyle(.inline)`），每组前加 `Section("分组方式")` 等标题，对应 groupBy / orderBy / archivedFilter
- “新会话”放底部 toolbar 或右上 `square.and.pencil`；目标工作区沿用 `startSession` 的推断规则

**搜索**
- `.searchable(text:placement:.navigationBarDrawer(displayMode:.always), prompt:"搜索会话名称")`
- 非空时用搜索结果 List 替换树
- 本地匹配立即出结果；远端用 `.task(id: query)` 内 `try await Task.sleep(250ms)` 实现防抖，再调 `session/search`，靠 Task 取消实现 abort
- 结果行两行布局：标题 + 状态点 / 工作区名 · snippet（`.lineLimit(1)`）
- 加载中放 `.redacted(reason:.placeholder)` 骨架行；底部 hasMore 提示
- 归档结果行加 `.swipeActions` 的“取消归档”
- `.onSubmit(of:.search)` 不需要特别处理
- 点结果：清空搜索 → 打开会话；返回列表时用 `ScrollViewReader.scrollTo(id)` 做 reveal

**树（按工作区 / 工作区树）**
- `List` 中每个工作区一个 `Section`，或者用 `DisclosureGroup(isExpanded:)`，展开状态绑定 `groupExpansion`
- 组头行：文件夹图标 + 标题 + 右侧 “+” 小按钮（在该工作区新建）
- 组头 `.contextMenu`：重命名 / 删除工作区（`role:.destructive`）/ 复制路径；可附加 `.swipeActions`
- hover 卡片里的信息（路径、创建时间、复制路径）挪到 contextMenu 的 preview，或长按后的信息 sheet
- 工作区树模式：嵌套 `DisclosureGroup`，用缩进表示层级（`OutlineGroup` 也行，但展开状态需要自己控制）
- “展开其余 {n} 个会话 / 收起”保持为组尾的按钮行，水位线规则照抄（基线 5、自动抬升到 50、步长 5）
- “未分组”组放最后，不提供重命名 / 删除 / 新会话

**会话行**
- `HStack`：状态点（`Circle` 颜色映射 ongoing / warning / done）或定时任务标记 + 标题（`.lineLimit(1)`，不做 marquee）+ 尾部（紧凑 pending 标签或相对时间，`.foregroundStyle(.secondary)`）+ 置顶图钉
- 归档行 `.opacity(0.5)`；点击弹 toast，不导航
- **`.swipeActions(edge:.trailing)`**：归档 / 取消归档（对应 hover 按钮 order 100）；**`.swipeActions(edge:.leading)`**：置顶 / 取消置顶（归档行没有）
- **`.contextMenu`**（对应“…”菜单，顺序保持）：置顶 / 重命名 / 分叉会话（按权限）/ 归档或取消归档 / 复制 Session ID。preview 可以放 hover 卡片内容：完整标题、“N 分钟前”、定时任务、各状态行、“已归档”
- 双击标题重命名在 iOS 上不自然，用 contextMenu 的“重命名”替代
- 空白（新会话）行：只显示“新会话”，没有 swipe 和菜单

**拖拽排序**
- 会话：`List` + `.onMove`（进入 `EditButton` 编辑模式，或 iOS 16+ 用 `.draggable`/`.dropDestination`）
- 约束：只能在同一 Section 内、同一置顶分区内移动；空白行和归档行 `.moveDisabled(true)`
- 移动后写本地 `sessionOrderByAccount` 并把 orderBy 切到 manual（与 Web 一致，**不发 RPC**）
- 工作区重排：单独放一个“编辑工作区顺序”sheet，里面用 `List` + `.onMove` → `workspace/insertBefore`（anchor = 移动后下一个兄弟的 id，移到最后则省略），本地乐观更新。树模式下只允许兄弟之间移动

**对话框**
- 工作区重命名 / 会话重命名：`.alert(title, isPresented:) { TextField; Button("取消",role:.cancel); Button("重命名") }`。iOS 17 的 alert 无法 disable 按钮也无法显示内联错误，需要重名提示、进行中状态和错误展示的话，改用小 `.sheet`（`.presentationDetents([.height(220)])`）+ `Form`，规则照搬（工作区：空 / 未改 / 重名时禁用；会话：仅空串禁用）
- 删除工作区：`.confirmationDialog("删除工作区", titleVisibility:.visible)`，`message` 放 delete.desc，按钮 `Button("删除工作区", role:.destructive)`；进行中可以用 overlay ProgressView
- 停止并归档：`.alert` 或 `.confirmationDialog`。activity 列表比较长，建议用 sheet：标题 + 描述 + 列表 + “停止并归档”（destructive）
- 目录错误：`.alert("无法打开文件夹")`，按钮“取消” / “重新选择”

**Toast**
- 自定义顶部或底部 overlay banner（`.overlay(alignment:.bottom)` + `.transition(.move.combined(.opacity))`），同一时刻只显示一条，有动作时停留 6s
- “会话已归档，可 撤销 或 筛选已归档会话”拆成文本 + 两个 `Button`

**hero 工作区选择器**
- 会话页空态（hero）里的工作区 chip 用 `Menu`：各工作区 `Button`（当前项用 `checkmark` 标记）+ `Divider` + “添加工作区…”
- 工作区为空时点 chip 直接 present 目录浏览 sheet
- 列表 pending 时菜单里显示一行 disabled 的“正在加载工作区…”

**目录选择（重点）**
- `fileImporter` / `UIDocumentPicker` **不可用**：它们选的是手机本地路径，Host 在另一台机器上；`directoryPicker/pick` 也不能用，原生对话框会弹在 Host 上
- 统一实现**远程目录浏览**：sheet 内包 `NavigationStack`，每一层是一个 `List`，数据来自 `directoryPicker/list`。点文件夹 push 到下一层，用 iOS 原生的逐级 push 替代 Miller 两列
- 顶部用 crumbs 做横向 `ScrollView` 的面包屑按钮（home 显示为“主目录”），点击直接跳转（重设 NavigationPath）
- 工具栏：
  - 右上“打开”：采纳**当前层**路径；也可以给每行加 trailing“选择”按钮，直接采纳该行（相当于 Web 的选中后再点打开）
  - 左上“取消”
  - 底部 toolbar：“新建文件夹”（alert + TextField → `directoryPicker/createDirectory`，成功后刷新并 push 进新目录）+ “显示隐藏文件” `Toggle`
  - “编辑路径”：放一个 TextField 或 `.searchable`。最后一段作为本层前缀过滤；输入以分隔符结尾时防抖 250ms 后 list 并跳转；回车提交
- 截断提示放在 List footer；错误用 `ContentUnavailableView` 或 footer 红字；慢加载（>300ms）显示 `ProgressView`
- 选定路径后 → `workspace/create`：成功则关闭 sheet 并 `startSession(workspaceId)`；失败弹 alert，提供“重新选择”
- 只有 Host capability 为 `native` 时，list 会返回 `directory-picker/unavailable`，需要提示“Host 未启用远程浏览”，这时只能在 Host 上添加工作区

**快捷键**
- 外接键盘时用 `.keyboardShortcut` 映射：⌘N 新会话、⌘K 搜索（聚焦 searchable 用 `@FocusState`/`isPresented`）、⌘O 添加工作区、⌥⌘G 重命名、⌥⌘F 分叉、⇧⌘A 归档
- 这是可选项，手机上的主路径是 contextMenu 和 swipe

**状态与数据层**
- `@Observable WorkspaceStore`：维护 follow 流（baseline / replace / upsert / remove / order / archived / pinned），removedIds 防复活，insertBefore 乐观更新加 committedOrder 回滚，archive / pin 的请求 seq 防止旧回复覆盖新状态
- `ViewStore` 持久化 v5 JSON；推导函数（`deriveGroups` / `reconcileManualOrder` / `deriveSearchResults` / `sessionVisible` / `sectionMembers` / 水位线）建议**逐行移植为纯函数**，并配单元测试，保证与 Web 排序完全一致

---

# B. 终端面板 + 自动化/定时任务

> 本章内部编号：终端部分为 A.x 节 / A1…A20 条，自动化任务部分为 B.x 节 / B1…B35 条（总表中写作 "B §A7"、"B §B31"）。

> 来源：`engine/node_modules/@deepseek-ai/` 下各包 `lib/client.js`（UI）、`lib/types/**/*.d.ts`、`lib/typert.remote-client.d.ts`、`lib/index.js`（Host 实现，用于确认校验/默认值）、README.zh.md。版本均为 `0.2.1-rc.4`。
> 约定：`ctx.remote.<ns>.<method>(...)` 即 typert RPC `'<ns>/<method>'`，返回 `RemoteResult<T>`（`{ok:true,value}` / `{ok:false,error:RemoteError{code,message,details}}`）；流方法返回 `RemoteStreamHandle<Down, Up>`（可 `for await` 读下行帧、`handle.send(up)` 发上行帧）。客户端都经 `ctx.remote.$stream({name, open, ended, carrierFailed})` 包一层"自动重连流"：每次物理重连得到新的 `generation`，消费方必须 `item.accept()` 才算接收。传输层（Gateway mux / websocket）不在本笔记范围，iOS 需另行实现 typert 协议。

---

## A. 终端面板

### A.0 包与分工

| 包 | 作用 | 与 UI 关系 |
|---|---|---|
| `dsh-client-ui-sidebar-terminal` | 右侧栏 `terminal` 标签类型：开始页卡片（guide entry）、标签正文（xterm 屏幕）、标签标题（可重命名）、快捷键 `terminal.new` | **UI 本体** |
| `dsh-api-terminal-controller` | Host：`terminal/*` RPC（PTY、headless xterm 屏幕缓存、保活回收）；Client：`ctx.webTerminals`（无 React 的模型 `ClientTerminals`/`TerminalView`、localStorage 持久化） | **RPC + 客户端状态模型** |
| `dsh-terminal` / `dsh-terminal-bash` / `dsh-tool-terminal` / `dsh-experimental-terminal-bundle` | **Agent 用**的持久终端工具（`ctx.terminals`，模型工具 open/send/read/signal/close/list），实验性、默认关闭，插件页可启用 | **与用户终端面板无关**，不进 UI；iOS 无需做面板（若做"插件开关"属插件页范畴） |

`client.terminal.js`（686KB 懒加载 chunk）= `@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0` + xterm.css + 本包 `TerminalBody`/主题/光标代码。**只用了 FitAddon**；没有 webgl、canvas、search、web-links、clipboard、unicode11、serialize（serialize/headless 只在 Host 端用于生成快照）。渲染器 = xterm 默认 DOM renderer。

### A.1 功能清单

| # | 功能 | 交互细节 | 限制/条件 | RPC |
|---|---|---|---|---|
| A1 | 开始页"新建终端"卡片 | 右侧栏开始页（guide）中 order=20 的卡片：图标 `PluginArtworkTerminal`(26px，有描述时；否则22)，标题 `new`「新建终端」，描述 `description`「在会话工作区运行命令」；右侧显示当前生效快捷键（`ShortcutKeys`，无背景文字）。点卡片主体 → `tab.actions.openTab("terminal", {replaceTab:true})`（替换开始页，无 params → 用记忆的 shell） | 需要有当前会话 | 打开后触发 A5 |
| A2 | Shell 选择菜单 | 卡片标题旁独立 ▼ 按钮（aria `shell`「选择 Shell」）。**菜单展开时才**调 `launchShells` 拉取 shell 列表；加载中显示禁用项 `shellLoading`；空列表显示禁用项 `shellEmpty`；失败显示禁用项 `failed`(message) + 可点项 `retry`（重新拉取）。选中项 = 记忆的 shell（`selectedShell`，选中标记）。选择后：写 localStorage `dsh.terminal.shell` → `openTab("terminal",{replaceTab:true, params:{shellPath}})` | 不分配 PTY | `terminal/shells(agentId)` |
| A3 | 快捷键 `terminal.new` | 默认 `Ctrl+\``（code `Backquote` + `control`），平台：desktop:macos/windows/linux、web:macos/windows（**web:linux 不绑定**）。生效区域 `page`/`editable`/`terminal`。无会话时 blocked，提示 `shortcut.noSession`「请先选择会话」。执行 `sidebarRight.openTabFromTarget("terminal", target)`：在焦点停靠分栏打开新终端 | aliases `["new terminal","shell"]` | — |
| A4 | 多终端/多标签 | 标签类型 `multiple:true`，可开任意多个（受 Host `maxTerminals` 默认 8/会话 限制，**已退出的也计数**）。通过右栏"新标签页"回到开始页再开 | 超限报 `terminal/limit-reached` → issue `terminalLimit` | `terminal/create` |
| A5 | 新标签自动启动 | 挂载 → `refresh()`：并行 `environment` + （恢复视图才）`list`；新标签：若无 shellPath 则 `shells` 后选 `dsh.terminal.shell` 中记忆且仍可用者，否则第一个（默认 shell 排第一）；`create({id: 客户端生成UUID, shellPath?, cols: min(80,maxCols), rows: min(24,maxRows)})`；随后 `retain` 保活确认 → `attach` | 状态文案：`loading`「正在读取终端环境…」→`creating`「正在启动…」→`connecting`「正在连接…」 | `environment` → `shells` → `create` → `retain` → `attach` |
| A6 | 输出渲染 | attach 流首帧必为 `snapshot`（`xterm.reset()` + `resize(info.cols, info.rows)` + `write(screen)`），之后 `output` 帧按 `sequence` 严格 +1；每帧 xterm 解析完回调后才 `acknowledge(revision)` 放下一帧（背压） | 序号断裂/缺 snapshot → issue `invalidOutput` | `terminal/attach` 下行 |
| A7 | 键盘输入 | `xterm.onData(data)` → `view.write(data)`：原样（含 Tab、控制字符、ESC 序列）以 UTF-8 字符串发 `{type:"write",sequence,data}`；未确认原始字节 ≤ `maxInputBytes`(64KiB)，编码帧总量 ≤ `maxBufferedBytes`(2MiB) 且单帧 ≤ `inputWindow.maxBytes`；超限 → issue `inputFull` 并断开附件（不重放） | 仅 `writable` 时可输入（`xterm.options.disableStdin = !writable`） | `terminal/attach` 上行 |
| A8 | 自适应尺寸 | ResizeObserver + FitAddon.proposeDimensions()，clamp 到 `maxCols`(500)/`maxRows`(200)，cols<2 或 rows<1 忽略；仅"可见且可写"时 `xterm.resize`+发 `{type:"resize",sequence,cols,rows}`；只读时按 Host 的 `info.cols/rows` 显示。字体/字号变化后重新 fit | 同一时刻仅一个附件可写 | `terminal/attach` 上行 |
| A9 | 只读/接管输入 | 最新 attach 的连接获得输入权；其它窗口/标签同一终端变只读：状态条显示 `readonly`「此页面当前只读。」+ 按钮 `control`「接管输入」→ `view.connect()`（重新 attach 抢回控制权） | ack 带 `refusal:"read-only"` 时立即 writable=false | 重新 `attach` |
| A10 | 断线重连 | 传输断开 → phase `disconnected`，状态条 `disconnected`「连接已断开。」+ 按钮 `reconnect`「重新连接」（有 info 时 → `connect()`；无 info → `refresh()`）。**不展示传输内部错误**。重连后新快照恢复屏幕，**绝不重放**未确认输入 | 进程不因断线结束 | `retain` + `attach` |
| A11 | 进程退出 | `state` 帧 `info.state:"exited"` → 状态条 `exited`「进程已退出（{code}）」（code 为 `exitCode` 或 `—`）+ 按钮 `new`「新建终端」（`openTab("terminal",{replaceTab:true})` 原位替换）；**不自动重启**；屏幕保留 | 退出终端仍占配额 | — |
| A12 | 失败态 | `info.state:"failed"` → 状态 `unavailable`「不可用」；phase `failed` → 错误行 `failed`「终端错误：{message}」（message 来自 issue 的本地化文案或 `error`/`info.error`）+ `retry`「重试」按钮（无 info 时 `refresh`，有 info 时 `reconnect`→`connect`） | | |
| A13 | 终端已不存在 | issue `missingTerminal`（Host `terminal/unavailable`，或恢复视图在 list 中找不到）→ 整块空状态：终端图标 36px + `missingTerminal`「此终端已不存在，请新建终端。」+ 主按钮 `new`（md 尺寸），原位替换为新终端 | 恢复视图**不会**自动建替代进程 | — |
| A14 | 重命名 | 双击标签 chip（`[data-dockkit-tab]` / 浮动 `[data-dockkit-float-grip]`）→ 内联 input（maxLength 120，aria `rename`「终端名称」），自动全选；Enter/失焦提交（trim 后非空且变化才提交），Esc 取消；IME 组字中忽略按键。默认标题 = `shell.name` | Host 校验 1–120 字符 | `terminal/rename(agentId,id,title)` |
| A15 | 关闭终端 | 关闭/替换标签 → 关闭 handler：先存 `dsh.terminal.close.v1.<id>` 清理请求、删 binding、立即移除标签，再后台 `close`；成功或 `session/not-found` 删请求；失败留在 `closeFailures` 中，**Web UI 目前不展示通知**（`TerminalCleanup` 组件只有类型声明，未注册），插件启动时自动重试已存请求 | 关闭是**显式结束进程**；折叠侧栏/切标签/切会话/浮动/全屏都**不**结束 | `terminal/close` |
| A16 | 刷新恢复 | 侧栏恢复布局后，各终端标签按 `dsh.terminal.binding.v1.[sessionId,contentId]` 找回 Host id，作为"恢复视图"（`createWhenMissing=false`）：`list` 中找到就 attach，找不到 → A13 | 保存布局外的 Host 终端**无 UI 恢复入口**（`recover()` 存在但未接 UI；`TerminalRecovery` 未注册） | `list` → `retain` → `attach` |
| A17 | 窗口保活 | 每个打开的 terminal 标签（含隐藏、非当前会话）对其 Host id 持有一条 `retain` 流；最后一个持有消失后，Host 在确认空闲 `unattendedTimeoutMs`(默认 2h) 后回收；运行中/后台任务保护 | 同窗口重复 occurrence 共用一条 | `terminal/retain` |
| A18 | 主题/字体 | 背景/前景/光标/选区跟随 DSH 主题（读屏幕容器计算样式）；字体 = 设置中终端字体 + `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`；字号 = `theme.fontSizes.terminal`；`minimumContrastRatio: 4.5`、`cursorBlink: true`、`scrollback = environment.scrollback`(1000)。OSC 4/104/10/11/12/110/111/112 颜色覆盖被保留，重置回 DSH 默认；光标与单元格背景保证 ≥3:1 对比 | 新渲染器无法从快照恢复 OSC 颜色 | — |
| A19 | 复制粘贴 | 仅 xterm 默认行为（选中→系统复制快捷键；粘贴走 xterm textarea 的 paste 事件 → onData）。**无右键菜单、无复制按钮、无链接识别、无搜索** | | |
| A20 | 环境/cwd | 新终端在 Session 当前工作目录启动（Host 先 `workingDirectory.ensure`），`info.cwd` 为初始目录，shell 内 cd 不回写；环境变量 `TERM=xterm-256color`、`DSH_SESSION_ID=<sessionId>`；权限 = 执行环境系统用户，独立于 Agent 沙箱/审批 | 终端输出不进入模型上下文 | `environment` 只读 cwd |

### A.2 RPC 方法表（namespace `terminal`）

> 注意参数名：`agentId`/`sessionId` 都是 `SessionId`（字符串）。`agent:*` scope 版本由 Gateway 注入 agent，客户端用的是带 id 的全名版本。

| 方法 | 参数 | 返回 | 何时调用 |
|---|---|---|---|
| `terminal/environment` | `(agentId: SessionId)` | `TerminalEnvironment` | 每个视图 refresh 时（取 cwd 与上限） |
| `terminal/shells` | `(agentId)` | `TerminalShell[]`（默认 shell 第一） | 展开 shell 菜单；新视图无 shellPath 时 |
| `terminal/list` | `(sessionId)` | `WebTerminalInfo[]` | 恢复视图首次 / 显式重试 / 连接重置后刷新已查询过的会话；不激活 Agent |
| `terminal/create` | `(agentId, request: TerminalCreateRequest)` | `WebTerminalInfo` | 新标签分配；对同一 open id **幂等**；已关闭 id 不可重建 |
| `terminal/retain` | `(sessionId, id)` 流 | 下行 `TerminalRetentionFrame`，无上行（`never`） | 每个打开的 terminal 标签持续持有；收到首帧 `{type:"retained"}` 后才允许 attach |
| `terminal/attach` | `(agentId, id)` 双工流 | 下行 `TerminalFrame`，上行 `TerminalInput` | 挂载/重连/接管输入 |
| `terminal/rename` | `(agentId, id, title: string)` | `void` | 标题编辑提交 |
| `terminal/close` | `(agentId, id)` | `void` | 关闭标签（后台）；重复 close 成功 |

类型（原样）：

```ts
type WebTerminalId = string   // 客户端生成 UUID v4；Host 校验 /^[\w-]{1,128}$/

interface TerminalShell { path: string; args: string[]; name: string }

interface TerminalEnvironment {
  cwd: string               // 当前目录（不校验）
  maxInputBytes: number     // 默认 65536
  maxBufferedBytes: number  // 默认 2097152
  maxCols: number           // 默认 500
  maxRows: number           // 默认 200
  scrollback: number        // 默认 1000
}

interface WebTerminalInfo {
  id: WebTerminalId
  title: string             // 初始 = shell.name
  shell: TerminalShell
  cwd: string               // 初始目录
  cols: number
  rows: number
  state: 'running' | 'exited' | 'failed'
  exitCode: number | null
  error?: string
}

interface TerminalCreateRequest {
  shellPath?: string        // 来自 shells()；省略=执行环境默认
  id: WebTerminalId
  cols: number              // 2..maxCols
  rows: number              // 1..maxRows
}

interface TerminalRetentionFrame { type: 'retained' }

// 上行（每个 attach 内从 1 连续编号；断开后新 attach 重新从 1 开始）
type TerminalInput =
  | { type: 'write';  sequence: number; data: string }            // data 为原始 UTF-8 字符串（非 base64）
  | { type: 'resize'; sequence: number; cols: number; rows: number }

// 下行
type TerminalFrame =
  | { type: 'snapshot'; sequence: number; screen: string; info: WebTerminalInfo; writable: boolean; inputWindow?: RemoteUplinkWindow }
  | { type: 'output';   sequence: number; data: string }           // sequence = 上一帧 +1
  | { type: 'state';    info: WebTerminalInfo; writable: boolean } // 尺寸/标题/控制权/退出变化
  | { type: 'ack';      sequence: number; refusal?: 'read-only' | 'not-running' }  // 对上行命令按序确认

interface RemoteUplinkWindow { maxBytes: number; frameOverheadBytes: number }
```

- `snapshot.screen`：Host 端 headless xterm + `SerializeAddon.serialize()` 生成的 **ANSI 转义字符串**（含 scrollback ≤1000 行），客户端 reset 后直接 write 即可还原画面；`snapshot.sequence` 是 Host 当前输出序号基线。
- `output.data`：PTY 输出经流式 UTF-8 解码后的字符串（跨块字符已拼好）。
- 每条上行命令 Host 处理后回 `ack{sequence}`；控制权被抢 → `refusal:"read-only"`；进程已退出 → `refusal:"not-running"`。客户端要求 ack 严格按序，否则 `invalidOutput`。
- 客户端估算帧字节：`UTF8(JSON.stringify(command)).byteLength + inputWindow.frameOverheadBytes`；在途字节超过 `inputWindow.maxBytes` 时本地排队等待 ack 释放额度。
- 过慢的订阅者（Host 端排队 > `maxBufferedBytes`）会被**显式断开**，客户端重连拿新快照。

错误码（`RemoteErrorDetailsMap`）：

| code | details | 客户端映射 |
|---|---|---|
| `terminal/unavailable` | `{}` | issue `missingTerminal`，并从 inventory 移除 |
| `terminal/control-unavailable` | `{reason:'read-only'\|'not-running'}` | （attach 内体现为 ack.refusal）writable=false |
| `terminal/limit-reached` | `{limit:number}` | issue `terminalLimit` |
| `terminal/view`（客户端自产） | `{issue: 'missingTerminal'\|'inputFull'\|'attachmentEnded'\|'invalidOutput'\|'terminalLimit'}` | 对应 locale key |
| `session/not-found` | — | 关闭清理时视为成功 |
| `RemoteStreamCarrierError`（传输失败） | — | phase `disconnected`（不显示错误） |

Host 配置（`TerminalController.Config`，默认值）：`shell` 省略；`shellCandidates` `["zsh","bash","fish","pwsh","powershell","cmd"]`；`maxTerminals` 8；`maxCols` 500；`maxRows` 200；`scrollback` 1000；`maxBufferedBytes` 2097152；`maxInputBytes` 65536；`disposeGraceMs` 1000；`unattendedTimeoutMs` 7200000（0=不回收）；`activityPollIntervalMs` 30000；`cleanupRetryMs` 60000。

### A.3 客户端状态模型 & 持久化

**`TerminalViewState`**（每个侧栏 occurrence 一个 `TerminalView`，DOM 卸载不销毁）：
```ts
{
  phase: 'idle'|'loading'|'creating'|'connecting'|'connected'|'disconnected'|'closing'|'closed'|'failed'
  environment?: TerminalEnvironment
  title?: string
  info?: WebTerminalInfo
  writable: boolean          // = info.state==='running' && frame.writable
  render?: { revision: number; frame: snapshot|output }   // 待渲染帧（渲染完 acknowledge(revision)）
  error?: string
  issue?: 'missingTerminal'|'inputFull'|'attachmentEnded'|'invalidOutput'|'terminalLimit'
}
```
- 状态机：idle →(mount) loading →(新) creating → connecting → connected；传输断 → disconnected；流结束且已 exited → closed；其它异常 → failed。
- UI 派生：`status` 文案（loading/creating/connecting/disconnected/exited/unavailable/closed）；`ended = info.state==='exited' || phase==='closed'`；`retry = !ended && (phase==='failed'||'disconnected')`；`readOnly = phase==='connected' && state==='running' && !writable`。
- `ClientTerminals`（`ctx.webTerminals`）：`views: Map<sessionId, Map<tabKey, TerminalView>>`；`inventories: Map<sessionId, TerminalInventory>`（list 缓存，单飞，失败缓存直到显式 refresh/重连）；`holds: Map<sessionId, Map<id, TerminalWindowHold>>`（retain 流）；`closeFailures: SnapshotStore<{id,title,message}[]>`；`connection/reset` 时对已用过的 inventory 重新 list。
- 标签身份：`tabKey`（布局内 occurrence id）≠ `contentId`（全局唯一内容 id，用作持久化键）≠ `WebTerminalId`（Host id）。侧栏 tab params：`{terminalId}`（恢复已有）或 `{shellPath}`（新建时选定 shell）。

**localStorage key**：
| key | 值 | 说明 |
|---|---|---|
| `dsh.terminal.shell` | shell path 字符串 | 上次选择的 shell |
| `dsh.terminal.binding.v1.` + `JSON.stringify([sessionId, contentId])` | `JSON.stringify(WebTerminalId)` | 内容→Host 终端绑定，分配前写入 |
| `dsh.terminal.close.v1.<WebTerminalId>` | `{"sessionId","id","title"}` | 未完成的关闭清理请求，启动时重试 |

### A.4 Locale

命名空间 **`sidebarTerminal`**（`ctx.locale.register("sidebarTerminal", {zh,en})`）：

| key | zh | en |
|---|---|---|
| `shortcut.noSession` | 请先选择会话 | Select a session first |
| `recoveryFailed` | 恢复终端失败：{message} | Terminal recovery failed: {message} |
| `retryRecovery` | 重试恢复终端 | Retry terminal recovery |
| `shell` | 选择 Shell | Choose shell |
| `shellLoading` | 正在读取 Shell… | Loading shells… |
| `shellEmpty` | 没有可用的 Shell | No shells available |
| `description` | 在会话工作区运行命令 | Run commands in the Session workspace |
| `title` | 终端 | Terminal |
| `new` | 新建终端 | New terminal |
| `loading` | 正在读取终端环境… | Reading terminal environment… |
| `creating` | 正在启动… | Starting… |
| `connecting` | 正在连接… | Connecting… |
| `disconnected` | 连接已断开。 | Disconnected. |
| `reconnect` | 重新连接 | Reconnect |
| `readonly` | 此页面当前只读。 | This view is read-only. |
| `control` | 接管输入 | Take control |
| `closed` | 终端已关闭。 | Terminal closed. |
| `exited` | 进程已退出（{code}） | Process exited ({code}) |
| `failed` | 终端错误：{message} | Terminal error: {message} |
| `rename` | 终端名称 | Terminal name |
| `unavailable` | 不可用 | Unavailable |
| `retry` | 重试 | Retry |
| `cleanupFailed` | 终端「{title}」未能结束：{message} | Terminal “{title}” could not be ended: {message} |
| `missingTerminal` | 此终端已不存在，请新建终端。 | This terminal no longer exists. Open a new terminal. |
| `inputFull` | 输入缓冲区已满，请重新连接后重试。 | The input buffer is full. Reconnect and try again. |
| `attachmentEnded` | 终端连接已结束，请重新连接。 | The terminal connection ended. Reconnect to continue. |
| `invalidOutput` | 终端画面传输异常，请重新连接。 | The terminal screen could not be received. Reconnect to recover it. |
| `terminalLimit` | 终端数量已达上限，请关闭不用的终端后重试。已退出的终端也计入数量。 | The terminal limit has been reached. Close unused terminals and try again. Exited terminals also count toward the limit. |

（`recoveryFailed`/`retryRecovery`/`cleanupFailed` 当前 UI 未使用，属预留；建议 iOS 用 `cleanupFailed` 把 `closeFailures` 显示出来，并提供重试 = `retryClose`。）

插件 meta（`locale/*.json`）：api-terminal-controller zh `终端控制接口` / desc `向客户端提供会话终端的创建、输入、读取和恢复能力。`；en `api-terminal-controller`。

### A.5 SwiftUI 落地建议

**渲染方案取舍**
- **推荐 SwiftTerm**（原生 `TerminalView`/`iOSTerminalView`）：Host 下行是纯 ANSI 字符串（snapshot 为 serialize 输出，含 SGR/光标定位），SwiftTerm 能直接 `feed(text:)`；原生选择/复制、VoiceOver、软键盘 `inputAccessoryView`、硬件键盘、性能都更好。需要自己实现：`snapshot` 时 `terminal.resetToInitialState()` + `resize(cols,rows)` + `feed`；`TerminalViewDelegate.send(source:data:)` → UTF-8 字符串 → `write`；`sizeChanged(newCols,newRows)` → clamp → `resize`（仅可写时发送，只读时强制按 Host cols/rows）；OSC 颜色由 SwiftTerm 自己处理。风险：SerializeAddon 输出与 SwiftTerm 解析器的细微兼容（建议用真机回放快照测试），以及 xterm `minimumContrastRatio` 无对等功能（可忽略或自行调色）。
- **备选 WKWebView + xterm.js 6.0.0 + addon-fit 0.11.0**：与 Web 100% 一致（同版本、同序列化格式），可直接复用 `terminal-theme`/光标逻辑；但软键盘控制差（隐藏 textarea 聚焦、`inputAccessoryView` 难定制）、JS↔Swift 桥接每帧开销、选择/复制手势不原生。仅在 SwiftTerm 兼容性出问题时退回。
- 背压：每帧 feed 完再处理下一帧（SwiftTerm feed 是同步的，天然满足"渲染后 acknowledge"）。

**手机布局**
- iPhone：右侧栏 → 会话内底部 sheet 或全屏 push 页"终端"，顶部横向 tab 条（多终端，标题可长按重命名 → Alert 带 TextField，限 120），"+" 按钮 = 新建（长按/菜单选 shell，菜单打开时才调 `shells`）。iPad：保留右侧栏/分栏。
- 状态条放在终端上方：连接中/断开（重新连接）/只读（接管输入）/已退出（新建终端），错误行在下方。
- 软键盘附加键栏（`inputAccessoryView`）：`Esc`、`Tab`、`Ctrl`（粘滞修饰，下一个字母发 `\u0001`–`\u001A`）、`Alt/Meta`（前缀 `\u001B`）、方向键 ↑↓←→（`\u001B[A/B/C/D`，注意 DECCKM 应用模式时 SwiftTerm 会自动用 `\u001BOA`）、`|`、`/`、`~`、`-`、`Home/End/PgUp/PgDn`、粘贴按钮、隐藏键盘。关闭自动纠错/大写/智能引号。
- iPad 硬件键盘：SwiftTerm 已处理；需额外用 `UIKeyCommand` 注册 `Ctrl+\``（= `terminal.new`），并保证 Cmd+C/Cmd+V 走复制粘贴而非发给 PTY。
- 复制粘贴：长按选择（SwiftTerm 原生），菜单"复制/粘贴"；粘贴大段文本注意 `maxInputBytes` 64KiB → 需要分块发送并等 ack（Web 是直接报 `inputFull` 断开，iOS 可做得更好：按 64KiB 切片串行）。
- 字体：设置中终端字体/字号映射到 SwiftTerm `font`；主题色从 App 主题取 background/foreground。
- 生命周期：App 进后台时 attach/retain 流会断，回前台按 A10 重连（retain → attach，新快照）；关闭标签必须先持久化 close 请求（UserDefaults 等价 key）再后台 `close`，启动时重放。

---

## B. 自动化 / 定时任务（schedule）

### B.0 总体结论（重要）

- **Web UI 没有"创建任务"表单，也没有暂停/恢复/立即运行。** 任务只能由 Agent 调用 `schedule_create` 工具创建；页面"新建"按钮 = `ctx.uiWorkspace.startSession()`（开一个新会话，用户在对话里让模型建）。
- UI 能做的：浏览（全局页 + 右栏任务页签 + 会话头弹层 + 会话行标记/悬停）、搜索/状态筛选、编辑**名称/指令/运行时间**（仅 active）、查看运行（投递）记录、删除（硬删除）、打开原会话。
- 状态只有 `active` / `inactive`（一次性任务投递后变 inactive，仍保留可查看，zh 文案「已结束」）。没有 enabled 开关、没有模型/权限/工作区字段——任务绑定在创建它的会话上，到点向该会话收件箱投递一条消息。
- 服务端事件 `schedule/changed`（`ctx.remote.$on`）+ `connection/reset` → 所有目录源重新拉取。

### B.1 功能清单

#### B.1.1 全局「自动化任务」页（slot `main` key `schedules`；侧栏入口 slot `sidebar.panellist` id `schedules` order 10，label `panel`，图标 `IconClockOutlineRegular`）

| # | 功能 | 交互细节 | 限制 | RPC |
|---|---|---|---|---|
| B1 | 页头 | `h1` `title`「自动化任务」+ 主按钮 `new.action`「新建」（+ 图标）→ 新建会话；窄时按钮换行 | 不选择/激活会话 | — |
| B2 | 状态筛选 | 一行分段按钮（aria `statusFilter.label`）：`all`「全部」/`active` → `status.active`「已开启」/`inactive` → `status.inactive`「已结束」，默认 all | 本地状态 | — |
| B3 | 搜索 | 搜索框（`search.label` / placeholder `search.placeholder`），非空时显示清除按钮 `search.clear`。匹配（小写 includes）**title、prompt、sessionId**；不匹配会话标题 | 本地 | — |
| B4 | 列表 | 过滤后按 `scheduledAt` 升序。每行（按钮）：标题；元数据行：inactive 时先显示 `status.inactive`，然后频率文本（`formatScheduleFrequency`，时区=系统时区时省略时区），active 时再显示 `list.nextPrefix`「下次计划时间：」+ 绝对时间 + 相对时间`(…)`（每 30s 刷新）。**不显示原会话名称** | | `schedule/catalog` |
| B5 | 加载/错误 | 首次加载无数据：居中 `StateDot(ongoing)`（aria `list.loading`）。错误：有数据 → 顶部 notice `list.error` + `list.retry`；无数据 → 警告图标 + `list.error` + 重试按钮 | 错误不显示为空 | `catalog` 重试 |
| B6 | 空状态 | 时钟图标 + 标题：筛选=inactive 且无搜索 → `list.emptyInactive`；目录本身空 → `list.empty`；否则 `list.noMatches`；下方按钮 `empty.action`「新建自动化任务」（=新建会话） | | |
| B7 | 选中 → 详情 | 点击行 → 打开第二层详情（同页右侧/覆盖），默认 `rule` 页签；Esc 关闭（确认弹窗打开时不关）；关闭后焦点回到原行 | 任务从目录消失且无草稿/保存中 → 自动关闭 | |

#### B.1.2 任务详情 `TaskDetail`（全局页与右栏任务页签共用）

| # | 功能 | 交互细节 | 限制 | RPC |
|---|---|---|---|---|
| B8 | 页签条 | tablist（aria `detail.tabs`）：`rule`「规则」/ `records`「任务运行记录」；←/→ 互切，Home/End 首/尾；带修饰键不拦截 | | |
| B9 | 关联会话入口 | 仅 rule 页签、且不在该任务自己会话的右栏中时显示：按钮文字 `detail.session`「关联会话」+ 会话标题（无标题回退 sessionId）+ `>`；放不下时收为图标按钮（`ReferenceIconRegular` 会话图标，tooltip `detail.session`）。aria：`detail.openSessionTitle`(title) 或 `detail.openSession`。可用性 `sessionLinkState`：workspaces.state==='error' → unavailable；sessions/workspaces phase pending → loading；归档 → archived；不在 sessions.ids → unavailable；否则 available。不可用时禁用 + 下方 status 文案 `detail.sessionLoading`/`detail.sessionArchived`/`detail.sessionUnavailable`。点击时再检查一次后 `uiWorkspace.openSession(id)` | 唯一会激活会话的操作；不取消归档 | — |
| B10 | 更多操作菜单 | `…` 按钮（aria/title `detail.more`）→ 菜单项 `delete.action`「删除任务」（danger，删除中显示 `delete.pending`）；禁用条件：删除中/目录加载中/任务已不在目录 | | |
| B11 | 关闭按钮 | 仅全局页有（aria `detail.close`） | 右栏页签无 | |
| B12 | 名称 | active：input（aria `detail.name`）编辑草稿；inactive：`h2` 只读 | trim 后 1–120 字符，否则 `rule.invalidTitle` | update.title |
| B13 | 下次运行 | active：`detail.nextRun`「下次运行」+ 绝对时间 + `(相对)`；inactive：`status.inactive` | | |
| B14 | 指令 | active：textarea（aria `detail.instruction`）；inactive：只读段落 | trim 后非空，否则 `rule.invalidPrompt` | update.prompt |
| B15 | 运行时间卡片（RuleCard） | 标题 `rule.title`「运行时间」；行：**重复**（菜单，见 B16）/ **星期**（weekly 时，7 个 Pill 周一…周日，至少保留 1 个）/ **重复间隔**（every 时）/ **日期**（once 时）/ **时间**（非 cron、非 every）/ **Cron 行组**（cron 时，见 B19）/ **时区**（非 every）。卡片下方提示行：every → 间隔提示（`timing.intervalHint.<unit>`）或错误；cron → 错误 / `rule.cronInvalid` / cron 中文描述句；once 且记录无存储时区 → `timing.zoneNoStored`；其它 → 错误 | 保存中/删除中/目录加载中/inactive 时整卡禁用（inactive 只读） | — |
| B16 | 「重复」菜单 | 选项顺序：`weekly`「每周」/`weekdays`「周一至周五」/`daily`「每天」/`every-hour`「每 N 小时」/`every-minute`「每 N 分钟」/`every-second`「每 N 秒」/`once`「仅一次」/`cron`「自定义」。显示值：every 时为对应单位标签；与存储种类相同（且非 cron）时显示存储规则的本地化频率；否则显示选项标签。存储 weekly 且星期集合恰为 1–5 → 选中 `weekdays` | 接受任意切换，包括改变种类（Host 按新规则重算目标） | — |
| B17 | 切换种类的种子值 | 时区种子：记录有 timeZone 用它，否则设备时区（`Intl…resolvedOptions().timeZone`，兜底 `UTC`）。once：已提交目标在该时区的日期 + 时间；every：3600 秒（显式选单位时也是 3600）；daily/weekdays/weekly：目标时刻在该时区的钟表时间；在三者之间切换时保留当前显示的时间与时区；weekly 星期：沿用之前的集合 / 记忆 / 存储集合 / 目标日在该时区的星期；weekdays 固定 `[1,2,3,4,5]`；cron：`"<分> <时> * * *"`（目标时刻钟表值的每天表达式）。切回存储种类 → 恢复存储草稿 | | |
| B18 | 间隔编辑 | 数字输入（单位 = 小时/分钟/秒，显示 `timing.unit.*`）+ ▲▼ 步进；最小值 = `ceil(60/单位秒)`（时 1、分 1、秒 60）；▼ 在最小值时禁用；存储时换算为秒（`Math.round(值*单位)`）。初始单位：秒数能整除 3600 → hour，整除 60 → minute，否则 second | ≥60 整秒，否则 `timing.invalidInterval.<unit>` | change `{kind:"every",every_seconds}` |
| B19 | Cron 编辑（自定义） | 子菜单「频率」`cronForm.frequency`：`monthly`「每月」/`weekly`「每周」/`daily`「每天」/`hourly`（标签复用 `rule.everyHours`）/`minutely`（`rule.everyMinutes`）/`raw`（`rule.cronLabel`「Cron 表达式」）。识别到形状时显示结构化行：monthly → 「在以下日期」31 个日 Pill（`cronForm.dateOption`，至少 1 个）+ 时间（时:分，无秒）；weekly → 星期 Pill + 时间；daily → 时间；hourly → 「重复间隔」步进 1–23 小时 + 「在第几分钟」步进 0–59；minutely → 「重复间隔」步进 1–59 分钟（切入默认 5）。无法识别或选 raw → 单行文本框（spellcheck off，`aria-invalid`）。每次编辑都重写表达式；下方实时显示本地化描述句（`cronPreview`），解析失败显示 `rule.cronInvalid` 并阻止保存 | 方言见 B.2.4；形状要求月份 `*`，且两个"日"字段至多一个受限 | change `{kind:"cron",cron:{expression,time_zone}}` |
| B20 | 日期选择 | 只读触发器显示 `YYYY/MM/DD`；弹出月历：本地化星期表头（**周一为首**）、上/下月（`timing.prevMonth`/`timing.nextMonth`）、今天标记（`aria-current=date`）；方向键移动、Enter 选、Esc 关 | 必须是真实 ISO 日期 | `at.date` |
| B21 | 时间选择 | 只读触发器显示 24 小时 `HH:mm:ss`；弹出三列滚动列表 时(00–23)/分(00–59)/秒(00–59)（cron 内无秒列），打开时滚到当前值；方向键/Enter/Esc | 正则 `^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$`；未改动保留存储的毫秒；选取后按整秒 | `time` |
| B22 | 时区菜单 | 可搜索、限高菜单；顶部（无标题）为最近使用的 ≤5 个时区（localStorage），分隔线后为全部：系统时区第一（带 `rule.zone.system`「（系统）」后缀），其余按当前 UTC 偏移、再按 IANA id 排序；显示 `UTC±HH:MM · <longGeneric 本地化名称>`；相同标签的多个 zone 合并一行（全部可搜索；已存储 id 保持选中不改写）。搜索框 placeholder `timing.zoneSearch`；无结果 `timing.zoneNoResults`。清单来自 `Intl.supportedValuesOf('timeZone')`，失败退回 `["UTC"]` | once 改时区 = 保留钟表值、改变时点 | `time_zone` |
| B23 | 保存栏 | 仅当草稿 ≠ 存储值（title/prompt trim 后比较 + 时间字段）且 active 时出现：`rule.unsaved`「有未保存的修改」+ `rule.cancel`「取消」（恢复存储值）+ 主按钮 `rule.save`「保存修改」/保存中 `rule.saving`「保存中…」 | 先本地校验 `draftError` | `schedule/update` |
| B24 | 保存请求 | `{sessionId, id, expected: timingSnapshot(task), title?(变了才带), prompt?(变了才带), change?(时间字段变了才带)}`；成功 → 用返回 record 作为新存储值，并刷新目录；错误码 → 本地化提示，保留草稿 | 冲突需刷新后重试 | `schedule/update` → `schedule/catalog` |
| B25 | 目录刷新与草稿合并 | 目录刷新时：无未保存修改 → 直接显示新值；有草稿 → `mergeRuleDraft`（用户改过的字段保留草稿，未改字段取新值；种类不同则整体保留草稿；名称/指令逐字段合并） | | |
| B26 | 删除确认 | Modal：`delete.title`「删除此任务？」/ `delete.description` / 正文显示任务标题 / 按钮 `delete.cancel`、`delete.confirm`（busy 时禁用）/ 关闭 aria `delete.close`。确认后关闭弹窗与详情（右栏页签则关闭该页签），结果走全局 toast | 硬删除：任务行 + 投递历史一并删除；不撤回已排队消息；原会话保留 | `schedule/delete` |
| B27 | 删除结果 toast | slot `shell.overlay` id `schedule.delete-toast`：成功 `toast.deleted`（tone success），失败 `toast.deleteFailed`（警告图标）；每次带递增 seq，新的一条重新开始横幅 | 生命周期长于发起面板 | — |
| B28 | 运行记录页签 | 打开时请求最新 20 条；每条：时钟图标 + 发生时间（任务时区的 `月 日 时:分`，跨年才带年；一次性任务用浏览器时区）+ 保存的 prompt（>2 行折叠，`delivery.expand`/`delivery.collapse`，宽度变化重测）；无 prompt 的旧记录不以当前指令代替。`nextBefore` 存在时 `delivery.loadMore`「加载更多」（按 messageId 去重追加）。`task.lastDelivery.messageId` 变化时重新拉最新页 | | `schedule/history` |
| B29 | 记录空/错 | 加载中（无记录）：StateDot；空：时钟图标 + `delivery.empty`；失败：有记录 → notice + `delivery.retry`；无记录 → 警告图标 + 文案 + 按钮；`schedule_not_found` → `delivery.notFound`；`delivery_cursor_not_found` → `delivery.cursorError` + `delivery.refresh`（重拉最新页） | | |
| B30 | 清理提示 | 最后一页加载完 && 有记录 && `earlierRecordsPruned` && 无错误 → 左下 footer：`delivery.pruned` + ⓘ 按钮（tooltip/aria `delivery.retention`）展开 `delivery.retentionBounds`(days, records) + `delivery.retentionExplanation` | | |

#### B.1.3 会话关联面

| # | 位置 / slot | 功能 | 数据源 |
|---|---|---|---|
| B31 | `conversation.session.header.utilities` id `schedule-catalog` order -5（紧邻"更多"左侧） | 仅会话 `openState==='open'` 时；首次读取前、或读取完成且 0 个活动任务时**不渲染**；读取失败保留按钮。仅图标时钟按钮（16px），aria：有数据 `trigger.one`/`trigger.other`(count)，否则 `trigger.label`。恰好 1 个且 ready → 直接打开该任务右栏页签；否则弹层（portal、目标宽 336px、16px 视口边距、≤ 视口宽-32）：loading 行 `list.loading`、错误行 `list.error`+`list.retry`、任务行（逾期在前，再按目标时间升序）：标题按钮（aria `list.open`）→ 打开右栏详情；频率；`list.nextRun` + 绝对时间 + 相对时间（弹层打开时每 1s 刷新；逾期行高亮）；删除按钮（垃圾桶，aria `delete.label`，title `delete.action`/`delete.pending`，删除中禁用，**无确认**，结果走 toast）。Esc 关闭并聚焦按钮；点外部关闭 | **每会话独立** `schedule/list({sessionId})`（仅 active） |
| B32 | 右侧栏页签类型 kind `scheduleTask`，id `@deepseek-ai/dsh-client-ui-schedule/task`（`sidebar.right.pane.tab` + `.title`） | 打开：`sidebarRight.openTab("scheduleTask", {params:{sessionId,id}})`。chip：时钟图标 16 + 任务标题（找不到时 `detail.label`「任务详情」）。正文 = `TaskDetail`（无关闭按钮；`withinSession`=当前会话，若任务属于本会话则隐藏关联会话入口）。刷新后无 params → 读 localStorage 绑定；本页签出现后的一次成功读取仍找不到 → 显示时钟图标 + `detail.missing`「任务已不可用，可能已被删除」，并删除绑定；删除确认后关闭页签 | 全局 `schedule/catalog` |
| B33 | `conversation.chat.turnTail` id `schedule-created` order 20 | 本轮内每个成功的 `schedule_create` 工具结果渲染一张卡片（在轮末 assistant 文本之后，工具组折叠也可见）：时钟图标 18 + 标题 + 频率 + 描边按钮 `card.open`「打开」（整卡也可点，aria `card.openLabel`）→ 打开右栏任务页签。挂载时触发一次目录读取，之后用目录中的当前记录显示名称/频率；目录里没有 → 频率位显示 `card.deleted`「已删除」且不可打开。结果非完整任务（运行中/失败）→ 只显示标题（参数里的 title 或 prompt 首行或工具名）+ 若结果为单个文本块则 `<pre>` 原文 | 解析 `tool/result` 的 JSON（`narrowScheduleRecord`）+ `schedule/catalog` |
| B34 | `sidebar.session.row.leading` id `schedule-mark` order 10 | 会话行空闲、未归档、且该会话有 ≥1 活动任务时，在 16px 前导格显示时钟 14px（visually hidden 文本 `mark.aria`(count)）；点击不冒泡。行处于更高优先级状态（待处理交互/进行中/未读完成）时该格属状态点，不渲染 | 全局 `schedule/catalog` 过滤 `sessionId && status==='active'`；未 settled 视为无 |
| B35 | `sidebar.session.row.hover` id `schedule-tasks` order 10 | 行悬停卡片中追加区段：最多 2 个任务（逾期在前），每条：时钟 12px + 标题 + `频率 · 绝对时间 (相对)`（打开时取一次 now 不刷新）；多余 → `hover.more`(count) | 同上 |

### B.2 RPC 方法表（namespace `schedule`）

| 方法 | 参数 | 返回 `value` | 何时调用 |
|---|---|---|---|
| `schedule/catalog` | `()` | `ScheduleCatalogEntry[]`（所有会话 active+inactive，按 `scheduledAt` 升序、再按 id） | 全局页、右栏页签、turn 卡片、会话行标记/悬停（共享一个源）；`schedule/changed`、`connection/reset`、删除/更新成功后刷新 |
| `schedule/list` | `(request: {sessionId})` | `ScheduleRecord[]`（该会话仅 active，无 sessionId/status 字段） | 会话头时钟弹层 |
| `schedule/update` | `(request: ScheduleUpdateRequest)` | `ScheduleUpdateResult` | 详情"保存修改" |
| `schedule/delete` | `(request: {sessionId, id})` | `ScheduleDeleteResult` | 删除确认 / 会话头弹层删除 |
| `schedule/history` | `(request: {sessionId, id, limit, before?})` | `ScheduleDeliveryHistoryResult` | 运行记录页签（limit 固定 20） |
| 事件 `schedule/changed` | `()` | — | 任务集合变化（含每次投递后）→ 重新拉目录 |

> 没有 create RPC（只有 Agent 工具 `schedule_create`）。

#### B.2.1 记录类型（原样展开）

```ts
type ScheduleId = string   // Host 新建为 "schedule-<uuid v4>"；历史数据可能为 "schedule-N"
type SessionId = string
type MessageId = string

// 6 种规则，公共字段 id/kind/title/prompt/scheduledAt
type ScheduleRecord =
  | { id; kind: 'after';  title: string; prompt: string; afterSeconds: number; scheduledAt: string }
  | { id; kind: 'at';     title: string; prompt: string; scheduledAt: string }
  | { id; kind: 'every';  title: string; prompt: string; everySeconds: number; scheduledAt: string }   // everySeconds ≥ 60
  | { id; kind: 'daily';  title: string; prompt: string; time: string; timeZone: string; scheduledAt: string }      // time = "HH:mm:ss.SSS"
  | { id; kind: 'weekly'; title: string; prompt: string; time: string; timeZone: string; weekdays: number[]; scheduledAt: string } // weekdays 唯一升序 1(一)…7(日)
  | { id; kind: 'cron';   title: string; prompt: string; expression: string; timeZone: string; scheduledAt: string }  // 规范化 5 字段
// title: 已 trim、非空、≤120；prompt: 已 trim、非空
// scheduledAt: 四位年 RFC3339 UTC（如 "2026-11-04T01:00:00.000Z"）；active 时=下一次目标，inactive 时=最后一次发生

type ScheduleCatalogEntry = ScheduleRecord & {
  sessionId: SessionId
  status: 'active' | 'inactive'
  lastDelivery?: ScheduleDeliveryReceipt
}

interface ScheduleDeliveryReceipt { scheduledAt: string; deliveredAt: string; messageId: MessageId }
interface ScheduleDeliveryRecord extends ScheduleDeliveryReceipt { prompt?: string }  // 旧回执无 prompt
```

#### B.2.2 update

```ts
interface ScheduleUpdateRequest {
  sessionId: SessionId
  id: ScheduleId
  expected: ScheduleRecord          // 编辑开始时观察到的完整记录（不含 sessionId/status/lastDelivery）——compare-and-set
  title?: string                    // 省略=保留；trim 后 1..120
  prompt?: string                   // 省略=保留；trim 后非空
  change?: ScheduleTimingChange     // 省略=保留规则与已提交目标
}

type ScheduleTimingChange =
  | { kind: 'at';     at: AtInput }
  | { kind: 'every';  every_seconds: number }
  | { kind: 'daily';  daily:  { time: string; time_zone: string } }
  | { kind: 'weekly'; weekly: { time: string; time_zone: string; weekdays: number[] } }
  | { kind: 'cron';   cron:   { expression: string; time_zone: string } }
// 注意 change 内字段是 snake_case：every_seconds / time_zone
// 不支持改回 'after'（一次性统一用绝对 at）

type AtInput = string /* RFC3339 带偏移 */ | { date: string /* YYYY-MM-DD */; time: string /* HH:mm[:ss[.SSS]] */; time_zone: string }

type ScheduleUpdateResult =
  | { id; updated: boolean; record: ScheduleRecord }           // updated=false 表示等价规则未写入
  | { id; updated: false; code: 'schedule_not_found' | 'schedule_ended' | 'schedule_conflict' }
  | { code: 'invalid_prompt'|'invalid_selector'|'invalid_rule'|'invalid_time_zone'|'not_future'|'time_out_of_range'|'frequency_too_high'|'subagent_session'|'internal_error'; message: string }
```
Web 端实际发出的 change（`ruleChange`）：
- once → `{kind:"at", at:{date, time: "HH:mm"→补":00", time_zone}}`
- every → `{kind:"every", every_seconds: Number(seconds)}`
- daily → `{kind:"daily", daily:{time, time_zone}}`
- weekdays/weekly → `{kind:"weekly", weekly:{time, time_zone, weekdays}}`（weekdays 选项固定 `[1,2,3,4,5]`）
- cron → `{kind:"cron", cron:{expression: trim, time_zone: trim}}`

错误码 → locale（`timingError` + 卡片覆盖 `RULE_ERROR_OVERRIDES`）：
| code | key |
|---|---|
| `schedule_conflict` | `timing.conflict` → 卡片内显示 `rule.error.conflict` |
| `schedule_ended` | `timing.inactive` |
| `schedule_not_found` | `timing.notFound` → `rule.error.notFound` |
| `subagent_session` | `timing.subagentSession` |
| `invalid_time_zone` | `timing.invalidZone` |
| `not_future` | `timing.notFuture` |
| `frequency_too_high` | `timing.invalidInterval`（显示为 `timing.invalidInterval.<当前单位>`） |
| `invalid_prompt` / `invalid_selector` / `invalid_rule` / `time_out_of_range` | `timing.invalid` |
| `internal_error` | `timing.error` → `rule.error.unknown` |
| RPC 失败 / 异常 | `rule.error.unknown` |

本地校验 `draftError`（顺序）：title trim 长度 0 或 >120 → `rule.invalidTitle`；prompt trim 空 → `rule.invalidPrompt`；every：`/^\d+$/` 且 ≥60 否则 `timing.invalidInterval`；cron：`parseCronExpression` 失败 → `rule.cronInvalid`；once 日期非真实 ISO 日期，或（任何种类）time 不匹配 `^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$` → `timing.invalid`（注意源码运算符优先级：非 once 种类也检查 time，every/cron 已提前 return）。

#### B.2.3 delete / history

```ts
interface ScheduleDeleteRequest { sessionId: SessionId; id: ScheduleId }
type ScheduleDeleteResult =
  | { id; deleted: true }
  | { id; deleted: false; code: 'schedule_not_found' }
// 客户端：RemoteResult.ok 即视为 "deleted"（包括 deleted:false）；异常/ok:false → "failed"

interface ScheduleDeliveryHistoryRequest { sessionId; id; limit: number /* 1..100 整数，否则 invalid_rule 抛错 */; before?: MessageId }
type ScheduleDeliveryHistoryResult =
  | { id; records: ScheduleDeliveryRecord[] /* 新→旧，按追加顺序 */; earlierRecordsUnavailable: boolean; earlierRecordsPruned: boolean;
      retention: { days: number; records: number }; nextBefore?: MessageId }
  | { id; code: 'schedule_not_found' | 'delivery_cursor_not_found' }
```
Host 配置：`deliveryHistoryDays` 默认 30（1–3650）、`deliveryHistoryRecords` 默认 200（1–10000）。

#### B.2.4 Cron 方言（客户端 `parseCronExpression` 与 Host 一致）

- 恰好 5 个空白分隔字段，整体不可有首尾空白：minute 0–59、hour 0–23、day-of-month 1–31、month 1–12、day-of-week 0–7（0/7=周日）。
- 元素：`*`、`*/n`(n≥1)、`a`、`a-b`(a≤b)、`a-b/n`；逗号列表。**不支持** `L W # ? JAN MON @daily`、6 字段、`a/n`（无范围的步长）。
- 两个日字段：任一以 `*` 开头 → 两者都需匹配（AND）；都不以 `*` 开头 → 任一匹配（OR，Vixie）。
- Host 存储规范化表达式（合并、步长重写、周日写 0）。
- 结构化形状识别 `recognizeCronShape` → `minutely{step}`/`hourly{step,minute}`/`daily{hour,minute}`/`weekly{weekdays,hour,minute}`/`monthly{days,hour,minute}`；生成：`* * * * *`、`*/s * * * *`、`m * * * *`、`m */s * * *`、`m h * * *`、`m h * * <dow>`、`m h <dom> * *`（连续 ≥3 合成 `a-b`）。

#### B.2.5 频率/时间格式化规则（iOS 需复刻）

- `formatScheduleFrequency`：after/at → `frequency.once`；every → 选能整除的最大单位 day/hour/minute/second → `frequency.every`({value},{unit}=`unit.<u>.one|other`)；daily → `frequency.daily`/`frequency.dailyLocal`（时区 = 系统时区时用 Local 版）；weekly 同理（星期用 `frequency.weekday.N` 以 `frequency.weekday.join` 连接）；cron → 可解析时 `cronPreview` 句子（+ `frequency.cronRule` 带时区），否则 `frequency.cron`/`frequency.cronLocal`。时钟文本 `clockLabel`：去掉小数秒，再去掉 `:00` 秒。会话头弹层与卡片调用时不传 zone → 总是带时区标签。
- 时区标签 `zoneLabel`：`UTC±HH:MM · <Intl longGeneric 名称>`（名称形如 GMT±… 时只显示偏移）。
- 绝对时间 `formatScheduleAbsolute`：locale `time.locale`；en 带年，zh 不带年；`month:"short", day, hour:"2-digit", minute:"2-digit", hourCycle:"h23"`，**设备时区**。
- 相对时间 `formatScheduleRelative`：差 0 → `relative.now`；否则选最大的 ≥1 单位（天/时/分/秒），未来向上取整、逾期向下取整，最小 1 → `relative.future`/`relative.overdue`；外面包 `(…)`。
- 运行记录时间 `formatScheduleNextRun`：`month:"short", day, hour:"numeric", minute:"2-digit"`，当年省略年份，时区 = 任务时区（daily/weekly/cron），否则设备时区。
- 排序 `orderScheduleRecords`（弹层、悬停）：逾期（≤now）在前，各自按时间升序。全局页列表：按 `scheduledAt` 升序。

### B.3 客户端状态模型 & 持久化

**目录源 `createCatalogSource`**（全局一个 manager；会话头每个会话一个）快照：
```ts
{ records: Entry[]; status: 'loading'|'ready'|'error'; deleting: ScheduleId[]; settled: boolean /* 曾成功过 */;
  readRequest: number /* 最新请求序号 */; readSettled: number /* 产生当前 records 的请求序号 */ }
```
- 首个订阅者出现时订阅 `schedule/changed` + `connection/reset` 并立即拉取；最后一个退订时释放并作废在途响应。
- `onRetry(since)`：同一微任务内合并请求；`readSettled > 锚点` 用于"挂载之后的一次读取"判定（turn 卡片、右栏页签 missing 判定）。
- 刷新期间 status=loading 但保留旧 records（行标记不闪烁）。
- 删除：`deleting` 中加入 id → RPC → 移除 → ok 则强制刷新。

**详情本地状态**：`tab: 'rule'|'records'`、`confirmId`、`edit {propKey, stored: RuleValues, shown: RuleValues}`、`intervalUnit: 'hour'|'minute'|'second'`、`pending`、`failure`、`deletionConfirmed`；`RuleValues = {title, prompt, kind: 'once'|'every'|'daily'|'weekdays'|'weekly'|'cron', draft:{date,time,timeZone,seconds,expression}, weekdays:number[]}`。保存中/失败/删除确认期间，即便目录里该行消失，详情仍保留显示（`onEditState`）。
**运行记录**：`page`、`loading`、`failure{key,before}`、`retentionOpen`；epoch 防止过期响应。

**localStorage key**：
| key | 值 | 说明 |
|---|---|---|
| `dsh.schedule.recent-time-zones.v1` | `string[]`（≤5，最新在前） | 最近选择时区；首次默认 `[系统时区, "UTC"]` |
| `dsh.schedule.task-tab.v1.<sessionId>` | `{ [tabId]: {kind, contentId, sessionId, id} }` | 右栏任务页签 → 任务绑定（刷新恢复用，只保留仍存在的 tab） |

### B.4 Locale

#### 共享频率片段 `frequencyZh` / `frequencyEn`（同时并入下列两个命名空间）

| key | zh | en |
|---|---|---|
| `time.locale` | zh-CN | en |
| `time.utcPrefix` | UTC | UTC |
| `frequency.daily` | 每天 {time}（{timeZone}） | Daily at {time} ({timeZone}) |
| `frequency.dailyLocal` | 每天 {time} | Daily at {time} |
| `frequency.weekly` | 每周{weekdays} {time}（{timeZone}） | Weekly on {weekdays} at {time} ({timeZone}) |
| `frequency.weeklyLocal` | 每周{weekdays} {time} | Weekly on {weekdays} at {time} |
| `frequency.cron` | Cron {expression}（{timeZone}） | Cron {expression} ({timeZone}) |
| `frequency.cronLocal` | Cron {expression} | Cron {expression} |
| `frequency.cronRule` | {rule}（{timeZone}） | {rule} ({timeZone}) |
| `cron.list.join` | 、 | `, ` |
| `cron.part.join` | （一个空格） | （一个空格） |
| `cron.weekday.name` | 周{weekday} | {weekday} |
| `cron.weekday.range` | {from}至{to} | {from}–{to} |
| `cron.months` | （{months}） | ` in {months}` |
| `cron.day.every` | 每天{months} | Every day{months} |
| `cron.day.weekdays` | {weekdays}{months} | {weekdays}{months} |
| `cron.day.monthDays` | 每月 {days} 日{months} | Day {days} of every month{months} |
| `cron.day.both` | 每月 {days} 日或{weekdays}{months} | Day {days} of every month or {weekdays}{months} |
| `cron.day.bothStarred` | 每月 {days} 日且{weekdays}{months} | Day {days} of every month and {weekdays}{months} |
| `cron.hours.range` | {from} 至 {to} | {from}–{to} |
| `cron.hours.list` | {hours} | {hours} |
| `cron.time.everyMinute` | 每分钟 | Every minute |
| `cron.time.everyMinutes` | 每 {step} 分钟 | Every {step} minutes |
| `cron.time.joinedEveryMinute` | 每分钟 | every minute |
| `cron.time.joinedEveryMinutes` | 每 {step} 分钟 | every {step} minutes |
| `cron.time.everyHour` | 每小时 | Every hour |
| `cron.time.joinedEveryHour` | 每小时 | every hour |
| `cron.time.everyNHours` | 每 {count} 小时 | Every {count} hours |
| `cron.time.joinedEveryNHours` | 每 {count} 小时 | every {count} hours |
| `cron.time.hourlyAt` | 每小时的第 {minutes} 分钟 | Every hour at minute {minutes} |
| `cron.time.joinedHourlyAt` | 每小时的第 {minutes} 分钟 | every hour at minute {minutes} |
| `cron.time.hoursEveryMinute` | {hours} 点的每分钟 | every minute during hours {hours} |
| `cron.time.hoursEveryMinutes` | {hours} 点内每 {step} 分钟 | every {step} minutes during hours {hours} |
| `cron.time.at` | {times} | at {times} |
| `cron.time.hoursAt` | {hours} 点的第 {minutes} 分钟 | at minute {minutes} of hours {hours} |
| `frequency.weekday.join` | 、 | `, ` |
| `frequency.weekday.1` … `.7` | 一 二 三 四 五 六 日 | Mon Tue Wed Thu Fri Sat Sun |
| `unit.day.one` / `unit.day.other` | 天 / 天 | day / days |
| `unit.hour.one` / `.other` | 小时 / 小时 | hour / hours |
| `unit.minute.one` / `.other` | 分钟 / 分钟 | minute / minutes |
| `unit.second.one` / `.other` | 秒 / 秒 | second / seconds |
| `relative.now` | 现在到期 | Due now |
| `relative.future` | {value}{unit}后 | in {value} {unit} |
| `relative.overdue` | 已逾期 {value}{unit} | {value} {unit} overdue |

#### 命名空间 `schedule.catalog`（会话头弹层、行标记、悬停卡片）= 下表 + 共享片段

| key | zh | en |
|---|---|---|
| `trigger.label` | 提醒 | Reminders |
| `list.loading` | 正在加载提醒… | Loading reminders… |
| `list.error` | 无法加载提醒。 | Could not load reminders. |
| `list.retry` | 重试 | Retry |
| `delete.action` | 删除 | Delete |
| `delete.pending` | 正在删除… | Deleting… |
| `delete.label` | 删除提醒：{title} | Delete reminder: {title} |
| `list.open` | 打开提醒详情：{title} | Open reminder details: {title} |
| `trigger.one` | {count} 个提醒 | {count} reminder |
| `trigger.other` | {count} 个提醒 | {count} reminders |
| `list.aria` | 活动提醒 | Active reminders |
| `list.nextRun` | 下次运行 | Next run |
| `frequency.once` | 单次 | Once |
| `frequency.every` | {value}{unit}一次 | Every {value} {unit} |
| `mark.aria` | {count} 个自动化任务 | {count} scheduled tasks |
| `hover.more` | 另有 {count} 个任务 | {count} more |

#### 命名空间 `schedule.manager`（全局页、详情、右栏页签、turn 卡片、toast）= 下表 + 共享片段

| key | zh | en |
|---|---|---|
| `panel` | 自动化任务 | Automation tasks |
| `title` | 自动化任务 | Automation tasks |
| `new.action` | 新建 | New |
| `list.label` | 任务列表 | Task catalog |
| `list.nextPrefix` | 下次计划时间： | Next scheduled time: |
| `list.loading` | 正在加载任务… | Loading tasks… |
| `list.error` | 无法加载任务 | Could not load tasks. |
| `list.retry` | 重试 | Retry |
| `list.empty` | 还没有自动化任务，在会话中创建的任务会显示在这里 | No tasks yet. Tasks created in your sessions appear here. |
| `list.emptyInactive` | 没有已结束的自动化任务 | No inactive automation tasks |
| `list.noMatches` | 没有匹配的自动化任务 | No matching tasks |
| `search.label` | 搜索任务 | Search tasks |
| `search.placeholder` | 搜索自动化任务 | Search automation tasks |
| `search.clear` | 清空搜索 | Clear search |
| `empty.action` | 新建自动化任务 | New automation task |
| `statusFilter.label` | 任务状态 | Task status |
| `statusFilter.all` | 全部 | All |
| `status.active` | 已开启 | Enabled |
| `status.inactive` | 已结束 | Inactive |
| `detail.label` | 任务详情 | Task details |
| `detail.close` | 关闭详情 | Close details |
| `detail.more` | 自动化任务操作 | Automation task actions |
| `detail.nextRun` | 下次运行 | Next run |
| `detail.tabs` | 任务详情视图 | Task detail views |
| `detail.rule` | 规则 | Rules |
| `detail.records` | 任务运行记录 | Records |
| `delivery.empty` | 暂无任务运行记录 | No delivery record available |
| `delivery.loading` | 正在加载任务运行记录… | Loading delivery records… |
| `delivery.error` | 无法加载任务运行记录 | Could not load delivery records. |
| `delivery.notFound` | 任务已不可用 | This task is no longer available. |
| `delivery.cursorError` | 记录已更新 | Records were updated. |
| `delivery.retry` | 重试 | Retry |
| `delivery.refresh` | 刷新 | Refresh |
| `delivery.loadMore` | 加载更多 | Load more |
| `delivery.expand` | 展开 | Expand |
| `delivery.collapse` | 收起 | Collapse |
| `delivery.pruned` | 更早的运行记录已清理 | Earlier delivery records have been cleared |
| `delivery.retention` | 保留规则 | Retention rules |
| `delivery.retentionBounds` | 每个任务最多保留近 {days} 天内的 {records} 条运行记录。 | Each task keeps up to {records} delivery records from the last {days} days. |
| `delivery.retentionExplanation` | 产生新记录时，超出范围的旧记录会自动清理。清理记录不影响任务继续运行。 | When a new record is saved, older records outside these limits are cleared automatically. Clearing records does not stop the task. |
| `detail.name` | 自动化任务名称 | Automation task name |
| `detail.instruction` | 自动化任务内容 | Automation task instruction |
| `detail.status` | 状态 | Status |
| `detail.next` | 下次计划时间 | Next scheduled time |
| `detail.frequency` | 提醒频率 | Frequency |
| `detail.id` | 任务 ID | Task ID |
| `detail.session` | 关联会话 | Linked session |
| `detail.openSession` | 关联会话：打开原会话 | Linked session: open original session |
| `detail.openSessionTitle` | 关联会话 {title}：打开原会话 | Linked session {title}: open original session |
| `detail.sessionLoading` | 正在加载原会话信息 | Loading original session information. |
| `detail.sessionArchived` | 原会话已归档 | The original session is archived. |
| `detail.sessionUnavailable` | 原会话当前不可用 | The original session is unavailable. |
| `detail.missing` | 任务已不可用，可能已被删除 | Task unavailable. It may have been deleted. |
| `delivery.label` | 已保存的任务运行记录 | Saved delivery record |
| `frequency.once` | 仅一次 | Once |
| `frequency.every` | 每 {value} {unit} | Every {value} {unit} |
| `timing.date` | 日期 | Date |
| `timing.time` | 时间 | Time |
| `timing.hour` | 时 | Hour |
| `timing.minute` | 分 | Minute |
| `timing.second` | 秒 | Second |
| `timing.prevMonth` | 上个月 | Previous month |
| `timing.nextMonth` | 下个月 | Next month |
| `timing.zone` | 时区 | Time zone |
| `timing.zoneSearch` | 搜索 UTC 偏移、IANA 标识或城市 | Search by UTC offset, IANA ID, or city |
| `timing.zoneNoResults` | 没有匹配的时区 | No matching time zones |
| `timing.interval` | 重复间隔 | Repeat every |
| `timing.intervalIncrease` | 增大间隔 | Increase interval |
| `timing.intervalDecrease` | 减小间隔 | Decrease interval |
| `timing.unit.hour` | 小时 | hours |
| `timing.unit.minute` | 分钟 | minutes |
| `timing.unit.second` | 秒 | seconds |
| `timing.intervalHint.hour` | 至少 1 小时。间隔自任务创建或上次修改规则时起计，不受时区影响 | At least 1 hour. The interval counts from task creation or the last rule change and is independent of time zones. |
| `timing.intervalHint.minute` | 至少 1 分钟。间隔自任务创建或上次修改规则时起计，不受时区影响 | At least 1 minute. The interval counts from task creation or the last rule change and is independent of time zones. |
| `timing.intervalHint.second` | 至少 60 秒。间隔自任务创建或上次修改规则时起计，不受时区影响 | At least 60 seconds. The interval counts from task creation or the last rule change and is independent of time zones. |
| `timing.zoneNoStored` | 单次任务只保存触发时刻，不保存时区；日期和时间按所选时区换算 | A one-time task stores only its target moment, not a time zone. The date and time are interpreted in the selected time zone. |
| `timing.inactive` | 已结束的任务为只读，无法修改时间 | Inactive tasks are read-only. Their timing cannot be edited. |
| `timing.conflict` | 编辑期间任务已变化，草稿已保留。请在刷新后取消并重新打开编辑器，以修改最新规则 | This task changed while you were editing. Your draft is retained. Cancel and reopen after refresh to edit the latest rule. |
| `timing.notFound` | 此任务当前不可用，草稿已保留。请取消以关闭编辑器 | This task is no longer available. Your draft is retained; cancel to close the editor. |
| `timing.subagentSession` | 此会话属于子 agent，永远不会收到投递的提醒 | This session belongs to a sub-agent, which never receives delivered reminders. |
| `timing.invalid` | 请输入有效的日期和时间，或检查时间字段 | Enter a valid date and time, or check the timing fields. |
| `timing.invalidZone` | 请输入有效的 IANA 时区，例如 Asia/Shanghai | Enter a valid IANA time zone, for example Asia/Shanghai. |
| `timing.notFuture` | 请选择未来的日期和时间 | Choose a date and time in the future. |
| `timing.invalidInterval` | 请输入至少 1 分钟的间隔 | Enter an interval of at least 1 minute. |
| `timing.invalidInterval.hour` | 请输入至少 1 小时的间隔 | Enter an interval of at least 1 hour. |
| `timing.invalidInterval.minute` | 请输入至少 1 分钟的间隔 | Enter an interval of at least 1 minute. |
| `timing.invalidInterval.second` | 请输入至少 60 秒的间隔 | Enter an interval of at least 60 seconds. |
| `timing.error` | 无法确认时间修改是否已保存。草稿已保留，请在重试前检查任务 | Could not confirm the timing update. Your draft is retained. Check the task before retrying. |
| `rule.title` | 运行时间 | Run time |
| `rule.repeat` | 重复 | Repeat |
| `rule.weekday` | 星期 | Weekday |
| `rule.weekdayOption` | 星期{weekday} | Weekday {weekday} |
| `rule.unsaved` | 有未保存的修改 | Unsaved changes |
| `rule.save` | 保存修改 | Save changes |
| `rule.saving` | 保存中… | Saving… |
| `rule.cancel` | 取消 | Cancel |
| `rule.invalidTitle` | 请输入不超过 120 个字符的任务名称 | Enter a task name of at most 120 characters. |
| `rule.invalidPrompt` | 请输入任务内容 | Enter a task instruction. |
| `rule.once` | 仅一次 | Once |
| `rule.everyMinutes` | 每 N 分钟 | Every N minutes |
| `rule.everyHours` | 每 N 小时 | Every N hours |
| `rule.everySeconds` | 每 N 秒 | Every N seconds |
| `rule.daily` | 每天 | Every day |
| `rule.weekdays` | 周一至周五 | Monday to Friday |
| `rule.weekly` | 每周 | Weekly |
| `rule.cron` | 自定义 | Custom |
| `rule.cronLabel` | Cron 表达式 | Cron expression |
| `rule.cronInvalid` | 请输入 5 字段的 cron 表达式，例如 0 9 * * 1-5 | Enter a five-field cron expression, for example 0 9 * * 1-5. |
| `cronForm.frequency` | 频率 | Frequency |
| `cronForm.monthly` | 每月 | Monthly |
| `cronForm.weekly` | 每周 | Weekly |
| `cronForm.daily` | 每天 | Every day |
| `cronForm.dates` | 在以下日期 | On dates |
| `cronForm.dateOption` | {day} 日 | Day {day} |
| `cronForm.atMinute` | 在第几分钟 | At minute |
| `cronForm.minuteIncrease` | 增大分钟 | Increase minute |
| `cronForm.minuteDecrease` | 减小分钟 | Decrease minute |
| `rule.zone.system` | （系统） | ` (system)` |
| `rule.error.conflict` | 任务在保存前已发生变化。当前显示已保存的规则，请重试 | This task changed before the update was saved. The row shows the saved rule; try again. |
| `rule.error.notFound` | 此任务当前不可用 | This task is no longer available. |
| `rule.error.unknown` | 无法确认规则是否已更新。当前显示已保存的规则 | Could not confirm the rule update. The row shows the saved rule. |
| `delete.action` | 删除任务 | Delete task |
| `delete.title` | 删除此任务？ | Delete this task? |
| `delete.description` | 任务将停止触发，并连同其已保存的任务运行记录一并删除。原会话及其消息仍然保留；已排队的消息不会被撤回。 | This stops the task from triggering and deletes it together with its saved delivery records. The original session and its messages remain; queued messages are not withdrawn. |
| `delete.confirm` | 确认删除 | Confirm deletion |
| `delete.cancel` | 取消 | Cancel |
| `delete.close` | 关闭删除确认 | Close deletion confirmation |
| `delete.pending` | 正在删除… | Deleting… |
| `toast.deleted` | 任务已删除 | Task deleted. |
| `toast.deleteFailed` | 无法删除任务 | Could not delete the task. |
| `card.open` | 打开 | Open |
| `card.openLabel` | 打开任务详情：{title} | Open task details: {title} |
| `card.deleted` | 已删除 | Deleted |
| `tool.invoked` | 已调用 {name} | Invoked {name} |

（`detail.status`/`detail.next`/`detail.frequency`/`detail.id`/`tool.invoked` 当前组件未直接使用，README 提到"规则"显示状态、下一目标、重复规则和任务 id——iOS 可在详情底部补一个"信息"区用这些 key。）

插件 meta：dsh-schedule zh `任务调度` / `保存自动化任务，到点后在原会话中执行，并为智能体提供管理任务的工具。`

### B.5 Agent 工具 `dsh-tool-schedule` 对 UI 的影响

- 工具：`schedule_create`、`schedule_list`、`schedule_update`、`schedule_delete`（preset `standard`/`cordis`/`ptc` 挂载，`minimal` 无）。参数与 Remote 一致（`prompt`、`title`、`after_seconds`|`at`|`every_seconds`|`daily`|`weekly`|`cron` 六选一）。
- `schedule_create` 的 `tool/result` 内容为单个 text 块，文本是 JSON（`ScheduleView` = 记录 + `state:'scheduled'|'overdue'` + `deliveryMode:'host'`，或错误 `{code,message}`）。UI 用 `narrowScheduleRecord` 解析（缺 title 的旧结果回退 prompt 首行）→ B33 卡片。
- 工具调用本身在工具组里由通用 tool view 渲染（本包不注册 `tool.call.toolview`）。
- 任何工具改动都会触发 `schedule/changed` → 目录刷新。
- 归档仍有活动提醒的会话会被拒绝（由会话归档流程处理，见 shell/会话部分）。

### B.6 SwiftUI 落地建议

- **入口**：侧栏/Tab「自动化任务」→ `NavigationStack` 列表页。iPhone：列表 → push 详情；iPad：`NavigationSplitView`（列表 + 详情）。会话页导航栏右侧加时钟按钮（规则同 B31：首次结果前不显示、0 个不显示、1 个直接打开详情 sheet、多个弹 `popover`/`Menu` 列表，带删除 `swipeActions`）。会话列表行前导时钟 `Image(systemName:"clock")` + `contextMenu` 预览（替代 hover 卡片，最多 2 条 + "另有 N 个"）。turn 卡片做成消息流中的 `Button` 卡片。
- **列表**：`.searchable`（匹配 title/prompt/sessionId）+ 顶部 `Picker(.segmented)`（全部/已开启/已结束）；行：标题、`已结束` 标签、频率、`下次计划时间：绝对 (相对)`；`TimelineView(.periodic(from:.now, by:30))` 刷新相对时间（弹层 1s）。空状态 `ContentUnavailableView` + "新建自动化任务"按钮（= 新建会话并跳转）。`.refreshable` 拉 catalog。
- **详情**：`Picker(.segmented)` 规则 / 任务运行记录；工具栏 `Menu`（删除任务，`role: .destructive`）+ "关联会话"按钮；名称 `TextField`、指令 `TextEditor`（inactive 用 `Text` 只读）；底部 `safeAreaInset` 保存栏（有未保存的修改 · 取消 · 保存修改/保存中…），`interactiveDismissDisabled(dirty)` 防误关。删除用 `.confirmationDialog` 或 `.alert`（标题/描述/确认删除），结果用全局 toast overlay。
- **运行时间 `Form` Section**：
  - 重复：`Picker`（menu 风格）8 个选项；
  - 星期：7 个 toggle 胶囊（`HStack` of `Button`），至少保留 1 个；
  - 间隔：`Stepper` + `TextField(.numberPad)` + 单位文本，最小值按单位；
  - 日期：`DatePicker(displayedComponents: .date)`（`.graphical`），**必须设置 `environment(\.timeZone, 所选时区)` 与 `calendar.firstWeekday = 2`**，草稿仍存 ISO `YYYY-MM-DD`；
  - 时间：秒精度 → `DatePicker(.hourAndMinute)` 不含秒，需自定义 3 列 `Picker(.wheel)`（时/分/秒）；cron 内只要时/分；
  - 时区：push 到可搜索列表（`List` + `.searchable`），Section1 最近 5 个（UserDefaults `dsh.schedule.recent-time-zones.v1` 等价），Section2 全部（`TimeZone.knownTimeZoneIdentifiers` 按偏移+id 排序，系统时区置顶带"（系统）"；名称用 `TimeZone.localizedName(for: .generic, locale:)`，标签 `UTC±HH:MM · 名称`，同标签合并）；
  - Cron：频率子 `Picker`（每月/每周/每天/每 N 小时/每 N 分钟/Cron 表达式），每月 = 31 日 `LazyVGrid` 胶囊，raw = 等宽 `TextField`（关闭自动更正/大写），下方实时显示描述句或错误。**需要 Swift 复刻 `parseCronExpression`/`cronPreview`/`recognizeCronShape`/`cronShapeExpression`**（约 300 行纯函数，可直接对照 JS 翻译并用同一组样例做单元测试）。
- **关键实现点**：保存时 `expected` 必须是打开编辑时的完整原记录（不含 sessionId/status/lastDelivery）；change 字段 snake_case；仅发送变化的字段；收到 `schedule/changed` 时若有草稿需按 `mergeRuleDraft` 合并而不是覆盖；冲突后提示并允许取消重开。
- **时间/时区运算**：所有"目标时刻在某时区的钟表值/星期"用 `Calendar(identifier:.gregorian)` + `timeZone` 计算；绝对时间格式 zh 不带年、en 带年、24 小时制；运行记录时间按任务时区。
- **运行记录**：`List` + 分页（`onAppear` 最后一行或"加载更多"按钮，limit 20，`before = nextBefore`，按 messageId 去重），prompt 用 `Text.lineLimit(expanded ? nil : 2)` + 展开/收起（需测量是否截断，可用 `ViewThatFits` 或 GeometryReader 比较）；列表底部清理提示 + `DisclosureGroup`/popover 显示保留规则。
- **右栏任务页签在手机上**：用 sheet（`presentationDetents([.medium,.large])`）打开同一详情；"关联会话"在会话内打开时隐藏（同 `withinSession`）。刷新恢复绑定（`dsh.schedule.task-tab.v1.*`）在 iOS 上可简化为导航状态恢复。

---

# C. 右侧栏及其面板（开始页 / 文件 / 文档预览 / 浏览器 / 在应用中打开）

> 范围：`dsh-client-ui-sidebar-right`、`-sidebar-files`、`-sidebar-documentpreview`、`-sidebar-browser`、`-open-in-app`、`-entry-customization`，以及注入 `sidebar.right.pane.tab` 的 deliverables / plan / subagent / session-inspector；服务端 `dsh-api-workspace-files`、`dsh-workspace-changes`（经 deliverables 路由）、`dsh-host-open-in-app`、`dsh-office-to-pdf`、`/api/file`。终端、定时任务不在本笔记（只列 tab 元数据）。
> 版本：各包 `0.2.1-rc.4`。源：`engine/node_modules/@deepseek-ai/<pkg>/lib/client.js`（去 CSS 副本）、`lib/typert.remote-client.d.ts`、`lib/types/*.d.ts`、README.zh.md。
> 所有标识符、字符串原样保留。

---

### 0. 总体模型（先看这个）

- **每个会话（sessionId）一个“停靠面”（SurfaceState）**，没有会话就没有右栏，也没有头部展开按钮（hero/空态页右侧什么都没有）。
- 停靠面 = dockkit 布局树：`nodes`（pane / split）、`tabs`（TabRecord）、`rootId`、`floats`（浮窗 pane 列表）、`activePaneId`、`expanded`（是否展开）、`mode`（`"push" | "fullscreen"`）+ `minted`（id 铸造计数器）+ 内存中的 `history`（undo/redo，仅 `@internal`，无 UI）。
- **最多左右两格**（split 只允许 `axis:"row"`、根节点、2 个子节点；分隔条比例限定 20%～80%）；**浮窗**（float pane，每个只含 1 个 tab，带 rect）。
- **Tab = TabRecord `{ id: "tabN", kind, contentId, title }`**。`contentId` 是内容身份：资源 tab 用 `dsh-resource://…` 地址；页 tab（guide/files/browser/terminal…）用 `sidebar://<kind>`，`multiple:true` 的类型用 `sidebar://<kind>/<uuid>`。
- **Tab 类型注册表** `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted?, multiple? })`。资源地址的认领：先按档位 `extension(3) > builtin(2) > fallback(1)`，再按匹配 pattern 长度，再按注册顺序；`canOpen` 可否决。pattern 含 `:` 时匹配整个地址，否则（`*.md` 这种）以 basename、忽略大小写匹配 URL path。
- **导航控制器** `ctx.sidebarRight`：`openResource(address, options?)`、`openTab(kind, options?)`、`close(tabId)`、`active()`、`isExpanded()`、`toggleExpanded()`、`toggleFullscreen(target)`、`focus(tabId)`、`split(paneId?)`、`float(tabId, rect?)`、`dock(paneId)`、`focusedTarget(el?)`、`commandTarget(el?)`、`isTargetCurrent(t)`、`openTabFromTarget(kind, t)`、`registerCloseHandler(kind, handler)`、`mounted`（当前屏幕上的 sessionId observable）、`openTabs`（所有会话打开 tab 的清单 observable）。
  - options（`SidebarRightPlacement`）：`paneId?`、`replaceTab?: tabId`、`revealIfOpened?: boolean`（默认 true）、`preferNewPane?: boolean`；`openResource` 另有 `kind?`、`params?`；`openTab` 有 `params?`。
  - 打开规则：已展示同一 (kind, contentId) 的**资源** tab → 聚焦它（跨分栏），除非 `revealIfOpened:false`；**页** tab 只在目标分栏内去重；否则新 tab 落到 `replaceTab` 所在位置（并关掉被替换的）→ `paneId` → 活动停靠格。**打开一定会展开右栏**。随后 Tab 域记录导航 `{ address, params, revision++ }`（不进布局历史）。
  - 未认领地址 / 非 `dsh-resource://` / 未注册 kind → throw（接线错误）。
- **默认页（seed）规则**：已注册 guide 入口数恰好 1 个 → 直接打开该入口的 kind；0 个或多个 → 打开 `guide`（“开始”页）。展开空布局时才播种默认页。
- **关闭规则**：作为“唯一停靠 tab”的 guide 不可关闭（无关闭按钮、无菜单关闭项，chip 呈 quiet 样式）；其它 tab 若是唯一停靠 tab，点关闭 = 关闭它 + 切回 `push` 模式 + 收起整列（下次展开再播种默认页）。浮窗不受此规则约束。
- **两种呈现**：`push`（右轨道占宽，会话区让位）/`fullscreen`（覆盖整窗）。**窗口 <768px 时打开右栏自动全屏**；窄屏退出全屏 = 收起右栏；变宽不自动重新打开。宽度拖拽手柄只在普通展开态（宽度由 `dsh-client-ui-layout` 的 AppFrame 拥有，非本包）。

---

### 1. 功能清单

#### 1.1 `dsh-client-ui-sidebar-right`（容器、tab/pane、guide、全屏、快捷键）

| # | 功能 | 交互细节 / 触发 | 限制 / 禁用条件 | RPC |
|---|---|---|---|---|
| R1 | 会话头部右上角“打开侧边栏”按钮（slot `conversation.session.header.corner`，组件 `ExpandButton`） | 仅在该会话右栏**收起**时渲染；图标 `IconPanelLeftOutlineRegular` 水平镜像（scaleX(-1)）；28px 宽紧凑 Button；Tooltip `chrome.expand` + 快捷键 `sidebar.right.toggle`；aria-label `chrome.expandAria`；点击 `setExpanded(sessionId,true)` | 展开时返回 null（角落席位收起，不占宽度）；无会话不渲染 | 无 |
| R2 | 面板 chrome（tab 条最右端，仅右上格）：①全屏切换 ②收起 | ①Tooltip/aria `chrome.toFullscreen` / `chrome.exitFullscreen`，快捷键 `pane.fullscreen.toggle`；②Tooltip `chrome.collapse`，aria `chrome.collapseAria`，快捷键 `sidebar.right.toggle`，点 `toggleExpanded` | 面板**没有标题行**，tab 条就是上边；窄格只有 tab chip 收缩，控件不收缩 | 无 |
| R3 | Tab 条：每格一条；从左到右 = tab chip（标题 slot + 关闭 ×）、“新标签页”`+`、strip 填充、分栏按钮、（右上格）chrome | chip 点击聚焦；键盘：ArrowLeft/ArrowRight 循环、Home/End 首尾、Enter/Space 激活；右键/上下文菜单 → 菜单项“关闭”(`dock.closeTab`) + `sidebar.right.tab.menu.item` 扩展项；Escape/点外部关闭菜单 | `+` 仅当该格**没有 guide tab** 时绘制，点了 `openTab('guide',{paneId,revealIfOpened:false})`；关闭 × 仅 `canCloseTab` 时显示 | 无 |
| R4 | 分栏（split） | 分栏按钮 / 快捷键 `pane.split`（`Mod+\`）；新格播种默认页；返回新 paneId | 已有 2 格 → 禁用+提示 `dock.splitPaneDisabled`；宽度不足 → `dock.splitPaneNarrow`；空格不能分；浮窗不能分；收起态不能分（命令提示 `command.collapsed`/`command.empty`/`command.float`/`command.budget`/`command.width`） | 无 |
| R5 | 拖拽 tab | 指针拖动超过 4px 开始；落在 strip → `placeTab`（重排/跨格移动）；落在格内区域 → `dropTab(zone)`，zone ∈ `center`(移到这里)/`left`/`right`（新分栏）；`top`/`bottom` 被忽略（只允许水平）；拖出整个停靠面 → `floatTab`，浮窗默认 380×300，最小 220×140 | 已 2 格时 left/right 无效；把 guide 拖进已有 guide 的格 → 合并（来者关闭、聚焦原有）；拖放提示文案 `dock.drop.*` | 无 |
| R6 | 浮窗 | 可移动（moveFloat）、缩放（resizeFloat）；按钮“收回到侧边栏”`dock.dockFloat`（→活动停靠格）、“关闭”`dock.closeFloat` | 浮窗即使列收起也渲染；每浮窗 1 tab | 无 |
| R7 | 分隔条拖拽 | resizeSplit，最小比例 0.2 | 仅 2 格时 | 无 |
| R8 | Guide（开始页，kind `guide`，id `@deepseek-ai/dsh-client-ui-sidebar-right/guide`，标题 `tab.guide.title`“开始”，标题图标=罗盘） | 正文：56px 弱化罗盘 hero + 每个 guide 入口一张卡片（按 `order` 升序：files 10、terminal 20、browser 30、session-inspector 60…）；卡片=图标（无图标用浅色立方体占位）+标题+可选描述+右对齐快捷键文字；**可见卡片 ≤4 时显示描述**，否则全去掉；点卡片 `openTab(kind,{replaceTab:true})`（guide 让位） | provider 可用 `sidebar.right.tab.guide.entry`（keyed by provider id）自定义卡片（终端有）；`sidebar.right.tab.guide`（chain）可整页替换 | 无 |
| R9 | Guide “更多工具”卡片 | 有 `sidebar.right.tab.guide.actions` 注册项时出现在卡片末尾；点开 Menu（end 对齐、不窄于卡片、最大 min(480px, 视口-24px)）；菜单行由注册项渲染，props `{ entries:[{id:"kind:entryId",label,pinned}] (不含 kind=files), onOpen(id), onPinnedChange(id,pinned), onDismiss() }` | Pin 状态只在内存（`unpinned` 列表，刷新/重载插件重置，不读 localStorage）；`files:` 前缀永不可 unpin；默认注册项（entry-customization）不消费 pin，只给“浏览/创建插件” | 无 |
| R10 | 未注册正文兜底 | tab 的 kind 没有正文注册时显示 `tab.unavailable` | — | 无 |
| R11 | 后台会话保活 | `rightbar` 根通过 `rightbar.session` 子树为选中会话 + 有已初始化 `keepMounted` 正文的后台会话各渲染一份（隐藏），只有前台上报列宽 | `keepMounted:true` 的 tab 类型（Desktop 浏览器）在切 tab/切会话/收起/浮动时保留 DOM | 无 |
| R12 | 焦点管理 | 快捷键打开/展开/分栏后焦点移至选中分栏；关闭后焦点移至同会话仍可见分栏；保留文本选区 | — | 无 |
| R13 | 关闭 handler | `registerCloseHandler(kind, handler)` 在显式关闭/替换前同步调用（终端用于结束 PTY）；handler throw 则保留 tab | 折叠/切换呈现/卸载不调用 | 无 |
| R14 | 资源 pin | 每个 tab occurrence 首次同步时 `ctx.resources.pin(address, signal)`，tab 存在期间保持资源（文件元数据流）订阅 | — | 间接：`workspaceFiles/changes` 流 |

**快捷键（`registerSidebarShortcuts`，regions `page`/`editable`/`terminal`）**：

| id | 标签 key | desktop（mac/win/linux） | web:macos / web:windows | 行为与阻断 |
|---|---|---|---|---|
| `sidebar.right.toggle` | `command.toggle` | `Mod+Alt+B` | `Mod+Shift+B` | 展开/收起；无会话 → `command.noSession` |
| `pane.split` | `dock.splitPane` | `Mod+\`（code `Backslash`） | 同 | 需焦点在可见停靠分栏，否则 `command.noFocus`；阻断原因见 R4 |
| `pane.fullscreen.toggle` | `command.fullscreen` | `Mod+Alt+Enter` | 同 | 需焦点在分栏；浮窗 → `command.float`；自动全屏(窄屏)下再切 = 收起 |
| `page.close` | `command.close` | `Mod+W` | `Mod+Alt+W`（mac/win） | 先关前台弹窗；再关聚焦 tab（唯一停靠 guide → 收起右栏）；Desktop 无目标时关窗；Web 无目标 → `command.noFocus`；焦点在过期 iframe → `command.stale` |
| `page.refresh` | `command.refresh` | `Mod+R` | web:windows `Mod+Alt+R`（web:macos 无默认） | 调用聚焦 tab 通过 `tab.actions.bindCommands({refresh})` 绑定的刷新；无 → `command.noRefresh` |

（`Mod` = primary：mac Cmd / win,linux Ctrl。Linux Web 未列出 = 默认不绑定。）

#### 1.2 `dsh-client-ui-sidebar-files`（工作区文件树，kind `files`）

- 类型：id `@deepseek-ai/dsh-client-ui-sidebar-files`，kind `files`，`builtin`，无 patterns（页类型，`sidebar://files`），标题 `type.label`“文件”；guide 入口 `{ id:"workspace", commandId:"workspace.files", order:10, title:guide.title, description:guide.description, icon: GuideArtworkFiles(黄色文件夹) }`。Tab 标题前 16px 文件夹 `FileTypeIcon`。
- 快捷键 `workspace.files`：desktop `Mod+P`；web mac/win `Mod+Alt+P`；无会话 → `shortcut.noSession`；执行 `openTabFromTarget("files", target)`（在焦点分栏打开/聚焦，替换 guide）。
- 正文：
  - **头部行**：`PathLabel`（根路径；目录部分弱化色、最后一段主色；过长左侧渐隐保留尾部；hover 显示完整路径）→（隐藏的）自动刷新开关 →“重新读取”按钮（`IconRefreshOutlineRegular`，Tooltip `reload` + `page.refresh` 快捷键）→ slot `sidebar.right.tab.files.actions`（props `{absolutePath: root}`；open-in-app 在此放“在应用中打开工作区目录”分体按钮）。
  - **树**：根 = `sessions.byId[sessionId].cwd`（绝对路径）。每层 key = 绝对路径，子路径 = 父路径去尾斜杠 + `/` + name。首次展开时 `workspaceFiles/list(sessionId, absolutePath)`。排序：目录优先，然后 `Intl.Collator(undefined,{numeric:true,sensitivity:"base"})` 自然序；dotfile 照常显示。
  - 行类型：`directory` → 按钮，图标打开/关闭文件夹，`aria-expanded`，点击切换展开/折叠（折叠保留缓存；再展开重新列举并恢复仍存在的已展开后代）；`file` → 按钮，`FileTypeIcon(classifyFileType(name))` 16px，点击 `tab.actions.openResource(fileAddressFor(sessionId, root, path))`（在本 tab 所在 pane 打开文档预览）；`other` → 灰显、`aria-disabled`，title `entry.other`，不可点。
  - 每层状态行：加载中 `loading`；空 `empty`；被 `maxEntries` 截断 → 末尾 `truncated`；失败 → `error.notFound`/`error.outsideWorkspace`/`error.notDirectory`/`error.unavailable{message}`（已 ready 的层再失败时，失败行显示在条目上方，条目保留）。
  - 无 cwd 的会话 → 只显示 `noWorkspace`。
  - **自动刷新**：每个打开目录节点持有 `workspaceFiles/changes(sessionId, dirPath)` 流；收到帧（ready 后的 change）即重新 list（直接子项变化）；`watch-unsupported` 静默降级为手动；默认开启，开关 UI 隐藏但逻辑在。
  - 重新读取（按钮 / `page.refresh`）：就地刷新根与所有展开层（`refreshTree`），读取期间保留已显示条目。
  - 滚动位置按 tab 保存（卸载时写入），切回 tab 恢复。
- **没有**：搜索、过滤、拖拽、重命名、右键菜单、当前文件高亮、变更/diff 标记（README 明确列为限制）。只能以 cwd 为根，不能浏览到上层。
- 文件的“变更/diff”显示不在 files 里，而在 deliverables 的 `changes-review` tab（见 1.7）。

#### 1.3 `dsh-client-ui-sidebar-documentpreview`（文件预览，kind `text`）

- 类型：id `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`，kind `text`，pattern `dsh-resource://file/[\s\S]+`，**档位 `fallback`**，`canOpen` 仅接受 `scope==="session"` 的地址（`dsh-resource://file/session/<sid>/<path>`；`absolute/…` 不认领）。标题 = 地址最后一段 decode 后的 basename（打开时固定）；标题前 `FileTypeIcon(classifyFileType(title))`。
- 内容身份 = 完整地址（不同目录同名文件、不同会话同路径 → 不同 tab）。
- **头部**（固定）：`PathLabel`（Host 报告的 `absolutePath`，否则请求路径）→ 渲染器下拉“打开方式”（`openWith`，仅候选 >1 时出现；按钮文字=当前渲染器名；Menu end 对齐）→ 换行开关（仅所选渲染器 `wrap:true`；图标表示点了之后的模式；aria `wrap.aria`，Tooltip `wrap.enable`/`wrap.disable`；默认开启，按 tab 保存）→ 渲染器专属动作 slot `sidebar.right.tab.document.action`（keyed by renderer id；Office 的缺字体警告在此）→（隐藏）自动刷新开关 →“重新读取文件”按钮（`reload`，Tooltip 带 `page.refresh` 键）→ slot `sidebar.right.tab.document.actions`（props `{absolutePath}`，仅元数据报出 Host 路径后；open-in-app 的“打开/显示文件位置”分体按钮）。
- **变更横幅**（头部上方）：元数据失败且已有内容 → `failureLine` + “重新载入”`reloadNow`；文件版本变了（观察到的 version ≠ 已加载 version）或依赖资源变脏 → `changed`“文件已更新，当前显示为旧内容” + `reloadNow`。自动刷新开着时直接重载（默认开）。
- **正文状态**：
  - 已知二进制后缀（见 §4 `UNVIEWABLE_BINARY_EXTENSIONS`）且无渲染器 → “unsupported” 态：头部 + 36px 文件类型图标 + `unsupportedFile` + slot `sidebar.right.tab.document.unpreviewable`（open-in-app 40px 大按钮“打开”/“显示文件位置”）；**不发起读取**。
  - 首次加载：居中 28px ongoing `StateDot` + `loading`“文档渲染中...”；资源服务不可用 → `resourceUnavailable`。
  - 文本分页：首页 offset=1；滚到底（距底 ≤1px）或点“加载更多”`loadMore` 读下一页（offset = 已加载最后一行+1）直到 `eof`；加载中按钮禁用并显示 14px 行内 spinner。后续页 version 变了 → 从头重读。
  - 无内容时失败：36px 图标 + 失败文案 + 出路：`not-text`/`too-large` → unpreviewable slot（打开外部应用）；`not-found`/`not-regular-file` → 无；其它 → “重试”按钮（`IconRefreshOutlineRegular` + `retry`）。有内容后再失败 → 内容下方失败行 + “重试”（继续加载下一页）。
  - 渲染器正文 slot 未注册 → `rendererUnavailable{name}`。
- **行号导航**：`openResource(addr, { params: { line } })`（1 起算）。text-pages 模式顺序加载到该行或 EOF 后滚动；纯文本与代码有行锚点（`data-textpreview-line`），Markdown 没有 → 导航挂起，切到纯文本/代码时执行；字节模式不消费。每个 navigation revision 只处理一次。同一文件再次打开（未 `revealIfOpened:false`）→ 聚焦已有 tab 并送达新 revision。
- **渲染器注册表** `ctx.documentPreviews.register({ id, extensions, binaryExtensions?, priority, title, loading, wrap? })`，排序：`extension` 优先于 `builtin`，再按更长后缀，再按注册顺序；非二进制后缀额外追加“纯文本”候选；无匹配且不在 unviewable 列表 → 只有纯文本。`loading` ∈ `"text-pages" | "bytes-complete" | "renderer"`。
- 各渲染器细节：
  - **纯文本**（`…/text`）：`<pre>` 每行一 div，`wrap:true`。
  - **Markdown**（`…/markdown`，md/markdown）：`MarkdownText` 增量渲染（未 eof 时 streaming）；frontmatter（首行 `---` 到 `---`/`...`）显示为键值列表（YAML 懒加载 `client.frontmatter-fields.js`，失败/加载中显示原样 `<pre>`）；本地图片走 `/api/file?path=<abs>`（相对路径基于文档目录，需 Host 绝对路径；HTTP(S) 图片原样；失败显示 alt）；代码块复制按钮（`code.copy`/`code.copied`）；脚注标题 `footnotes`。注意代码引用了 `codeBlock.title`/`codeBlock.wrap`/`codeBlock.unwrap` 但字典里未定义（会回退）。
  - **代码**（`…/code`，扩展名见 §4）：语法高亮（Shiki 风格 `pre .line`），tertiary 色语言名 + 复制图标（`copy`/`copied`，复制不含行号），默认显示行号，`wrap:true`，内部滚动区。
  - **HTML**（`…/html`，html/htm，bytes-complete）：两种模式由“代码工作工具”设置（`ctx.configForms.developerTools.enabled` → `interactivePreview`）决定：关 → DOMPurify 清洗（禁 noscript/base/link/meta/iframe/frame/object/embed/set/animate*，禁 href/xlink:href）+ CSP `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`，iframe `sandbox=""`；开 → Blob iframe `sandbox="allow-scripts"`（无 allow-same-origin），打包直接引用的相对 `.js`（经典脚本）/`.css`，经 `workspaceFiles/readBytes(sid, relPath, {baseFile: docPath})` 读取；上限单资源 4 MiB / 总 32 MiB / 64 个资源；iframe name `dsh-sidebar-html-<tab-id>`；无缩放控件。
  - **图片**（`…/image`，png/jpg/jpeg/gif/webp/bmp/ico/svg；svg 非二进制故有“纯文本/代码”备选）：Blob URL `<img>`，12px 内边距圆角；默认适应宽度但不放大小图；共享缩放控件；SVG 只作 `<img>`，不进 DOM。
  - **PDF**（`…/pdf`）：懒加载 `client.pdf.js`（PDF.js + worker）；纵向页序列，页距/四周 12px；惰性渲染，未渲染页 3:4 占位；文字层可选择复制；密码 PDF → `password`；worker 崩 → `workerFailed`；页位图上限 16,777,216 像素。
  - **缩放控件**（PDF/图片共用）：选项 **适应宽度**、25%、50%、100%、150%、200%；按钮 ±25%，范围 25%–400%；默认适应宽度；精细指针设备上初始隐藏，指针进入底部 72px 滑入、离开 420ms 后退出；触控板捏合/Ctrl+滚轮实时缩放（锚定指针）；缩放值在正文重挂载后保留直至 tab 关闭。
  - **表格**（`…/excel`，xlsx/xls/csv/tsv，bytes-complete）：懒加载 `client.excel.js`（FortuneSheet + ExcelJS(xlsx) + SheetJS CE(xls) + PapaParse(csv/tsv)），Worker 解析；工作表标签、单元格选择、复制、只读公式栏；不重算公式（`formulaWarning`）；图表/图片/形状/条件格式检测到则提示 `unsupportedNotice`；CSV/TSV 默认表格，也可纯文本，CSV 还可“代码”；编码 UTF-8 / 带 BOM UTF-16，否则 `encoding`；限额 `excel.maxBytes` 16 MiB、`excel.maxCells` 250000、`excel.timeoutMs` 15000。表格始终浅色背景。
  - **Office**（`…/office`，doc/docx/ppt/pptx，loading `renderer`）：调用 `officeToPdf/render` 转 PDF 后复用 PDF 正文；客户端 LRU 缓存（`office.maxCachedEntries` 8、`office.maxCachedBytes` 64 MiB、`office.maxPending` 8、`office.maxReaders` 32）；先 `readBytes(range{0,1})` 授权检查 + `stat` 比对版本，不一致 → `changed`；缺字体 → 头部刷新按钮前黄色三角警告（Tooltip `viewMissingFonts{count}`，点开锚定列表：标题 `missingFontsTitle`、说明 `missingFontsDescription`、`missingFontsCount{count}`、关闭 `closeDetails`；Esc/点外关闭）；Host 无服务 → `unavailable`。注意 xls/xlsx 不走 Office 转换（走表格）。

#### 1.4 `dsh-client-ui-sidebar-browser`（内置浏览器，kind `browser`）

- 类型：id `@deepseek-ai/dsh-client-ui-sidebar-browser`，kind `browser`，`multiple:true`（每次打开新实例，contentId `sidebar://browser/<uuid>`），`builtin`，标题 `type.label`；guide 入口 `{ id:"new", commandId:"browser.new", order:30, icon: GuideArtworkBrowser(蓝色地球) }`；Tab 标题 = 地球图标 + 当前条目 title（URL hostname 或页面标题）。
- **Web profile 默认禁用**（需 profile patch `- id: ui-sidebar-browser\n  disabled: false`），Desktop 默认启用。
- 快捷键 `browser.new`：desktop `Mod+T`，web mac/win `Mod+Alt+T`；无会话 → `shortcut.noSession`。
- 打开途径：guide 卡片；快捷键；`ctx.sidebarRight.openTab('browser', { params: { url } })`；Chat 链接偏好选“应用内侧边栏”时 HTTP(S) 链接在此打开（每次新 tab）；浏览器内请求打开新窗口（Desktop popup）→ 新 Browser tab。
- **工具栏（form）从左到右**：后退（`IconChevronLeft`，禁用 = `!canGoBack`）、前进（禁用 = `!canGoForward`）、刷新（禁用 = 无目标或尚未挂载；Tooltip 带 `page.refresh` 键）、地址输入框（placeholder `address.placeholder`，spellCheck off；地址变为 unknown 时加样式 + 徽标 `address.changed`）、“前往”提交按钮（`IconLink`）、“在系统浏览器中打开”（`window.open(url,"_blank","noopener,noreferrer")`，unknown 时禁用）、（Web 才有）沙箱开关（盾牌图标，√=沙箱开 / ×=关；aria-pressed = 已关闭）。
- 提交 Enter：`parseBrowserAddress`：空 → `error.empty`；>16384 字符或解析失败 → `error.invalid`；无 scheme 自动补 `https://`（`localhost:3000` 这种 host:port 也补）；含用户名/密码 → `error.credentials`；与应用自身 origin 相同 → `error.application-origin`；非 http/https（file:、javascript:、data:、blob:…）→ `error.protocol`。错误行 `role=alert`。
- 沙箱关闭 → 琥珀色警告条 `sandbox.warning`（仅本 tab occurrence，不持久化，切换会重新加载当前页）。
- 加载失败 notice（iframe error 事件）：`load.failed`（或 Desktop 有码时 `load.failed.detail{code,description}`），直到下次受控加载。
- 空态 `start`；加载中 `loading`；**恢复**：重启/刷新后若有保存的目标但未加载，显示卡片 `restore.previous` + 保存的标题 + URL + 主按钮 `restore.action`（刷新按钮也等价恢复）。
- 页面跳转到不可读 URL（iframe 二次 load）→ 地址 unknown：底部提示 `address.unknown`，后退/前进/外部打开禁用，刷新回到最后受控 URL。
- **实现**：Web = `<iframe src=url referrerpolicy=no-referrer sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox">`，应用自己维护历史（最多 100 条），**不代理、不探测**、无 Host RPC、无 HTTP 路由；Desktop = Electron `<webview>` + 主进程租约（iOS 无关）。localhost/loopback 与公网同等对待（相当于“localhost 预览”就是直接把 URL 塞进 iframe，从浏览器所在机器访问）。
- 持久化：store `persist: "dsh.sidebar-browser.v1"`，`byTab[tabId] = { entries:[{kind:"http"|"https",url,title}], index, request:{target,revision}, navigation:{status:"empty"|"loading"|"known"|"unknown",revision}, failure }`；tab 关闭删除检查点。

#### 1.5 `dsh-client-ui-open-in-app`（在应用中打开）

挂载点与组件：

| slot | id / order | 组件 | 目标 |
|---|---|---|---|
| `conversation.session.header.utilities` | `open-in-app`, order -10 | `SessionOpenInAppAction` → `OpenInAppAction`（kind directory） | 会话 cwd |
| `sidebar.right.tab.files.actions` | `open-in-app` | `OpenInAppAction` | 文件树根 `absolutePath` |
| `sidebar.right.tab.document.actions` | `open-in-app` | `OpenPathAction`（kind file，紧凑） | 文件 `absolutePath` |
| `sidebar.right.tab.document.unpreviewable` | `open-in-app` | `OpenPathEmptyAction`（kind file，prominent 40px 带文字） | 同上 |
| `deliverables.file.actions` / `deliverables.review.file.actions` | `open-in-app` | `FileRouteAction`（经 deliverables 鉴权路由） | 交付卡片/改动对比的文件 |

- **分体按钮 `OpenTargetButton`**（24px 高、圆角 9px；仅图标；Tooltip delay 500ms bottom）：主按钮执行默认动作，`⌄` 下拉（aria `path.more`；打开下拉时触发刷新关联应用列表）。
  - 目录（directory）：应用 = Host `/open-in-app/apps` 返回、且客户端词典有 `app.<id>` 的应用（按 Host 顺序）；默认 = 记住的选择（`dsh.open-in-app.choice`），不可用时回退第一个；主按钮 Tooltip `open.title{app}`；菜单项 = 每个应用（图标 `open-in-app/icon/<id>`，加载失败用 `IconRightUpOutlineRegular` 占位），当前默认项文案 `path.appDefault{app}`；选菜单项 = 启动并记住该选择。无可用应用或无 cwd → 不渲染。启动中禁用（busy），失败 Toast `path.openError`。
  - 文件（file）：先 `session/canOpenWorkspacePath`（每页一次）为 true 才渲染；应用 = `session/workspacePathApplications({path})`（OS 文件关联）；默认 = `default:true` 的那个，否则第一个；**都没有 → 主按钮 = “显示文件位置”**（文件夹打开图标）；菜单底部固定（分隔线后）“显示文件位置”`path.reveal`；查询失败 → 菜单里禁用项 `path.appsError`，默认动作=定位；首次加载显示灰色骨架图标；只有一个可用动作时不显示 `⌄`。主按钮选默认应用时发送 `{path}`（不带 application = 系统默认）；选其它应用 `{path, application:id}`；定位 `{path, action:"reveal"}`。失败 Toast `path.openError` / `path.revealError`。不修改系统默认应用。prominent 版主按钮文字 `path.open` 或 `path.reveal`。
- 快捷键 `workspace.openLocal`（label `open.tooltip`）：desktop `Mod+Alt+O`；web mac/win `Mod+Shift+O`；仅主区为会话（`layout.panelInfo.activePanelId===null`）、会话有 cwd、有可用应用时执行，用记住的应用打开 cwd；启动中 → `shortcut.busy`；不可用 → `shortcut.unavailable`。
- SSH 远程（`SSH_CONNECTION`/`SSH_TTY`）Host 返回空列表 → 头部按钮隐藏。

#### 1.6 `dsh-client-ui-entry-customization`（“更多”菜单）

- 注册到三个区域（id `entry-customization`，locale `entryCustomization`）：`sidebar.panellist.actions`（左栏“更多”，region `sidebar`）、`conversation.session.header.views.actions`（“更多会话视图”，region `conversation`）、**`sidebar.right.tab.guide.actions`（右栏开始页“更多工具”，region `rightbar`）**。
- 菜单行（`EntryMenuContent`）：仅 conversation 区域先列出收起的 View（当前项带 ✓）；然后（有收起 View 时前面加分隔线）“浏览更多插件”`install`（插件风车图标）→ `pluginNavigation.openList()`；“创建你的插件”`create`（+ 图标）→ `uiWorkspace.startSession(undefined, { agentPreset:"cordis", prompt: t("createPrompt.<region>"), whenDraftExists:"append" })`（只放草稿，不发送）。每行先 `onDismiss()`。
- **不提供 pin/unpin/排序**（右栏的 pin 回调存在但本包不调用）。埋点 `more_menu_item_click {region, action:"browse_plugins"|"create_plugin"}`（仅有 productAnalytics 时）。

#### 1.7 其它注入 `sidebar.right.pane.tab` 的类型（只列元数据）

| 包 | 实现 id | kind | patterns / 地址 | 档位 | 标题 | 图标 | 何时出现 |
|---|---|---|---|---|---|---|---|
| ui-sidebar-right | `@deepseek-ai/dsh-client-ui-sidebar-right/guide` | `guide` | 页 `sidebar://guide` | builtin | `tab.guide.title` 开始 | 罗盘 | 默认页 / `+` |
| ui-sidebar-files | `@deepseek-ai/dsh-client-ui-sidebar-files` | `files` | 页 `sidebar://files` | builtin | 文件 | 文件夹 | guide 卡片(order 10) / `Mod+P` |
| ui-sidebar-terminal（他人负责） | — | `terminal` | 页，multiple | builtin | 终端 `title` | PluginArtworkTerminal | guide(order 20) |
| ui-sidebar-browser | `@deepseek-ai/dsh-client-ui-sidebar-browser` | `browser` | 页，multiple | builtin | 浏览器 | 地球 | guide(order 30) / `Mod+T` / 聊天链接 |
| ui-sidebar-documentpreview | `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` | `text` | `dsh-resource://file/[\s\S]+`（仅 session scope） | fallback | 文件 basename | 按扩展名 FileTypeIcon | 文件树点击、聊天文件链接、工具行行号引用、改动对比“打开整个文件” |
| ui-deliverables | `@deepseek-ai/dsh-client-ui-deliverables` | `changes-review` | `dsh-resource://changes-review/**`，地址 `dsh-resource://changes-review/session/<encodeURIComponent(sid)>/<seq>/<turn>` | builtin | `review.title{turn}`“第 {turn} 轮改动” | — | 聊天轮尾“改动文件”卡片点文件 → `openResource(addr,{params:{index}})` |
| ui-plan | `@deepseek-ai/dsh-client-ui-plan` | `plan` | `dsh-resource://plan/**`（`plan/<sid>/<callId>` 或 `plan/subagent/<parent>/<child>/<mode>/<callId>`，各段 encodeURIComponent）、`dsh-resource://plan-review/<sid>/<requestKey>` | builtin | `preview.title`“计划”（标题 slot 会换成计划首行） | FileTypeIcon `other` | 计划卡片点击；**计划审阅（plan review）请求到达且右栏有已挂载会话时自动打开一次**（params `{planReview:{markdown,title}}`） |
| ui-subagent | `@deepseek-ai/dsh-client-ui-subagent` | `subagentchat` | `dsh-resource://subagentchat/session/<encodeURIComponent(childSid)>?parent=<parentSid>&mode=<mode>` | builtin | 子会话 `projectionValues.subagent.label`，否则 childSid，否则 `sidebar.chat`“聊天” | — | 子智能体目录“在侧边栏打开”`open.sidebar` → `openResource(addr,{kind:"subagentchat", preferNewPane:true})`（优先在新分栏），正文嵌入完整 Conversation（slot `sidebar.chat.conversation`） |
| experimental-session-inspector | `@deepseek-ai/dsh-experimental-session-inspector` | `session-inspector-log` | 页 | extension（默认） | `tab.title`“会话数据诊断” / “Session Log” | 无（立方体占位） | guide 入口 `{id:"open", order:60, description: tab.description}`（实验插件，启用时） |
| ui-schedule（他人负责） | `@deepseek-ai/dsh-client-ui-schedule/task` | `scheduleTask` | 页 | builtin | `detail.label`（标题 slot 换成任务标题） | — | 定时任务详情 |

`changes-review` 正文简述（diff 显示）：头部文件选择下拉（`review.selectFile`，菜单项=文件 display + `+N/-M` 计数）、计数、左右/单栏切换（`review.split`/`review.unified`，aria `review.splitAria`）、换行切换（`review.wrap`/`review.nowrap`）、“在侧边栏打开整个文件”（`review.openFileAria{name}` → `openResource(fileAddressFor(sid,cwd,file.path))`）、`deliverables.review.file.actions`（open-in-app）；hunk 渲染 `+`/`-`/` ` 行；`binary`/`oversized` 拒绝显示。

---

### 2. RPC 方法 / HTTP 路由表

#### 2.0 通用约定
- Remote 调用名 `'<namespace>/<method>'`，返回 `RemoteResult<T> = { ok: true, value: T } | { ok: false, error: RemoteFailure }`；`RemoteFailure` = `RemoteError { code, message, details, isDSHRemoteError: true }`，按 `code` 分支（不要按 message）。
- 流方法返回 `RemoteStreamHandle<Out, In>`（AsyncIterable；客户端用 `remote.$stream({open, ended})` 监督、断线自动重连；收到 `ready` 后 `item.accept()`）。
- 二进制结果（`readBytes`、`officeToPdf/render`）走 Connection 的 **multipart** 响应：JSON 元数据 + 原始字节，客户端得到 `data: Uint8Array`（无 base64）。
- 常见网关错误码：`gateway/bad-request`、`gateway/lookup-not-found`（cold session 无法解析）、`gateway/internal`、`gateway/invocation-unavailable`、`gateway/service-unavailable`。
- HTTP 路由都是**文档相对路径**（`fetch("open-in-app/apps")`、`api/file?…`），走浏览器认证 + Host/Origin 信任检查（iOS 端需带同样的认证 cookie/header，由连接层负责）。

#### 2.1 `workspaceFiles`（`dsh-api-workspace-files`）

| 方法 | 参数 | 返回 value | 何时调用 |
|---|---|---|---|
| `workspaceFiles/stat` | `(workspaceFileScopeId: SessionId, path: string)` | `WorkspaceFileStat { absolutePath: string; version: string; bytes?: number }` | 资源提供者（`useResource<'file'>`）在 ready 帧后 & 每次 change 帧后；Office 授权比对 |
| `workspaceFiles/read` | `(sid, path, range: WorkspaceFileRange { offset?: number /*1起*/; limit?: number /*≤maxLines*/ })` | `WorkspaceFileText` = stat + `{ offset: number; text: string /*行以\n连接,末行无终止符*/; lines: number; eof: boolean }` | 文本/Markdown/代码分页（客户端只传 `{offset}`） |
| `workspaceFiles/readBytes` | `(sid, path, options: WorkspaceByteReadOptions { range?: { offset?: number /*0起*/; length?: number /*≤maxBytes*/ }; baseFile?: string })` | `WorkspaceFileBytes` = stat + `{ offset: number; data: Uint8Array; eof: boolean }` | 图片/PDF/HTML/表格整文件（`{}` → ≤`maxFileBytes`）；HTML 关联资源（`{baseFile}`，path 为相对路径）；Office 授权（`{range:{offset:0,length:1}}`） |
| `workspaceFiles/list` | `(sid, path)`（工作区相对路径或绝对路径；客户端传绝对路径） | `WorkspaceDirectoryListing { path: string /*工作区相对,根为""*/; entries: { name: string; type: "file"\|"directory"\|"other"; size?: number }[]; truncated: boolean }` | 文件树展开/刷新 |
| `workspaceFiles/changes`（stream） | `(sid, path)` | 帧 `WorkspaceFileWatchFrame = { kind: "ready" } \| { kind: "change"; change: { absolutePath; version } \| { absolutePath; absent: true } }` | 文件树每个打开目录；每个被 pin 的文件资源（预览 tab、HTML 依赖） |

- 路径：read/readBytes/stat/changes(文件) 可指向工作区外（由 fs 后端权限决定）；list 与目录 watch 限定在工作区内。读文件拒绝末端符号链接；list 跟随目录链接。
- 配置默认：`maxBytes` 2097152（2 MiB，单页/单窗口）、`maxFileBytes` 33554432（32 MiB）、`maxLines` 5000、`maxEntries` 2000。
- 错误码与 details：
  - `workspace-file/not-found` `{ path }`
  - `workspace-file/outside-workspace` `{ path }`（list / 目录 watch）
  - `workspace-file/watch-unsupported` `{ path }`（如 SSH 后端；降级为手动刷新）
  - `workspace-file/too-large` `{ path, limit }`
  - `workspace-file/not-text` `{ path }`（非 UTF-8 或含 NUL）
  - `workspace-file/not-regular-file` `{ path, kind: "directory"|"symlink"|"other" }`
  - `workspace-file/not-directory` `{ path, kind: "file"|"symlink"|"other" }`
  - 客户端资源层另有：`workspace-file/unknown-workspace`（`absolute/` 地址无会话）、`workspace-file/unsupported-address`。
- 资源地址语法（`dsh-util-workspace-path`）：`dsh-resource://file/session/<encodeSegment(sid)>/<各段 encodeURIComponent，但保留 ":">`；`fileAddressFor(sid, cwd, path)`：相对路径直接用；绝对路径在 cwd 下 → 转相对；否则保留绝对（前导 `/` 保留，形成 `session/<sid>//etc/hosts`）。`\` 统一为 `/`，去掉前导 `./`。

#### 2.2 `officeToPdf`（`dsh-office-to-pdf`）

| 方法 | 参数 | 返回 value |
|---|---|---|
| `officeToPdf/generation` | `()` | `OfficeToPdfGeneration`（branded string，渲染引擎代次，缓存身份的一部分） |
| `officeToPdf/render` | `(sid, path, priority: "foreground"\|"background")`（客户端总用 foreground） | `RenderedDocumentBytes` = `WorkspaceFileBytes` + `{ missingFonts: string[]; generation: OfficeToPdfGeneration }`（`data` 为 PDF 字节，multipart） |

- 错误：`document-render/failed { reason: OfficeToPdfErrorCode }`，`OfficeToPdfErrorCode` = `'input-too-large' | 'output-too-large' | 'invalid-document' | 'unsupported-format' | 'invalid-output' | 'timeout' | 'unavailable' | 'failed' | 'busy' | 'source-changed'`；客户端映射：too-large→`tooLarge`、invalid-document/unsupported-format→`invalid`、timeout→`timeout`、unavailable→`unavailable`、busy→`busy`、source-changed→`changed`、其它→`failed`。服务缺失（`gateway/invocation-unavailable`/`service-unavailable`）→ `unavailable`。
- Host 端用 LibreOffice（`libreoffice-kit`），支持扩展名 `doc|docx|xls|xlsx|ppt|pptx`，但预览只把 doc/docx/ppt/pptx 送去转换。

#### 2.3 `session`（`dsh-api-session-controller`，仅 open-in-app 用到的）

| 方法 | 参数 | 返回 value |
|---|---|---|
| `session/canOpenWorkspacePath` | `()` | `boolean`（Host 有桌面） |
| `session/workspacePathApplications` | `(request: { path: string })` | `readonly NativeFileApplication[]`，`{ id: string; name: string; default: boolean; icon: string \| null /* data:image/png\|svg+xml;base64,… */ }` |
| `session/openWorkspacePath` | `(request: { path: string; action?: "reveal"; application?: string })` | `{ opened: true }` |

#### 2.4 HTTP 路由

| 路由 | 方法 | 请求 | 响应 | 调用方 / 时机 |
|---|---|---|---|---|
| `open-in-app/apps` | GET，`accept: application/json` | — | `{ "apps": string[] }`（目录 id，Host 菜单顺序；SSH 下为空） | open-in-app 每页一次 |
| `open-in-app/icon/<id>` | GET | — | PNG/SVG 图标（macOS 128px、Win 32px），无则 404 | `<img src>` |
| `open-in-app/open` | POST `content-type: application/json`（≤64 KiB） | `{ "app": "<id>", "path": "<绝对目录>" }` | 2xx 成功，否则失败 | 点击/快捷键启动 |
| `api/file?path=<encodeURIComponent(absPath)>` | GET/HEAD | — | 文件字节，`Content-Type` 按扩展名，头 `Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox; default-src 'none'`；400 缺 path/非绝对、404、403 非普通文件、413 超限（上限 = `attachments.imageLimits.maxImageBytes`） | Markdown 本地图片 |
| `api/changes.summary?sessionId=&seq=` | GET | — | `{ turn, files: WorkspaceChangedFile[], total, added, deleted }`；404 不可用 | changes-review |
| `api/changes.diff?sessionId=&seq=&index=` | GET | — | `WorkspaceFileDiff`：`{kind:"text",path,display,before:boolean,after:boolean,hunks:[{oldStart,oldLines,newStart,newLines,lines:string[] /*以 "+"," ","-" 开头*/}],coarse:boolean}` \| `{kind:"binary",path,display}` \| `{kind:"oversized",path,display}`；404 | changes-review |
| `api/changes.open?sessionId=&seq=&index=[&action=reveal][&application=<id>]` | GET → 关联应用列表（`NativeFileApplication[]`）；POST → 打开，204 | — | 409 无桌面；422 无 Host 路径；404 | `deliverables.review.file.actions` |
| `api/present.open?…`、`api/present.host` | 同上 / GET `{ name, available, fileManager: "finder"\|"explorer"\|…\|null }` | | | 交付卡片（非本范围） |

`WorkspaceChangedFile = { path: string; display: string; added: number; deleted: number; binary?: true; oversized?: true }`。`workspace/changes` 会话事件数据 `{ turn: number }`（seq 即该事件序号）。

**浏览器 tab 不使用任何 RPC / HTTP 路由**（无代理，`dsh-http-proxy` 是 Host 出站代理，与 UI 无关；Web 端 Desktop 的 webview 租约是 Electron IPC，iOS 不涉及）。

---

### 3. 客户端状态模型与本地持久化 key

| key / 存储 | 内容 | 生命周期 |
|---|---|---|
| `localStorage["dsh.sidebar-right.v1.<sessionId>"]` | `{"bySession":{"<sid>":{"layout":{…},"minted":N}}}`，layout = `{ nodes: {[id]: {kind:"pane",id:"paneN"\|"floatN",host:"dock"\|"float",tabs:["tabN"],activeTabId?,rect?:{x,y,width,height}} \| {kind:"split",id:"splitN",axis:"row"\|"column",children:[id,id],sizes:[f,f]}}, tabs: {[tabId]: {id,kind,contentId,title}}, rootId, floats: [paneId], activePaneId, expanded: boolean, mode: "push"\|"fullscreen" }` | 每次布局变化写入；读取时 zod 校验 + 引用校验（id 格式 `/^(pane\|float)[1-9]\d*$/`、`/^split…/`、`/^tab…/`，序号 ≤ minted，split 仅根、row、2 子、sizes 和为 1，float 必有 rect 且 1 tab），无效则删除该 key；undo 历史不持久化 |
| `localStorage["dsh.sidebar-browser.v1"]`（store persist） | `{ byTab: { [tabId]: BrowserNavigation 快照 } }` | tab 关闭删除 |
| `localStorage["dsh.open-in-app.choice"]`（snapshot store persist） | 最近一次成功选择的目录应用 id 字符串 | 永久 |
| 内存：guide pins | `unpinned: string[]`（`kind:entryId`） | 重载重置 |
| 内存：Tab 域 | 每 (session, tabId) 一个 occurrence：`{ id: uuid, signal, navigation: {address, params, revision}, commands: {refresh?}, paneId, tabActions: {bindCommands, openResource, openTab, close} }` | 记录消失才 abort；undo 恢复是新 occurrence |
| 内存：files store | `byTab[tabId] = { root, levels: {[absPath]: {kind:"loading"} \| {kind:"ready", level:{entries,truncated}, failure?} \| {kind:"failed", failure}}, expanded: string[] /*含 root*/, scrollTop, autoRefresh: true }` | tab signal 结束清除 |
| 内存：documentpreview store | `byTab[tabId] = { autoRefresh:true, resourcesDirty, loadRevision, version, observedVersion, pages: {[offset]: {text, lines}}, complete?: WorkspaceFileBytes, eof, loading, failure, scrollTop, wrap:true, revision /*已处理导航*/, rendererId?, mode?, contentRendererId? }`；zoom store、pdf store、office store（PDF 字节+missingFonts）另存 | 字节只在内存，从不持久化 |
| 内存：open-in-app | `apps: string[]\|null`、`operation: {phase:"idle"\|"busy"\|"error", path}`、`desktop: boolean\|null`、文件关联查询共享缓存（按 path，最后一个控件释放即取消） | 每页 |

- 打开 tab 清单 `sidebarRight.openTabs`：`[{ sessionId, tabId, kind, contentId }]`，启动时扫描所有 `dsh.sidebar-right.v1.*` key 得到（不挂载内容），供 provider 恢复（如终端重连、浏览器检查点清理）。
- 同源多窗口共享每会话最后保存布局；活动窗口不被其它窗口的写入覆盖。

---

### 4. 文档预览类型映射表

匹配基于 basename 小写后缀（`name.endsWith("."+ext)`，最长后缀优先）。“备选”= 下拉中的其它渲染器。

| 扩展名 | 默认渲染器（id 后缀） | loading | 备选 | wrap 开关 |
|---|---|---|---|---|
| `md`, `markdown` | Markdown（`/markdown`） | text-pages | 代码（md/markdown 也在代码表里）、纯文本 | 否（选代码/纯文本后有） |
| `html`, `htm` | HTML（`/html`） | bytes-complete | 代码、纯文本 | 否 |
| `png`,`jpg`,`jpeg`,`gif`,`webp`,`bmp`,`ico` | 图片（`/image`） | bytes-complete | 无（二进制） | 否 |
| `svg` | 图片 | bytes-complete | 代码（xml）、纯文本 | 否 |
| `pdf` | PDF（`/pdf`） | bytes-complete | 无 | 否 |
| `xlsx`, `xls` | 表格（`/excel`） | bytes-complete | 无（二进制） | 否 |
| `csv` | 表格 | bytes-complete | 代码（csv）、纯文本 | — |
| `tsv` | 表格 | bytes-complete | 纯文本 | — |
| `doc`,`docx`,`ppt`,`pptx` | Office→PDF（`/office`） | renderer | 无 | 否 |
| 代码表扩展名（见下） | 代码（`/code`） | text-pages | 纯文本 | 是 |
| 其它未知扩展名 / 无扩展名 | 纯文本（`/text`） | text-pages | — | 是 |
| `UNVIEWABLE_BINARY_EXTENSIONS` 中且无渲染器者 | 不支持态（不读取）+ 外部打开 | — | — | — |

- 代码表 `CODE_HIGHLIGHT_EXTENSIONS`（`dsh-util-code-language`，扩展名→语言）：typescript `ts tsx mts cts`；javascript `js jsx mjs cjs`；shellscript `sh bash zsh`；fish `fish`；json `json jsonc jsonl ndjson ipynb`；csv `csv`；python `py pyw pyi`；ruby `rb rake gemspec`；go `go`；rust `rs`；java `java`；c `c h`；cpp `cc cpp cxx hh hpp hxx`；csharp `cs`；kotlin `kt kts`；swift `swift`；php `php`；yaml `yaml yml`；toml `toml`；ini `ini conf cfg properties`；dotenv `env`；log `log`；diff `diff patch`；http `http`；markdown `md markdown`；mdx `mdx`；rst `rst`；latex `tex sty cls`；bibtex `bib`；asciidoc `adoc`；html `html htm xhtml`；css `css`；scss `scss`；less `less`；sql `sql`；xml `xml xsd xsl xslt plist svg`；lua `lua`；bat `bat cmd`；powershell `ps1 psm1 psd1`；r `r`；julia `jl`；dart `dart`；scala `scala`；clojure `clj cljs edn`；erlang `erl hrl`；elixir `ex exs`；haskell `hs`；fsharp `fs fsi fsx`；vb `vb`；perl `pl pm`；verilog `v`；system-verilog `sv svh`；graphql `graphql gql`；proto `proto`；hcl `tf tfvars hcl`；nix `nix`；vue `vue`；svelte `svelte`；make `makefile mk`；cmake `cmake`；groovy `gradle groovy`。
- `UNVIEWABLE_BINARY_EXTENSIONS`：`mp4 mov avi mkv webm flv wmv m4v mp3 wav flac ogg m4a aac wma opus zip gz tgz bz2 xz zst 7z rar tar jar doc docx xls xlsx ppt pptx odt ods odp pages numbers exe dll so dylib bin o class pyc wasm ttf otf woff woff2 eot dmg iso img sqlite db psd ai sketch tiff tif heic heif avif`（其中 doc/docx/xls/xlsx/ppt/pptx 有渲染器，故实际可预览；heic/heif/avif/tiff 在 Web 不预览——iOS 原生可额外支持）。
- 不可预览/失败兜底：①unviewable → “该格式文件暂时无法预览”+ 外部打开；②`not-text`/`too-large` → 同文案/上限文案 + 外部打开；③`not-found`/`not-regular-file` → 只说明；④其它 → 重试。目录地址以 `not-regular-file` 失败。
- 大库用途：`client.pdf.js` = PDF.js + worker + 内嵌数据（PDF 与 Office 转出的 PDF 共用）；`client.excel.js` = FortuneSheet + ExcelJS(patched) + SheetJS CE + PapaParse（Worker 解析）；`client.frontmatter-fields.js` = YAML 解析器，渲染 frontmatter 键值表。

---

### 5. Locale 表（完整照抄）

#### `sidebarRight`
| key | zh | en |
|---|---|---|
| command.close | 关闭当前页面／窗口 | Close current page or window |
| command.refresh | 刷新当前页面 | Refresh current page |
| command.noRefresh | 当前页面不支持刷新 | This page cannot be refreshed |
| command.toggle | 展开／收起右侧栏 | Toggle right sidebar |
| command.fullscreen | 面板全屏／退出全屏 | Toggle panel fullscreen |
| command.noSession | 请先选择会话 | Select a session first |
| command.noFocus | 请先聚焦右侧面板 | Focus a right sidebar pane first |
| command.stale | 页面已切换，请重新聚焦 | The page changed; focus it again |
| command.collapsed | 请先展开右侧栏 | Expand the right sidebar first |
| command.float | 浮动面板不支持此操作 | This action is unavailable in a floating panel |
| command.empty | 请先打开页面 | Open a page first |
| command.budget | 已达两格上限 | Two panes is the limit |
| command.width | 栏宽不足，拖宽侧边栏后再分栏 | Not enough width to split, widen the sidebar |
| chrome.expand | 打开侧边栏 | Open sidebar |
| chrome.expandAria | 打开右侧边栏 | Open right sidebar |
| chrome.collapse | 收起侧边栏 | Collapse sidebar |
| chrome.collapseAria | 收起右侧边栏 | Collapse right sidebar |
| chrome.toFullscreen | 全屏 | Fullscreen |
| chrome.exitFullscreen | 退出全屏 | Exit fullscreen |
| dock.emptyPane | 空面板 | Empty pane |
| dock.splitPane | 分栏 | Split |
| dock.splitPaneDisabled | 已达两格上限 | Two panes is the limit |
| dock.splitPaneNarrow | 栏宽不足，拖宽侧边栏后再分栏 | Not enough width to split, widen the sidebar |
| dock.closeTab | 关闭 | Close |
| dock.addTab | 新标签页 | New tab |
| dock.dockFloat | 收回到侧边栏 | Send back to the sidebar |
| dock.closeFloat | 关闭 | Close |
| dock.drop.center | 移到这里 | Move here |
| dock.drop.left | 左分栏 | Add left split |
| dock.drop.right | 右分栏 | Add right split |
| dock.drop.top | 上分栏 | Add top split |
| dock.drop.bottom | 下分栏 | Add bottom split |
| tab.guide.title | 开始 | Start |
| tab.guide.more | 更多工具 | More tools |
| tab.unavailable | 这类内容还没有可用的查看方式。 | Nothing here can view this kind of content yet. |

#### `sidebarFiles`
| key | zh | en |
|---|---|---|
| shortcut.noSession | 请先选择会话 | Select a session first |
| type.label | 文件 | Files |
| guide.title | 工作区文件 | Workspace files |
| guide.description | 浏览会话工作区的文件 | Browse files in this session's workspace |
| loading | 正在读取… | Reading… |
| empty | 空目录 | Empty directory |
| truncated | 条目太多，只显示了一部分。 | Too many entries, showing only some of them. |
| noWorkspace | 这个会话没有工作区目录。 | This session has no workspace directory. |
| reload | 重新读取 | Reload |
| autoRefresh | 自动刷新 | Auto refresh |
| autoRefresh.enable | 开启自动刷新 | Enable auto refresh |
| autoRefresh.disable | 关闭自动刷新 | Disable auto refresh |
| entry.other | 这不是文件或目录，没法打开。 | Not a file or a directory, so it cannot be opened. |
| error.notFound | 这个目录不在了。可能已被移动或删除。 | That directory is gone. It may have been moved or deleted. |
| error.outsideWorkspace | 这个目录在工作区之外，侧栏不会读取它。 | That directory is outside the workspace, so the sidebar will not read it. |
| error.notDirectory | 这不是一个目录。 | That is not a directory. |
| error.unavailable | 读取失败：{message} | Read failed: {message} |

#### `sidebarBrowser`
| key | zh | en |
|---|---|---|
| type.label | 浏览器 | Browser |
| guide.title | 浏览器 | Browser |
| guide.description | 浏览网页 | Browse web pages |
| shortcut.noSession | 请先打开一个会话 | Open a session first |
| address.placeholder | 输入 HTTP(S) 地址 | Enter an HTTP(S) address |
| address.changed | URL 已变化 | URL changed |
| back | 后退 | Back |
| forward | 前进 | Forward |
| reload | 刷新 | Reload |
| go | 前往 | Go |
| external | 在系统浏览器中打开 | Open in system browser |
| sandbox.disable | 关闭沙箱限制 | Disable sandbox restrictions |
| sandbox.enable | 恢复沙箱限制 | Restore sandbox restrictions |
| sandbox.warning | 沙箱限制已关闭；页面可以导航顶层应用，并使用下载、模态对话框与输入锁定。 | Sandbox restrictions are disabled; the page can navigate the top-level app and use downloads, modal dialogs, and input locks. |
| start | 输入 HTTP(S) 地址开始浏览 | Enter an HTTP(S) address to start browsing |
| loading | 正在打开… | Opening… |
| restore.previous | 上次打开 | Previously opened |
| restore.action | 恢复页面 | Restore page |
| error.empty | 请输入地址。 | Enter an address. |
| error.invalid | 这个地址无效或过长。 | That address is invalid or too long. |
| error.protocol | 只支持 HTTP 和 HTTPS 地址；本地文件请使用文档预览。 | Only HTTP and HTTPS addresses are supported; use Document Preview for local files. |
| error.credentials | 地址不能包含用户名或密码。 | Addresses cannot contain a username or password. |
| error.application-origin | 不能在嵌入浏览器中打开 DSH 应用自身。 | The embedded browser cannot open the DSH application itself. |
| load.failed | 页面加载失败；请刷新重试或在系统浏览器中打开。 | The page could not load; reload or open it in the system browser. |
| load.failed.detail | 页面加载失败 ({code}): {description} | Page load failed ({code}): {description} |
| address.unknown | 页面已跳转；当前载体无法读取新的 URL。 | The page navigated; this carrier cannot read its new URL. |

#### `sidebarDocumentPreview`
| key | zh | en |
|---|---|---|
| loading | 文档渲染中... | Rendering document... |
| loadMore | 加载更多 | Load more |
| changed | 文件已更新，当前显示为旧内容 | The file has changed, showing the previous content. |
| reloadNow | 重新载入 | Reload |
| reload | 重新读取文件 | Read the file again |
| autoRefresh | 自动刷新 | Auto refresh |
| autoRefresh.enable | 开启自动刷新 | Enable auto refresh |
| autoRefresh.disable | 关闭自动刷新 | Disable auto refresh |
| wrap.enable | 自动换行 | Turn on line wrap |
| wrap.disable | 取消换行 | Turn off line wrap |
| wrap.aria | 自动换行 | Line wrap |
| openWith | 打开方式 | Open with |
| viewer.text | 纯文本 | Plain text |
| resourceUnavailable | 文件资源服务不可用 | The file resource service is unavailable. |
| rendererUnavailable | 预览器 {name} 不可用 | The {name} preview is unavailable. |
| unsupportedFile | 该格式文件暂时无法预览 | Preview is not available for this file type yet. |
| error.notFound | 文件不存在，可能已被移动或删除 | File not found. It may have been moved or deleted. |
| error.tooLarge | 单页内容超过 {limit} 上限，无法读取 | This page exceeds the {limit} limit and cannot be read. |
| error.notText | 该格式文件暂时无法预览 | Preview is not available for this file type yet. |
| error.notRegularFile | 该路径不是普通文件，没有可显示的内容 | Not a regular file, nothing to display. |
| error.unavailable | 读取失败：{message} | Read failed: {message} |
| retry | 重试 | Retry |

（`{limit}` 由 `humanBytes`：≥1MiB → `N MB`，≥1KiB → `N KB`，否则 `N B`，四舍五入。）

#### `documentMarkdown`
| key | zh | en |
|---|---|---|
| viewer.label | Markdown | Markdown |
| code.copy | 复制 | Copy |
| code.copied | 已复制 | Copied |
| footnotes | 脚注 | Footnotes |
（代码另引用 `codeBlock.title` / `codeBlock.wrap` / `codeBlock.unwrap`，字典未定义。）

#### `documentHtml`
| key | zh | en |
|---|---|---|
| title | HTML | HTML |
| frame | HTML 文档预览 | HTML document preview |
| loading | 文档渲染中... | Rendering document... |
| failed | 无法预览这份 HTML 文档 | This HTML document could not be previewed. |

#### 缩放（并入 `sidebarImage` 与 `sidebarPdf`）
| key | zh | en |
|---|---|---|
| zoomControls | 缩放控件 | Zoom controls |
| zoomMenu | 选择缩放比例 | Choose zoom |
| zoomOut | 缩小 | Zoom out |
| zoomIn | 放大 | Zoom in |
| zoomFitWidth | 适应宽度 | Fit width |
| zoomValue | {percent}% | {percent}% |

#### `sidebarImage`（+缩放）
| key | zh | en |
|---|---|---|
| title | 图片 | Image |
| preview | 图片预览：{name} | Image preview: {name} |
| loading | 文档渲染中... | Rendering document... |
| failed | 无法显示这张图片 | This image could not be displayed. |
| unsupported | 图片预览需要完整文件内容 | Image preview requires the complete file contents. |

#### `sidebarPdf`（+缩放）
| key | zh | en |
|---|---|---|
| title | PDF | PDF |
| pageImage | PDF 第 {page} 页 | PDF page {page} |
| loading | 文档渲染中... | Rendering document... |
| rendering | 正在绘制页面… | Rendering page… |
| failed | 无法显示 PDF：{message} | Cannot display PDF: {message} |
| password | 此 PDF 需要密码，暂不支持预览 | This PDF requires a password; password-protected previews are not supported. |
| workerFailed | PDF 渲染进程无法继续，请重试 | The PDF rendering process could not continue. Please retry. |
| unsupported | PDF 预览需要完整文件内容 | PDF preview requires the complete file contents. |
| retry | 重试 | Retry |

#### `sidebarCodePreview`
| key | zh | en |
|---|---|---|
| title | 代码 | Code |
| copy | 复制 | Copy |
| copied | 已复制 | Copied |

#### `sidebarOffice`
| key | zh | en |
|---|---|---|
| title | Office 文档 | Office document |
| loading | 文档渲染中... | Rendering document... |
| retry | 重试 | Retry |
| viewMissingFonts | 缺失 {count} 种字体，点击查看 | Missing fonts: {count}. Click to view. |
| missingFontsTitle | 缺失的字体 | Missing fonts |
| missingFontsDescription | 本次预览无法使用以下字体，预览中的文字和排版可能与原文档不同。 | These fonts are unavailable for this preview. Text and layout may differ from the original document. |
| missingFontsCount | {count} 种字体 | Fonts: {count} |
| closeDetails | 关闭字体详情 | Close font details |
| unavailable | Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。 | Office previews are unavailable. Enable the document preview service on the computer running DeepSeek Harness. |
| invalid | 无法预览此 Office 文件。文件可能已损坏、受密码保护，或与扩展名不符。 | This Office file cannot be previewed. It may be damaged, password protected, or have the wrong extension. |
| tooLarge | Office 文件或转换后的 PDF 超过预览大小上限，请缩小文件或调整预览配置。 | The Office file or converted PDF exceeds the preview size limit. Reduce the file size or adjust the preview configuration. |
| failed | Office 转换失败，未生成可用的 PDF。请检查该文件后重试。 | Office conversion did not produce a usable PDF. Check the file and try again. |
| timeout | Office 转换超时，请重试。 | Office conversion timed out. Try again. |
| busy | Office 预览任务较多，请稍后重试。 | Office preview is busy. Try again shortly. |
| changed | 文件在读取时已更改，请重新打开预览。 | The file changed while being read. Reopen the preview. |

#### `sidebarExcel`
| key | zh | en |
|---|---|---|
| title | 表格 | Spreadsheet |
| language | zh | en |
| loading | 文档渲染中... | Rendering document... |
| invalid | 无法打开此表格。请检查文件格式、内容或密码保护。 | This spreadsheet could not be opened. Check its format, contents, or password protection. |
| tooLarge | 此表格超过预览大小限制。 | This workbook exceeds the preview size limit. |
| timeout | 打开表格超时。请缩小文件后重试。 | Opening this workbook timed out. Try a smaller file. |
| encoding | 无法识别此文本文件的编码。请另存为 UTF-8 或带 BOM 的 UTF-16 后重试。 | This text encoding could not be read. Save the file as UTF-8 or UTF-16 with a BOM and retry. |
| formulaWarning | 此工作簿包含公式，显示结果可能缺失或不准确。 | This workbook contains formulas. Displayed results may be missing or inaccurate. |
| unsupportedNotice | 当前预览不支持此工作簿中的{features}。请使用系统应用打开，以获得完整体验。 | This preview does not support {features} in this workbook. Open it in a system application for the full experience. |
| charts | 图表 | charts |
| images | 图片 | images |
| shapes | 形状 | shapes |
| conditionalFormatting | 条件格式 | conditional formatting |
| featureSeparator | 、 | ", "（逗号+空格） |
| retry | 重试 | Retry |

#### `open-in-app`
| key | zh | en |
|---|---|---|
| open.title | 用 {app} 打开 | Open in {app} |
| path.appDefault | {app}（默认） | {app} (default) |
| path.appsError | 无法获取应用列表 | Could not load applications |
| shortcut.busy | 正在打开工作区 | Opening workspace |
| shortcut.unavailable | 当前工作区或本地应用不可用 | Current workspace or local application unavailable |
| open.tooltip | 在本地打开 | Open locally |
| path.open | 打开 | Open |
| path.more | 更多打开方式 | More ways to open |
| path.reveal | 显示文件位置 | Show file location |
| path.openError | 打开失败，请重试 | Could not open. Try again. |
| path.revealError | 无法显示文件位置，请重试 | Could not show the file location. Try again. |
| app.finder | 访达 | Finder |
| app.explorer | 文件资源管理器 | File Explorer |
| app.filemanager | 文件管理器 | Files |
| app.terminal | 终端 | Terminal |
| app.cursor / vscode / vscodeinsiders / windsurf / zed / sublimetext / xcode / androidstudio / intellij / pycharm / webstorm / phpstorm / goland / rider / rustrover / fork / sourcetree / github / tower / gitkraken / smartgit / sublimemerge / ghostty / warp / iterm / kitty / windowsterminal / gitbash / gnometerminal / konsole | 中英同：Cursor / VS Code / VS Code Insiders / Windsurf / Zed / Sublime Text / Xcode / Android Studio / IntelliJ IDEA / PyCharm / WebStorm / PhpStorm / GoLand / Rider / RustRover / Fork / Sourcetree / GitHub Desktop / Tower / GitKraken / SmartGit / Sublime Merge / Ghostty / Warp / iTerm2 / kitty / Windows Terminal / Git Bash / GNOME Terminal / Konsole | 同左 |

（目录 id 白名单即 `APP_LABEL_KEY` 的 key：finder, explorer, filemanager, cursor, vscode, vscodeinsiders, windsurf, zed, sublimetext, xcode, androidstudio, intellij, pycharm, webstorm, phpstorm, goland, rider, rustrover, fork, sourcetree, github, tower, gitkraken, smartgit, sublimemerge, ghostty, warp, iterm, kitty, terminal, windowsterminal, gitbash, gnometerminal, konsole；Host 返回的 id 不在此表则不显示。）

#### `entryCustomization`
| key | zh | en |
|---|---|---|
| install | 浏览更多插件 | Browse other plugins |
| create | 创建你的插件 | Create your plugin |
| createPrompt.sidebar | 创建一个带左侧栏入口的 DSH 插件。 | Create a DSH plugin with a left sidebar entry. |
| createPrompt.conversation | 创建一个 DSH 会话视图插件。 | Create a DSH conversation view plugin. |
| createPrompt.rightbar | 创建一个带右侧栏入口的 DSH 插件。 | Create a DSH plugin with a right sidebar entry. |

#### 其它包中与右栏 tab 相关的 key（节选）
- `deliverables`（命名空间见该包 NS）：review.title 第 {turn} 轮改动 / Review · turn {turn}；review.selectFile 选择要查看的文件 / Choose the file to review；review.split 切换为左右对比 / Switch to split view；review.unified 切换为单栏对比 / Switch to unified view；review.splitAria 左右对比 / Split view；review.wrap 开启自动换行 / Enable line wrap；review.nowrap 关闭自动换行 / Disable line wrap；review.wrapAria 自动换行 / Line wrap；review.openFile 在侧边栏打开整个文件 / Open the whole file in the sidebar；review.openFileAria 在侧边栏打开 {name} / Open {name} in sidebar。
- `plan`：preview.title 计划 / Plan。
- `subagent`：sidebar.chat 聊天 / Chat；open.sidebar 在侧边栏打开 / Open in sidebar；open.sidebar.aria 在侧边栏打开 {label} / Open {label} in sidebar。
- session-inspector：tab.title 会话数据诊断 / Session Log；tab.description 在侧边栏分析当前会话原始日志和聊天分组数据 / Analyze raw logs and grouped chat messages for the current session in the sidebar.

---

### 6. 手机端 SwiftUI 对应建议

#### 6.1 容器 / 导航
- **数据模型**：照搬 per-session `RightbarSurface { tabs: [TabRecord], panes, activePaneId, expanded, mode }`；TabRecord 的 `kind/contentId/title` 与 Web 同构，便于将来与 Web 的 localStorage 格式互通（不必须）。持久化到 `UserDefaults`/文件，key 仿 `dsh.sidebar-right.v1.<sessionId>`。实现同样的 `openResource/openTab` 去重规则（资源全局去重、页按 pane 去重、multiple 类型每次新建）和“唯一 guide 不可关、唯一其它 tab 关闭=收起”规则。
- **iPhone**：右栏 = 会话页上的 `.sheet`（`presentationDetents([.medium, .large])`，可拖到全屏）或直接 `fullScreenCover`/push 一层“工具”页（Web 窄屏本来就是自动全屏，语义一致）。入口 = 会话导航栏右上角按钮（对应 `conversation.session.header.corner` 的镜像侧栏图标），多 tab 时顶部用横向滚动的 tab chip 条（或 `TabView(.page)` + 自定义指示器）；`+` 打开“开始”页；关闭 × / 长按 chip 弹 `contextMenu`（关闭 + 扩展菜单项）。**分栏、浮窗、拖拽改为不支持或降级**：iPhone 只用单格；`preferNewPane` 忽略。
- **iPad**：`NavigationSplitView` 三栏的 detail 右侧用 `.inspector(isPresented:)`（iOS 17+）承载右栏，宽度可拖；全屏模式 = inspector 隐藏后改为 `fullScreenCover` 或把 detail 列替换为右栏内容；可支持两格（`HStack` + 可拖分隔，比例 0.2–0.8），拖拽重排用 `draggable/dropDestination`；浮窗可不做（或用 Stage Manager 多窗口 `openWindow` 替代“浮出”）。
- **快捷键**（iPad 外接键盘）：`.keyboardShortcut` 映射 `sidebar.right.toggle`(⌘⌥B)、`pane.split`(⌘\)、`pane.fullscreen.toggle`(⌘⌥↩)、`page.close`(⌘W)、`page.refresh`(⌘R)、`workspace.files`(⌘P)、`browser.new`(⌘T)、`workspace.openLocal`(⌘⌥O)；并在菜单 `UIKeyCommand` 中显示 discoverability title（对应 locale 的 `command.*`）。
- **开始页（guide）**：`LazyVGrid`/`List` 卡片；≤4 个入口时显示描述；“更多工具”卡片 → `Menu`（浏览插件 / 创建你的插件，后者在新会话里预填草稿，不发送）。

#### 6.2 文件树
- `List` + `OutlineGroup` 或 `DisclosureGroup` 递归（懒加载：展开时调 `workspaceFiles/list`）；目录在前、`localizedStandardCompare` 自然序；`other` 行灰显不可点；截断/空/失败行作为 footer 文本。顶部 `PathLabel` 用 `Text(path).truncationMode(.head)` + `.help`/长按显示全路径；右侧“重新读取”按钮 + 下拉刷新 `.refreshable`。每个展开目录订阅 `workspaceFiles/changes` 流（`AsyncThrowingStream`），收到帧就重新 list；`watch-unsupported` 静默。点文件 → 在右栏打开预览（iPhone push 进 `NavigationStack`）。
- Web 无搜索/右键菜单；iOS 可选加 `.searchable`（本地过滤已加载节点）和 `contextMenu`（复制路径、在…中打开），但属新增功能，标注为增强。

#### 6.3 文档预览
- 头部：路径 + `Menu("打开方式")`（候选 >1）+ 换行 Toggle + 刷新 + “在应用中打开”`Menu`。变更横幅用 `.safeAreaInset(edge:.top)`。
- **文本/代码/Markdown（text-pages）**：`ScrollView` + `LazyVStack` 按行渲染（行号列 + 文本），滚动到底自动 `read` 下一页；`ScrollViewReader.scrollTo(line)` 实现行号导航；代码高亮可用 Highlightr/Splash/tree-sitter（语言表照 §4）；Markdown 用 swift-markdown + 自绘，或 `WKWebView` 渲染（frontmatter 用 Yams 解析成键值表）；本地图片：iOS 端无法直接 `<img src=api/file>` 时，用带认证的 `URLSession` 拉 `api/file?path=` 或改用 `readBytes`。
- **图片**：`UIImage(data:)`（SVG 需 WKWebView 或 SVGKit）；缩放用 `ScrollView` + `MagnifyGesture`，或 UIKit `UIScrollView` zoom；保留“适应宽度/25–400%”菜单。iOS 原生还能额外支持 HEIC/HEIF/TIFF/AVIF（Web 列为不可预览）。
- **PDF / Office**：`PDFKit.PDFView`（`autoScales` = 适应宽度，`displayMode .singlePageContinuous`，文字可选）；Office → 调 `officeToPdf/render` 拿 PDF 字节进 PDFView，缺字体警告做成工具栏黄色三角 `popover`。也可以 **QuickLook**（`QLPreviewController`）本地直接预览 docx/pptx/xlsx 作为离线兜底（需先 `readBytes` 落临时文件，受 32 MiB 上限）。
- **表格**：xlsx/xls/csv 简单方案用 QuickLook；要保留工作表标签、选择、公式栏等则用 `WKWebView` 嵌入一份 FortuneSheet bundle（可直接复用 `client.excel.js` 的解析思路），或用 CoreXLSX + 自绘 `Grid`（工作量大）。CSV/TSV 可原生解析（引号/多行字段规则见 README）后 `LazyVGrid`/`Table`（iPad）。
- **HTML**：`WKWebView`。静态模式：`loadHTMLString` 前做清洗（可在 WebView 里跑 DOMPurify）+ 注入同一 CSP meta，并 `WKWebpagePreferences.allowsContentJavaScript = false`；交互模式：允许 JS，用 `WKURLSchemeHandler` 自定义 scheme 拦截相对 `.js/.css` 请求转 `readBytes(baseFile:)`（比 Web 的预打包更自然，仍保持 4/32 MiB、64 个上限）。
- 不可预览：图标 + 文案 + 大号“打开/显示文件位置”按钮（open-in-app 文件动作，作用于 Host 桌面），并可加 iOS 本地 `ShareLink`/“用其他应用打开”（`UIDocumentInteractionController`，下载到临时目录后）作为增强。

#### 6.4 内置浏览器
- `WKWebView`（`SFSafariViewController` 不能嵌入 tab 且不能读 URL，故用 WKWebView）：工具栏后退/前进/刷新/地址栏/前往/“在 Safari 中打开”（`openURL`）；WKWebView 能拿到真实 URL 和 title，**不存在 Web 的 unknown 状态**，`canGoBack/canGoForward` 直接用；地址校验照搬 `parseBrowserAddress`（补 https、拒凭据、拒非 http(s)、拒应用自身 origin）。
- **localhost 难点**：iOS 上的 “localhost” 指手机本身，不是 Host 机器。Web 版 iframe 是由浏览器所在机器直接访问 URL；iOS 客户端连接的是远端 Host，loopback 预览需要把 `localhost/127.0.0.1` 改写成 Host 的局域网地址，或经 dev-tunnel；Web 版没有代理路由可复用（`dsh-http-proxy` 是 Host 出站代理，不是给 UI 用的）。需在 iOS 端明确设计（建议：检测 loopback 时提示/自动替换为连接所用的 Host 地址）。
- 沙箱开关：WKWebView 无 iframe sandbox 概念，可映射为“禁用 JS / 禁止弹窗 / 非持久 `WKWebsiteDataStore.nonPersistent()`”，或直接省略该开关并在文档注明。每 tab 一个 WebView；持久化 `{entries,index}` 以显示“上次打开 / 恢复页面”卡片（不自动加载）。
- ATS：允许任意 http 需 `NSAllowsArbitraryLoadsInWebContent`。

#### 6.5 在应用中打开
- 语义是“在 **Host 电脑**上用桌面应用打开”，不是在 iPhone 上打开。保留：会话导航栏 `Menu`（分体按钮在 iOS 用 `Menu(primaryAction:)` 实现：点按=默认应用，长按/箭头=列表），图标来自 `open-in-app/icon/<id>`（`AsyncImage` 带认证头）；记住选择存 `UserDefaults["dsh.open-in-app.choice"]`；文件动作用 `session/workspacePathApplications` + `session/openWorkspacePath`，底部固定“显示文件位置”。失败用 toast/banner。`canOpenWorkspacePath` 为 false 或列表为空时整组隐藏。

#### 6.6 难点 / 风险汇总
1. dockkit 布局（两格、拖拽、浮窗、undo 历史）在 iPhone 上无意义，需定义降级规则并保证与 Web 存储格式/语义（尤其默认页与关闭规则）兼容。
2. 文件预览的“多渲染器 + 分页 + 版本对账 + 自动刷新（changes 流）+ 行号导航”状态机较复杂，建议独立成 `DocumentPreviewModel` 精确移植 store 逻辑。
3. 表格（FortuneSheet 级别功能）与 HTML 交互预览原生实现成本高，倾向 WKWebView 复用 Web 资源。
4. 浏览器 tab 的 localhost 语义在远程客户端上不同，需要 Host 地址改写方案。
5. 二进制 Remote 走 multipart，iOS 连接层要支持（readBytes / officeToPdf/render）。
6. HTTP 路由是文档相对路径 + 浏览器认证，iOS 需在同一认证上下文中请求（`api/file`、`open-in-app/*`、`api/changes.*`）。
7. Browser 在 Web profile 默认禁用、session-inspector 为实验插件：iOS 是否默认显示需要按 profile/插件开关决定。

---

# D. 壳层浮层与入口（登录 / API Key / 首启引导 / 设置壳 / 会话顶栏 / Toast）

> 源：`engine/node_modules/@deepseek-ai/*/lib/client.js`（版本 `0.2.1-rc.4`）。
> 最权威的 slot 清单在 **`dsh-cordis-client-runner/lib/client.js` 的 `//#region lib/types/client/slot-catalog.js`**：每个 slot 带 `key/kind/doc/occupants/source`，等于官方的"谁注册了哪里"总表，本笔记的注册者列表均已与之核对。
> 标注 **[desktop-only]** 的分支以 `"dshDesktop" in globalThis` / `globalThis.dshPlatform` / `globalThis.dshOnboarding` 为门槛，纯 Web（含当前 iOS WKWebView 方案）不会走到。

---

### 0. 关键结论（先看这个）

1. **登录 = 浏览器 OAuth（PKCE S256）+ 本机回环回调**，不是扫码、不是手机号表单。Host 起 `/oauth/callback` 路由，`redirect_uri = ${callbackOrigin}/oauth/callback`，**`callbackOrigin` 必须是 `http://localhost|127.0.0.1|[::1]:<显式端口>`**（`dsh-deepseek-account-platform` 的 `loginOrigin()`，否则抛 `PlatformAuthError("protocol")` → attempt `failed`）。dsh-ios 引擎本机跑，回环可达 → 可直接用 `ASWebAuthenticationSession`/`SFSafariViewController` 打开 `authorizeUrl`，靠 `account/watch` 流判定成功后**由 App 主动关闭**会话（回调不会跳自定义 scheme）。
2. 登录对话框 SignInDialog 的两个按钮是 **「添加 API Key」/「登录」**，API Key 是登录的平级替代方案。
3. 首启引导有两套：
   - **Web 流（iOS 应照此）**：`settings.onboarding` 两步，`welcome-notice`（预览版说明，order -100，仅非 desktop）→ `deepseek-official`（order 0，无可用模型时弹「添加一个 API Key 开始使用」，先经 `settings.models.sign-in` 显示登录/API Key 二选一）。
   - **Desktop 流 [desktop-only]**：`shell.overlay` 的 `desktop-onboarding` 全屏 4 步（欢迎→准备额度→用途→过程展示），进度存在 Host settings 命名空间 `ui-settings-account`。数据层可移植，见 §6。
4. **设置按钮其实是账号菜单**：`settings.launcher`（AccountMenu）总是注册，SettingsRoot 里它优先于 `settings.trigger` 的默认按钮；"设置/意见反馈/登录|退出登录"三项菜单。
5. **账号分区只在已登录时注册**（`snapshot.view.status === "credential-stored"` 才 register `settings.section#account`），未登录设置里看不到「账号与余额」。
6. 全局 Toast：顶部居中 `top:40px`，默认 `holdMs=3000` + 1s 淡出后 `onDone`；`tone:"success"` 显示对勾；可带 `actions:[{prefix,label,onClick}]` 文字按钮。没有统一队列，每个 overlay 自管一个。
7. 断线提示不在 toast，而在**侧栏底部设置行旁的 ConnectionIndicator 药丸**（仅侧栏展开时），三态：断开/重连中/已恢复(2s)。

---

### 1. 功能清单（按钮/菜单项级）

#### 1.1 账号菜单 `settings.launcher` → `AccountMenu`（dsh-client-ui-settings-account）
| 功能 | 交互细节 / 触发条件 | 限制 | RPC |
|---|---|---|---|
| 触发按钮 | 侧栏底部。已登录：头像（`profile.avatarUrl`，`referrerPolicy:no-referrer`，加载失败回退 `IconUserOutlineMedium`）+ 宽侧栏时显示名字 `profile.name ?? profile.contact ?? t("signedIn")`（资料加载中为空）。未登录：`IconEllipsisOutlineMedium` + 宽侧栏显示「更多」。aria-label「账号菜单」。点击开合 Menu（`side:"top"`）| 窄侧栏（rail）只显图标 | — |
| 菜单项 `settings`「设置」| 图标 `IconSettingsOutlineMedium`，带快捷键提示（`settings.open`：desktop `Cmd/Ctrl+,`，web `Cmd/Ctrl+Alt+,`）；点击关菜单→打开设置面板 | | — |
| 菜单项 `contact`「意见反馈」| 图标 `IconPaperPlaneOutlineMedium`；`window.open(contactUrl(...))` 打开飞书问卷，URL 带 `hide_uid/hide_source/hide_harness_version/hide_device_info=1` 与 `prefill_uid=<profile.id>`、`prefill_harness_version=0.2.2-rc.1`、`prefill_device_info=<UA; screen_resolution=WxH>`。默认问卷地址来自 `ContactConfig.contactFormUrl`（可被 `globalThis.__DSH_CONTACT_CONFIG__` 覆盖）| 无需登录 | — |
| 菜单项 `signin`「登录」| 未登录时出现，`IconUserOutlineMedium`；→ `start()` 打开 SignInDialog 并发起登录 | | `account/startSignIn` |
| 菜单项 `signout`「退出登录」| 已登录时出现，自定义 Logout 图标；先查 `hasRunningAccountTasks` 再弹 SignOutDialog；查询中 `disabled` | | `account/hasRunningAccountTasks` |
| 打开设置时刷新 | 设置面板 closed→open 时 `refreshAccount()`：头像失败重试 + 资料 + 余额 + 赠金通知 | | `account/getProfile`、`account/getBalance`、`account/getUnnotifiedBonuses` |
| Toast「当前模型暂不可用，请登录后再试」| Host 事件 `deepseek-account/model-sign-in-required` 触发（每次 +1 重挂载）| | 事件 |
| Toast「登录信息已失效，请重新登录」| Host 事件 `deepseek-account/session-expired`（服务端 401/40003 删除凭证时 emit，不重放）| | 事件 |
| 赠金通知卡片栈 | 已登录且非引导中、`account.notices` 非空时，在账号按钮上方 portal 一叠卡片（宽 ≈280，`left=max(8,min(rect.left, innerWidth-288))`，`bottom=innerHeight-rect.top+4`），后面的卡片按 `(272/280)^depth` 缩小。标题 `notice.title ?? "赠金已到账"`，正文 `notice.message`（服务端本地化纯文本），右上角关闭（×10）。`expiresAt` 已过的不画。**前景卡完成一帧绘制且页面可见即视为"已展示"** → 排队 `ackBonusNotified`；关闭也算展示。ack 失败指数退避 `bonusAckRetryDelayMs=1000` 起，上限 `bonusAckRetryMaxDelayMs=60000`；返回 false 不重试 | 每个 orderId 只 ack 一次 | `account/getUnnotifiedBonuses`、`account/ackBonusNotified` |
| 登录弹窗 | `account.loginVisible && !account.onboarding` 时渲染 SignInDialog（见 1.2）；其「添加 API Key」→ `openOnboarding("deepseek-official")`（关设置，显式请求该引导步）| | |
| 退出确认 | 见 1.3 | | |

#### 1.2 登录对话框 `SignInDialog`（Modal headless，标题随状态变）
- 状态由 `account/watch` 流的 `AccountView.attempt.phase` 驱动：
  - 空闲：标题「开始使用」，正文「登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。」；按钮 [添加 API Key]（outline）[登录]（primary）。
  - `initializing|waiting-browser|exchanging|committing`：标题「等待登录」；正文「没有自动打开新页面？[复制登录链接]，手动打开登录页完成登录。」——中间是可点链接按钮（`authorizeUrl` 未到前禁用），复制的是 `authorizeUrl?theme=light|dark`；复制后 2s 内显示「链接已复制」/「复制失败」，换 attempt 时重置。按钮 [取消]（outline）[spinner]（primary 禁用，aria「请在浏览器中继续」）。`committing` 时两按钮都禁用、不可关闭。
  - `expired`：标题「登录已超时」，正文「请重新登录后继续操作。」，主按钮「重新登录」。
  - `failed` 或本地失败：标题「登录失败」，正文 `errorCode==="no-response"` 时「操作未完成，可能是网络异常，请检查你的网络状况后重试」，否则「操作未完成，请重试。」；主按钮「重新登录」。
- 关闭（×/Esc/取消）：若 attempt 活跃 → `cancelSignIn(attempt.id)` 再关；`committing`/busy 时忽略。
- 重试：活跃则先 cancel，再 `startSignIn`。
- `view.status === "credential-stored"` → 自动关闭。
- Web 打开浏览器方式（`BrowserLogin`）：点击「登录」当下同步 `window.open("about:blank")` 预开标签（避开弹窗拦截）→ RPC 返回后跟随该 attempt；流帧出现 `authorizeUrl` 时 `popup.location.replace(authorizeUrl?theme=…)`；phase 变 `failed|expired|cancelled` 关标签；`succeeded` 若还没导航就关。被拦截则只能用「复制登录链接」。
- [desktop-only] desktop 不开标签，`loginSource:"desktop"`，由 Electron 原生打开。
- 登录成功（流帧首次出现 `credential-stored` 且 `attempt.phase==="succeeded"`）→ 客户端调用 `session/initializeDefaultModel()`（失败只 console.error）。

#### 1.3 退出登录确认 `SignOutDialog`
- 标题/主按钮「退出登录」，[取消]；正文按 `hasRunningAccountTasks` 结果三选一：
  - `false`：「退出登录不会丢失任何数据，你仍可以登录此账号。」
  - `true`：「当前有进程正在执行中，点击"退出登录"，将会打断进程，是否即刻退出登录？」
  - 查询失败 `"unknown"`：「暂时无法确认任务状态。退出登录可能会中断使用此账号的任务，是否继续？」
- 失败时下方红字「操作未完成，请重试。」；成功即关。Host 侧：取消进行中的 attempt、删凭证、后台带重试撤销 token（`logoutMaxRetries=5`），emit `deepseek-account/signed-out`。

#### 1.4 设置 → 账号与余额 `settings.section#account`（order -10，仅已登录注册）
- 身份卡：头像 + 名字（`profile.name ?? "已登录 DeepSeek"`）+ 状态行（优先级：失败「操作未完成，请重试。」> 过期「登录已过期，请重试。」> 进行中「正在发起登录…/请在浏览器中继续/正在完成登录…」> 已登录显示 `profile.contact`（平台已打码）或「加载中…」/「账号资料暂不可用」）；右侧链接「更多账号信息 ↗」→ `new URL("/", links.usageUrl)`（即平台首页）。
- 登录进行中额外一行：[打开浏览器]（链到 `authorizeUrl?theme=`）[取消]。
- 余额卡：
  - 行「充值余额」：`balance.value[]` 每个钱包 `formatBalance(balance, CNY?"¥":"$")`；加载中「加载中…」；读失败显示链接「前往开放平台查看」→ `usageUrl`。
  - 行「赠金余额」：只列 `balance>0` 的 `bonusWallets`；全为 0 且已加载则整行隐藏。
  - 行「更多」：[查询用量] → `links.usageUrl`；[充值]（primary）→ `links.topUpUrl`。Web 新标签；[desktop-only] 嵌入原生 Platform 页（`AccountPlatformHost`，顶栏「返回 DeepSeek Harness」，失败「操作未完成，请重试」+[重试]），返回自 top-up 后重新拉余额。
- `formatBalance` 规则：0 → `¥0.00`；负且 >-0.01 → `-¥0.01`；0<x<0.01 → `<¥0.01`；其余向下截断 2 位 + 千分位。
- 未登录分支（理论上只在注册瞬间可见）：「当前未登录 DeepSeek Harness 账号」/「登录 DeepSeek Harness 账号获取专属 API Key」+[登录]。

#### 1.5 额度不足提示 `shell.quota-notice`
- 触发：ui-chat 的 `QuotaNoticeHost`（`shell.overlay#chat.quota-notice`）监听每个 Session 事件流，`turn/end` 且 `reason.kind==="error"` 且 `reason.error.code ∈ {"QUOTA","ACCOUNT_QUOTA"}` → 设置一条 notice（被 hold 时不覆盖）。`ACCOUNT_QUOTA` 来自 `dsh-llm-deepseek-account` 把账号路由的 `QUOTA` 重映射。
- 链式选择：`AccountQuotaNotice` 的 `select: owner.code === "ACCOUNT_QUOTA" ? owner : null`。
  - 认领后：账号状态未知且有原生 Platform → 不画；**未登录或无原生 Platform（即 Web/iOS）→ 退化为警告 Toast**（文案 `message.failure.quota`「当前请求的额度已用尽」）；已登录+原生 Platform → Modal「当前无可用余额」/「没有可用额度时，DeepSeek Harness 无法开始新的任务，是否前往充值？或者可以稍后前往 设置 → 账号与余额 进行充值。」[取消][去充值]，去充值 `keepOpen()` 防止被新错误覆盖并打开 top-up 页。登录态从已登录变未登录时自动 dismiss。
  - 未认领（`QUOTA`，API Key 路由）→ Host 兜底警告 Toast「当前请求的额度已用尽」。
- iOS 建议：已登录时也用 Modal（能力等同 desktop），「去充值」→ SFSafariViewController 打开 `links.topUpUrl`，关闭后 `refreshAccount()`。

#### 1.6 API Key / 模型引导（dsh-client-ui-settings-models，壳层部分）
- `deepseek-official` 引导步（`DeepSeekOnboardingDialog`）条件：`credentialOnboarding`（`globalThis.__DSH_MODELS_ONBOARDING__.credentialOnboarding`，默认 true，且非 desktop）或显式请求（`explicit`）。
- 就绪判定 `onboardingReadiness(state)`：`loading` → 不画；读失败 `unavailable`；**任一 provider 可用**（`active` 且：账号路由需 `accountAvailable===true`；无 `apiKeyEnv` 视为可用；否则 `credential.configured===true`）→ `provider-ready`（自动模式下结束此步）；找不到 `provider==="deepseek-official" && settingsNs==="llm-deepseek" && settingsPath=[]` 行 → `adapter-absent`；inactive/凭证不可读/只读设置/凭证不可写 → `unavailable`；否则 `credential-missing` → 弹窗。
- 弹窗：未选 API Key 时先渲染 `settings.models.sign-in`（= AccountOnboarding → 上面的 SignInDialog，`close` 时 `complete()` 结束此步；登录成功也 `complete()`）；点「添加 API Key」或显式进入 → OnboardingModal「添加一个 API Key 开始使用」/「配置 DeepSeek 官方模型，即可开始使用。」+ ProviderEditor（`credentialOnly`、`credentialRequired`、自动聚焦），按钮 [稍后配置][保存并继续]（保存中「保存中…」）。保存埋点 `api_key_save_click`。
- Modal 不可隐式关闭（`onClose` 空函数），`#root.inert=true`。
- API Key 前端校验 `apiKeyFailure(draft)`：空串允许（=保留已存）；全空白 → `keyBlank`；匹配 `^[A-Z][A-Z0-9_]*=[^=]`（粘贴了 `NAME=value`）或被成对引号包裹 → `keyIllegalCharacters`；非 `^[\x21-\x7E]+$` → `keyIllegalCharacters`；必填时空 → `keyRequired`。输入框 `type=password` 可切换明文（「显示密钥/隐藏密钥」）。
- 保存：`credentials/set("DEEPSEEK_API_KEY"（=该行 apiKeyEnv）, value)`，随后 reload models；监听 `settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated`、`llm/adapters-updated`、`connection/reset` 刷新。

#### 1.7 欢迎 / 首启弹窗总表
| id | 来源 | 触发条件 | 持久化 | 文案/按钮 |
|---|---|---|---|---|
| `welcome-notice` | settings-models `WelcomeNotice`，`settings.onboarding` order -100，**仅非 desktop** | 引导激活（见下）且 `ui-settings-general.welcomeNoticeVersion !== "2026-09-28.1"` | `settings/mutate("ui-settings-general", [{op:"set",path:["welcomeNoticeVersion"],value:"2026-09-28.1"}])`（经 configForms `scope.set`）| 标题「预览版说明」，两段正文，[继续]；失败红字「暂时无法保存确认状态，请重试。」 |
| `deepseek-official` | settings-models，order 0 | 引导激活 + 无可用 provider + 官方凭证缺失 | 无（以凭证存在与否为准）| 见 1.6 |
| `desktop-onboarding` [desktop-only] | settings-account `shell.overlay` | 已登录 + `ui-settings-account.step !== "done"` + 设置可写 | `ui-settings-account` 命名空间：`{version:1, step:"welcome"\|"credit"\|"purpose"\|"process"\|"done", purpose:"office"\|"development"\|"both"\|null, process:"compact"\|"standard"\|"detailed"\|null, completion:"completed"\|"skipped"\|"api-key"\|null, usage:"compact"\|"detailed", developerTools:boolean}` | 见 1.8 |
| 登录对话框 | settings-account | 用户点登录 / 引导 sign-in 步 | — | 见 1.2 |

**引导激活条件**（`SettingsRoot`）：`sessions.phase==="ready"` 且（没有被 `retainedBy.mainView>0` 持有的会话，或该主会话 `blank`）——即"停在空白新会话首页"。按 order 依次挂载**一个**未完成步骤；离开空白首页时清空"已完成"集合（下次回到空白页会重新评估）。一个步骤出现时若设置面板开着则关闭它。显式请求（`openOnboarding(id)`）不受激活条件限制。

#### 1.8 [desktop-only] Desktop 首启 4 步（可选移植）
- 全屏 portal（`#root` 透明 + inert），顶部可拖拽带。加载中显示「正在加载设置…」。
- welcome：「欢迎使用 *DeepSeek Harness*」+ 介绍 + [开始设置] → step=credit。右侧插画（zh/en × light/dark 4 张 webp）。
- credit：「准备可用额度」+ 说明；有余额（充值或赠金任一 >0）时 [继续]/[去充值]；无余额时 [去充值]/[下一步]；「下一步」在已确认零余额时弹确认「暂时跳过充值？」[我知道了]→purpose /[前往充值]。
- purpose：「你希望 *DeepSeek Harness* 帮你做什么？」两张可多选卡片：办公与创作（word/ppt/excel/pdf/image 图标）、代码与开发（ts/js/sql/python/cpp）；选了才出现 [继续]；只选办公 → 直接完成。
- process：「你希望看到多少工作过程？」单选：聚焦结果 compact / 关键细节 standard / 完整过程 detailed；选了出现 [进入应用]。
- 底部：非 welcome 步有 [← 上一步] 与 [跳过]；跳过 → 确认「跳过设置？」[继续设置][进入应用]（credit 步跳过走"暂时跳过充值？"）。
- 完成写入：office → `process:"compact", usage:"compact", developerTools:false`；development/both → 选的 process、`usage:"detailed"`、`developerTools:true`；skipped → `process:"standard"`、`usage:"compact"`、`developerTools:false`。先写 `ui-chat` 的 `transcriptView`/`performanceUsage`，再写 `ui-settings.enabled`（developerTools），最后写进度 `step:"done"`。
- 未登录但已有 API Key（`dshOnboarding.hasApiKey()`）→ 自动写 `{step:"done", process:"standard", usage:"detailed", developerTools:true, completion:"api-key"}`。
- 埋点：`onboarding_page_view{page_name}`、`onboarding_page_click{page_name,button_name,selected_content?}`、`onboarding_popup_view/click`。page_name：`onboarding_welcome|onboarding_recharge|onboarding_use_case|onboarding_process`。

#### 1.9 设置壳（dsh-client-ui-settings-general；`dsh-client-ui-settings` 只提供 `configForms` 服务，无 UI）
- 状态 store：`{open:boolean, activeId?:string}`，动作 `open/close/select(id)/openSection(id)`（close 清 activeId）。
- 入口：`sidebar.settings`（侧栏底部）→ `SettingsRoot`：一行里 = `settings.launcher`（账号菜单，存在时替代默认按钮）｜默认 fallback：齿轮按钮 tooltip「设置」+ `settings.trigger`（齿轮 16/18 + 宽侧栏标签「设置」）｜ConnectionIndicator ｜ DesktopUpdateIndicator。
- 快捷键 `settings.open`（label「打开设置」，aliases `settings`/`preferences`）：desktop `Primary+Comma`，web `Primary+Alt+Comma`；设置已开时再按 = 关闭。
- 面板（760×500 居中 modal，遮罩点击/Esc/× 关闭）：左栏 = `settings.header`（标题「设置」）+ 分区导航（图标按 id：account→User，models→Data，agent-presets→AgentPreset，plugins→Personalization，archived-sessions→Archive，其余→Settings 齿轮），默认选第一项；右栏顶部 = `settings.action` 列表 + 关闭按钮（无障碍文本来自 `settings.close`「关闭」）；内容 = 当前 `settings.section`（传 `{close}`）。
- `settings.action#open-document`「打开配置文件」：**仅 loopback 连接**（`ctx.remote.$host.isLoopback`）且 `settings.describe().hasDocument` 时出现；→ `settings/openSettingsDocument()`，失败「无法打开配置文件」。iOS：Host 机上开文本编辑器无意义，建议隐藏或改为"导出/查看配置"。
- 通用分区 `general`：只是 `settings.general.item` 的竖排容器，条目见 §4。
- `sidebar.toggle.badge` = `DesktopUpdateBadge`：侧栏折叠时展开按钮上的蓝点，**含义=桌面端有可用更新/更新进行中/更新失败**（断线/连接中时隐藏，除非正在 installing）；tooltip 为更新状态文案。Web/iOS 无 `dshDesktop.updates` → 永不显示。
- DesktopUpdateIndicator [desktop-only]：宽侧栏底部按钮，phase `checking|available|downloading|verifying|installing|ready|error` 对应文案，点击 `bridge.open()`。
- 关于/版本：通用分区 `current-version` 行「当前版本：0.2.2-rc.1」（order 100）；无独立"关于"页、无"检查更新"按钮（Web）。
- 反馈：账号菜单「意见反馈」；会话顶栏 ⋯ 菜单「反馈」（需 `feedbackUi` 服务）。
- 退出：账号菜单「退出登录」。无"退出应用"。

#### 1.10 连接状态 ConnectionIndicator（SettingsRoot 内，仅宽侧栏，桌面 installing 时让位）
- `connection.state ∈ 'connected'|'disconnected'|'connecting'`（`connection` 服务）。
- `disconnected` → 警告药丸按钮「连接异常，刷新重试」（aria「连接异常，点击立即重连」），点击 `connection.reconnect()`。
- `connecting` → 药丸「重新连接中…」（三点动画 + spinner，aria「连接中断，正在重试，点击立即重连」，可点立即重连）；至少显示 `CONNECTING_MIN_VISIBLE_MS=800`。
- 从 disconnected/connecting 恢复到 connected → 成功药丸「连接成功」显示 `RECOVERY_CONFIRMATION_MS=2000`，退出带 leaving 动画。
- 客户端在 `connection/reset` 本地事件上重读 settings.describe、刷新 models 等。
- 断线期间 `DesktopUpdateBadge` 隐藏。

#### 1.11 服务版本变化弹窗 `shell.overlay#host-release-change`（`HostReleasePrompt`）
- 重连到运行另一 release 的 Host 时（`ctx.modules.entries.releaseChange`）弹 Modal「服务版本变化」/「服务版本已变化，本页面已暂停热更新，刷新后加载新版本。」，两行迁移图：服务 `prev → host`（实线完成）、页面 `page → host`（虚线待完成），版本号相同时改显 commit；[暂不刷新]（=关闭，`dismissRelease`）[刷新以加载新版本]（`location.reload()`）。
- iOS 原生：对应"引擎升级后 App 内 JS 插件需重载"，可在原生端比较 Host 版本，提示重启引擎/刷新会话缓存。

#### 1.12 会话顶栏（dsh-client-ui-conversation）
结构：`main`（keyed，默认 key `conversation` → `ConversationPanel` → `main.conversation` → `ConversationMainPanel`）→ `conversation.header`（`ConversationHeader`，常驻，`data-window-drag`）：
- 左：`conversation.header.leading`（全局导航，无注册者；侧栏完全隐藏时由 `shell.leading` 的 HeaderLeadingControls 提供重新打开侧栏/新会话）。
- 无会话时：空 titleRow；有会话 → `conversation.session.header`（`ConversationSessionHeader`，`hideChrome = 会话 blank 且对话阶段 blank`，即空白首页隐藏标题与按钮）：
  - **面包屑标题**（`nav` aria「会话层级」）：沿 `origin==="subagent"` 的 `parentId` 向上推出祖先链，`a / b / c`，非末项是按钮（点击打开该会话），末项纯文本 `displayTitle`；**标题不可在顶栏编辑**（重命名在侧栏 `shell.overlay#workspace.session-rename`）。无祖先信息时显示 sessionId。
  - `conversation.session.header.lineage`：子智能体面包屑由 `SubagentHeaderLineage` 替换为"标题+▾切换器"（aria「切换子智能体：{title}」），末项再附子会话计数下拉。
  - `conversation.session.header.actions`（标题旁，升序）：见下表。
  - `conversation.session.header.utilities`（右对齐，升序）。
  - `conversation.session.header.corner`（最右角，一个控件）。
  - 第二行：**View 标签行**（仅 `tabs.length>1`）：`role=tablist`，`chat` 固定第一，其余已 pin 的按注册序；有 `views.actions` 注册时按宽度 `floor((rowWidth-48)/120)` 截断，多余进 ⋯「更多会话视图」菜单（内容由 `conversation.session.header.views.actions` = entry-customization 渲染，可打开视图/切换 pin）。标签宽 88px 超出显示 tooltip。pin 状态内存态（`createViewPins`，`chat` 不可取消）。已注册 View：`chat`（ui-chat）、`trajectory`（ui-trajectory，"显示代码工作视图"开启时）。

| slot | id | order | 注册包 | 组件 | 功能一句话 |
|---|---|---|---|---|---|
| actions | `agent-team` | -20 | experimental-client-ui-agent-team | TeamAction | `IconUsersOutlineRegular`「智能体团队」弹层：成员列表 + 共享任务（空：「暂无共享任务，可以通过对话创建」），可点成员打开 teammate 会话 |
| actions | `agent-preset` | -10 | client-ui-agent-preset | AgentPresetLabel | 显示本会话 Agent 预设（`IconAgentPresetOutlineRegular`+名称），tooltip「本任务的 Agent 预设，在任务开始时确定」；无预设不显示 |
| actions | `subagent-catalog` | 10 | client-ui-subagent | SubagentCatalogAction | 根会话的子智能体计数下拉（aria「子智能体会话」树），可打开子会话或在侧边打开；子会话本身不显示 |
| actions | `job-list` | 20 | client-ui-jobs | JobListAction | 后台任务下拉：按钮文案「{n} 个后台任务运行中」/「{n} 个后台任务」，弹层分「进行中」「已结束 {count}」+「清空」，可展开输出、终止；无任务不显示 |
| utilities | `open-in-app` | -10 | client-ui-open-in-app | SessionOpenInAppAction | 用本机应用打开会话 cwd（「在本地打开」/「用 {app} 打开」/「更多打开方式」）；**iOS 不适用**（Host 本机 App） |
| utilities | `schedule-catalog` | -5 | client-ui-schedule | ScheduleCatalogAction | `IconClockOutlineRegular`「提醒」/「{n} 个…」下拉：本会话活动提醒列表、下次运行时间、打开详情、删除（trash）；无提醒且无错误不显示 |
| utilities | `session-log-download` | 0 | session-log-export | SessionLogDownloadHeaderAction | ⋯「更多操作」菜单：「下载 Session 日志」（HEAD 后下载 `api/session.export?sessionId=…&includeDescendants=true`，文件名 `dsh-session-<id>.zip`）、「反馈」（`feedbackUi.openSession(sessionId)`，有该服务才出现）|
| corner | — | — | client-ui-sidebar-right | ExpandButton | `IconPanelLeftOutlineRegular`「打开侧边栏」（aria「打开右侧边栏」），右侧栏收起时展开；有快捷键提示 |
| views.actions | `entry-customization` | — | client-ui-entry-customization | EntryMenuContent | 更多视图菜单行：隐藏的 View + pin 勾选；另含「浏览更多插件」「创建你的插件」入口 |
| lineage | — | — | client-ui-subagent | SubagentHeaderLineage | 子会话面包屑的同级切换器 |

#### 1.13 新会话首页 Hero（`conversation.content`，phase `hero`）
- 判定：无 sessionId，或会话 phase blank 且（`openState==="open"` 或 summary.blank）；加载中为 `settling`。
- 内容（自上而下）：HeroShell 标题行 = `conversation.hero.brand.mark`（无注册者，fallback 34px 鲸鱼 logo，hover 游动动画）+「探索未至之境」+ 胶囊「预览版」。
- 工作区行：WorkspaceChip（文件夹图标 + 工作区名 + ▾；无则「选择工作区」；`default-workspace` 显示为「默认工作区」）→ 打开 `conversation.hero.workspace`（WorkspacePicker，`{open, anchorRef, selectedId, onPick, onClose}`；其下 `conversation.hero.workspace.directoryFlow` 选目录：browse 或 native）；`conversation.hero.agentPreset`（AgentPresetSeat，选预设）；有会话时右侧 `conversation.hero.options`（无注册者）。
- `conversation.input.dock` + 输入框 `conversation.composer.bar`（variant `hero`，占位「描述你想要构建的内容, / 调用指令, @ 文件或对话」；未选工作区时禁用，占位「选择一个工作区开始」，点击请求打开工作区选择器）。
- 选工作区 `selectWorkspace(id)` 把新会话流迁到该工作区的空白会话。

#### 1.14 全局 Toast / 通知 / 错误弹窗
| overlay id / 位置 | 注册包 | 何时出现 | 类型 |
|---|---|---|---|
| `chat.quota-notice` | ui-chat | 回合以 QUOTA/ACCOUNT_QUOTA 结束 | 警告 Toast 或账号 Modal（1.5）|
| `plugin-manager.refresh-toast` | plugin-manager | 插件列表刷新失败 `notice.kind==="refresh-failed"` | 警告 Toast（`refreshError`）|
| `schedule.delete-toast` | ui-schedule | 删除任务 | 成功「任务已删除」/警告「无法删除任务」|
| `session-log-upload-toast` | settings-session-log | 切换"上传 Session Log"开关后 | 成功「设置已保存」/「无法保存设置」|
| `workspace.row-toast`（下挂 keyed `workspace.toast`）| ui-workspace | 复制 ID、置顶失败、归档、新建失败、fork 需先打开等 | `sessionIdCopied`「Session ID 已复制」、`sessionIdCopyFailed`「复制失败，请重试」、`pinFailed`、`unpinFailed`、`archivedNotOpenable`、`archived`「会话已归档，可 [撤销] 或 [筛选已归档会话]」、`stoppedAndArchived`、`createFailed`「新建会话失败：{message}」、`forkRequiresOpen`+[打开原会话]、`defaultWorkspaceFailed`、`shortcutForkFailed` |
| `workspace.session-rename` / `workspace.session-archive` | ui-workspace | 重命名 / 归档确认对话框 | Modal |
| `shortcuts` | ui-shortcuts | 快捷键速查 | 面板 |
| `host-release-change` | settings-general | Host release 变化 | Modal（1.11）|
| `desktop-onboarding`、`account.platform-page` | settings-account | [desktop-only] | 全屏 |
| AccountMenu 内部 Toast | settings-account | model-sign-in-required / session-expired | Toast |
- **Toast 原语**（`@deepseek-ai/dsh-client-ui-primitives` Toast，bundle 于 `dsh-web-frontend/dist/assets/index-*.js`）：props `{text, icon?, tone?:"success", anchor?, holdMs=3000, actions?:[{prefix?, label, onClick}], onDone}`；`role=alert`，portal 到 body，`position:fixed; top:40px; left:50%`（有 anchor 时 left=anchor 中心），最大宽 `min(640px, 100vw-48px)`，入场 0.16s 下滑，`holdMs` 后 1s 淡出，`holdMs+1000` 调 `onDone`。success 显示对勾图标，默认图标色为 warn。**无全局队列**：每个 owner 用 `seq` 作 key 重挂载以重启计时。
- 错误弹窗：没有统一错误 modal；各 feature 自带（登录失败在 SignInDialog 内、引导保存失败为内联 alert「未能保存设置，请重试。」+[重试]、session 导出失败 dialog「Session 导出失败」）。

#### 1.15 全局面板入口（`sidebar.panellist` / `main`）
见 §3。侧栏 `sidebar.panellist.actions#entry-customization` 提供面板列表的 ⋯ More 菜单（pin/unpin 面板 + 「浏览更多插件」「创建你的插件」）。`sidebar.footer.action#cordis-panel`（ui-cordis，开发者面板）在设置旁。

---

### 2. RPC 方法表（壳层相关）

统一返回 `RemoteResult<T>` = `{ ok: true, value: T } | { ok: false, error: { code, message } }`。流 = `RemoteStreamHandle<Frame, never>`（客户端每帧 `frame.accept()` 确认）。

#### 2.1 `account/*`（dsh-api-account-controller → dsh-deepseek-account-platform）
公共类型：
```ts
AccountClientMetadata = { version: string /* "0.2.2-rc.1" */, locale: string /* 活动 UI 语言 */, timezoneOffsetSeconds: number /* -getTimezoneOffset()*60，东正 */ }
SignInAttemptId = string(branded)
SignInErrorCode = 'no-response' | 'network' | 'protocol' | 'expired' | 'storage'
SignInAttemptView = { id, phase: 'initializing'|'waiting-browser'|'exchanging'|'committing'|'succeeded'|'cancelled'|'expired'|'failed', authorizeUrl?: string, expiresAt?: number, errorCode?: SignInErrorCode }
AccountLinks = { usageUrl: string /* <platformOrigin>/usage */, topUpUrl: string /* <platformOrigin>/top_up */ }
AccountView = { status: 'signed-out'|'credential-stored', links: AccountLinks, attempt: SignInAttemptView | null }
AccountProfile = { id: string|null, name: string|null, contact: string|null /* 已打码 */, avatarUrl?: string|null }
AccountWallet = { currency: 'CNY'|'USD', balance: string /* 十进制字符串 */ }
AccountDetails = {
  profile: { status:'ready', value: AccountProfile } | { status:'failed' },
  balance: { status:'ready', value: AccountWallet[], bonusWallets: AccountWallet[] } | { status:'failed' }
}
AccountBonusNotification = { title?: string, orderId: string, campaign?: Json, amount?: Json, currency?: Json, grantedAt?: Json, expiresAt: string /* "" = 永不过期 */, message: string }
AccountBonusBatch = { accountId: string, bonuses: AccountBonusNotification[] }
```
| 方法 | 参数 | 返回 | 何时调用 |
|---|---|---|---|
| `account/watch` | `()`（signal）| **流** `AccountView` 帧；状态或 attempt 变化即推，首帧立即 | 插件启动即订阅；每帧：清空 details/avatar、更新 BrowserLogin、已登录 begin 赠金读取否则 end、刷新详情；首次 succeeded → `session/initializeDefaultModel` |
| `account/getState` | `()` | `AccountView` | 客户端未用（流已覆盖）|
| `account/startSignIn` | `(client, callbackOrigin: string, loginSource: 'web'\|'desktop')` | `AccountView` | 点击登录/重新登录。已有活跃 attempt 时直接返回当前状态。Web 传 `window.location.origin`；desktop 传 `__DSH_TRANSPORT__.streamBaseUrl` 的 origin。**callbackOrigin 必须是回环 http 带端口** |
| `account/cancelSignIn` | `(attemptId)` | `AccountView` | 关闭/取消等待中的登录；committing 阶段不可取消（等待完成）|
| `account/signOut` | `(client)` | `AccountView` | 确认退出 |
| `account/hasRunningAccountTasks` | `()` | `boolean` | 退出前查询 |
| `account/getProfile` | `(client)` | `AccountDetails['profile'] \| null` | 每个 account 帧后、打开设置时、充值返回后 |
| `account/getBalance` | `(client)` | `AccountDetails['balance'] \| null` | 同上 |
| `account/getUnnotifiedBonuses` | `(client)` | `AccountBonusBatch \| null` | 登录态开始、打开设置时 |
| `account/ackBonusNotified` | `(accountId, orderId, client)` | `boolean`（false=服务端不接受，不再重试）| 赠金卡片展示/关闭后 |
| `account/watchExpiry` | `()` | **流** `'session-expired'` | 客户端未用（改用事件）|

Host→Client 事件（`ctx.remote.$on`）：`deepseek-account/session-expired`、`deepseek-account/model-sign-in-required`（另有 Host 内部 `deepseek-account/signed-out`）。

登录时序（Host 侧，供原生实现核对）：`startSignIn` → phase `initializing` → Host 注册 webServer 精确路由 `GET /oauth/callback` → POST 平台 `auth_init {code_challenge, code_challenge_method:"S256", state, redirect_uri, locale, login_source}` → 得 `{authorize_url, authorize_id, expires_in}`，`authorizeUrl` 校验为平台 `/dsh/authorize` → phase `waiting-browser{authorizeUrl, expiresAt}`（超时 `min(attemptTimeoutMs=600000, expires_in)`）→ 浏览器回调 `/oauth/callback?code&state`（state 定长比较，重复/错误 400，过期 410）→ phase `exchanging` → `auth_exchange {code, code_verifier, redirect_uri, device_id, device_model:"<platform>-<arch>", os_version}` → 得 `authorized_url`（`/dsh/authorized`，附 `login_source`）→ `committing`（写凭证）→ `succeeded`，回调响应 `302 Location: completionUrl`（浏览器落到平台"已授权"页）。平台默认 `https://platform.deepseek.com`，资料接口 `/auth-api/v0/users/current`，余额 `/api/v0/users/get_user_summary`。

#### 2.2 设置 / 凭证 / 会话（壳层用到的部分）
| 方法 | 参数 | 返回 | 何时 |
|---|---|---|---|
| `settings/describe` | `()` | `SettingsDescribeValue = { writable: boolean, hasDocument: boolean, namespaces: SettingsNamespaceView[] }`；`SettingsNamespaceView = { autoGenerate, ns, schema, value, base?, user?, applies:'live', secrets: {path:string[], set:boolean}[], revision: number }` | configForms 镜像：启动、`settings/document-updated`、`connection/reset` |
| `settings/mutate` | `(ns, ops: ({op:'set',path:string[],value:Json}\|{op:'unset',path:string[]})[], expectedRevision: number\|undefined)` | `SettingsNamespaceView`；冲突 error.code `settings/conflict` | 欢迎确认、onboarding 进度、developerTools、session-log 开关等所有 configForms 写 |
| `settings/update` / `settings/replace` | `(ns, patch|section, expectedRevision)` | `SettingsNamespaceView` | （壳层未直接用）|
| `settings/openSettingsDocument` | `()` | `{ opened: true }` | 「打开配置文件」（仅 loopback）|
| `credentials/set` | `(ref: string, value: string)` | `void` | API Key 保存（ref 默认 `DEEPSEEK_API_KEY`）|
| `credentials/unset` | `(ref)` | `void` | 删除 Key（模型页）|
| `credentials/describe` | `(refs: string[])` | `Record<ref, { configured: boolean, source?: string, writable: boolean }>` | iOS 可用它替代 desktop 的 `dshOnboarding.hasApiKey()` |
| `session/initializeDefaultModel` | `()` | `void` | 账号首次登录成功后 |
| HTTP `HEAD/GET api/session.export?sessionId=&includeDescendants=true` | — | ZIP | 顶栏下载 Session 日志 |

相关事件：`settings/document-updated(ns, revision)`、`credentials/record-updated`、`credentials/reference-updated`、`llm/adapters-updated`；客户端本地 `connection/reset`、`theme/change`。

#### 2.3 持久化 key 一览
| 位置 | key | 含义 |
|---|---|---|
| Host settings `ui-settings-general` | `welcomeNoticeVersion` = `"2026-09-28.1"` | 预览版说明已确认 |
| Host settings `ui-settings-account` | `version/step/purpose/process/completion/usage/developerTools` | [desktop] 首启进度 |
| Host settings `ui-settings` | `enabled`（默认 true）| 显示代码工作视图（developer tools）|
| Host settings `ui-chat` | `transcriptView`、`performanceUsage` | 引导写入的展示偏好 |
| Host settings `session-log-deepseek` | `enabled` | 上传 Session Log |
| Host 凭证 | `DEEPSEEK_API_KEY` | 官方 API Key |
| 浏览器 localStorage | `dsh.open-in-app.choice` | 打开方式偏好（iOS 不需要）|
| 内存 | View pin、面板 pin、设置 open/activeId | 不持久 |

---

### 3. 全局面板（`sidebar.panellist` → `main`）总表

| id（= main key）| 标题 zh / en | order | 图标 | main 面板 | 注册包 / locale NS |
|---|---|---|---|---|---|
| `conversation`（保留 key，非 panellist 项；`activePanelId` 为空时默认）| — | — | — | `ConversationPanel` → 会话/Hero | dsh-client-ui-conversation |
| `plugins` | 插件 / Plugins | 0 | `IconPluginPinwheelOutlineRegular` | `PluginManagerPage`（下挂 `plugins.add.actions` 等子 slot）| dsh-client-ui-plugin-manager / `pluginManager` |
| `schedules` | 自动化任务 / Automation tasks | 10 | `IconClockOutlineRegular` | `TaskManagerPage`（含「新建任务」→ `uiWorkspace.startSession()`）| dsh-client-ui-schedule / `schedule.manager` |

- 侧栏 PanelRow：图标由注册组件按 `{size}` 渲染，label 来自注册的 `label` thunk；点击 `ctx.layout.selectPanel(id)`；埋点 `sidebar_menu_click`。
- `sidebar.panellist.actions#entry-customization` 存在时显示 More。

---

### 4. 设置分区总表

#### 4.1 `settings.section`（导航顺序按 order 升序）
| order | id | 标题 zh / en | 注册包 | 导航图标 | 条件 | 内容一句话 |
|---|---|---|---|---|---|---|
| -10 | `account` | 账号与余额 / Account | settings-account `AccountSection` | User | **仅已登录** | 身份、余额、用量/充值链接（1.4）|
| 0 | `general` | 通用设置 / General | settings-general `GeneralSection` | Settings | 总是 | `settings.general.item` 列表 |
| 10 | `models` | 模型 / Models | settings-models `ModelsSection` | Data | 总是 | provider 卡片与 API Key（他人负责）|
| 15 | `plugins` | 内置插件 / Built-in plugins | settings-plugins `PluginsSettingsSection` | Personalization | 总是 | tab：`settings.plugins.tab#all`（plugin-inventory，order 10）；`plugins.item`：subagent(10)/web-search(20)/agent-loop(30)/shell(40) |
| 20 | `agent-presets` | Agent 预设 / Agent presets | ui-agent-preset `AgentPresetSection` | AgentPreset | 总是 | 预设管理（他人负责）|
| — | `archived-sessions` | （导航图标已预留 Archive，但本版本无注册者）| | Archive | | |

#### 4.2 `settings.general.item`（通用分区行，order 升序）
| order | id | 注册包 | 标题 zh / en |
|---|---|---|---|
| -20 | `permission` | ui-permission-presets | 默认权限（描述「选择新会话的默认权限模式」/ "Choose the default permission mode for new sessions"）|
| 0 | `language` | client-locale | 语言 / Language |
| 10 | `appearance` | ui-theme | 外观 / Appearance |
| 11 | `font-size` | ui-theme `FontSettingsGroup` | 字体大小组 |
| 12 | `transcript-view` | ui-chat | 工作步骤展示 / Work details（+「工作步骤收起时机」）|
| 15 | `developer-tools` | settings-general | 显示代码工作视图 / Show coding view（开关；描述「开启后，显示轨迹、本轮代码差异，可选择完整的 Agent 预设切换」；失败「保存失败，请重试」；埋点 `code_work_view_toggle{is_enabled}`）|
| 16 | `shortcuts` | ui-shortcuts | 快捷键 / Keyboard shortcuts（iOS 仅外接键盘有意义）|
| 17 | `link-opening` | ui-chat | 网页链接默认打开方式 / Open chat links in（应用内侧边栏 / …）|
| 20 | `composer-enter` | ui-conversation | 繁忙时的发送行为 / Send behavior while busy |
| 30 | `performance-usage` | ui-chat | 性能与用量 / Performance & usage |
| 90 | `session-log-deepseek` | settings-session-log | 在使用官方模型 API 时上传 Session Log（仅 `configForms.whileServed(["session-log-deepseek"])` 时）|
| 100 | `current-version` | settings-general | 当前版本：{version} |

#### 4.3 其它设置壳 slot
| slot | 注册者 | 内容 |
|---|---|---|
| `settings.launcher` | settings-account AccountMenu | 账号菜单 |
| `settings.trigger` | settings-general TriggerContent | 齿轮 +「设置」（fallback 用）|
| `settings.header` | settings-general HeaderContent | 「设置」|
| `settings.close` | settings-general CloseLabel | 「关闭」|
| `settings.action` | settings-general SettingsDocumentAction `open-document` | 「打开配置文件」|
| `settings.onboarding` | settings-models `welcome-notice`(-100, 非 desktop)、`deepseek-official`(0) | 首启步骤 |
| `settings.models.sign-in` | settings-account AccountOnboarding | 引导中的登录选择 |
| `sidebar.settings` | settings-general SettingsRoot | 整个设置壳 |
| `sidebar.toggle.badge` | settings-general DesktopUpdateBadge | 折叠侧栏更新徽标 |

---

### 5. locale 表（壳层相关，原文照抄）

#### 5.1 `settings.account`（dsh-client-ui-settings-account）
| key | zh | en |
|---|---|---|
| modelSignInRequired | 当前模型暂不可用，请登录后再试 | Model unavailable. Please sign in and try again. |
| sessionExpired | 登录信息已失效，请重新登录 | You have signed out of your account, please log in again. |
| close | 关闭 | Close |
| addApiKey | 添加 API Key | Add API Key |
| retry | 重新登录 | Sign in again |
| loginTitle | 开始使用 | Get started |
| loginDescription | 登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。 | Sign in to your DeepSeek account or add an API Key to get started. Your projects and files are stored locally. |
| browserTitle | 等待登录 | Waiting for sign in |
| browserPrompt | 没有自动打开新页面？ | Page did not open automatically?␠ |
| copyLink | 复制登录链接 | Copy sign-in link |
| copiedLink | 链接已复制 | Link copied |
| copyFailed | 复制失败 | Copy failed |
| browserDescription | ，手动打开登录页完成登录。 | , then open it in your browser to finish signing in. |
| timeoutTitle | 登录已超时 | Sign in timed out |
| timeoutDescription | 请重新登录后继续操作。 | Sign in again to continue. |
| failureTitle | 登录失败 | Could not sign in |
| platformFailed | 操作未完成，请重试 | Could not complete the operation. Try again. |
| platformRetry | 重试 | Retry |
| loading | 加载中… | Loading… |
| backToHarness | 返回 DeepSeek Harness | Back to DeepSeek Harness |
| settings | 设置 | Settings |
| contactUs | 意见反馈 | Feedback |
| menu | 账号菜单 | Account menu |
| nav | 账号与余额 | Account |
| signedIn | 已登录 DeepSeek | Signed in to DeepSeek |
| signedOut | 尚未登录 | Not signed in |
| signIn | 登录 | Sign in |
| signOut | 退出登录 | Sign out |
| signOutUnknownDescription | 暂时无法确认任务状态。退出登录可能会中断使用此账号的任务，是否继续？ | Could not check running tasks. Signing out may interrupt tasks using this account. Sign out now? |
| signOutDescription | 退出登录不会丢失任何数据，你仍可以登录此账号。 | Signing out will not delete any data. You can sign in to this account again. |
| signOutRunningDescription | 当前有进程正在执行中，点击“退出登录”，将会打断进程，是否即刻退出登录？ | Tasks are currently running. Signing out will interrupt them. Sign out now? |
| cancel | 取消 | Cancel |
| open | 打开浏览器 | Open browser |
| initializing | 正在发起登录… | Starting sign in… |
| waiting | 请在浏览器中继续 | Continue in your browser |
| completing | 正在完成登录… | Completing sign in… |
| expired | 登录已过期，请重试。 | Sign in expired. Try again. |
| failed | 操作未完成，请重试。 | Could not complete the operation. Try again. |
| noResponse | 操作未完成，可能是网络异常，请检查你的网络状况后重试 | Something went wrong. Please check your network connection and try again. |
| settingsSignedOutTitle | 当前未登录 DeepSeek Harness 账号 | You are not signed in to DeepSeek Harness |
| settingsSignedOutDescription | 登录 DeepSeek Harness 账号获取专属 API Key | Sign in to DeepSeek Harness to get your dedicated API Key |
| signInDescription | 登录 DeepSeek 账号以开始使用 | Use your DeepSeek account to get started. |
| profileUnavailable | 账号资料暂不可用 | Account details are not available yet. |
| balance | 充值余额 | Topped-up balance |
| bonusBalance | 赠金余额 | Granted balance |
| balanceUnavailable | 前往开放平台查看 | View on Platform |
| balanceSignedOut | 登录后查看 | Sign in to view |
| accountInfo | 更多账号信息 | More account information |
| more | 更多 | More |
| usage | 查询用量 | View usage |
| topUp | 充值 | Top up |
| quotaTitle | 当前无可用余额 | No balance available |
| quotaDescription | 没有可用额度时，DeepSeek Harness 无法开始新的任务，是否前往充值？或者可以稍后前往 设置 → 账号与余额 进行充值。 | DeepSeek Harness cannot start a new task with this account when no balance is available. Would you like to top up? You can also top up later in Settings → Account. |
| quotaTopUp | 去充值 | Top up |
| bonusNoticeTitle | 赠金已到账 | Bonus credited |

Desktop 引导（同 NS）：
| key | zh | en |
|---|---|---|
| onboardingArtworkLocale | zh | en |
| onboardingWelcome | 欢迎使用 | Welcome to |
| onboardingBrand | DeepSeek Harness | DeepSeek Harness |
| onboardingIntroduction | DeepSeek Harness 会以本地文件夹作为工作区，通过调用各种工具，读写本机文件，完成搜索整理资料、制作文档表格、编写代码、排查问题等各种任务。 | DeepSeek Harness works in a local folder and uses tools to read and write files on your computer. It can help you research and organize information, create documents and spreadsheets, write code, troubleshoot issues, and more. |
| onboardingStart | 开始设置 | Get started |
| onboardingCredit | 准备可用额度 | Add credits |
| onboardingCreditDescription | DeepSeek Harness 执行任务时，会根据模型与工具使用的 token 量扣除额度。请提前添加额度，避免任务在执行过程中被迫中断。你的余额只会在 Agent 实际执行任务时消耗。 | DeepSeek Harness charges credits based on the tokens used by models and tools. Add credits in advance to keep your tasks running without interruption. Your balance is only used while the agent is working on a task. |
| onboardingTopUp | 去充值 | Add credits |
| onboardingLater | 下一步 | Next |
| onboardingFundedTopUp | 去充值 | Add credits |
| onboardingPurposePrefix | 你希望 | What would you like |
| onboardingPurposeSuffix | 帮你做什么？ | to help with? |
| onboardingPurposeDescription | 我们会根据你的选择调整界面和工具，以更适合你的工作方式。 | We’ll tailor the interface and tools to fit the way you work. |
| onboardingOffice | 办公与创作 | Office & creative work |
| onboardingOfficeDescription | 编辑文档、整理数据和制作演示文稿等 | Edit documents, organize data, create presentations, and more |
| onboardingDevelopment | 代码与开发 | Coding & development |
| onboardingDevelopmentDescription | 修改代码、调试问题、运行命令和管理项目文件等 | Edit code, debug issues, run commands, manage project files, and more |
| onboardingContinue | 继续 | Continue |
| onboardingProcess | 你希望看到多少工作过程？ | How much detail would you like to see? |
| onboardingProcessDescription | 这只会影响工作过程的展示方式，不会影响 DeepSeek Harness 的工作能力。 | This only changes how progress is shown, not what DeepSeek Harness can do. |
| onboardingCompact | 聚焦结果 | Results only |
| onboardingCompactDescription | 只看结果，保持界面简洁明了 | See just the results in a clean, simple interface |
| onboardingStandard | 关键细节 | Key details |
| onboardingStandardDescription | 结果优先，仅展示重要步骤和关键操作 | Focus on results, with only the most important steps and actions shown |
| onboardingDetailed | 完整过程 | Full details |
| onboardingDetailedDescription | 查看完整工作过程，方便调试和排查问题 | See the full process for easier debugging and troubleshooting |
| onboardingEnter | 进入应用 | Open app |
| onboardingBack | 上一步 | Back |
| onboardingSkip | 跳过 | Skip |
| onboardingSkipTitle | 跳过设置？ | Skip setup? |
| onboardingSkipDescription | 你可以随时前往 设置 → 通用设置 中调整工作过程、性能与用量展示方式或开启代码工作工具。 | You can change how progress, performance, and usage are displayed, or enable Coding Tools, anytime in Settings → General. |
| onboardingKeepSetting | 继续设置 | Continue setup |
| onboardingNoCreditTitle | 暂时跳过充值？ | Skip adding credits? |
| onboardingNoCreditDescription | 没有可用额度时，DeepSeek Harness 将无法开始新的任务。你可以稍后前往 设置 → 账号与余额 进行充值。 | DeepSeek Harness can’t start new tasks without credits. You can add them later in Settings → Account. |
| onboardingUnderstood | 我知道了 | Got it |
| onboardingGoTopUp | 前往充值 | Add credits |
| onboardingSaveFailed | 未能保存设置，请重试。 | Could not save settings. Try again. |
| onboardingRetry | 重试 | Retry |
| onboardingLoading | 正在加载设置… | Loading settings… |

#### 5.2 `settings`（dsh-client-ui-settings-general）
| key | zh | en |
|---|---|---|
| trigger | 设置 | Settings |
| shortcut.open | 打开设置 | Open settings |
| desktop.update.available | 新版本 | Update |
| desktop.update.checking | 正在检查更新… | Checking for updates… |
| desktop.update.progress | {percent}% | {percent}% |
| desktop.update.verifying | 正在校验更新文件… | Verifying update files… |
| desktop.update.installing | 正在准备重启… | Preparing to restart… |
| desktop.update.ready | 安装并重启 | Install and Restart |
| desktop.update.retry | 重试更新 | Retry update |
| desktop.update.versionDetail | {label}：{version} | {label}: {version} |
| desktop.update.downloadDetail | 正在下载更新：{percent}%\n目标版本：{version} | Downloading update: {percent}%\nTarget version: {version} |
| desktop.update.checkFailed | 检查更新失败，请稍后重试。 | Could not check for updates. Please try again later. |
| desktop.update.downloadFailed | 下载更新失败，请重试。 | Could not download the update. Please try again. |
| desktop.update.installFailed | 安装更新失败，请稍后重试。 | Could not install the update. Please try again later. |
| desktop.update.checkNetworkFailed | 检查更新失败，请检查网络连接后重试。 | Could not check for updates. Check your connection and try again. |
| desktop.update.downloadNetworkFailed | 下载更新失败，请检查网络连接后重试。 | Could not download the update. Check your connection and try again. |
| desktop.update.installNetworkFailed | 安装更新失败，请检查网络连接后重试。 | Could not install the update. Check your connection and try again. |
| desktop.update.stopFailed | 未能安全停止任务，更新尚未安装，请稍后重试。 | Could not safely stop the tasks. The update has not been installed. Please try again later. |
| desktop.update.tasksChanged | 有新任务开始运行，请重新确认是否停止任务并更新。 | New tasks have started. Confirm again to stop the tasks and update. |
| desktop.update.tasksUnavailable | 无法确认任务状态，请在工作区就绪后重试更新。 | Task status is unavailable. Try updating again when the workspace is ready. |
| title | 设置 | Settings |
| close | 关闭 | Close |
| openDocument | 打开配置文件 | Open configuration file |
| openDocument.error | 无法打开配置文件 | Could not open configuration file |
| general.nav | 通用设置 | General |
| general.currentVersion | 当前版本：{version} | Current version: {version} |
| developerTools.title | 显示代码工作视图 | Show coding view |
| developerTools.error | 保存失败，请重试 | Could not save. Please try again. |
| developerTools.description | 开启后，显示轨迹、本轮代码差异，可选择完整的 Agent 预设切换 | Shows trajectory, code diffs, and all Agent presets |
| connection.error | 连接异常，刷新重试 | Disconnected |
| connection.connecting | 重新连接中 | Reconnecting |
| connection.connected | 连接成功 | Connected |
| connection.reconnect | 连接异常，点击立即重连 | Disconnected, reconnect now |
| connection.restart | 连接中断，正在重试，点击立即重连 | Reconnecting, reconnect now |
| hostRelease.title | 服务版本变化 | Service version changed |
| hostRelease.description | 服务版本已变化，本页面已暂停热更新，刷新后加载新版本。 | The service version changed. This page paused live updates; reload to load the new version. |
| hostRelease.service | 服务 | Service |
| hostRelease.page | 页面 | Page |
| hostRelease.unknown | 未解析 | Unknown |
| hostRelease.reload | 刷新以加载新版本 | Reload to load the new version |
| hostRelease.later | 暂不刷新 | Not now |

#### 5.3 `settings.models`（仅引导/Key 相关）
| key | zh | en |
|---|---|---|
| nav | 模型 | Models |
| welcomeTitle | 预览版说明 | Preview Notice |
| welcomeBody | DeepSeek Harness 目前的 0.2 版本仍处于预览阶段，还有许多地方需要持续改进和打磨，希望听取广大开发者和用户的反馈建议。现在，新的桌面端面向广泛用户，开发者相关的进阶功能可在配置中开启使用。预计 DeepSeek Harness 的产品功能以及插件 API 都会继续快速迭代、持续演化，并逐渐趋于稳定。\n\n我们期待与全球用户和开发者一起，在开源、可复用、可组合的基础设施之上，共同探索智能上限。欢迎大家用 DeepSeek Harness 将想法变成现实，与社区一起丰富插件生态。 | DeepSeek Harness 0.2 is still in preview, and many areas need continued improvement and refinement. We welcome feedback and suggestions from all developers and users. The new desktop app now targets a broad range of users, while developer-related advanced features can be enabled in the settings. DeepSeek Harness’s product features and plugin APIs are expected to continue rapid iteration and evolution, and will gradually stabilize over time.\n\nWe look forward to exploring the limits of intelligence together with users and developers around the world, building on open-source, reusable, and composable infrastructure. We welcome everyone to bring their ideas to life with DeepSeek Harness and participate in the community to enrich the plugin ecosystem. |
| welcomeContinue | 继续 | Continue |
| welcomeError | 暂时无法保存确认状态，请重试。 | The acknowledgement could not be saved. Please try again. |
| onboardingTitle | 添加一个 API Key 开始使用 | Add an API key to get started |
| onboardingDescription | 配置 DeepSeek 官方模型，即可开始使用。 | Configure the official DeepSeek provider to start building. |
| onboardingLater | 稍后配置 | Configure later |
| onboardingSave | 保存并继续 | Save and continue |
| onboardingSaving | 保存中… | Saving… |
| keyInput | API 密钥 | API key |
| keyReveal | 显示密钥 | Show secret |
| keyHide | 隐藏密钥 | Hide secret |
| keyPlaceholder | 输入 API 密钥 | Enter your API key |
| keyBlank | 请输入 API 密钥；留空则保持已存储的密钥。 | Enter the API key, or leave the field empty to keep the stored one. |
| keyBlankNew | 请输入 API 密钥；若该提供商以其他方式鉴权，可以留空。 | Enter the API key, or leave the field empty if this provider authenticates another way. |
| keyIllegalCharacters | 该 API 密钥格式错误，请检查。 | This API key is not in a valid format. Please check it. |
| keyRequired | 请输入 API 密钥后继续。 | Enter an API key to continue. |

#### 5.4 `conversation`（Hero / 顶栏）
| key | zh | en |
|---|---|---|
| hero.headline | 探索未至之境 | Into the Unknown |
| hero.preview | 预览版 | Preview |
| hero.chooseWorkspace | 选择工作区 | Choose workspace |
| session.hierarchy | 会话层级 | Session hierarchy |
| session.moreViews | 更多会话视图 | More conversation views |
| placeholder.hero | 描述你想要构建的内容, / 调用指令, @ 文件或对话 | Describe what you want to build, / commands, @ files or sessions |
| placeholder.workspace | 选择一个工作区开始 | Choose a workspace to start |
| placeholder.default | 发消息或创建任务, / 调用指令, @ 文件或对话 | Message or run a task, / commands, @ files or sessions |
| workspace.defaultName（client-locale 共享）| 默认工作区 | Default workspace |

#### 5.5 其它
- `settings.sessionLog`：title「在使用官方模型 API 时上传 Session Log」/ "Upload Session Log when using the official model API"；description「帮助改进 DeepSeek 模型与产品」/ "Help improve DeepSeek models and products."；saved「设置已保存」/ "Preference saved"；failed「无法保存设置」/ "Could not save preference"。
- `session-log-download`：header.more「更多操作」/ More actions；menu.download「下载 Session 日志」/ Download session log；menu.feedback「反馈」/ Feedback；dialog.preparingTitle「正在导出 Session」/ Exporting Session；dialog.preparingDescription「正在准备包含当前 Session、子 Session 和附件的 ZIP 文件。」/ "Preparing a ZIP containing this Session, its sub-Sessions, and attachments."；dialog.successTitle「Session 导出已开始下载」/ Session download started；dialog.successDescription「浏览器正在下载 Session ZIP 文件。」/ The browser is downloading the Session ZIP.；dialog.errorTitle「Session 导出失败」/ Session export failed；dialog.close「关闭」/ Close；dialog.commandFailed「无法启动 Session 导出。」/ Could not start the Session export.
- `ui-chat`：message.failure.quota「当前请求的额度已用尽」/ "Request quota exhausted."
- `pluginManager`：panel「插件」/ Plugins。`schedule.manager`：panel「自动化任务」/ Automation tasks；toast.deleted「任务已删除」/ Task deleted.；toast.deleteFailed「无法删除任务」/ Could not delete the task.
- `job`：list.aria「后台任务」/ Background jobs；count.live.one/other「{count} 个后台任务运行中」/ "{count} background job(s) running"；count.idle.one/other「{count} 个后台任务」/ "{count} background job(s)"；section.live「进行中」/ Running；section.settledCount「已结束 {count}」/ Finished {count}；section.clear「清空」/ Clear。
- agent-team：trigger「智能体团队」/ Agent Team；roster「成员」/ Members；tasks「共享任务」/ Shared tasks；empty「暂无共享任务，可以通过对话创建」/ "No shared tasks yet. Create them through the conversation."
- `schedule.catalog`：trigger.label「提醒」/ Reminders；list.aria「活动提醒」/ Active reminders；list.nextRun「下次运行」/ Next run；delete.label「删除提醒：{title}」/ "Delete reminder: {title}"；list.open「打开提醒详情：{title}」。
- subagent：switcher.aria「切换子智能体：{title}」/ "Switch subagent: {title}"；tree.aria「子智能体会话」/ Subagent sessions。
- sidebar-right：chrome.expand「打开侧边栏」/ Open sidebar；chrome.expandAria「打开右侧边栏」/ Open right sidebar。
- agent-preset：headerHint「本任务的 Agent 预设，在任务开始时确定」/ "The agent preset chosen when this task started"；nav「Agent 预设」/ Agent presets。settings-plugins nav「内置插件」/ Built-in plugins。
- workspace toast：见 1.14 表。

---

### 6. 手机端 SwiftUI 对应建议

#### 6.1 登录
- 用 **`ASWebAuthenticationSession`**（`prefersEphemeralWebBrowserSession=false` 以复用平台 Cookie）打开 `authorizeUrl + "&theme=light|dark"`；`callbackURLScheme` 随便给一个不会命中的自定义 scheme（例如 App 自有 scheme），**完成靠 `account/watch` 流**：phase→`succeeded`/`status==credential-stored` 时 `session.cancel()` 关闭；`failed|expired|cancelled` 也关闭并在 sheet 内显示对应文案。用户手动关闭浏览器（`canceledLogin`）→ 调 `account/cancelSignIn(attempt.id)`。
- `startSignIn(client, callbackOrigin: "http://127.0.0.1:<引擎端口>", loginSource: "web")`。**不要传 LAN 地址**（会被 `loginOrigin()` 拒绝）。若将来改为连远程 Host，此登录不可用，需要在 Host 本机完成或改用 API Key。
- 回调 302 落到平台 `/dsh/authorized` 页面时 ASWebAuthenticationSession 仍开着——这是正常的，等流帧再关；也可以用 `SFSafariViewController`（可展示完成页，用户自己点"完成"）。
- 「复制登录链接」保留：`UIPasteboard.general.string = authorizeUrl+theme`，按钮文案 2s 回弹。
- SignInDialog → `.sheet`（`presentationDetents([.medium])`，`interactiveDismissDisabled(phase == .committing)`），按钮区 `HStack { Button("添加 API Key") Button("登录").buttonStyle(.borderedProminent) }`；等待态主按钮换 `ProgressView()`。
- 退出确认 → `.confirmationDialog` 或 `.alert`（destructive「退出登录」），先 `await hasRunningAccountTasks()` 再选文案。
- 账号菜单 → 设置页顶部 Section（头像 `AsyncImage` + 名字 + contact）或导航栏左上角头像 `Menu { 设置 / 意见反馈 / 登录|退出登录 }`。
- 「查询用量/充值/更多账号信息」→ `SFSafariViewController`（sheet），`onDismiss` 时 `refreshAccount()`（与 desktop "returned from top-up" 行为对齐）。
- 赠金卡片 → 首页底部/侧栏抽屉底部的叠卡（`ZStack` + `scaleEffect(pow(272/280, depth))`），展示 `onAppear` 且 `scenePhase == .active` 后 ack；或简化为顶部 banner 队列逐条显示。

#### 6.2 首启引导
- 判定沿用 Web：会话列表 ready 且当前在空白新会话首页 → 依次评估 `welcome-notice`（读 `settings.describe()` 中 `ui-settings-general.value.welcomeNoticeVersion`）→ `deepseek-official`（复刻 `onboardingReadiness`：读 models 数据 + `credentials/describe(["DEEPSEEK_API_KEY"])`）。
- 都用 **`.fullScreenCover`** 或 `.sheet` + `interactiveDismissDisabled(true)`（源码 Modal 不可隐式关闭）。
- 预览版说明：`ScrollView { Text(段落) }` + 底部「继续」，失败内联红字。
- API Key 引导：先显示"开始使用"二选一（登录 / 添加 API Key）→ Key 表单：`SecureField` + 眼睛切换 `TextField`，`.textInputAutocapitalization(.never) .autocorrectionDisabled() .textContentType(.password)`，提交前跑 `apiKeyFailure`；按钮「稍后配置」「保存并继续」。
- 可选：把 Desktop 4 步引导移植为 `TabView(.page)` / `NavigationStack` 分步页（数据写 `ui-settings-account`、`ui-chat`、`ui-settings` 三个命名空间，接口都是 `settings/mutate`），`hasApiKey` 用 `credentials/describe` 代替。是否启用由产品决定；若启用要防止与 Web 两步同时出现（desktop 下 welcome-notice 不注册、deepseek-official 不自动弹）。

#### 6.3 设置
- `NavigationStack { Form/List }`：顶层 `Section`（账号卡，仅登录态）→ `NavigationLink` 列表：通用设置 / 模型 / 内置插件 / Agent 预设，顺序 = order；图标用 SF Symbols 对应（person.crop.circle / cpu / puzzlepiece / person.2.badge.gearshape / gearshape）。
- 通用设置按 §4.2 order 排 `Section`/行：Picker（语言、外观、发送行为、权限、链接打开方式、展示粒度）、Toggle（代码工作视图、上传 Session Log）、`LabeledContent("当前版本", value:)`。
- 写入失败：行内红字 + 保持原值（源码不做乐观更新）。成功/失败 toast 只在 session-log 开关有。
- 「打开配置文件」iOS 隐藏；快捷键行仅在检测到硬件键盘时显示（或放"关于"子页）。
- 入口：iPhone 侧栏抽屉底部齿轮/头像，或会话列表页 `toolbar` 的 `.topBarLeading` 头像 `Menu`；`keyboardShortcut(",", modifiers: .command)` 打开设置（iPad + 键盘）。
- "关于"可新增子页：版本、反馈（飞书问卷 URL，参数同 `contactUrl`，device_info 用 `UIDevice` 型号/系统 + 屏幕像素）、开源许可。

#### 6.4 会话顶栏
- `.navigationTitle(displayTitle)` + `.toolbarTitleDisplayMode(.inline)`；子智能体面包屑用 `ToolbarItem(placement: .principal)` 放 `Menu`（标题 + chevron，列同级子会话，祖先链做成菜单前几项"返回 xxx"）；或保留 `NavigationStack` 的 push 层级表示 lineage。
- `ToolbarItemGroup(placement: .topBarTrailing)`：常驻 1–2 个高频（后台任务计数徽章、右侧栏/文件面板按钮）；其余（智能体团队、Agent 预设、子智能体、提醒、下载 Session 日志、反馈）折叠到一个 `Menu { } label: { Image(systemName: "ellipsis.circle") }`，各项按其可见条件动态出现（无任务/无提醒/无预设不显示）。
- 弹层（任务列表、团队、提醒、子智能体树）→ `.popover`（iPad）/ `.sheet` + `presentationDetents([.medium, .large])`（iPhone）。
- `open-in-app` 不提供（或换成"复制路径"/"在文件 App 中打开"若工作区在 App 沙盒）。
- `corner` 的右侧栏 ExpandButton → toolbar 按钮打开 inspector：iPad `.inspector(isPresented:)`，iPhone `.sheet`。
- View 标签（chat / trajectory）→ 标题下 `Picker(.segmented)`，或 `.principal` 的 `Menu`；`views.actions` 的 pin 管理放到 ⋯ 菜单"自定义视图"。
- 空白首页（hideChrome）：隐藏标题与按钮，只留新建/侧栏按钮。

#### 6.5 Hero 首页
- `VStack`：鲸鱼 logo（可用 `PhaseAnimator` 做轻微摆动）+ 「探索未至之境」+ `Text("预览版")` 胶囊；工作区 chip = `Menu` 或点按弹 sheet 选择工作区（含"选择目录…"，iOS 用 `fileImporter(allowedContentTypes:[.folder])` 或应用内浏览器）；Agent 预设 chip `Menu`；底部输入框 `safeAreaInset(edge: .bottom)`，未选工作区时禁用 + 占位「选择一个工作区开始」，点按直接弹工作区选择器。

#### 6.6 Toast / 通知 / 连接
- 自建 `ToastCenter`（`@Observable`，单槽，新的替换旧的，与源码"每 owner 一槽、seq 重启"语义一致；可加 FIFO），`overlay(alignment: .top)` 显示胶囊，`.transition(.move(edge:.top).combined(with:.opacity))`，3s 停留 + 1s 淡出；`tone` success 用 `checkmark.circle.fill`，warning 用 `exclamationmark.triangle.fill`；`actions` 渲染为胶囊内文字按钮（需可点，注意源码 CSS `pointer-events:none` 外层，按钮自身可点）。
- 额度不足：`.alert("当前无可用余额", …) { Button("取消", role:.cancel); Button("去充值") }`（已登录账号路由）；API Key 路由仅 toast。
- 连接状态：不放侧栏，改为导航栏下方细条/`safeAreaInset(edge:.top)` 小胶囊：断开（橙色，点按重连）、重连中（`ProgressView` + 「重新连接中…」，≥0.8s）、已恢复（绿色「连接成功」2s 后消失）。本机引擎场景下"断开"多为 Worker 重启，可配合原生重启引擎逻辑。
- 服务版本变化：`.alert`「服务版本变化」[暂不刷新][刷新以加载新版本]（原生刷新=重建连接/重载插件表）。
- 会话导出：`ShareLink`/`UIActivityViewController` 分享下载到临时目录的 ZIP（GET `api/session.export?...`），进度用 sheet「正在导出 Session」。

#### 6.7 难点 / 风险
1. 登录回调强制回环 + 不跳自定义 scheme：ASWebAuthenticationSession 不会自然结束，必须以 `account/watch` 驱动关闭；App 进后台时引擎 HTTP 服务可能被挂起，需在登录期间申请后台任务或保证前台。
2. 账号分区"仅登录时存在"、设置按钮被账号菜单替代——原生重排时要保留这两点行为差异（未登录也要有登录入口：账号菜单「登录」与引导 sign-in）。
3. Web 两步引导与 Desktop 四步引导互斥条件依赖 `dshDesktop` 全局；原生需明确选型。
4. 赠金 ack 语义是"已真实展示一帧且可见"，原生要在 `onAppear` + 前台判定后 ack，不能拉到就 ack。
5. Toast 无全局协调，多个 overlay 可能同时显示（源码即如此），原生统一 ToastCenter 时注意替换策略。

---

# E. 主题 / 语言 / 字体 / 快捷键 / 客户端传输协议 / 品牌与小插件

> 源码根：`engine/node_modules/@deepseek-ai/`。标识符、JSON 原样保留。"Web" = 浏览器 Web UI；"Desktop" = Electron 壳（iOS 不需要实现其专属能力，但要知道它的存在）。

---

### 1. 各子系统功能清单

#### 1.1 `dsh-client-ui-theme`（主题 + 字号 + 字体）

| 功能 | 细节 | 默认值 / 范围 | 持久化 | RPC |
|---|---|---|---|---|
| 外观偏好 | `preference`: `light` / `dark` / `system`（`THEME_PREFERENCES`）。`system` 走 `prefers-color-scheme`，系统切换时重新发 `theme/change` | 默认 `system`（`DEFAULT_PREFERENCE`） | Host settings 命名空间 `ui-theme`，字段 `preference`（落盘 `$DSH_HOME/cordis.patch.yml`），所有已认证浏览器共享 | 读 `settings/describe`；写 `settings/mutate` |
| 第三方主题 id | `ctx.theme.register({id,colorScheme,tokens})`、`overrideTokens(source, {token:{light,dark}})`。**只在进程内**，不过 settings schema | — | 不持久化 | 无（iOS 可忽略） |
| 正文字号 text | 字段 `fontSize`，CSS 变量 `--dsh-content-font-size`；影响会话正文 + 标题阶梯 + 用户气泡 + 输入框草稿；表格/flow 行标题是"次级档"（≤14 时 -1，>14 时 -2，默认 13px）；小字号固定不变 | 10–22，默认 14，步进 1px（整数） | `ui-theme.fontSize` | 同上 |
| 代码字号 code | 字段 `codeFontSize`，变量 `--dsh-code-font-size`；代码块、工具输出小变体；行内代码 = 该值 +1px | 10–16，默认 11，步进 1 | `ui-theme.codeFontSize` | 同上 |
| 终端字号 terminal | 字段 `terminalFontSize`，变量 `--dsh-terminal-font-size`；侧栏终端单元格字号，改后保留 shell 输出并 refit 网格 | 10–20，默认 13，步进 1 | `ui-theme.terminalFontSize` | 同上 |
| 字体族 ×3 | 字段 `textFontFamily` / `codeFontFamily` / `terminalFontFamily`；输入逗号分隔，blur 或 Enter 提交；空串 = 内置栈。`normalizeFontFamily`：去掉引号、反斜杠、尖括号、控制字符，非通用族名一律加双引号；用户列表放在内置栈前面（缺字体自动回退）。不枚举本机字体 | 默认 `""`；内置 text 栈 `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif`；code 栈 `"SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, Courier, "PingFang SC", "Microsoft YaHei"`；品牌字体 `Montserrat`（300/400/500，OFL，仅品牌文字） | `ui-theme.*FontFamily` | 同上 |
| 设置项 UI ① | 注入 `settings.general.item`，`id: "appearance"`，`order: 10`，组件 `AppearanceRow`：三个偏好"方块"（浅色/深色/跟随系统），选中态读 `preference` 而非解析后的主题 | — | — | — |
| 设置项 UI ② | 注入 `settings.general.item`，`id: "font-size"`，`order: 11`，组件 `FontSettingsGroup`：正文字号步进器（+/- 按钮，单位 px）；其后"更多字体设置"按钮展开区域（**每次打开设置都折叠**），内含 正文/代码/终端 三个字体输入框 + 代码/终端两个字号步进器 | — | — | — |
| 桌面字号快捷键 | **仅 Desktop**（`shortcuts.runtime === "desktop"`）：`Mod+=`（或 `Mod+Shift+=`）三个字号同时 +1，`Mod+-` 同时 -1，各自夹在范围内；一次按键 = 一次 settings mutation；长按不重复；终端区域内不触发。fixed 命令 id `fontSize.increase` / `fontSize.decrease`，group `application`。Web 保留浏览器缩放 | — | 同 `ui-theme` | `settings/mutate`（一次写多字段） |
| 写入串行化 | 快速连续修改按手势顺序串行，携带 namespace revision（`expectedRevision`）；最新一次写失败则重读 durable 值；自身写入未落定时忽略回推（避免回声覆盖） | — | — | `settings/mutate` 失败 → `settings/describe` |
| 外部变更 | 订阅 forwarded 事件 `settings/document-updated(ns, revision)` 与 `connection/reset` → 重读 | — | — | `$events` emit |
| 首屏预载 | Host 在 index.html 注入：head `<style>` 设 canvas 颜色（light `#fff` / dark `#151517`，system 用 media query），body `<script>` 设置 `body[data-ds-dark-theme]`、`html[data-ds-theme-source]`、三个字号变量与非空字体变量 | — | — | （iOS 无需；首屏用本地缓存即可） |
| `theme/change` 事件 | `ctx.on('theme/change', (snapshot: ThemeSnapshot) => …)`，preference/字号/字体/注册表/override/系统配色变化都会发 | — | — | 进程内事件 |
| Snapshot 结构 | `ThemeSnapshot { preference; fontSizes: {text,code,terminal}; fontFamilies: {text,code,terminal}; active: ThemeDefinition{ id; colorScheme:'light'\|'dark'; tokens }; themes: ThemeDefinition[]; revision: number }` | — | — | — |
| 其它 | 圆角 `--dsw-radius-xs 4px / sm 8px / md 12px / lg 16px / xl 20px / panel 28px`；focus ring 2px，light `#4176E6` / dark `#7AAAFF`；指针模式下隐藏 ring；菜单 `backdrop-filter: blur(40px) saturate(150%)` | — | — | — |

`ui-theme` 的 durable schema（`ThemeSettingsSchema`）：
```json
{ "preference": "system", "fontSize": 14, "codeFontSize": 11, "terminalFontSize": 13,
  "textFontFamily": "", "codeFontFamily": "", "terminalFontFamily": "" }
```

#### 1.2 `dsh-client-locale`（语言）

| 功能 | 细节 | 默认值 | 持久化 | RPC |
|---|---|---|---|---|
| 内置语言 | `LOCALE_IDS = ["zh","en"]`；显示名 `zh → "中文"`（fallback `en`），`en → "English"` | — | — | — |
| 自动选择（跟随系统） | 无显式偏好时：按 `navigator.languages` 顺序，先全标签匹配再主子标签匹配已注册语言，均不中则 `en`（`FALLBACK_LOCALE`）。这是**临时值**，不写回 | `en` 兜底 | 不写 | — |
| 显式选择 | 设置 → 通用 → 语言（下拉 Menu，`align:"end"`）；`setLocale(id)` 即使与当前相同也会写入（因为当前可能是临时值） | — | settings 命名空间 `locale`，字段 `preference`（可缺省；缺省 = 跟随浏览器）；pattern `/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u` | `settings/mutate`（`{op:"set",path:["preference"],value:"zh"}`） |
| 设置项 UI | 注入 `settings.general.item`，`id: "language"`，`order: 0`，组件 `LanguageRow`（标题 + 胶囊选择器 + chevron） | — | — | — |
| 语言包扩展 | `ctx.locale.addLanguage({id,label,fallback})`；fallback 链必须终止于 `en`；查找顺序：当前 ns 的 fallback 链 → `common` ns 的 fallback 链 → 显示 key 本身 | — | — | — |
| 插值 | 模板 `{name}` 占位符 | — | — | — |
| `<html lang>` | `zh` → `zh-CN`，其它原样 | — | — | — |
| 事件 | `locale/change(snapshot)` 仅在切换时发；字典注册只 bump revision。`LocaleSnapshot { active; locales: {id,label,fallback?}[]; revision }` | — | — | — |
| Native 桥 | `__DSH_LOCALE__ { read(): Promise<{languages:string[], preference:string\|null}>; onChange(locale) }`（Desktop 用；iOS 原生可参照此语义：启动时读 Host 偏好 + OS 语言列表） | — | — | — |
| `resolveText(LocalizedText)` | 插件标题/描述多语言 map（小写语言 id，必须含 `en`），按 fallback 链解析 | — | — | — |

#### 1.3 `dsh-client-shortcuts`（注册模型）+ `dsh-client-ui-shortcuts`（面板 / 编辑 UI）

| 功能 | 细节 | 默认 | 持久化 | RPC |
|---|---|---|---|---|
| Profile | `ShortcutProfile = \`${'desktop'\|'web'}:${'macos'\|'windows'\|'linux'}\``；Web 由 `navigator.platform` 判定平台；未声明的 profile = 不绑定 | — | — | — |
| 绑定模型 | `ShortcutBinding { code: KeyboardEvent.code; secondCode?; modifiers: ('primary'\|'control'\|'alt'\|'shift'\|'meta')[] }`；`primary` 在 macOS = meta，其它 = control；规范化后修饰键顺序 `control, alt, shift, meta`（也是键帽顺序）；macOS 键帽 `⌃ ⌥ ⇧ ⌘`，Windows 用 `Ctrl + Alt + Shift + Meta` 带 ` + ` 分隔 | — | — | — |
| 可编辑命令 | `register({id,label,aliases,defaults,regions,modals,resolve})`；`regions: 'page'\|'editable'\|'terminal'`（输入焦点归属）；`modals`：允许在哪些模态（`settings`/`shortcuts`/`other`）下生效；`resolve(ctx)` → `handled{run}` / `blocked{reason}` / `pass`；重复 id、默认绑定重叠均抛错 | — | — | — |
| 固定命令 | `registerFixed({id,label,keys,bindings,group})`，group：`application`/`input`/`menus`/`approval`；只读、保留按键（编辑时不能占用） | — | — | — |
| 冲突规则 | 显式 override 优先于默认；多个显式 override 冲突则全部禁用；单键与包含它的双键组合在修饰键相同时视为冲突 | — | — | — |
| 双键组合 | 仅 Windows/macOS Desktop：两个非修饰键同时按住（顺序任意），0–4 修饰键；Web/Linux 不支持 | — | — | — |
| Web 允许组合 | `isWebBindingAllowed`：macOS Web 可用 `⌘/`、`⌘,`、`⌘\`、`⌃\``、`⌘⌥+键`、`⌘⇧+键`，以及任意 3–4 个修饰键组合；Windows Web 类似（Ctrl） | — | — | — |
| 校验问题 | `BindingIssue = 'reserved' \| 'unsupported-browser' \| 'modifier-required' \| 'unsupported-key'` | — | — | — |
| 偏好存储 | 只存 override：缺省继承默认；`null` = 显式解绑；恢复默认 = 删除 override。`ShortcutDocument { schemaVersion: 1\|2; profiles: { "<profile>": { "<commandId>": ShortcutBinding\|null } } }`；Restore All 只影响当前 profile | — | **Web：origin 本地 `localStorage["dsh.keybindings.v1"]`**（跨 tab 通过 storage 事件同步，last-writer-wins）；Desktop：`userData/keybindings.json`（**不在 Host / 不经 RPC**） | 无 |
| 编辑 API | `edit(edit: ShortcutEdit, revision)`；`ShortcutEdit = {type:'set',id,binding\|null} \| {type:'reset',id} \| {type:'reset-all'}`；结果 `ShortcutSaveResult.status: 'saved'\|'stale'\|'unreadable'\|'write-failed'\|'not-ready'\|'conflict'` | — | — | — |
| 读失败 | `ShortcutConfigSnapshot.status: 'loading'\|'ready'\|'unreadable'`，`error: 'read'\|'invalid'\|'future'\|null`；不可读时禁用编辑并 toast 提示文档位置 | — | — | — |
| 双 Esc 停止 | Host 配置 `stopSequenceMs`（默认 500，范围 1–2147483646），通过 index 注入 `globalThis.__DSH_SHORTCUTS_CONFIG__ = {"stopSequenceMs":500}` | 500ms | Host 配置 | 页面全局 |
| 快捷键面板 | `shell.overlay` 注入单个对话框（标题 "快捷键"/"Keyboard shortcuts"），480×600 卡片，可缩；顶部搜索（自动聚焦），列表内部滚动；按 group 分组：应用操作 / 消息输入 / 菜单与弹层 / 审批区域；行高 42px | — | — | — |
| 打开方式 | 可编辑命令 `shortcuts.open`（`Mod+/`，所有 6 个 profile 都有）：无模态或设置在前时打开，面板在前时关闭；录键/写入中/嵌套确认时不能关；也可从 设置→通用→"编辑快捷键" 打开 | — | — | — |
| 设置项 | 注入 `settings.general.item`，`id: "shortcuts"`，`order: 16`，`ShortcutsRow`：标题"快捷键"，描述，按钮"编辑快捷键"（tooltip "全局唤起查看" + 键帽） | — | — | — |
| 搜索 | 按 label / 英文 alias / 键位做有序子序列匹配（忽略大小写）；相关度优先，同分保持显示顺序 | — | — | — |
| 显示顺序 | core 顺序固定：`shortcuts.open, session.new, sidebar.left.toggle, session.search, workspace.add, session.rename, session.fork, session.archive, settings.open, fontSize.increase, fontSize.decrease, workspace.openLocal, sidebar.right.toggle, workspace.files, browser.new, terminal.new, pane.split, pane.fullscreen.toggle, page.refresh, page.close`；其余按 id 排；`response.stop` 永远排在其组最后 | — | — | — |
| 行内录键 | 点击整行进入录键；松开第一个键即保存当前组合；冲突/保留 → 录键框红边 + toast；"移除"清除绑定（未绑定时不显示）；"恢复默认"；底部"恢复全部默认"+ "{count} 项已自定义"（0 时隐藏并禁用），二次确认初始聚焦"取消"；配置或命令目录变化 → stale，需要勾选"已核对最新配置" | — | — | — |

#### 1.4 `dsh-client-connection` / `dsh-api-gateway`（client 部分）/ `dsh-client-modules` / `dsh-client-hmr`

| 功能 | 细节 | 默认 | 持久化 | RPC |
|---|---|---|---|---|
| Unary RPC | HTTP `POST <base>/api/<namespace>/<method>`，JSON 信封（见 §2） | — | — | 全部 unary |
| 流 | 单条 WebSocket `<base>/api/remote.mux`，多路复用逻辑流（open/item/end/cancel/error） | — | — | 全部 stream + `$events` |
| 鉴权 | 启动 token → 签名 cookie `dsh-auth-<sha256(authority) b64url>`（`HttpOnly; SameSite=Strict; Path=/; Max-Age=30 天`，TLS 时 `Secure`） | 30 天 | 浏览器 cookie；签名密钥在 `$DSH_HOME/.credentials.yaml` 记录 `client-connection/browser-session` | — |
| 连接代（generation） | `$events` 流首帧 `{type:'ready',clientId,host:{home}}` 才算 connected；之后发 `connection/reset`，各缓存重拉 | — | — | `$events` |
| 重连 | 抖动指数退避：cap 500ms→1s→2s→4s→8s→10s（之后保持 10s），实际延迟为 cap 的 50–100%；握手 3s 打 slow 警告，15s 超时 abort；浏览器 `offline` → `disconnected` 并暂停重试，`online` → 从 500ms 档重来；`reconnect()` 立即重试 | `backoffBaseMs 500, backoffFactor 2, backoffMaxMs 10000, generationReadyWarnMs 3000, generationReadyTimeoutMs 15000`（Host 可配，注入 `__DSH_CONNECTION_RECOVERY__`） | — | — |
| 断线提示 UI | 在 `dsh-client-ui-settings-general` 的设置触发行（侧栏左下）里 `ConnectionIndicator`：`connecting`（至少显示 800ms：`CONNECTING_MIN_VISIBLE_MS`）、`disconnected`（可点击立即重连 → `connection.reconnect()`）、`recovered`（从断线/连接中恢复后显示"连接成功" 2s：`RECOVERY_CONFIRMATION_MS`）。另有 `sidebar.toggle.badge` 徽标（侧栏收起时） | — | — | — |
| 心跳 | Host 每 `websocketHeartbeatIntervalMs`（默认 2000ms）发 WS Ping；浏览器自动回 Pong；连续 2 个间隔（`MAX_MISSED_HEARTBEATS = 2`）无任何活动则 terminate | 2s | — | — |
| 版本/热更新提示 | `/plugins/events`（SSE）推 `{type:'graph',graph}` / `{type:'rebuilt',id,rev}`；graph 里 `release:{version,commit?}` 与页面启动时不同 → `ctx.modules.entries.releaseChange` → `shell.overlay` 弹框 `host-release-change`（"服务版本变化"，"刷新以加载新版本"/"暂不刷新"）；"暂不刷新" = `dismissRelease()`，只记住最后一次 dismiss 的 release（页面内存） | — | — | SSE（非 RPC） |
| 插件热插拔 | 启用/禁用插件无需刷新：按 graph 增删 Loader entry（Web 动态模块，iOS 原生不适用） | — | — | — |
| `isLoopback` | 页面 hostname 是 `localhost` / `[::1]` / `127.x.x.x` 时为 true；部分特权 UI（如"打开设置文档"）仅 loopback 显示 | — | — | — |

#### 1.5 品牌与小插件

| 包 | 功能 | 细节 |
|---|---|---|
| `dsh-client-ui-brand-official` | 侧栏品牌 | 注入 `sidebar.brand.mark` → `FishLogo`（官方鲸鱼 mark，接受 `size` prop）；`sidebar.brand.name` → `BrandWordmark{includeMark:false}`（"DeepSeek Harness" 字标）。未装此包时 shell 用鱼 mark + `common.brand.localBuild`（"DSH 本地构建"/"DSH Local Build"）。会话 hero 永远是动画鱼。无状态、无 RPC |
| `dsh-client-ui-cordis` | 侧栏底部动作 `sidebar.footer.action`（`id: "cordis-panel"`） | **Cordis 插件面板**：触发按钮 "Cordis Plugin" + 徽标（运行中 + 待审批数量，`{count} running`）；打开后列出所有动态 Cordis 定义（不按会话过滤，"当前会话"组在前，"其他会话"在后），每行显示 Host 运行状态 + 本页加载状态（状态标记：待激活/待审批/运行失败/Client 待激活/运行中/已移除/已有更新），动作：允许（仅此版本 / 允许后续版本）、拒绝、运行、停止、移除、重试、回退、查看；内联显示渲染失败。订阅 `cordis/dynamic-package`、`cordis/dynamic-retract`、`cordis/request-run`、`cordis/request-run-resolved`、`connection/reset` → 重读 inventory |
| 同上 | `tool.call.toolview` | key `cordis_define`（`CordisDefineRow`：名称、用途、源码 Host/Client、是否运行，指向面板）、`cordis_run`（`CordisRunRow`：mode、plugin/package/run id、结果；子 slot `tool.view.cordis` 承载插件自己的业务视图）、`cordis_stop` / `cordis_undefine`（`CordisActionRow`） |
| 同上 RPC | | `dynamicCordisRunner/inventory {}` → `DynamicCordisInventoryRow[]`；`dynamicCordisRunner/stopFromPanel {agentId,pluginId}` → `DynamicCordisStopResponse`；`dynamicCordisRunner/undefineFromPanel {agentId,pluginId}` → `{ok:true,wasRunning}\|{ok:false,reason:'plugin-missing',message}`；审批/运行走 `resolveRequestRun {requestId,resolution}`、`runHostHalf {agentId,pluginId,packageId,mode,requestId,approveFutureVersions}`、`settleUserRun {agentId,pluginId,resolution}`；其余 `getClientCode / invoke / reportRenderFailure / reportClientGuardFailure / resolveInspectQuery / syncInspectManifest`。**注意：Cordis 动态插件的 Client half 是 JS 代码（`getClientCode`），iOS 原生无法执行 → 面板可做（列表/停止/移除/审批），业务视图 `tool.view.cordis` 无法原生渲染，需降级为只读卡片或 WebView** |
| `dsh-client-product-analytics` | 埋点 | **普通 Web 客户端从不提交**（仅 Desktop 经 OTel）。RPC：`productAnalytics/enabled {}` → `boolean`；`productAnalytics/report {event}` → `void`；`productAnalytics/watchPolicy {}`（stream，`boolean`）。事件名：`desktop_app_launch, auth_page_view, auth_page_click, api_key_save_click, onboarding_page_view, onboarding_page_click, onboarding_popup_view, onboarding_popup_click, desktop_upgrade_click, desktop_upgrade_download_result, desktop_upgrade_install_restart_click, send_button_click, model_switch, thinking_level_switch, context_compression, branch_session_click, sidebar_menu_click, more_menu_item_click, agent_preset_switch, code_work_view_toggle, plugin_toggle, plugin_add_button_click, plugin_install_click, install_plugin_result, confirm_uninstall_plugin`。`ProductEvent = {eventName, attributes, timestamp}`。**iOS 可忽略** |

---

### 2. 传输协议规范（可照此实现原生客户端）

#### 2.1 总览

```
                ┌──────────── HTTP(S) listener (dsh-host-webserver, host:port) ────────────┐
GET  /?token=…  │ 303 + Set-Cookie dsh-auth-…  (frontend-static → connection.authorizeIndex)│
GET  /          │ 200 index.html（需 cookie；带 <base href="./"> 和注入的 globalThis 全局）   │
GET  /connect   │ API 客户端专用 token 交换（见 2.3.2，不推荐 iOS 用）                       │
POST /api/<ns>/<method>      unary RPC（JSON 信封）                                       │
GET|HEAD|POST /api/<exact>   个别包注册的非 JSON 路由（如 session-log 下载、原始文件上传） │
WS   /api/remote.mux         多路复用流（text frame JSON）                                │
GET  /plugins/…              浏览器插件 bundle（Web 专用）                                │
GET  /plugins/events         SSE：graph / rebuilt（版本检测可用）                          │
GET  /assets/… /favicon*.svg /manifest.webmanifest   公开静态资源                          │
                └───────────────────────────────────────────────────────────────────────────┘
```
- 路径都是**相对挂载点**的（页面有 `<base href="./">`，前端用 document-relative URL）。若服务被反代挂在前缀下，iOS 也要把用户给的 base URL（含前缀）当根。
- `dsh-sdk-protocol` 是**另一套**（stdio 上的换行分隔 JSON-RPC 2.0，供 SDK/headless 使用：`initialize`、`session/prompt`…），**Web UI 不用它**，iOS 也不该用它连 Web 服务。
- `dsh-typert-protocol` 定义 `RemoteResult<T>`、`RemoteError{code,message,details}`、`RemoteStreamHandle` 等通用形状。

#### 2.2 Host/Origin 信任栅栏（先于鉴权，失败 403）

- `Host` 头必须是：loopback（`localhost`、`[::1]`、`127/8`）、**监听器绑定的 IP 字面量（任意端口）**，或 `client-connection.config.trustedHosts` 中的条目（`host:port` 精确，或 `host` 任意端口）。
- 若请求带 `Origin`，必须与 Host 同 authority；`sec-fetch-site: cross-site` 直接拒绝。
- **iOS 影响**：
  - 手机通过局域网访问 Mac：Host 头是 `192.168.x.y:port`，需要 webserver `host` 绑定到该 IP（`dsh web --host 0.0.0.0` 不支持），或在 `trustedHosts` 加入。
  - 通过隧道（dev-tunnel 等）访问：Host 是隧道域名，必须加入 `trustedHosts`。
  - 原生请求**不要发 `Origin`**（或发与 Host 一致的值）；URLSession 默认不带 Origin。第三方 WS 库（如 Starscream）默认会加 Origin，需关掉或设为同源。
- 失败语义：403 = Host/Origin 不信任；401 = 未认证（body `unauthorized`；index 页 401 body：`dsh web authentication required; reopen the URL printed by dsh web.\n`）。

#### 2.3 鉴权

##### 2.3.1 浏览器 cookie（推荐 iOS 采用）

1. `dsh web` 启动时生成进程级 launch token（32 字节 base64url），打印/打开 `http://host:port/?token=<token>`。**token 每次进程重启都会变**。
2. 客户端 `GET /?token=<token>`（必须恰好一个 `token` 参数、路径为 `/`）→
   ```
   HTTP/1.1 303 See Other
   cache-control: no-store
   location: ./
   referrer-policy: no-referrer
   set-cookie: dsh-auth-<b64url(sha256(audience))>=v1.<b64url(JSON payload)>.<b64url(HMAC-SHA256)>; Max-Age=2592000; Path=/; Expires=<UTC>; HttpOnly; SameSite=Strict[; Secure]
   ```
   - `audience`：HTTP 监听器 = `Host` 头规范化后的 `host:port`（URL.host）；HTTPS 监听器 = `https://host:port`（URL.origin）。
   - payload：`{"version":1,"authority":"<audience>","issuedAt":<ms>,"expiresAt":<ms>}`。
   - token 错误/重复 → 401。
3. 之后所有 `/`、`/api/*`、`/api/remote.mux` 请求都带 `Cookie: dsh-auth-…=v1.…`。cookie 有效 30 天（`cookieMaxAgeDays`），**跨 Host 进程重启仍有效**（签名密钥持久化）；删除 `$DSH_HOME/.credentials.yaml` 中 `client-connection/browser-session` 记录 + 重启 = 吊销全部会话；**没有 logout 接口**。
4. cookie **绑定 authority（含端口与协议）**：换 IP / 端口 / http↔https 都需重新用 token 登录。
5. 浏览器 cookie 对应共享的 **owner browser Peer**，`interactions: 'answer'`：可以打开 `$events`、接收并回答 waterfall（审批、用户提问）。可同时开多个 WS（多 tab 共享同一 Peer）。

> iOS 实现建议：让用户扫码/粘贴打印出的 URL；用 `URLSession` 关闭自动重定向（或允许重定向，从 `HTTPCookieStorage` 取）拿到 `Set-Cookie`，把 name=value 存 Keychain（按 base URL 分组）；之后**手动**给每个 `URLRequest` 和 WebSocket 握手请求加 `Cookie` 头（`URLSessionWebSocketTask` 的 cookie 自动附带行为不可靠）。

##### 2.3.2 API 客户端（`/connect`，不推荐给 iOS）

`GET /connect?token=<token>&interactions=answer|none`（默认 `none`；重复声明 → 400 `interactions must be declared once as answer or none\n`）→ `302 location: ./api/remote.mux` + `set-cookie`（payload `version:2` 含 `id`）。该 Peer **只允许一条 WS**（重复 → 409），WS 关闭即销毁 Peer，之后该 cookie 的 HTTP 也被拒；Host 重启后必须用新 token 重来。所以对需要长期使用、后台断线重连的 iOS App 不合适。

#### 2.4 Unary RPC（HTTP POST）

- URL：`<base>/api/<namespace>/<method>`（endpoint 段字符集 `/^[A-Za-z0-9_$.-]+$/`，例如 `api/settings/mutate`、`api/$events/result`）。
- 请求头：`content-type: application/json`（否则 415 `content type must be application/json`），`Cookie`，（可选）`Host` 自动。
- 请求体（`ClientRequest`）：`method` 必须等于 URL 里的 endpoint，否则返回 `gateway/bad-request`。
  ```json
  {
    "type": "client-request",
    "rpcId": "3b0f6a52-0c6e-4c1e-9a43-7f0d2b0e2c11",
    "method": "settings/mutate",
    "payload": {
      "args": {
        "ns": "ui-theme",
        "ops": [{ "op": "set", "path": ["preference"], "value": "dark" }],
        "expectedRevision": 7
      }
    }
  }
  ```
  - `payload` 永远是 `{ "args": { <参数名>: <值> } }`；参数名取 `typert.remote-client.d.ts` 中 `TYPERT_REMOTE` 的字段名（不是位置参数）；值为 `undefined` 的参数**省略**；Host 做严格校验（字段必须与 descriptor 精确匹配，多余字段 → `gateway/arguments-invalid` / `gateway/input-invalid`）。
  - Scoped 方法（`@RemoteScope`）的上下文 id（如 `agentId`/`sessionId`）也作为 args 中的一个字段传。
- 成功响应（`ServerResponse`，HTTP 200，`application/json`）：
  ```json
  { "type": "server-response", "rpcId": "3b0f6a52-…", "result": { "ok": true, "value": { "ns": "ui-theme", "revision": 8, "value": { "preference": "dark", "fontSize": 14, "…": "…" }, "…": "…" } } }
  ```
  `void` 方法 `value` 为 `null`/缺省。
- 业务/网关失败（仍是 HTTP 200）：
  ```json
  { "type": "server-response", "rpcId": "3b0f6a52-…",
    "result": { "ok": false, "error": { "code": "gateway/input-invalid", "message": "…", "details": { "endpoint": "settings/mutate", "field": "ops" } } } }
  ```
  `details` 必为对象。信封无效时 `rpcId` 可能是占位值，`code: "gateway/bad-request"`，`details.issues`。
- 二进制结果：`content-type: multipart/form-data`，part `metadata`（字符串 JSON = 上述 server-response 信封 + `attachments`），以及 `bytes-0`、`bytes-1`… 二进制 part；`result.value` 中对应位置是 `null` 占位：
  ```json
  { "type":"server-response","rpcId":"…","result":{"ok":true,"value":{"name":"a.png","data":null}},
    "attachments":[{"path":["data"],"codec":"bytes","part":"bytes-0"}] }
  ```
  path 段：字符串 = 对象键，数字 = 数组下标。没有附件的结果（含 base64 字符串）仍是纯 JSON。二进制参数/流式二进制**不支持**。
- 非 200：401/403（见上）、404（未知路由）、415、400（body 不是 JSON）、500（`handler failure: …`）、413 类（超出 `maxRequestBodyBytes`，默认 300 MiB）。Web 客户端把这些全部折叠为 `{ok:false,error:{code:"gateway/internal",…}}`；取消则折叠为 `gateway/cancelled`。iOS 应**单独识别 401 → 跳转重新登录**。
- 取消：直接取消 HTTP 请求（断开连接会 abort Host 端 handler 的 signal）。
- 客户端校验：响应 `rpcId` 必须等于请求的 `rpcId`。`rpcId` 用 v4 UUID。

##### 错误码词表（`gateway/*`，`details: { endpoint, field? }`）
`gateway/ambiguous-endpoint, gateway/arguments-invalid, gateway/binding-invalid, gateway/context-failed, gateway/context-not-found, gateway/context-unavailable, gateway/definition-unavailable, gateway/input-invalid, gateway/interactions-forbidden, gateway/invocation-unavailable, gateway/lookup-failed, gateway/lookup-not-found, gateway/lookup-unavailable, gateway/method-unavailable, gateway/peer-disposed, gateway/protocol, gateway/provider-mismatch, gateway/result-invalid, gateway/service-unavailable, gateway/signature-invalid, gateway/uplink-overflow`；另有 `gateway/bad-request`、`gateway/internal`、`gateway/cancelled`、`remote-access/denied`（`details:{action,reason}`）。业务包自己的 `RemoteError` 码原样透传。

#### 2.5 流：WebSocket `/api/remote.mux`

- URL：`ws(s)://<host:port><mount>/api/remote.mux`（http→ws，https→wss）。握手带 `Cookie`。仅在 Host 应用启动完成（`appReady`）后才注册该 upgrade 路由，之前的连接尝试会失败——按重试策略处理。
- 只用 **text frame**，每帧一个 JSON 对象。Host 收到 binary → close `1003 "text messages required"`；收到非法帧 → close `1008 "invalid Remote stream request"`；同一 streamId 重复 `open` → 关 socket；Peer 销毁 → `1001 "peer left"`；下发失败无法投递 → `1011`。Web 客户端自身：主动重连 `4000 "reconnect requested"`，收到非法服务端帧 `4002 "invalid Remote stream frame"`，销毁 `1000 "disposed"`。
- **字段严格**：两端解析器都要求精确的键集合，不要加多余字段。

##### 客户端 → Host（`RemoteStreamClientMessage`）
```json
{"type":"open","streamId":"9d1e…-uuid","endpoint":"productAnalytics/watchPolicy","payload":{"args":{}}}
{"type":"item","streamId":"9d1e…","value":{"any":"json"}}
{"type":"item","streamId":"9d1e…"}
{"type":"end","streamId":"9d1e…"}
{"type":"cancel","streamId":"9d1e…"}
```
- `item`（uplink）= 向该流发送一个上行项；顶层 `undefined` 项 = 不带 `value` 的 item；`end` = 上行半关闭；`cancel` = 取消整个逻辑流（未收到终止帧前客户端放弃时必须发）。
- 上行缓冲上限 `streamInboxBytes`（默认 262144 字节/流），溢出 → 流失败 `gateway/uplink-overflow`；`end` 之后再发 item → `gateway/protocol`（都不关 socket）。对已结束 streamId 的 item/end/cancel 会被丢弃。

##### Host → 客户端（`RemoteStreamServerMessage`）
```json
{"type":"item","streamId":"9d1e…","value":true}
{"type":"item","streamId":"9d1e…"}
{"type":"end","streamId":"9d1e…"}
{"type":"error","streamId":"9d1e…","error":{"code":"gateway/cancelled","message":"…","details":{"endpoint":"productAnalytics/watchPolicy"}}}
```
- `end` / `error` 为终止帧。未知 streamId 的帧客户端直接忽略。

##### 心跳 / 存活
- Host 每 2s 发 WS **Ping 控制帧**，客户端在协议层回 Pong（`URLSessionWebSocketTask` 自动回 Pong）。任何收到的帧、Pong、或阻塞写完成都算活动；连续 2 个间隔无活动 → Host `terminate()`。⇒ iOS 进后台挂起后几秒内会被断开，回前台必须重连。
- 客户端没有应用层 ping 义务；可选用 `sendPing` 检测死链。

#### 2.6 `$events`：转发事件流（连接代的定义者）

- 在 mux 上打开保留端点 `$events`，payload 必须是 `{"args":{}}`。需要 `interactions === 'answer'`（浏览器 cookie 满足），否则 `gateway/interactions-forbidden`。
- 第一项必须是 ready，否则视为本代失败：
  ```json
  {"type":"item","streamId":"e1","value":{"type":"ready","clientId":"c-7f…","host":{"home":"/Users/alice"}}}
  ```
  收到 ready 后才算 `connected`；`host.home` 仅用于把路径显示成 `~/…`。之后应发出本地 `connection/reset`：**所有派生缓存（会话列表、设置、inventory…）重新拉取**；普通通知断线期间不会补发。
- 后续项（`RemoteEventDownlinkFrame`）：
  ```json
  {"type":"emit","event":"settings/document-updated","args":["ui-theme",8]}
  {"type":"waterfall","event":"approval/request","eventId":"ev-12","agentId":"<sessionId>","request":{ "…": "JSON 请求字段（不含 agent/signal）" }}
  {"type":"cancel","eventId":"ev-12"}
  ```
- 回答 waterfall：用 unary `POST api/$events/result`：
  ```json
  {"type":"client-request","rpcId":"…","method":"$events/result",
   "payload":{"args":{"clientId":"c-7f…","eventId":"ev-12","outcome":{"kind":"result","value":{"…":"listener 结果(JSON)"}}}}}
  ```
  `outcome` 三选一：`{"kind":"next"}`（交给 Host 链上下一个监听者/默认行为）、`{"kind":"result","value":…}`（无值时省略 `value`）、`{"kind":"rejected","error":{"name":"Error","message":"…","code?":"…","details?":…}}`。若找不到对应 Agent 上下文，Web 回 `next`。收到 `cancel` 帧应放弃该 waterfall 且不再回复。
- ready 超时 15s、流结束、流出错、首项非 ready、帧格式错误 → 本代失效，按 §1.4 退避重连（每次重试先重建物理 WS 再重开 `$events`）。
- 转发事件白名单（`API_REMOTE_FORWARDED_EVENTS`，`ctx.remote.$on` 的合法 key）：
  - emit：`agent-preset/selected`, `api-session/activity`, `api-session/added`, `api-session/error`, `api-session/removed`, `api-session/status`, `commands/change`, `deepseek-account/session-expired`, `deepseek-account/model-sign-in-required`, `credentials/record-updated`, `credentials/reference-updated`, `goal/activation-changed`, `cordis/request-run`, `cordis/request-run-resolved`, `cordis/dynamic-package`, `cordis/dynamic-retract`, `cordis/inspect-query`, `cordis/inspect-query-resolved`, `llm/adapters-updated`, `permission-presets/catalog-changed`, `plugin-manager/changed`, `plugin-manager/install-log`, `plugin-manager/install-state`, `plugin-market/changed`, `settings/document-updated`, `schedule/changed`
  - waterfall：`approval/request`, `user-questions/request`
  - 各事件参数形状见其 owner 包 `./types` 的 Cordis `Events` 声明（其它调研分块负责）。
- ⚠️ 难点：多个 answering 客户端（例如 Mac 浏览器 + iPhone）同时在线时，waterfall 是沿 Cordis 监听链传递的（每个客户端流各有一个监听者），某客户端回 `next` 才轮到下一个——iOS **必须及时回答或回 `next`**，否则审批会卡住（此点按 waterfall 语义推断，建议实测确认）。

#### 2.7 普通 stream 方法（`@Remote({mode:'stream'})`）

- 同样在 mux 上 `open`，`endpoint = "<namespace>/<method>"`，`payload = {"args":{…}}`；返回项依次以 `item` 下发，正常结束 `end`，失败 `error`。
- 上行类型由 `RemoteStreamHandle<Out, In>` 的 `In` 决定（`never` = 不读上行）。
- 上层封装（Web 的 `$stream()` / `RemoteSnapshotStream` / `RemoteJournalStream`）：物理断线时等待重连后**重新 open**；首项通常是 snapshot/opening value，之后 delta；journal 类支持 follow-before-page、分页、断线追补与缺口修复。具体每个流的 resume 语义由各业务域定义（会话 follow 等由其它分块描述）。

#### 2.8 页面注入的全局（原生 App 拿不到，必要时自行获取）

index.html 中以 `<script>globalThis["NAME"] = <JSON></script>` 注入（可 GET `/`（带 cookie）后用正则提取）：
- `__DSH_CONNECTION_RECOVERY__`：`{"backoffBaseMs":500,"backoffFactor":2,"backoffMaxMs":10000,"generationReadyWarnMs":3000,"generationReadyTimeoutMs":15000}`
- `__DSH_SHORTCUTS_CONFIG__`：`{"stopSequenceMs":500}`
- `__DSH_BOOT__`：`WebBootGraph { rev, release?: {version, commit?}, entries, batches }`（含 Host 版本，可用于"版本变化"提示）
- 其他：`__DSH_DOCUMENT_PREVIEW_CONFIG__`、`__DSH_MODELS_ONBOARDING__`、`__DSH_CONTACT_CONFIG__`、`__DSH_REMOTE_ACCESS__`、`__DSH_INSPECTOR__`（各自分块负责）
- 结尾还有 `<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>`。
- `__DSH_TRANSPORT__`（`streamBaseUrl`、`createWebSocket`…）、`__DSH_LOCALE__` 由 Desktop 壳提供，served 页面没有。

#### 2.9 版本检测 / 热更新（SSE `/plugins/events`）

- `GET <base>/plugins/events`，`text/event-stream`；连接后先发注释 `: connected`，再发 `data: {"type":"graph","graph":{…WebBootGraph…}}`；之后图变化再发 graph，开发态重建发 `data: {"type":"rebuilt","id":"<pkg>","rev":"<rev>"}`。该路由直接注册在 webServer 上（看起来未经 cookie 校验）。
- iOS 用途：比较 `graph.release.version/commit` 与 App 适配的版本，变化时弹出等价的"服务版本变化"提示（原生 App 无法"刷新加载新版本"，可改为提示"服务已升级，部分功能可能不兼容/请更新 App"）。

#### 2.10 RPC 方法表（本分块涉及）

| 方法字符串 | args（wire 字段） | 返回 `value` 形状 | 备注 |
|---|---|---|---|
| `settings/describe` | `{}` | `SettingsDescribeValue { writable: boolean; hasDocument: boolean; namespaces: SettingsNamespaceView[] }` | 读取全部 settings；主题取 `ns==="ui-theme"`，语言取 `ns==="locale"` |
| `settings/mutate` | `{ ns: string; ops: SettingsPathOpView[]; expectedRevision?: number }` | `SettingsNamespaceView` | `SettingsPathOpView = {op:'set',path:string[],value:JsonValue} \| {op:'unset',path:string[]}`；revision 过期被拒 → 重新 describe |
| `settings/update` | `{ ns; patch: Record<string,JsonValue>; expectedRevision? }` | `SettingsNamespaceView` | Web 主题/语言未使用，可备选 |
| `settings/replace` | `{ ns; section: Record<string,JsonValue>; expectedRevision? }` | `SettingsNamespaceView` | |
| `settings/openSettingsDocument` | `{}`（cancellable） | `SettingsDocumentOpenValue` | 仅 loopback 显示的"打开设置文档" |
| `credentials/describe` / `credentials/set` / `credentials/unset` | `{refs:string[]}` / `{ref,value}` / `{ref}` | `Record<string,CredentialInfo>` / void / void | 设置分块使用 |
| `$events`（stream） | `{}` | 见 §2.6 | Gateway 保留 |
| `$events/result` | `{ clientId; eventId; outcome }` | （无关紧要） | 回答 waterfall |
| `dynamicCordisRunner/inventory` | `{}` | `DynamicCordisInventoryRow[]` | `{pluginId, agentId, packages[], currentPackageId?, nextPackageId?, activeRun?{pluginRunId,packageId}, latestRun?}` |
| `dynamicCordisRunner/stopFromPanel` | `{ agentId; pluginId }` | `DynamicCordisStopResponse`（`ok` 或 `reason:"not-running"` 视为成功） | |
| `dynamicCordisRunner/undefineFromPanel` | `{ agentId; pluginId }` | `{ok:true,wasRunning:boolean} \| {ok:false,reason:'plugin-missing',message}` | |
| `dynamicCordisRunner/resolveRequestRun` | `{ requestId; resolution }` | `DynamicCordisResolveAck` | 面板审批 |
| `dynamicCordisRunner/runHostHalf` | `{ agentId; pluginId; packageId; mode; requestId: string\|null; approveFutureVersions: boolean }` | `DynamicCordisHostHalfResult` | |
| `dynamicCordisRunner/settleUserRun` | `{ agentId; pluginId; resolution }` | `DynamicCordisRunResponse` | |
| `productAnalytics/enabled` / `report` / `watchPolicy`(stream) | `{}` / `{event}` / `{}` | `boolean` / void / `boolean` 流 | iOS 忽略 |

`SettingsNamespaceView`：`{ autoGenerate: boolean; ns: string; schema: JsonValue(schemastery JSON); value: JsonValue(合并后，已脱敏); base?: JsonValue; user?: JsonValue(用户层，存在的字段 = 被用户覆盖); applies: 'live'; secrets: SettingsSecretView[]; revision: number }`。

---

### 3. 快捷键总表

**可编辑命令**（`ctx.shortcuts.register`）。`Mod` = primary（mac ⌘ / win,linux Ctrl）。"—" = 该 profile 无默认（未绑定）。所有命令 `web:linux` 除注明外均无默认。

| id | zh 标签 | en 标签 | desktop:macos/windows/linux | web:macos | web:windows | web:linux | 所属包 | regions / modals | iPad 映射 |
|---|---|---|---|---|---|---|---|---|---|
| `shortcuts.open` | 快捷键速查 | Open keyboard shortcuts | Mod+/ | ⌘/ | Ctrl+/ | Ctrl+/ | dsh-client-ui-shortcuts | page,editable,terminal / settings,shortcuts | ✅ ⌘/（同时可借 iPadOS 长按 ⌘ 的发现面板） |
| `session.new` | 新会话 | New Session | Mod+N | ⌘⌥N | Ctrl+Alt+N | — | dsh-client-ui-workspace | page,editable / – | ✅ ⌘N |
| `sidebar.left.toggle` | 展开／收起左侧栏 | Toggle left sidebar | Mod+B | ⌘⌥B | Ctrl+Alt+B | — | dsh-client-ui-layout（ns `shortcuts.layout`） | page,editable / – | ✅ ⌘B（iPad 分栏 columnVisibility） |
| `session.search` | 搜索会话 | Search sessions | Mod+K | ⌘⌥K | Ctrl+Alt+K | — | dsh-client-ui-workspace | page,editable | ✅ ⌘K |
| `workspace.add` | 添加工作区 | Add workspace | Mod+O | ⌘⌥O | Ctrl+Alt+O | — | dsh-client-ui-workspace | page,editable | ✅ ⌘O（远端目录选择器） |
| `session.rename` | 重命名会话 | Rename session | Mod+Alt+G | ⌘⌥G | Ctrl+Alt+G | — | dsh-client-ui-workspace | page,editable | ✅ ⌘⌥G |
| `session.fork` | 分叉会话 | Fork session | Mod+Alt+F | ⌘⇧F | Ctrl+Shift+F | — | dsh-client-ui-workspace | page,editable | ✅ ⌘⌥F |
| `session.archive` | 归档会话 | Archive session | Mod+Shift+A | ⌘⌥A | Ctrl+Alt+A | — | dsh-client-ui-workspace | page,editable | ✅ ⌘⇧A |
| `settings.open` | 打开设置 | Open settings | Mod+, | ⌘⌥, | Ctrl+Alt+, | — | dsh-client-ui-settings-general | page,editable,terminal / settings | ✅ ⌘,（系统惯例） |
| `workspace.openLocal` | 在本地打开 | Open locally | Mod+Alt+O | ⌘⇧O | Ctrl+Shift+O | — | dsh-client-ui-open-in-app | page,editable | ❌（在 Host 机器上用本地 App 打开工作区；iOS 远程无意义，除非 Host=本机。可保留为"在 Mac 上打开"远程动作） |
| `sidebar.right.toggle` | 展开／收起右侧栏 | Toggle right sidebar | Mod+Alt+B | ⌘⇧B | Ctrl+Shift+B | — | dsh-client-ui-sidebar-right | page,editable,terminal | ✅ ⌘⌥B（inspector 显隐） |
| `workspace.files` | 工作区文件 | Workspace files | Mod+P | ⌘⌥P | Ctrl+Alt+P | — | dsh-client-ui-sidebar-files | page,editable,terminal | ✅ ⌘P |
| `browser.new` | 浏览器 | Browser | Mod+T | ⌘⌥T | Ctrl+Alt+T | — | dsh-client-ui-sidebar-browser | page,editable,terminal | ⚠️ ⌘T（若 iOS 实现侧栏浏览器） |
| `terminal.new` | 新建终端 | New terminal | Ctrl+` | ⌃` | Ctrl+` | — | dsh-client-ui-sidebar-terminal | page,editable,terminal | ✅ ⌃`（若实现终端） |
| `pane.split` | 分栏 | Split | Mod+\ | ⌘\ | Ctrl+\ | — | dsh-client-ui-sidebar-right | page,editable,terminal | ⚠️ 仅 iPad 大屏右侧栏分栏 |
| `pane.fullscreen.toggle` | 面板全屏／退出全屏 | Toggle panel fullscreen | Mod+Alt+Enter | ⌘⌥↩ | Ctrl+Alt+Enter | — | dsh-client-ui-sidebar-right | page,editable,terminal | ✅ ⌘⌥↩ |
| `page.refresh` | 刷新当前页面 | Refresh current page | Mod+R | **—** | Ctrl+Alt+R | — | dsh-client-ui-sidebar-right | page,editable,terminal | ✅ ⌘R（刷新右栏当前页） |
| `page.close` | 关闭当前页面／窗口 | Close current page or window | Mod+W | ⌘⌥W | Ctrl+Alt+W | — | dsh-client-ui-sidebar-right | page,editable,terminal / settings,shortcuts,other（有模态时关闭顶层模态） | ✅ ⌘W |
| `inspector.toggle` | 展开或收起 NodeJS 诊断 | Toggle NodeJS Inspector | Mod+Shift+. | ⌘⇧. | Ctrl+Shift+. | Ctrl+Shift+. | dsh-experimental-inspector（实验） | page,editable,terminal | ❌（开发诊断） |

阻塞原因文案（`blocked.reason`，Web 以提示展示）：sidebarRight `command.noRefresh` 当前页面不支持刷新 / This page cannot be refreshed；`command.noSession` 请先选择会话 / Select a session first；`command.noFocus` 请先聚焦右侧面板 / Focus a right sidebar pane first；`command.stale` 页面已切换，请重新聚焦 / The page changed; focus it again；`command.collapsed` 请先展开右侧栏 / Expand the right sidebar first；`command.float` 浮动面板不支持此操作 / This action is unavailable in a floating panel；`command.empty` 请先打开页面 / Open a page first；`command.budget` 已达两格上限 / Two panes is the limit；`command.width` 栏宽不足，拖宽侧边栏后再分栏 / Not enough width to split, widen the sidebar。open-in-app `shortcut.busy` 正在打开工作区 / Opening workspace；`shortcut.unavailable` 当前工作区或本地应用不可用 / Current workspace or local application unavailable。workspace `shortcut.noSession` 请先选择一个会话 / Select a session first；`shortcut.noPicker` 目录选择器不可用 / Directory picker unavailable；`shortcut.directoryBusy` 正在选择或添加工作区 / Selecting or adding a workspace；`shortcut.noCompletedTurn` 当前会话没有已结束的轮次 / This session has no completed turn；`shortcut.forkFailed` 无法分叉会话，请重试 / Could not fork the session. Try again.

**固定（只读）命令**（`registerFixed`，所有平台同键）：

| id | zh | en | 键 | group | 所属包 | iPad |
|---|---|---|---|---|---|---|
| `fontSize.increase` | 增大字号 | Increase font size | Mod+= / Mod+Shift+= | application | dsh-client-ui-theme（**仅 desktop runtime**） | ✅ ⌘+ / ⌘=（三字号同时 +1） |
| `fontSize.decrease` | 减小字号 | Decrease font size | Mod+- | application | dsh-client-ui-theme（仅 desktop） | ✅ ⌘- |
| `fixed.send` | 发送消息 | Send message | Enter | input | dsh-client-ui-conversation | ✅ 硬件键盘 Return 发送（`onSubmit` / `.onKeyPress(.return)`） |
| `fixed.newline` | 换行 | New line | Shift+Enter | input | dsh-client-ui-conversation | ✅ ⇧↩ 换行 |
| `fixed.complementary` | 使用互补的 Queue／Steer 方式 | Use the complementary Queue / Steer action | Mod+Enter（绑定 Ctrl+Enter 与 Meta+Enter 两者） | input | dsh-client-ui-conversation | ✅ ⌘↩ |
| `fixed.slash` | 打开命令菜单 | Open command menu | / | input | dsh-client-ui-conversation | ✅（输入框首字符 `/` 触发） |
| `fixed.mention` | 打开引用菜单 | Open reference menu | @（Shift+Digit2） | input | dsh-client-ui-conversation | ✅（输入 `@` 触发） |
| `response.stop` | 停止生成 | Stop generating | Esc Esc（两次独立 Esc，间隔 ≤ `stopSequenceMs` 500ms） | input | dsh-client-ui-conversation | ✅ 双击 Esc（iPad 键盘 ⌘. 也可作补充） |
| `approval.allow` | 允许一次 | Allow once | Enter | approval | dsh-client-ui-approval | ✅ 审批卡片聚焦时 ↩ |
| `approval.reject` | 拒绝 | Reject | Esc | approval | dsh-client-ui-approval | ✅ Esc |
| `fixed.move` | 移动菜单选择 | Move menu selection | ↑ ↓ | menus | dsh-client-ui-shortcuts | ✅（自定义菜单需支持方向键） |
| `fixed.select` | 选择菜单项 | Select menu item | Enter | menus | dsh-client-ui-shortcuts | ✅ |
| `fixed.dismiss` | 关闭菜单或顶层弹窗 | Close menu or top dialog | Esc | menus | dsh-client-ui-shortcuts | ✅（系统 sheet 默认支持 Esc） |

> 建议 iPad 采用 `desktop:macos` 列的默认键位（原生 App 无浏览器占键问题），而非 `web:macos`。

---

### 4. Locale 表（完整照抄）

#### 4.1 `common`（dsh-client-locale，全局兜底命名空间）

| key | zh | en |
|---|---|---|
| ok | 确定 | OK |
| cancel | 取消 | Cancel |
| close | 关闭 | Close |
| copy | 复制 | Copy |
| copied | 复制成功 | Copied |
| codeBlock.title | 代码块 | Code block |
| codeBlock.wrap | 自动换行 | Wrap lines |
| codeBlock.unwrap | 取消自动换行 | Do not wrap lines |
| copy.failed | 复制失败 | Copy failed |
| copy.value | 复制值 | Copy value |
| copy.json | 复制 JSON | Copy JSON |
| copy.path | 复制属性路径 | Copy property path |
| copy.prettyJson | 复制格式化 JSON | Copy pretty JSON |
| copy.compactJson | 复制紧凑 JSON | Copy compact JSON |
| copy.optionsHint | {action}；右键点击可选择复制方式 | {action}; right-click for copy options |
| retry | 重试 | Retry |
| loading | 加载中… | Loading… |
| load.failed | 加载失败 | Failed to load |
| submit | 提交 | Submit |
| submitting | 正在提交… | Submitting… |
| next | 下一步 | Next |
| previous | 上一步 | Previous |
| skip | 跳过 | Skip |
| delete | 删除 | Delete |
| edit | 编辑 | Edit |
| save | 保存 | Save |
| search | 搜索 | Search |
| more | 更多 | More |
| collapse | 收起 | Collapse |
| expand | 展开 | Expand |
| back | 返回 | Back |
| brand.localBuild | DSH 本地构建 | DSH Local Build |
| workspace.defaultName | 默认工作区 | Default workspace |
| unknown | 未知 | Unknown |
| none | 无 | None |
| truncated | 已截断 | Truncated |
| json.label | JSON | JSON |
| markdown.footnotes | 脚注 | Footnotes |
| markdown.truncatedCharacters | … 已截断，共 {total} 字符 | … truncated at {total} characters |
| number.thousand | {value}K | {value}K |
| number.million | {value}M | {value}M |

#### 4.2 `settings.locale`

| key | zh | en |
|---|---|---|
| language.title | 语言 | Language |

（语言显示名：`中文` / `English`）

#### 4.3 `settings.theme`

| key | zh | en |
|---|---|---|
| appearance.title | 外观 | Appearance |
| appearance.light | 浅色 | Light |
| appearance.dark | 深色 | Dark |
| appearance.system | 跟随系统 | System |
| fontSize.text.title | 字号大小 | Font size |
| fontSize.text.description | 仅影响会话内容的字号 | Only affects conversation content |
| fontSize.text.increase | 增大字号 | Increase font size |
| fontSize.text.decrease | 减小字号 | Decrease font size |
| fontSize.code.title | 代码字号 | Code font size |
| fontSize.code.description | 用于代码块、行内代码与工具输出 | Used for code blocks, inline code, and tool output |
| fontSize.code.increase | 增大代码字号 | Increase code font size |
| fontSize.code.decrease | 减小代码字号 | Decrease code font size |
| fontSize.terminal.title | 终端字号 | Terminal font size |
| fontSize.terminal.description | 用于侧栏终端 | Used for the sidebar terminal |
| fontSize.terminal.increase | 增大终端字号 | Increase terminal font size |
| fontSize.terminal.decrease | 减小终端字号 | Decrease terminal font size |
| fontSize.unit | px | px |
| fontFamily.text.title | 正文字体 | Text font |
| fontFamily.text.description | 用于界面与会话正文。多个字体用逗号分隔，留空使用默认字体 | Used for the interface and conversation text. Separate fonts with commas; leave empty for the default |
| fontFamily.code.title | 代码字体 | Code font |
| fontFamily.code.description | 用于代码块、行内代码与工具输出。多个字体用逗号分隔，留空使用默认字体 | Used for code blocks, inline code, and tool output. Separate fonts with commas; leave empty for the default |
| fontFamily.terminal.title | 终端字体 | Terminal font |
| fontFamily.terminal.description | 用于侧栏终端。多个字体用逗号分隔，留空使用默认字体 | Used for the sidebar terminal. Separate fonts with commas; leave empty for the default |
| fontFamily.placeholder | 默认 | Default |
| fontSize.more | 更多字体设置 | More font settings |

（插件 meta：`界面主题` / `ui-theme`，描述 `提供浅色、深色和跟随系统的主题设置。`）

#### 4.4 `shortcuts`（dsh-client-ui-shortcuts）

| key | zh | en |
|---|---|---|
| edit-label | 修改{command}快捷键 | Edit shortcut for {command} |
| record | 按下快捷键 | Press a shortcut |
| record-help | 松开组合键即保存。Tab 切换操作，Esc 退出录键。 | Release the keys to save. Tab moves between actions; Esc cancels. |
| web-help | 浏览器可用组合：Mod+/、Mod+Shift+,、Mod+Shift+.。Mod 在 Mac 上为 Command，其他系统为 Ctrl。 | Browser combinations: Mod+/, Mod+Shift+,, Mod+Shift+.. Mod is Command on Mac and Ctrl elsewhere. |
| unsupported-key | 暂不支持这个按键。 | This key is not supported. |
| reserved | 此组合由系统或文本编辑操作保留。 | This combination is reserved for system or text editing actions. |
| modifier-required | 请同时按下 Command、Ctrl 或 Alt 修饰键。 | Include Command, Ctrl, or Alt in the combination. |
| too-many-keys | 最多同时按下两个非修饰键。请松开后重试。 | Hold at most two non-modifier keys. Release the keys to try again. |
| macos-web-help | 可设置 Command+/、Command+,、Command+反斜杠、Control+反引号、Command+Option+按键或 Command+Shift+按键。也支持三个或四个不同修饰键的组合。浏览器或系统占用的组合可能无法送达页面。 | Use Command+/, Command+,, Command+Backslash, Control+Backquote, Command+Option+key, or Command+Shift+key. Combinations with three or four distinct modifiers are also supported. Browser or system shortcuts may not reach the page. |
| windows-web-help | 可设置 Ctrl+/、Ctrl+,、Ctrl+Alt+按键或 Ctrl+Shift+按键。也支持三个或四个不同修饰键的组合。浏览器或系统占用的组合可能无法送达页面。 | Use Ctrl+/, Ctrl+,, Ctrl+Alt+key, or Ctrl+Shift+key. Combinations with three or four distinct modifiers are also supported. Browser or system shortcuts may not reach the page. |
| unsupported-browser | 此浏览器暂不支持该组合。 | This browser does not support this combination yet. |
| conflict | 已被「{commands}」占用 | Already used by “{commands}” |
| saved | 已修改 | Modified |
| clear | 移除 | Remove |
| retry-save | 重试保存 | Retry save |
| reset | 恢复默认 | Restore default |
| reset-all | 恢复全部默认 | Restore all defaults |
| modified-count | {count} 项已自定义 | {count} customized |
| reset-title | 恢复全部默认快捷键？ | Restore all default shortcuts? |
| reset-description | 将恢复当前平台的默认快捷键。你修改或移除的快捷键都会恢复，其他平台不受影响。 | Restore the default shortcuts for this platform. All modified or removed shortcuts will be restored. Other platforms are unaffected. |
| cancel | 取消 | Cancel |
| reset-saved | 已恢复默认快捷键 | Default shortcuts restored |
| close-confirmation | 关闭确认 | Close confirmation |
| reset-failed | 恢复默认失败。原快捷键已保留，请重试。 | Could not restore defaults. Your shortcuts are unchanged. Please retry. |
| review | 已核对最新配置 | I have reviewed the latest configuration |
| stale | 快捷键配置或可用命令已更新。请核对最新键位后再保存。 | Shortcut configuration or available commands changed. Review the latest bindings before saving. |
| write-failed | 保存失败。原快捷键和当前草稿已保留，请重试。 | Could not save. Your previous shortcuts and current draft are preserved. Please retry. |
| not-ready | 快捷键尚未准备好，请稍后重试。 | Shortcuts are not ready. Please try again. |
| read | 无法读取 {location}。请检查访问权限后{reload}。 | Could not read {location}. Check access permissions, then {reload}. |
| invalid | {location} 的快捷键配置内容损坏。请先备份并修复该配置，然后{reload}。 | Shortcut configuration in {location} is damaged. Back up and repair this configuration, then {reload}. |
| future | {location} 的快捷键配置由更新版本创建。请升级 Harness 后重试。 | Shortcut configuration in {location} was created by a newer version. Upgrade Harness and try again. |
| web-document | 当前网站本地存储中的 dsh.keybindings.v1 | this site’s localStorage entry dsh.keybindings.v1 |
| desktop-document | userData/keybindings.json | userData/keybindings.json |
| web-reload | 刷新页面 | reload the page |
| desktop-reload | 重新启动 Harness | restart Harness |
| using-defaults | 当前使用默认键位。 | Default bindings are active. |
| using-accepted | 当前继续使用上次读取成功的键位。 | The last successfully read bindings remain active. |
| native-failed | 无法启用桌面录键保护，请关闭后重试。 | Could not protect desktop key recording. Exit recording and try again. |
| global-hint | 全局唤起查看 | Open from anywhere |
| clear-search | 清空搜索 | Clear search |
| title | 快捷键 | Keyboard shortcuts |
| open | 快捷键速查 | Open keyboard shortcuts |
| settings | 快捷键 | Keyboard shortcuts |
| view | 编辑快捷键 | Edit shortcuts |
| description | 查看和编辑当前可用的快捷键和输入操作 | View and edit available shortcuts and input actions |
| search | 搜索快捷键 | Search shortcuts |
| close | 关闭快捷键 | Close keyboard shortcuts |
| application | 应用操作 | Application |
| input | 消息输入 | Message input |
| menus | 菜单与弹层 | Menus and dialogs |
| approval | 审批区域 | Approval area |
| unbound | 暂无快捷键 | No shortcut |
| empty | 没有匹配的快捷键 | No matching shortcuts |
| move | 移动菜单选择 | Move menu selection |
| select | 选择菜单项 | Select menu item |
| dismiss | 关闭菜单或顶层弹窗 | Close menu or top dialog |

#### 4.5 `shortcuts.layout`（dsh-client-ui-layout）

| key | zh | en |
|---|---|---|
| toggle | 展开／收起左侧栏 | Toggle left sidebar |

#### 4.6 `settings`（dsh-client-ui-settings-general）中与本分块相关的 key（其余由设置分块负责）

| key | zh | en |
|---|---|---|
| shortcut.open | 打开设置 | Open settings |
| connection.error | 连接异常，刷新重试 | Disconnected |
| connection.connecting | 重新连接中 | Reconnecting |
| connection.connected | 连接成功 | Connected |
| connection.reconnect | 连接异常，点击立即重连 | Disconnected, reconnect now |
| connection.restart | 连接中断，正在重试，点击立即重连 | Reconnecting, reconnect now |
| hostRelease.title | 服务版本变化 | Service version changed |
| hostRelease.description | 服务版本已变化，本页面已暂停热更新，刷新后加载新版本。 | The service version changed. This page paused live updates; reload to load the new version. |
| hostRelease.service | 服务 | Service |
| hostRelease.page | 页面 | Page |
| hostRelease.unknown | 未解析 | Unknown |
| hostRelease.reload | 刷新以加载新版本 | Reload to load the new version |
| hostRelease.later | 暂不刷新 | Not now |

版本弹框文案逻辑：两端 version 不同时显示 version，否则显示 commit；"服务"行显示 Host 已完成的 previous→host（起点淡化），"页面"行显示 page→host（终点淡化，表示待刷新）。

#### 4.7 `cordis`（dsh-client-ui-cordis）

| key | zh | en |
|---|---|---|
| row.defineTitle | 注册 Cordis 插件 | Register Cordis Plugin |
| a11y.preparing | 准备调用 Cordis 工具 | Preparing a Cordis tool call |
| row.runTitle | 运行 Cordis 插件 | Run Cordis Plugin |
| row.updateTitle | 更新 Cordis 插件 | Update Cordis Plugin |
| row.stopTitle | 停止 Cordis 插件 | Stop Cordis Plugin |
| row.removeTitle | 移除 Cordis 插件 | Remove Cordis Plugin |
| purpose.missing | (未填写用途) | (no purpose given) |
| status.idle | 待激活 | Ready |
| status.awaitingApproval | 待审批 | Awaiting approval |
| status.failed | 运行失败 | Run failed |
| status.clientPending | Client 待激活 | Client ready to activate |
| status.running | 运行中 | Running |
| status.removed | 已移除 | Removed |
| status.superseded | 已有更新 | Newer run available |
| run.removed | 包已不存在 | This package no longer exists |
| run.superseded | 已有更新的运行卡片，请查看下方 | A newer run card is available below |
| panel.hint | 运行控制在左下角设置上方的 Cordis 面板 | Run controls live in the Cordis panel above Settings |
| panel.plugins.aria | Cordis 插件 | Cordis plugins |
| panel.approvals.aria | Cordis 审批 | Cordis approvals |
| panel.trigger | Cordis Plugin | Cordis Plugin |
| panel.runningCount | {count} running | {count} running |
| panel.title | Cordis 插件 | Cordis plugins |
| panel.empty | 还没有定义任何插件 | No plugins defined yet |
| panel.loading | 读取中… | Reading… |
| panel.readFailed | 读取插件清单失败：{message} | Reading the plugin inventory failed: {message} |
| panel.group.current | 当前会话 | This session |
| panel.group.others | 其他会话 | Other sessions |
| panel.version | 版本 | Version |
| panel.current | 当前：{packageId} | Current: {packageId} |
| panel.next | 待切换：{packageId} | Next: {packageId} |
| action.approve | 允许 | Allow |
| action.approveOnce | 仅允许此版本 | Allow this version only |
| action.approvePlugin | 允许此插件的后续版本 | Allow future versions of this plugin |
| action.decline | 拒绝 | Decline |
| action.run | 运行 | Run |
| action.stop | 停止 | Stop |
| action.remove | 移除 | Remove |
| action.retry | 重试 | Retry |
| action.rollback | 回退 | Roll back |
| action.inspect | 查看 | Inspect |
| render.failedAbdicated | {slot} 渲染失败，已恢复默认界面： | Rendering failed in {slot}; the default UI was restored: |
| render.failedHeld | {slot} 渲染失败： | Rendering failed in {slot}: |
| a11y.defining | 正在定义插件 | Defining the plugin |
| a11y.failed | 定义失败 | Definition failed |
| a11y.stopped | 定义已中断 | Definition interrupted |
| body.source | 插件代码 | Plugin source |
| body.hostCode | Host | Host |
| body.clientCode | Client | Client |
| body.output | 结果 | Result |
| body.copy | 复制 | Copy |
| body.copied | 已复制 | Copied |

#### 4.8 快捷键标签所在的其它命名空间（仅相关 key，完整字典由各分块负责）

| ns | key | zh | en |
|---|---|---|---|
| workspace | session.new | 新会话 | New Session |
| workspace | search.sessions.aria | 搜索会话 | Search sessions |
| workspace | workspace.add | 添加工作区 | Add workspace |
| workspace | rename.session.title | 重命名会话 | Rename session |
| workspace | menu.fork | 分叉会话 | Fork session |
| workspace | menu.archiveSession | 归档会话 | Archive session |
| open-in-app | open.tooltip | 在本地打开 | Open locally |
| sidebarFiles | guide.title | 工作区文件 | Workspace files |
| sidebarBrowser（browser 包） | guide.title | 浏览器 | Browser |
| sidebarTerminal | new | 新建终端 | New terminal |
| sidebarRight | command.toggle / dock.splitPane / command.fullscreen / command.refresh / command.close | 展开／收起右侧栏 / 分栏 / 面板全屏／退出全屏 / 刷新当前页面 / 关闭当前页面／窗口 | Toggle right sidebar / Split / Toggle panel fullscreen / Refresh current page / Close current page or window |
| conversation | input.send / shortcut.newline / shortcut.complementary / shortcut.slash / shortcut.mention / input.stop | 发送消息 / 换行 / 使用互补的 Queue／Steer 方式 / 打开命令菜单 / 打开引用菜单 / 停止生成 | Send message / New line / Use the complementary Queue / Steer action / Open command menu / Open reference menu / Stop generating |
| approval | allowOnce / reject | 允许一次 / 拒绝 | Allow once / Reject |
| inspector | toggle | 展开或收起 NodeJS 诊断 | Toggle NodeJS Inspector |

---

### 5. 主题 token 精选表（`--dsw-*`，来自 `design-platform.css`，light = `body`，dark = `body[data-ds-dark-theme]`）

| token | 用途 | light | dark |
|---|---|---|---|
| `--dsw-alias-bg-base` | 页面主背景（=boot canvas） | `#fff` | `#151517` |
| `--dsw-alias-bg-layer-1` | 一级浮层/卡片 | `#fff` | `#232324` |
| `--dsw-alias-bg-layer-2` | 二级浮层 | `#fff` | `#2c2c2e` |
| `--dsw-alias-bg-layer-3` | 三级浮层 | `#fff` | `#353638` |
| `--dsw-specific-sidebar-fill` | 左侧栏填充 | `#f9fafb` | `#1b1b1c` |
| `--dsw-specific-sidebar-nav-item-hover` | 侧栏项 hover | `#f1f3f5` | `#2c2c2e` |
| `--dsw-specific-sidebar-nav-item-active` | 侧栏项选中 | `#ebeef2` | `#43454a` |
| `--dsw-specific-sidebar-nav-item-active-accent` | 侧栏项选中（强调） | `#e4edfd` | `#353638` |
| `--dsw-specific-input-major` | 主输入框（composer）背景 | `#fff` | `#2c2c2e` |
| `--dsw-specific-bubble` | 用户消息气泡 | `#edf3fe` | `#2c2c2e` |
| `--dsw-specific-bubble-highlight` | 气泡高亮 | `#d3e2ff` | `#43454a` |
| `--dsw-specific-menu` | 菜单材质（半透明，配 blur） | `#f8f9fa94`（macOS Desktop `#f8f9faf0`） | `#43454a73`（macOS `#303136f0`） |
| `--dsw-specific-selector` | 选择器/分段控件底 | `#f5f6f7` | `#353638` |
| `--dsw-specific-tip` | 提示块底 | `#f5f6f7` | `#353638` |
| `--dsw-alias-label-primary` | 主文字 | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-secondary` | 次文字 | `#61666b` | `#cfd3d6` |
| `--dsw-alias-label-tertiary` | 三级文字 | `#81858c` | `#adb2b8` |
| `--dsw-alias-label-caption` | 说明文字 | `#adb2b8` | `#81858c` |
| `--dsw-alias-label-dimmed` | 禁用文字 | `#e1e5ee` | `#43454a` |
| `--dsw-alias-label-primary-foreground` | 主按钮上的文字 | `#fff` | `#0f1115` |
| `--dsw-alias-border-l1` | 最细分隔 | `#0000000a` | `#ffffff0f` |
| `--dsw-alias-border-l2` | 常规边框（设置行底线等） | `#0000001a` | `#ffffff1f` |
| `--dsw-alias-border-l3` | 较强边框 | `#0000001f` | `#ffffff29` |
| `--dsw-alias-border-l4` | 最强边框 / elevation stroke | `#00000029` | `#fff3` |
| `--dsw-alias-brand-primary` | 品牌主色（黑/白） | `#0f1115` | `#f9fafb` |
| `--dsw-alias-state-business-primary` | 强调蓝（链接、focus ring、选中） | `#4176e6` | `#7aaaff` |
| `--dsw-alias-state-business-tertiary` | 强调蓝浅底 | `#e4edfd` | `#34415b` |
| `--dsw-alias-link` | 链接 | `#4176e6` | `#7aaaff` |
| `--dsw-alias-button-primary-fill` | 主按钮 | `#0f1115` | `#f9fafb` |
| `--dsw-alias-button-primary-hover` | 主按钮 hover | `#43454a` | `#ebeef2` |
| `--dsw-alias-button-ghost-active-fill` | ghost 按钮按下 | `#ebeef2` | `#43454a` |
| `--dsw-alias-interactive-bg-hover` | 通用 hover 底 | `#2631480f` | `#ffffff14` |
| `--dsw-alias-interactive-bg-active` | 通用按下底 | `#2631481a` | `#ffffff24` |
| `--dsw-alias-state-error-primary` | 错误 | `#ec1313` | `#f25a5a` |
| `--dsw-alias-state-success-primary` | 成功 | `#22c55e` | `#22c55e` |
| `--dsw-alias-state-warn-primary` | 警告 | `#f59e0b` | `#f59e0b` |
| `--dsw-alias-state-idle-primary` | 空闲状态点 | `#d4d4d4` | `#545557` |
| `--dsw-alias-markdown-code-block` | 代码块底 | `#f9fafb` | `#1b1b1c` |
| `--dsw-alias-markdown-code-block-banner` | 代码块标题栏 | `#f9fafb` | `#2c2c2e` |
| `--dsw-alias-markdown-inline-code` | 行内代码底 | `#fafafa` | `#292929` |
| `--dsw-alias-code-diff-added` / `-deleted` | diff 行底 | `#22c55e14` / `#ec131314` | `#22c55e1f` / `#f25a5a1f` |
| `--dsw-alias-toast-bg` / `--dsw-alias-toast-label` | toast | `#353638` / `#fff` | `#43454a` / `#fff` |
| `--dsw-alias-tooltip-bg` | tooltip | `#2c2c2e` | `#43454a` |
| `--dsw-alias-bg-mask-1` | 模态遮罩 | `#0000003d` | `#00000080` |
| `--dsw-alias-switch-thumb` | 开关滑块 | `#fff` | `#adb2b8` |
| `--dsw-alias-label-deep-diving` | 思考中蓝色标签 | `color-mix(in srgb, #4176e6 70%, #172554)` | `color-mix(in srgb, #5686fe 55%, #adb2b8)` |
| `--dsw-alias-bg-skeleton` | 骨架屏 | `#0000000a` | `#ffffff14` |

完整 112 个 alias/specific token 见附录 F（列：token、light、dark，var() 已解析为 hex）。阴影：`--dsw-shadow-lv1: 0 2px 4px 0 #0000000d`，`lv2: 0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a`，`lv3: 0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014`；elevation 用 0.5px hairline（`--dsw-elevation-stroke-color: var(--dsw-alias-border-l4)`）。

---

### 6. 手机端 SwiftUI 对应建议

#### 6.1 外观
- 根视图 `.preferredColorScheme(pref == .system ? nil : (pref == .dark ? .dark : .light))`；`system` 直接交给 iOS（等价于 `prefers-color-scheme`）。
- token 落地为 Asset Catalog 的 Any/Dark 颜色集或 `Color(light:dark:)` 动态色（`UIColor { trait in … }`），名称沿用 token 名，便于对照。半透明菜单材质 → `.ultraThinMaterial`/`.regularMaterial`，不必硬抄 `--dsw-specific-menu`。
- 写入：`settings/mutate {ns:"ui-theme", ops:[{op:"set",path:["preference"],value}], expectedRevision}`；乐观更新本地；串行队列 + 失败重读（与 Web 一致）。监听 `settings/document-updated` 且 `args[0]==="ui-theme"` 时重读（自身写入在途时忽略回推）。
- 首屏：本地缓存上次的 `ui-theme` 值（UserDefaults），启动先用缓存渲染，连接后以服务端为准（替代 Web 的 index 注入 boot script）。
- 注意：偏好是**服务端共享**的（所有浏览器/设备同一份）。iOS 若希望"本机独立外观"，需要额外的本地覆盖开关——但"保留所有功能"要求至少支持同步服务端值。建议：默认跟随服务端值，可选"仅本设备"开关（非 Web 原有功能，需标注）。

#### 6.2 字号与 Dynamic Type
- 服务端 `fontSize`(10–22, 默认14) 是"会话内容字号"，不影响界面 chrome。建议：**界面 chrome 完全使用 Dynamic Type**；会话内容用 `scale = fontSize / 14` 乘以 Dynamic Type 的 body 尺寸（`UIFontMetrics(forTextStyle: .body).scaledValue(for: 17 * scale)` 或 `@ScaledMetric`），这样两者叠加：用户系统字号 + 服务端偏好同时生效。代码字号 `codeFontSize/11`、终端 `terminalFontSize/13` 同理（终端可不跟 Dynamic Type）。
- 次级档规则（≤14 时 -1，>14 时 -2）与行内代码 +1px 可在 Markdown 渲染器内复刻。
- 设置页：`Stepper(value:in:step:1)` 显示 `"\(n) px"`，三个 role；"更多字体设置"用 `DisclosureGroup`（每次进入设置折叠）。
- 字体族：输入框按 Web 的 `normalizeFontFamily` 规则规范化后写回；渲染时按逗号列表依次 `UIFont(name:size:)` 尝试（iOS 只有系统已装字体/App 内置字体），通用族映射：`monospace`→`.monospaced` design，`sans-serif`/`system-ui`→系统字体，`serif`→`.serif`；全失败回落内置（text：系统字体/PingFang SC；code：SF Mono `.monospaced`）。
- 键盘 ⌘+ / ⌘- / ⌘=（iPad）：三字号同时 ±1，一次 mutation 写多个字段（Web 仅 Desktop 有，iPad 加上合理）。

#### 6.3 语言
- 不能依赖 Bundle 本地化做运行时切换：用自建字典（直接把 §4 的 zh/en 表生成为 Swift 常量或 `.strings`/String Catalog 两套，运行时按 `active` 选表），`{name}` 占位符自己替换；查找顺序 当前 ns → `common` → key。
- 设置 → 通用 → 语言 用 `Picker`/`Menu`（中文 / English）；选择即 `settings/mutate {ns:"locale", ops:[{op:"set",path:["preference"],value:"zh"}]}`（即使同值也写）。
- 跟随系统：无服务端 `preference` 时，用 `Locale.preferredLanguages` 按"全标签→主子标签"匹配 `zh`/`en`，否则 `en`；不写回。
- 同时给 SwiftUI 环境 `.environment(\.locale, Locale(identifier: active == "zh" ? "zh-Hans" : "en"))`，让日期/数字格式跟随。
- 监听 `settings/document-updated` 且 ns==="locale" 时重读。

#### 6.4 快捷键（iPad 硬件键盘）
- 用 `desktop:macos` 列默认键位。SwiftUI：在 `.commands { CommandMenu(...) { Button(...).keyboardShortcut("n", modifiers: .command) } }` 中声明（iPadOS 长按 ⌘ 的**发现面板**和 iPadOS 26 菜单栏会自动列出），或 UIKit `UIKeyCommand` + `discoverabilityTitle` 用 §3 的 zh/en 标签。
- `regions`/`modals` 语义：SwiftUI 中 focus 在 TextEditor 时 ⌘ 组合仍会触发菜单命令（与 `editable` 一致）；有 sheet 时用 `.disabled` 或按 modal 白名单控制（`settings.open` 只在无模态/设置页时有效，`page.close` 有模态时关闭顶层模态 → `dismiss()`）。
- `blocked` 原因用轻提示（toast/HUD）显示 §3 的文案。
- 固定输入：Return 发送 / ⇧Return 换行 / ⌘Return 互补 Queue/Steer：在输入框用 `.onKeyPress(keys:[.return], phases:.down)` 判断 `modifiers`；`/`、`@` 触发菜单靠文本变化检测；Esc Esc 停止：记录上次 Esc 时间，间隔 ≤ `stopSequenceMs`（从 `__DSH_SHORTCUTS_CONFIG__` 取或默认 500）；审批卡片 ↩/Esc。
- 快捷键速查面板（⌘/）：做成 sheet，分组列表 + `.searchable`，展示当前键位；**自定义重绑定**：Web 存 localStorage（与 Host 无关），iOS 存 UserDefaults，文档结构可复用 `ShortcutDocument`（profile 键可自定义如 `ios:ipados`，与 Web 不共享）。SwiftUI `.keyboardShortcut` 支持用状态动态构造 `KeyboardShortcut`，因此重绑定可实现；录键可用 `UIPress`/`pressesBegan` 捕获。iPhone 无硬件键盘时整块隐藏或只读。

#### 6.5 连接 / 传输
- 封装 `DSHConnection`（actor）：`baseURL`、Keychain 里的 cookie、`URLSession`（unary）+ 单条 `URLSessionWebSocketTask`（mux），`streamId → AsyncThrowingStream` 路由表；状态机 `connecting / connected / disconnected` 发布给 UI（`@Observable`）。
- 连接代：WS open → 立刻 open `$events` → 等 ready（15s 超时，3s 打日志）→ `connected` + 广播 `connectionReset`（各 Store 重新拉取）。任一失败 → 退避（500ms×2^n 封顶 10s，50–100% 抖动）重建 WS。
- `NWPathMonitor` 等价浏览器 online/offline：无网 → `disconnected` 暂停重试；恢复 → 从第一档重试。`scenePhase == .background` 主动关闭 WS（Host 2s ping / 2 次未应答也会断）；回 `.active` 立即 `reconnect()`（重置退避）。
- UI：侧栏底部（或导航栏）连接指示器，复刻 connecting 至少显示 800ms、恢复后"连接成功"显示 2s、断开可点击立即重连。
- 401 → 清 cookie，进入"扫描/粘贴 `dsh web` 打印的 URL"登录页；403 → 提示 Host 未信任（需 `trustedHosts` 或绑定局域网 IP）。
- 版本：连接后 GET `/plugins/events`（SSE）或解析 `/` 的 `__DSH_BOOT__.release`，与 App 兼容版本比对，变化时弹出等价"服务版本变化"提示（按钮改为"重新连接"/"稍后"）。
- Waterfall（`approval/request`、`user-questions/request`）：收到后在 UI 弹审批/提问，用户作答后 `POST api/$events/result`；收到 `cancel` 帧撤销 UI；本端无法处理时回 `{"kind":"next"}`，**不要沉默**。

#### 6.6 品牌 / Cordis / 埋点
- 品牌：App 内置鲸鱼 mark 与 "DeepSeek Harness" 字标（侧栏顶部）；本地构建标签用 `common.brand.localBuild`。
- Cordis 面板：侧栏底部按钮 + 徽标（运行中+待审批），sheet 列表分"当前会话/其他会话"，支持 允许/拒绝/运行/停止/移除/重试/回退；`tool.view.cordis` 业务视图是动态 JS，原生只能降级（显示 run 卡片元数据，或可选 WKWebView 承载——需评估）。
- 埋点：忽略（Web 本身不上报）。

---

### 7. 难点 / 风险汇总
1. **鉴权引导**：必须先拿到 `dsh web` 打印的 `?token=` URL（进程重启即变）才能换取 30 天 cookie；cookie 绑定 `host:port`+协议，换网络地址需重登。无 logout。
2. **Host 信任栅栏**：手机经局域网/隧道访问时 Host 头非 loopback，需服务端配置 `trustedHosts` 或绑定具体网卡 IP；原生 WS 库别发跨源 `Origin`。
3. **严格帧格式**：mux 帧与 RPC 信封都是精确键集合校验；args 用 descriptor 字段名、省略 undefined。
4. **后台断线**：2s Ping、2 次未应答即断，iOS 后台必断，需前台即时重连 + `connection/reset` 全量重拉；普通通知不补发。
5. **Waterfall 必答**：审批/提问经 `$events` waterfall 下发，需 HTTP `$events/result` 回答；多客户端并存时链式传递（推断，建议实测）。
6. **主题/语言是服务端共享设置**（`ui-theme`、`locale` 命名空间），快捷键是**设备本地**（Web localStorage），三者持久化位置不同。
7. **Dynamic Type 与服务端字号叠加策略**需产品确认；字体族在 iOS 只能用已安装字体。
8. **Cordis 动态插件 Client half 为 JS**，原生无法执行其业务视图。

---

# F. 附录：主题 token 全表（112 项，`var()` 已解析）

| token | light | dark |
|---|---|---|
| `--dsw-alias-bg-base` | `#fff` | `#151517` |
| `--dsw-alias-bg-document-preview` | `#ebeef2` | `#151517` |
| `--dsw-alias-bg-document-selection` | `color-mix(in srgb, #3b82f6 40%, transparent)` | `color-mix(in srgb, #3b82f6 40%, transparent)` |
| `--dsw-alias-label-document-preview` | `#61666b` | `#cfd3d6` |
| `--dsw-alias-bg-layer-1` | `#fff` | `#232324` |
| `--dsw-alias-bg-layer-2` | `#fff` | `#2c2c2e` |
| `--dsw-alias-bg-layer-3` | `#fff` | `#353638` |
| `--dsw-alias-bg-mask-1` | `#0000003d` | `#00000080` |
| `--dsw-alias-bg-mask-2` | `#0000001f` | `#0003` |
| `--dsw-alias-bg-mask-3` | `#0000007a` | `#0000007a` |
| `--dsw-alias-bg-mask-photo` | `#000000e0` | `#000000e0` |
| `--dsw-alias-bg-mask-drop` | `#ffffffb3` | `#272730b3` |
| `--dsw-alias-bg-module-platform` | `#f5f6f7` | `#353638` |
| `--dsw-alias-bg-multi-select` | `#f5f6f7` | `#212123` |
| `--dsw-alias-bg-overlay` | `#e9ecf2` | `#61666b` |
| `--dsw-alias-bg-skeleton` | `#0000000a` | `#ffffff14` |
| `--dsw-alias-border-inverted2` | `#0000` | `#ffffff14` |
| `--dsw-alias-border-inverted` | `#0000` | `#ffffff0f` |
| `--dsw-alias-border-l1` | `#0000000a` | `#ffffff0f` |
| `--dsw-alias-border-l2-darkmode-thin` | `#0000001a` | `#ffffff0f` |
| `--dsw-alias-border-l2` | `#0000001a` | `#ffffff1f` |
| `--dsw-alias-border-l3` | `#0000001f` | `#ffffff29` |
| `--dsw-alias-border-l4` | `#00000029` | `#fff3` |
| `--dsw-alias-brand-primary-invert` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-brand-primary-new-colorprimary-new-color` | `#4176e6` | `#5686fe` |
| `--dsw-alias-brand-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-brand-text` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-button-contrast-fill` | `#61666b` | `#f9fafb` |
| `--dsw-alias-button-elevated-fill` | `#fff` | `#43454a` |
| `--dsw-alias-button-floating-fill` | `#fff` | `#2c2c2e` |
| `--dsw-alias-button-floating-hover` | `#f1f3f5` | `#353638` |
| `--dsw-alias-button-ghost-active-border` | `#979da6` | `#81858c` |
| `--dsw-alias-button-ghost-active-fill` | `#ebeef2` | `#43454a` |
| `--dsw-alias-button-ghost-active-hover` | `#e9ecf2` | `#61666b` |
| `--dsw-alias-button-info-fill` | `#4176e6` | `#7aaaff` |
| `--dsw-alias-button-info-hover` | `#7aaaff` | `#4176e6` |
| `--dsw-alias-button-primary-dimmed` | `#ebeef2` | `#43454a` |
| `--dsw-alias-button-primary-fill` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-button-primary-hover` | `#43454a` | `#ebeef2` |
| `--dsw-alias-button-tool-bar-fill-invisible` | `#1f1f1f5c` | `#1f1f1f5c` |
| `--dsw-alias-button-tool-bar-fill` | `#54555780` | `#54555780` |
| `--dsw-alias-button-tool-bar-hover` | `#54555799` | `#54555799` |
| `--dsw-alias-interactive-bg-active` | `#2631481a` | `#ffffff24` |
| `--dsw-alias-interactive-bg-hover-accent` | `#26314824` | `#ffffff3d` |
| `--dsw-alias-interactive-bg-hover-danger` | `#ec13130d` | `#f25a5a26` |
| `--dsw-alias-interactive-bg-hover-solid` | `#f1f3f5` | `#353638` |
| `--dsw-alias-interactive-bg-hover` | `#2631480f` | `#ffffff14` |
| `--dsw-alias-label-caption` | `#adb2b8` | `#81858c` |
| `--dsw-alias-label-deep-diving` | `color-mix(in srgb, #4176e6 70%, #172554)` | `color-mix(in srgb, #5686fe 55%, #adb2b8)` |
| `--dsw-alias-label-deep-diving-shimmer` | `color-mix(in srgb, #4176e6 30%, #172554)` | `color-mix(in srgb, #93c5fd 65%, #7aaaff)` |
| `--dsw-alias-label-dimmed` | `#e1e5ee` | `#43454a` |
| `--dsw-alias-label-primary-bluish` | `#0e3074` | `#f9fafb` |
| `--dsw-alias-label-primary-dimmed` | `#151517` | `#ebeef2` |
| `--dsw-alias-label-primary-foreground` | `#fff` | `#0f1115` |
| `--dsw-alias-label-primary-inverted` | `#fff` | `#353638` |
| `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` |
| `--dsw-alias-label-shimmer` | `color-mix(in srgb, #000 30%, transparent)` | `color-mix(in srgb, #fff 45%, transparent)` |
| `--dsw-alias-label-tertiary` | `#81858c` | `#adb2b8` |
| `--dsw-alias-menu-icon` | `#353638` | `#ebeef2` |
| `--dsw-alias-link` | `#4176e6` | `#7aaaff` |
| `--dsw-alias-markdown-citation` | `#ebeef2` | `#353638` |
| `--dsw-alias-markdown-code-block-banner` | `#f9fafb` | `#2c2c2e` |
| `--dsw-alias-markdown-code-block` | `#f9fafb` | `#1b1b1c` |
| `--dsw-alias-markdown-code-segment-selected` | `#fff` | `#353638` |
| `--dsw-alias-markdown-code-segment-unselected` | `#f1f3f5` | `#1b1b1c` |
| `--dsw-alias-markdown-inline-code` | `#fafafa` | `#292929` |
| `--dsw-alias-markdown-placeholder` | `#f5f6f7` | `#2c2c2e` |
| `--dsw-alias-markdown-tag` | `#f1f3f5` | `#2c2c2e` |
| `--dsw-alias-scrollbar-bg-l1` | `#e5e5e5` | `#3c3c3d` |
| `--dsw-alias-scrollbar-bg-l2` | `#e5e5e5` | `#545557` |
| `--dsw-alias-scrollbar-hover-l1` | `#d4d4d4` | `#545557` |
| `--dsw-alias-scrollbar-hover-l2` | `#d4d4d4` | `#65676b` |
| `--dsw-alias-state-business-primary` | `#4176e6` | `#7aaaff` |
| `--dsw-alias-state-business-tertiary` | `#e4edfd` | `#34415b` |
| `--dsw-alias-code-diff-added` | `#22c55e14` | `#22c55e1f` |
| `--dsw-alias-code-diff-deleted` | `#ec131314` | `#f25a5a1f` |
| `--dsw-alias-file-diff-added-bg` | `#e6f4e7` | `#1f3124` |
| `--dsw-alias-file-diff-added-gutter` | `#edf7ed` | `#132016` |
| `--dsw-alias-file-diff-added-marker` | `#01a241` | `#41c977` |
| `--dsw-alias-file-diff-deleted-bg` | `#fce6e2` | `#3c1f1b` |
| `--dsw-alias-file-diff-deleted-gutter` | `#fdece9` | `#28130e` |
| `--dsw-alias-file-diff-deleted-marker` | `#ba2723` | `#fa423e` |
| `--dsw-alias-state-error-primary` | `#ec1313` | `#f25a5a` |
| `--dsw-alias-state-error-secondary` | `#f25a5a` | `#f25a5a` |
| `--dsw-alias-state-idle-primary` | `#d4d4d4` | `#545557` |
| `--dsw-alias-state-success-primary` | `#22c55e` | `#22c55e` |
| `--dsw-alias-state-success-secondary` | `#4ed17e` | `#4ed17e` |
| `--dsw-alias-state-success-tertiary` | `#e6faed` | `#233c2c` |
| `--dsw-alias-state-warn-label` | `#dd8629` | `#dd8629` |
| `--dsw-alias-state-warn-primary` | `#f59e0b` | `#f59e0b` |
| `--dsw-alias-state-warn-secondary` | `#f7ad31` | `#f7ad31` |
| `--dsw-alias-state-warn-tertiary` | `#fef5e7` | `#27241f` |
| `--dsw-alias-switch-thumb` | `#fff` | `#adb2b8` |
| `--dsw-alias-toast-bg` | `#353638` | `#43454a` |
| `--dsw-alias-toast-label` | `#fff` | `#fff` |
| `--dsw-alias-tooltip-bg` | `#2c2c2e` | `#43454a` |
| `--dsw-alias-tooltip-key-bg` | `color-mix(in srgb, #2c2c2e, white 18%)` | `color-mix(in srgb, #43454a, white 18%)` |
| `--dsw-alias-turn-trigger-bg` | `#f9fafb` | `#ffffff14` |
| `--dsw-alias-turn-trigger-bg-hover` | `#2631480f` | `#ffffff24` |
| `--dsw-specific-bubble-highlight` | `#d3e2ff` | `#43454a` |
| `--dsw-specific-bubble` | `#edf3fe` | `#2c2c2e` |
| `--dsw-specific-input-major` | `#fff` | `#2c2c2e` |
| `--dsw-specific-login-input` | `#f9fafb` | `#1b1b1c` |
| `--dsw-alias-menu-group-header-fill` | `#f8f9faf0` | `#303136f0` |
| `--dsw-specific-menu` | `#f8f9fa94` | `#43454a73` |
| `--dsw-specific-selector` | `#f5f6f7` | `#353638` |
| `--dsw-specific-sidebar-fill` | `#f9fafb` | `#1b1b1c` |
| `--dsw-specific-sidebar-nav-item-active-accent` | `#e4edfd` | `#353638` |
| `--dsw-specific-sidebar-nav-item-active` | `#ebeef2` | `#43454a` |
| `--dsw-specific-sidebar-nav-item-hover` | `#f1f3f5` | `#2c2c2e` |
| `--dsw-specific-tip` | `#f5f6f7` | `#353638` |
