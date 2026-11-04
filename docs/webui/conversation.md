# 会话体验（Conversation）功能清单 · SwiftUI 对齐检查表

> 范围：DSH 官方 Web UI 中「一个会话」内的全部体验——transcript（消息流）、工作步骤/推理、工具调用卡片、输入框（Composer）及其选择器、排队/插话/停止、审批与提问接管、Dock（任务/目标/队列/上下文）、会话内业务插件（子智能体、后台任务、交付物、计划、目标、技能、密钥遮罩、反馈）、Trajectory 开发者视图，以及实验插件（思维链翻译、语音输入、智能体团队）。
> 不含：侧边栏/工作区列表、设置页主体、右侧栏文件预览/终端/浏览器本身（只记录"从会话打开它们"的入口）。
>
> 来源（MIT，未压缩 React bundle）：`engine/node_modules/@deepseek-ai/<pkg>/lib/client.js`，文中 `pkg:L123` 指该文件行号；locale 表内嵌在 client.js（`const zh = {…}` / `const en = {…}`）。会话 face 类型：`dsh-api-session-controller/lib/types/client/contract/{session,snapshot,events}.d.ts`、`lib/types/types.d.ts`。RPC 完整 schema 见同目录 `rpc-methods.json`（endpoint 形如 `session/prompt`；客户端写作 `remote.session.prompt(...)`）。
>
> 用法：每条功能有稳定 ID（`C-xx`），最后一列 `☐` 用于跟踪原生实现进度（完成后改 `☑`）。优先级：**P0** = MVP 必须，**P1** = 对齐必须，**P2** = 开发者/实验功能。

---

## 0. 架构速览（实现前必读）

1. **事件 → 节点 → 视图**。会话日志是 `SessionEvent {type, seq, time, data}` 序列（外层 `SessionEventLikeEntry` 区分 durable `event` 与瞬态 `transient` = `assistant/live-chunk`）。`ui-conversation` 的 assembler 把事件按 Definition 投影成 keyed **节点**（`{key, kind, id, anchorSeq, location, visibility, groupTree?, data}`），`ui-chat` 再做排序、分组（process group）、整轮折叠，最后按 `node.kind` 派发到渲染器。iOS 侧建议把这套投影写成**纯 Swift reducer**（输入事件，输出有序 root entries），视图只读结果。
2. **Slot 插件化**。Web UI 一切可扩展点都是 slot（`single`/`list`/`keyed`/`chain`，scope `root`/`session`）。原生实现不必复刻插件系统，但要覆盖每个 slot 里**官方包注册的内容**。本文 §16 列出全部相关 slot。
3. **Session face**（`binding.session`）：`beginSubmission / prompt / updateQueue / cancel / loadOlder / loadThrough / readAttachment / command / rename` + 快照字段 `running, openState, hasMore, loadingOlder, pendingSubmissions, promptError, subagent, removed, blank, awaitingFirstTurn, promptAttempted` + `projections.faceOf(key)`。
4. **Projections**（Host 计算、按 seq 推送）：`inbox`、`modelSelection`、`plan`、`goal`、`todos`、`agentPreset`、`permissions`、`contextPressure`、`contextBreakdown`、`imageLimits`、`turnOutline`、`sessionStats`、`tokenUsage`、`userQuestions`、`subagentCatalog`、`subagentTiming`、`agentTeam`、`sessionListMetadata`。见 §17。
5. **Composer 接管（takeover）**：审批 / 提问 / 计划审阅挂起时，用卡片**替换**输入框区域（原 composer 保持挂载、草稿不丢）。优先级 approval(0) > question(1) > plan-review(2)，同级后发布者胜。
6. **乐观发送**：发送即清空输入、插入本地 echo（`pendingSubmissions`），失败再把文本/附件放回。

---

## 1. 会话外壳（ui-conversation skeleton）

| ID | P | 功能 | 行为要点（Web） | 数据 / RPC | iPhone 原生建议 | 状态 |
|---|---|---|---|---|---|---|
| C-01 | P0 | 外壳相位 | `conversationPhase`（conversation:L17381）：`active`（有 target / 非 blank 且不在等首轮 / running）否则 `engaging`（已尝试发送）或 `blank`。布局相位 `settling / hero / active`（L17601）：blank+loading → settling（不闪 hero） | snapshot `blank, awaitingFirstTurn, promptAttempted, openState, running` | 根视图 `switch phase`：hero 空态页 / 骨架占位 / 消息流 | ☐ |
| C-02 | P0 | 空态 Hero | 鱼 logo（hover 摆尾，reduced-motion 关）+ 标题 `hero.headline`「探索未至之境」+ 徽标 `hero.preview`「预览版」；下方工作区 chip、Agent 预设 chip（C-111）、`conversation.hero.options` | — | 居中 logo + 标题；下排胶囊按钮 `Menu`；composer 固定底部 | ☐ |
| C-03 | P0 | 工作区选择 chip | 无工作区：闭合文件夹图标 +「选择工作区」；有：打开文件夹 + 名称/cwd basename + chevron → 打开工作区 picker。选择后把当前草稿（含引用 chip）和附件迁移到新会话（文件附件重新上传），旧会话清空；失败回滚 | `uiWorkspace.openWorkspace(id, prepare)` | `Menu` 或 sheet 列表；迁移草稿逻辑照抄 | ☐ |
| C-04 | P0 | 惰性 composer | 无会话或（hero 且无工作区）→ composer 惰性：placeholder `placeholder.workspace`「选择一个工作区开始」，点击/Enter 打开工作区 picker | — | 输入框禁用态，点按弹工作区选择 | ☐ |
| C-05 | P1 | Header 面包屑 | 沿 `parentId` 上溯子智能体链，`/` 分隔，非末项可点 → `openSession(id)`；无 summary 显示 sessionId | `sessions.list.byId[id].{displayTitle,parentId,origin}` | `NavigationStack` 返回链；导航栏标题下方小号面包屑 `Menu` | ☐ |
| C-06 | P1 | Header 动作区 | `conversation.session.header.actions`（list：agent-team -20、agent-preset -10、subagent-catalog 10、job-list 20）、`.utilities`、`.corner`、`.lineage` | 各插件 | `.toolbar`：按钮 + badge，次要项进 `…` 菜单 | ☐ |
| C-07 | P1 | 视图切换（Chat / Trajectory） | 视图标签行仅在 `!blank && tabs>1` 显示；`chat` 固定第一；`trajectory` 仅当设置 `developerTools.enabled`（「显示代码工作视图」）开启；超宽进 More 菜单，可 pin（内存态）。选择按会话持久化在 `dsh.conversation.<sid>.view` | localStorage | 导航栏 `Picker(.segmented)` 或 `Menu`；pin 可省 | ☐ |
| C-08 | P2 | 内容宽度拖拽 | 左右 gutter 拖动，`dsh.conversation.contentWidth`（min 640，默认 clamp(列宽×0.64, 680, 920)） | localStorage | **省略**：手机全宽 + 16pt 边距 | ☐ |
| C-09 | P0 | 会话占用错误 | `promptError.error.code === "session/writer-held"` → toast `error.sessionInUse`（另一个 DSH 实例占用） | snapshot.promptError | `.alert` | ☐ |

---

## 2. 消息流（Transcript，ui-chat）

### 2.1 框架与滚动

| ID | P | 功能 | 行为要点 | 数据 / RPC | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-10 | P0 | 加载状态 | `openState==='loading'` →「载入历史…」；`'error'` → `chat.loadError`「历史加载失败：{message}（{code}）」 | snapshot.openState/openError | 顶部 `ProgressView` / 错误行 + 重试 | ☐ |
| C-11 | P0 | 加载更早 | `hasMore` 时顶部按钮「加载更早」，`loadingOlder` 时禁用并显示「加载中」；调用 `session.loadOlder()`（≥50 条消息且 ≥2 个 turn 起点，≤500 条）；prepend 后用语义锚点（首个可见 `data-chat-paging-anchor` 行）补偿滚动 | `session.loadOlder()` → `session/page` | 列表顶部哨兵行 `onAppear` 自动加载；`scrollPosition(id:)` 记录并恢复锚点 | ☐ |
| C-12 | P0 | 跟随底部 | 距底 ≤25px 视为跟随；自己发送消息时强制跟随（next-input 时机 smooth，否则 instant）；用户上滚后保持位置；阅读位置每 500ms 采样，按会话记在内存（`{anchorKey, anchorTop, scrollTop}`），重新打开恢复 | — | `defaultScrollAnchor(.bottom)` + `onScrollGeometryChange` 判断距底；内存字典存每会话位置 | ☐ |
| C-13 | P0 | 回到底部按钮 | 不跟随时出现 chevron-down（aria `chat.toBottom`「回到底部」），点击跟随尾部 | — | 右下浮动圆形按钮（composer 上方） | ☐ |
| C-14 | P1 | 轮次导航条（Turn rail） | ≥2 轮且宽度 >900px 才显示（**手机自然隐藏**）；刻度间距 10px；hover 预览 prompt ≤50 字、response ≤120 字；点击已加载轮次滚到锚点，未加载 → `session.loadThrough(seq)`（每页 ≥200 条）后定位 | projection `turnOutline [{turn, seq, prompt, response}]` + 已加载窗口 | 替代：工具栏「跳转到轮次」按钮 → sheet 列出各轮（第 N 轮 + 预览），未加载的调用 `loadThrough` | ☐ |
| C-15 | P1 | 打开文件失败弹窗 | 文件链接打开失败 → 模态 `fileOpen.title`「无法打开文件」+ 错误信息 + 取消/重试 | — | `.alert` 重试 | ☐ |
| C-16 | P0 | 运行中指示 | 流尾部：分隔线 + 鲸鱼动画（reduced-motion 用静态 SVG）+ 蓝色流光文字 `chat.deepDivingFor`「深度求索中，用时 {duration} ···」，1s 刷新，起点 = 当前 turn 的 `turn/start` 时间；无起点用 `chat.deepDiving` | snapshot.running + turn location | `TimelineView(.periodic(by:1))` + 动画图标；尊重 `accessibilityReduceMotion` | ☐ |

### 2.2 用户消息

| ID | P | 功能 | 行为要点 | 数据 | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-17 | P0 | 用户气泡 | 右对齐，最大宽 min(748×0.702, 82%)，`pre-wrap`；顺序：附件行（图片/文件卡）→ 文本 → 引用摘要 `message.referenceSummary`「引用会话 · {labels}」 | `user/message`（source.kind `user`） | `HStack{Spacer; bubble}`，`frame(maxWidth: 0.82×宽)` | ☐ |
| C-18 | P0 | 用户文本富渲染 | `conversation.user.text` 规则链：`secret`（密钥遮罩 C-132）、`session` 引用 `@[label](dsh-session:id)` → 标签、`file`/`folder` `@path` → 可点 chip、`skill` `/name` → chip（点开 SKILL.md）、`command` chip；空白规则 trim / collapse（队列预览用） | facts: `sessionLabels`、`skillNames` | `AttributedString` 自定义 run；点 chip push 文件预览 | ☐ |
| C-19 | P0 | 用户消息操作 | **只有时间戳 + 复制**（复制拼接所有 text 块）；无编辑、无重新生成、无分支。后面还有用户行时 hover 才显示，触屏常显 | — | 长按 `.contextMenu`：复制；时间显示在菜单头或小号 caption | ☐ |
| C-20 | P0 | 本地 echo / 插话气泡 | `PendingSubmissionBubble`：`pendingSubmissions` 中 placement ≠ `queued` 且尚未被 durable `user/message.source.rpcId` 认领的显示在流中（图片用本地 objectURL 预览，时间=提交时间）；placement `steering` 用 pending 样式；`PendingSteeringBubble`：projection `inbox['next-step']` 中用户插话；durable `steering` 节点与 user 同视图 | snapshot.pendingSubmissions、`inbox` | 同一气泡组件 + 半透明/时钟角标表示待处理 | ☐ |

### 2.3 助手消息与推理

| ID | P | 功能 | 行为要点 | 数据 | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-21 | P0 | 助手 Markdown 流式渲染 | `assistant-step` 节点 `status: running | settled | interrupted`，同一 key 贯穿流式到完成；块：`text` → Markdown（流式）、`reasoning` → 推理行、连续 `image` → 图片组、`tool-call` 跳过（由工具节点渲染）、其他 → JSON 块 `message.unknownBlock`；interrupted 末尾显示「已停止」 | `step/start`、`assistant/live-chunk`（`block-start/text-delta/reasoning-delta/tool-call-delta/block-end/usage/finish`）、`assistant/message` | Markdown 渲染器（swift-markdown-ui 或自研）；live-chunk 按帧合并（16ms/CADisplayLink） | ☐ |
| C-22 | P0 | 代码块 chrome | 粘性代码块头：语言 `codeBlock.title`、复制 `copy`/`copied`、换行切换 `codeBlock.wrap/unwrap`；脚注 `markdown.footnotes` | — | 代码块视图：头部（语言、复制、换行）+ 非换行时横向滚动 | ☐ |
| C-23 | P0 | 链接打开 | http(s)：设置 `linkOpening==='sidebar'` 且有侧栏浏览器 → 侧栏打开，否则新标签；文件路径链接 → `openFile(path,{line})`（支持 `#L24`/`#L24-L30`，相对路径按会话 cwd 解析）→ 右侧栏文件预览；本地绝对路径图片 → file-media URL | `sidebarRight.openResource/openTab` | web 链接 → `SFSafariViewController`（对应 sidebar）或 `openURL`（new-tab）；文件 → push 文件预览并滚到行 | ☑ |
| C-24 | P1 | 结尾消息文件名链接化 | 仅「已结束 turn 的收尾助手消息」中 inline code 的文件名被 `chatFileMentions.forClosing` 链接化（ui-deliverables 提供） | turn-tail.closing | 同规则：仅收尾消息做文件名识别 | ☐ |
| C-25 | P0 | 推理（思考）行 | 默认折叠；行 = 思考图标 +「思考」+ `· 摘要`。摘要：流式时取**最近完成段落**首行，完成后取首行，去 `**`；运行中流光。摘要显示条件：未展开 && (running || 策略 `settledReasoningPreview`)。展开体 = compact Markdown（slot `conversation.chat.reasoning.body`，可被 C-138 翻译替换）。**不显示思考时长** | `reasoning` 块 | `DisclosureGroup` label：`Text(summary).lineLimit(1).foregroundStyle(.secondary)` | ☐ |
| C-26 | P1 | 图片块 / 大图 | 助手图片左对齐（`align:'start'`）；单图长边 240、宽高比夹在 [0.25,4] cover；多图 64px 方块；点击 lightbox（Esc/遮罩/关闭）；加载失败「图片加载失败，点击重试」 | `session.readAttachment(id)` → `session/attachment`（每会话 URL 缓存） | `AsyncImage` 自定义加载器 + `fullScreenCover` 可缩放查看 + 分享 | ☐ |

### 2.4 工作步骤（Process group）与整轮折叠

| ID | P | 功能 | 行为要点 | 数据 | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-27 | P0 | 工作步骤分组 | 同一 turn 内连续的无 groupTree 节点（工具调用、模型重试、推理片段、命令…）合为一组；遇到 process 级以外的节点或助手**回复**（`groupPart:'response'`）就切组。是否显示组头由 `grouped` 决定：`stepGrouping==='collapsed'`，或 `'history'` 且 turn 已结束（C-34 策略表） | chat.L11471 | 自研 reducer 生成 group entries | ☐ |
| C-28 | P0 | 活动类别映射 | 按工具名：`read`→read；`read_image`→readImage；`grep|glob|*_inspect`→search；`write`→write；`edit|apply_patch`→edit；`bash|pwsh|exec_command|write_stdin|terminal_*`→commands；`run_code`→code；`web_search`→webSearch；`web_fetch`→webFetch；`subagent|subagent_*`→subagents；`todo_write|create_goal|update_goal|get_goal`→plan；`ask_user_question|request_user_input`→questions；其他→tools；无运行中工具→thinking | chat.L11190 | 同表；SF Symbol：eye / photo / magnifyingglass / pencil / square.and.pencil / terminal / chevron.left.forwardslash.chevron.right / globe / safari / person.2 / checklist / questionmark.bubble / wrench / brain | ☐ |
| C-29 | P0 | 组头标题 | 进行中：`message.stepProcess.<kind>`（「正在读取文件」），参数流式中用 `.prepare.<kind>`；策略 `liveProcessDetail` 时追加 ` · 细节`（取首个存在的参数：`title, description, objective, task, task_name, name, question, questions, prompt, message, command, cmd, queries, query, pattern, url, uri, file_path, path, target, action, status`，≤160 字形）；无运行工具时用流式推理的最新段落；标题变化至少保持 150ms。已结束：取数量前 3 的 `done.<kind>`，2 个用 `joinTwo`（中文去掉第二个的「已」：「已读取文件并搜索代码」），3 个用 `comma`，>3 用 `more`「{title}等」；空 → `done.thinking`「已完成分析」 | chat.L3852 | 同逻辑；运行中流光（`LinearGradient` mask + `phaseAnimator`） | ☐ |
| C-30 | P0 | 组展开/收起 | 本地状态，默认**收起**；展开时若进行中滚到组内底部、已结束滚到顶部；组体最大高 min(400px, 50vh) 带上下渐隐，组内独立跟随（阈值 1px） | — | `DisclosureGroup` + 内层 `ScrollView(maxHeight: min(400, 屏高×0.5))` + 渐隐 mask | ☐ |
| C-31 | P0 | 整轮折叠按钮 | `turn-process` 节点位于本轮过程之上，仅 turn 已关闭时渲染：标签「已停止」（aborted/interrupted）/「处理失败」（error）/「已完成，用时 1分2秒」（≥1s）/「已完成」；可折叠时带 chevron。折叠时隐藏本轮全部过程节点，**最终回答保留** | `TurnProcessChatData {turn, processStartSeq, answerAnchorSeq, answerStep, inlineReasoning, messageCount, toolCallCount, subagentCount}` | 行按钮 + `withAnimation(.easeInOut(duration:0.18))` 隐藏过程行 | ☐ |
| C-32 | P0 | 整轮折叠规则 | 不可折叠（alwaysOpen）：进行中、本轮有插话、结束原因 aborted/interrupted/error。默认：时机 `completion` → 完成即折叠；`next-input` → 最新一轮保持展开直到下次输入。手动选择按 `(turn, answerStep)` 存内存（`setTurnProcessOpen`），新回答步骤重置。`verbose` 模式不折叠（头显示但禁用） | chatStore.turnProcesses | 内存字典 | ☐ |
| C-33 | P1 | 不可见节点 | Chat 中永不显示：`system-prompt`、普通 `context` 注入（只显示工具增减）、`command name==='permission'`、`visibility:'hidden'` 的助手尝试 | chat.L8200 | 过滤同表 | ☐ |
| C-34 | P0 | 展示策略（设置 `ui-chat.transcriptView`） | `compact`：折叠完成轮 / 组 collapsed / 无实时细节 / 不预览已完成推理；`standard`：折叠 / collapsed / 有细节 / 预览；`detailed`：折叠 / history（运行时平铺、完成后分组）/ 有 / 有；`verbose`：不折叠 / 无组头 / 无 / 有。默认：桌面 `standard`，Web `detailed` | configForms `ui-chat` | iOS 默认建议 `standard`；`Picker` 设置 | ☐ |

### 2.5 Turn 尾部：消息操作与用量

| ID | P | 功能 | 行为要点 | 数据 / RPC | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-35 | P0 | 复制回答 | 复制**收尾助手消息**（最后一条已完成且含文本的）的 text 块拼接（不含推理）；图标变 ✓ 1s | — | `UIPasteboard` + `.success` 触感 | ☐ |
| C-36 | P0 | 分支到新对话（Fork） | 需权限 `useAccess('session/fork')`；tooltip `message.branch`「在新对话中分支」；不可用（无收尾消息，或收尾后还有 tool/call、tool/result、error 结束、llm/retry，或后面还有可见节点）→ 禁用 + `message.branchUnavailable`「仅可从已完成轮次的最后一条消息分支」。点击 → `sessions.fork({sessionId, atSeq: turn/end 的 seq, increaseTitle:true})` → 打开子会话（错误静默） | `session/fork` `{sessionId, atSeq?, allowMigration?}` → `{sessionId}`；错误 `session/fork-unavailable`、`session/migration-required` | 长按菜单「在新对话中分支」，禁用时显示说明 footnote；成功后导航到新会话，失败建议 alert | ☐ |
| C-37 | P0 | 反馈 👍/👎 | 见 C-129 | — | — | ☐ |
| C-38 | P1 | 时间戳 | 当天 `HH:mm`；同年 `{m}月{d}日 HH:mm`；否则 `{y}年{m}月{d}日 HH:mm`；跨午夜自动刷新 | `closing.time` | 同格式；`Text(date, format:)` | ☐ |
| C-39 | P1 | 操作行显隐 | 最新一轮且最后内容是回复 → 常显；否则 hover 显示；无 hover 设备常显 | — | 最新回复下常显精简操作行；历史消息用 `.contextMenu` | ☐ |
| C-40 | P1 | Turn 尾卡片区 | slot `conversation.chat.turnTail`：计划卡（C-130）、交付物/改动卡（C-127/109）、定时任务卡 | 各插件 | turn 结尾 `VStack` 卡片组 | ☐ |
| C-41 | P1 | 本轮用量胶囊 | 仅 `performanceUsage==='detailed'` 且用量精确：胶囊 `用量 {total}`（紧凑 K/M）→ 弹窗「本轮用量」：精确总数、提供方/模型、缓存命中（1 位小数，非精确不显示 100%）、未缓存输入、缓存读取、缓存写入（≠0）、输出（含推理 tokens）。任何事件不一致即隐藏 | 由 `step/start, assistant/attempt, assistant/message, llm/retry, llm/retry-started, step/end, turn/end` 推导 | 胶囊 → `.popover`/小 sheet（`presentationDetents([.height])`） | ☐ |
| C-42 | P1 | 会话统计胶囊（composer dock） | `activity`：详细 →「{turns} 轮 {steps} 步 · {tps} tok/s」，弹窗「会话统计」：模型用时 / 工具调用用时 / 首 token 平均 / 输出速度；简洁 → 只显示速度。`usage`：详细 →「{count} tok · 缓存命中 {percent}%」，弹窗「Token 用量」；简洁 → 只显示命中率；无 token 隐藏 | projection `sessionStats {turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens}`、`tokenUsage {uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens}` | composer 下方小胶囊 + sheet | ☐ |
| C-43 | P1 | 数字/时长格式 | tokens：<1000 精确；<1M `{v}K`（<100 保留 1 位）；否则 `{v}M`；精确值用千分位；tok/s ≥10 取整否则 1 位；时长 <60s `{s.s}s` 否则 `{m}m{s}s`；运行时长单位「小时/分/秒」 | chat.L6668 | `FormatStyle` 自定义 | ☐ |

### 2.6 错误、重试、截断、配额

| ID | P | 功能 | 行为要点 | 数据 | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-44 | P0 | 模型重试条 | 每个 `retryId` 一行（可展开）：`{label}（{retry}/{maximum}） · {seconds}s`，maximum = `mode==='normal'` ? maxRetries : ∞；label：进行中（250ms 倒计时 + 流光）「正在重试模型请求」/ 已取消 / 已重试 / 等待重试；展开：重试延迟 `{ms}毫秒`、失败原因 | `llm/retry {retryId, retry, maxRetries, mode, delayMs, failure, turn, step}`、`llm/retry-started` | `DisclosureGroup` + `Text(timerInterval:)` | ☐ |
| C-45 | P0 | 本轮失败 | 红点；标题「任务已停止」（`ACCOUNT_SIGNED_OUT`/`INTERRUPTED`）或「本轮运行失败」；文案映射：`ACCOUNT_SIGNED_OUT`、`INTERRUPTED`、`ACCOUNT_SIGN_IN_REQUIRED`、`QUOTA|ACCOUNT_QUOTA`、`AUTH` → 固定文案，否则原始 message；非 INTERRUPTED 显示 code chip | `turn/end reason.kind ∈ error/aborted(hook deepseek-account/signed-out)/interrupted` | 红色状态行 + `Text(code).font(.caption.monospaced())` | ☐ |
| C-46 | P0 | 输出 token 上限 | 琥珀点「已达到输出 token 上限」+ 提示「回答被截断…发送“继续”可让模型接着输出。」 | `turn/end reason.kind==='max-tokens'` | 黄色提示行（可加「继续」快捷按钮，发送「继续」） | ☐ |
| C-47 | P1 | 配额用尽全局提示 | 仅**实时追加**的 `turn/end` 错误码 `QUOTA|ACCOUNT_QUOTA` 触发（历史加载不触发）→ 账户插件的配额提示或 toast `message.failure.quota` | `shell.quota-notice` | App 级 banner/toast，按 seq 去重 || ☑ |

### 2.7 命令、压缩、上下文、触发器

| ID | P | 功能 | 行为要点 | 数据 | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-48 | P0 | 命令结果卡 | `/xxx` 执行在流中显示为卡：图标 + 名称 + `· 摘要`（运行中「执行中…」，完成 outcome.text 或「已完成」/「指令失败」）；多行结果可展开（pre）。状态 running/ok/error | `command/run {commandId, name, args}`、`command/done {commandId, kind, text?, sourceEventSeq?}` | 卡片行 + DisclosureGroup | ☐ |
| C-49 | P0 | `/goal` 命令输入气泡 | `command/run name==='goal'` → 右对齐用户气泡「/goal …」（chip），排在命令结果前，无时间/复制/分支 | ui-goal | 同用户气泡（无操作） | ☐ |
| C-50 | P0 | 上下文压缩 | 自动或 `/compact`：标题「上下文已压缩」，摘要「已压缩 {items} 条历史记录（约 {tokens} tokens）」；进行中「正在压缩…」；点击展开 Markdown 摘要（无摘要禁用，「压缩摘要不可用」） | `compaction/start|summary|end`、replacement `user/message source.kind==='compact-checkpoint'` | 卡片 + 展开 Markdown | ☐ |
| C-51 | P1 | 工具增减提示 | 只显示工具变化型 context：单个「已添加工具：{name}」/「已移除工具：{name}」；多个「工具已更新 · 新增 N 个，移除 M 个」可展开列出 | `developer/message` / 非用户 `user/message` | 次要灰色行 | ☐ |
| C-52 | P1 | 非人类触发通知 | 带 `waking` 的 context 显示为边框通知：图标 + 标题 + 时间 + chevron；展开「这条通知触发了本轮回复。」+ 正文（最大高 240）。来源：goal / agent-message / team-message / subagent-settled / webhook（github 特判）/ schedule / tool-jobs / cordis-host-runner / 其他 | `source.kind` | 卡片 + DisclosureGroup | ☐ |
| C-53 | P2 | 未知事件兜底 | 未认领的 append surface 事件 → JSON 块「未知 surface 事件：{type}」（截断提示 `json.truncated`） | — | 等宽折叠 JSON | ☐ |

---

## 3. 工具调用卡片（ui-tool 及各插件）

### 3.1 通用骨架

| ID | P | 功能 | 行为要点 | iPhone 建议 | 状态 |
|---|---|---|---|---|---|
| C-54 | P0 | 工具调用节点 | `tool-call` 节点 data `{root: ToolCallBlock}`；按 `toolName` 派发到 keyed 视图，未注册 → GenericToolCard。**Auto review 拒绝优先**：`error.name==='AutoReviewDeniedError' && code==='AUTO_REVIEW_DENIED'` 强制通用卡 | `ToolViewRegistry: [String: (Owner)->AnyView]` + fallback | ☐ |
| C-55 | P0 | Block 形状 | `PreparingToolCall {phase:'preparing'}`（参数流式，不可展开）/ `StartedToolCall {phase:'start', argsRaw}` / `ToolResultNode {kind:'tool-result', call, content: ContentBlock[], isError, error?:{name,code,reason?}, meta?, subCalls}`；头部 `callId, parentCallId?, name, turn, step, time, args(PartialArguments)`；未决的中断调用合成错误 `{name:'Interrupted', code:'interrupted'}` | Swift enum + 可懒解析的部分参数（流式 JSON） | ☐ |
| C-56 | P0 | 行状态 | `preparing | running | ok | error | stopped`（`error.code==='interrupted'`）；shell 成功但退出码≠0/信号 → error。error 摘要红色（输出首行），stopped 黄色；error/stopped 隐藏大小与 diff 计数、文件链接失效 | 状态枚举 | ☐ |
| C-57 | P0 | 行 chrome | `[16px 图标] 标题 · 摘要（单行省略）[后缀：退出码/KB/+A -R]`，整行点击展开；运行中整行流光；展开体末尾「查看」(Inspect) 胶囊（**仅 hover**，打开 Trajectory 定位该调用） | `DisclosureGroup` 自定义 label，路径 `truncationMode(.middle)`；Inspect 放进 contextMenu | ☐ |
| C-58 | P0 | 摘要推导 | 文件类取 `file_path` → 相对 cwd → home 变 `~`；其他取 `description` 首行；回退键序 bash[description,command] read[path,file_path,url] search[query,pattern,url]（`queries[]` 逗号连接）write/edit[path,file_path] code[description]；再回退首个字符串值 / argsRaw 首行 / callId；通用标题时摘要前缀 `toolName · ` | 纯函数照抄 | ☐ |
| C-59 | P1 | PTC 子调用树 | `run_code`（PTC 模式）子调用经 `tool/ptc-dispatch-start` / `tool/ptc-dispatch` 进入 `subCalls`，缩进树展示（左侧 0.5px 竖线，缩进 22px）；子调用只出 terminal/image 结构卡，其余通用卡 | `VStack.padding(.leading,14)` + 左侧细线 | ☐ |
| C-60 | P1 | 展示元数据 | 工具在 Host 用 `output.presentationMeta(args,value)` 产生 `meta`，持久化在 `tool/result`/`tool/ptc-dispatch` 事件中；客户端**只用** `argsRaw + content + isError + error + meta` 重建卡片，任何校验失败回退通用卡。`presentCall/presentResult` 只给 Host（TUI/ACP），**不进 Web Client**。呈现模式 `dsh-agent-tool-presentation`：preset 行 `mode: native|ptc`（ptc 下模型只见 `run_code`） | 卡片模型只依赖事件字段，可离线重放 | ☐ |

### 3.2 各工具渲染

> C = 折叠行，E = 展开体。所有工具共享 C-56/57 的状态与 chrome。meta 形状见 §3.3。

| ID | P | 工具（模型可见名与参数） | C 折叠行 | E 展开体 / 特例 / 动作 | 状态 |
|---|---|---|---|---|---|
| C-61 | P0 | `bash`（`command`*, `description`, `timeoutMs`, `workdir`, `run_in_background`, `sandbox_permissions`, `justification`）；`pwsh` 同（走通用卡内终端模型） | 图标 Api · 「运行命令」 · description（流式显示）；完成且前台失败 → **退出码徽标**「退出码 N」/「信号 SIG」/「未正常退出」（由输出尾标 `\n[exit code: N]` / `\n[killed by signal: SIG]` 解析，无尾标视为 0） | 终端块：头 cwd（`meta.cwd` → workdir 相对会话 cwd → 会话 cwd）、命令、完整输出、退出码；无 description = 持久 shell（运行中终端卡，结束走通用）；`run_in_background:true` → 运行时终端卡，成功回执只剩命令+cwd；输出以 spill 提示结尾 → 通用卡。动作：复制 | ☐ |
| C-62 | P1 | `terminal_send`（`sessionId`*, `text`*, `submit`, `run_in_background`） | 摘要「终端 {sessionId}」；命令 = text 或「（发送输入）」 | 终端卡（不解析退出码）；后台 → 通用卡 | ☐ |
| C-63 | P1 | `terminal_open/read/list/signal/close` | 图标 Code · 创建/读取/查看/发送信号/关闭终端 · 详情摘要（「N 个终端」「已启动」） | 详情列表：id、type、pid、exitCode、signal、状态徽标；read = 代码块输出 | ☐ |
| C-64 | P0 | `read`（`file_path`*, `offset`, `limit`） | 图标 Browse · 「读取」 · **可点路径**（相对化） | 行号代码视图，内折叠 8 行（「… 其余 N 行」），「显示 {shown} / {total} 行」，按 `meta.lang` 高亮。仅 root + 成功 + meta 合法才出卡。点路径 → `openFile(path,{line: offset})` | ☐ |
| C-65 | P0 | `read_image`（`file_path`*） | 「读取图片」 · 路径 | 图片组（png/jpeg/webp/gif）+ 完整路径 + 每图「{w}x{h}px，{bytes} 字节」（缩放过注明「由 WxH 缩小」）+ 额外文本；未知块 → 通用卡 | ☐ |
| C-66 | P0 | `write`（`file_path`*, `content`*）/ `edit`（`file_path`*, `old_string`*, `new_string`*, `replace_all`） | 图标 Edit · 「写入/编辑」 · 路径 · `NKB`（ceil(UTF-16 长度/1024)，edit 为 old+new，流式即显示）· `+A -R`（hover/展开着色） | Diff 块（内折叠 9 行）：运行中由参数推 intended diff（write 整文件新增；edit old→new）；完成用 `meta.diffs` 上下文 hunk；write 空 diffs 回退整文件。仅 root 出 diff。动作：点路径打开、复制 | ☐ |
| C-67 | P1 | `str_replace_editor`（`command`, `path`, `file_text`, `old_str`, `new_str`, `insert_line`, `view_range`） | 通用标题「工具调用 · str_replace_editor · …」 | 运行中且 command ∈ {create, str_replace} → diff 卡；完成 → 通用 IN/OUT | ☐ |
| C-68 | P0 | `grep`（`pattern`*, `path`, `include`）/ `glob`（`pattern`*, `path`） | 图标 Search · 「搜索文件内容」/「查找文件」 · pattern | grep：按文件分组的匹配行（行号+文本）；glob：路径列表；头「{n} 处匹配 · {f} 个文件」/「{n} 个路径」；截断「显示 {shown} / 共 {total} …」+ recovery 文本；空「无结果」；内折叠 8 行 | ☐ |
| C-69 | P0 | `web_search`（`queries`*: string[]）/ `web_fetch`（`url`*） | search：Globe ·「网页搜索」· queries；fetch：Browse ·「网页获取」· URL 为链接（仅 http/https） | search：可选 answer（Markdown）+ 来源列表（title/url/snippet/publishedAt），「来源列表已截断」；fetch：URL + `HTTP {status}` +「内容已截断」 | ☐ |
| C-70 | P0 | `todo_write`（`todos`*: [{content, status}]） | Checklist ·「更新任务清单」· `{done}/{total} 已完成 · <首个进行中>`；后缀「新增 N · 更新 N · 移除 N」/「清单没有变化」· `+K`（其他并行进行中） | 与上次 `todo_write` 的 diff：caption「首次记录」/「与上次清单相比」/「旧清单不可用」（更早页未加载）；每项状态图标 ✓/▶/○/+/− + 标题 +「旧状态 → 新状态」/「· 顺序调整」；「{N} 项未变化」折叠组 | ☐ |
| C-71 | P0 | `ask_user_question`（`questions`*: [{id, question, header?, detail?, options?[{label, description?}], multi_select?}]） | Question ·「提问」· 状态：「等待回答」/「已继续工作，仍可回答」/「{a}/{t} 已回答」/「已结束」/「已取消」/「已中断」；行尾按钮「回答」（重新打开面板）或「查看回答」（只读） | answered：问题 + 答案（跳过显示「未回答」）；`ASK_CANCELLED` → ok+已取消；`ASK_ABORTED` → stopped；`{pending:true}`/`TOOL_OUTCOME_UNKNOWN` → 查 `userQuestions` 投影；inbox 中迟到回复显示其答案。按钮调 `userQuestionPanels.reveal/review`（C-114） | ☐ |
| C-72 | P1 | `subagent`（`description`*, `prompt`*, `cwd`, `agent_preset`, `provider`, `model`, `reasoning_effort`）、`list_subagent_models`、`list_agents`、`send_message`、`interrupt_agent`、`wait_agent`、`spawn_teammate`、`team_task_*` | 详情行：「创建子智能体 · <prompt> · 已启动」/「查看子智能体 · N 个智能体」/「消息已送达」「已入队」/「已请求中断」/「子智能体状态 · 等待超时|检测到变化」 | 回执：标题=prompt，徽标「已启动」，字段 智能体 ID / 任务 ID；否则「智能体回复」Markdown + 折叠「任务内容」；团队任务字段 owner/ready/blockedBy/writeScopes | ☐ |
| C-73 | P1 | `job_list` / `job_output`（`job_id`*, `wait`, `timeout_ms`）/ `job_kill`（`job_id`*, `reason`）；`create_goal` / `get_goal` / `update_goal`；`schedule_*`；`workflow`（`script`*, `meta`）/ `ralph`；`session_event_*`/`session_search`/`session_trace`；`lsp`；`cordis_inspect_*` | 详情行（DetailsRow），标题见 locale `tool.title.*`（「查看后台任务」「读取任务输出」「取消后台任务」「创建/查看/更新目标」「创建/查看/删除/修改定时任务」「运行工作流」「运行循环工作流」…） | 详情列表：job 行解析 `<id> [<kind>] <state> — <title>`，输出代码块（「输出已截断」）；goal 字段 状态（进行中/等待继续/已暂停/受阻/已完成）、执行轮次 r/max、受阻原因；schedule 计划时间/重复/状态；workflow 状态、启动智能体数、脚本；lsp 位置「第 L 行，第 C 列」可点开文件 | ☐ |
| C-74 | P1 | `skill`（`name`*） | Skill ·「加载技能」· 名称；error 首行；stopped「skill 加载已中止」；preparing「准备加载技能」 | 「说明」卡 = 原样输出 | ☐ |
| C-75 | P1 | `present`（`files`*: [{path*, description?}] ≤4） | DeliverDoc ·「交付文件」· 准备交付/正在交付/已交付/交付失败/已中断 + 路径列表 | 结果文本 + 「查看调用」；文件卡见 C-127 | ☐ |
| C-76 | P1 | `exit_plan_mode`（`plan`*: 以 `# ` 开头的 Markdown） | 通用行 | IN/OUT；计划卡与审阅见 C-130/C-115 | ☐ |
| C-77 | P1 | `run_code`（PTC：`code`, `description`） | Code ·「代码」· description | TypeScript 代码块 + OUT；子调用缩进树（C-59） | ☐ |
| C-78 | P0 | 任意未注册工具（GenericToolCard） | Sparkle ·「工具调用」· `<toolName> · <摘要>` | IN（JSON pretty，解析失败原样）/ OUT（text 原样，其余块 JSON；空内容失败 → `name: code`）。通用卡内部仍尝试 terminal/read/diff/search/web 模型 | ☐ |
| C-79 | P0 | Auto review 拒绝（任意工具） | 摘要「Auto review 已拒绝」（红） | OUT 一行「工具未执行。原因：{reason}」（空 →「Auto review 未授权此次操作」），**不显示原始参数** | ☐ |

### 3.3 工具 `meta` 形状（presentationMeta）

| 工具 | meta | 用途 |
|---|---|---|
| bash / pwsh | `{cwd}` | 终端卡 cwd |
| terminal_send | 前台 `{viewport, waitReason, sessionStatus, truncated}`，后台 null | UI 未用 |
| read | `{path, offset, lines:[{number,text}], totalLines, lang?}` | 读取卡 |
| write | `{operation, path, diffs:[{path, oldText, newText}]}`（新建 → `[]`） | Diff + 绝对路径 |
| edit | `{path, diffs:[…]}` | 同上 |
| read_image | `{path}`；图片本体在 content `{type:'image', attachment:{attachmentId, mediaType, bytes, width, height, name?, originalDimensions?}}` | 图卡 |
| grep / glob | `{shape:'matches', files:[{path, matches:[{lineNumber,line}]}], truncated, total}` / `{shape:'paths', paths[], truncated, total}` | 搜索卡 |
| web_search | `{sources:[{url, title?, snippet?, publishedAt?}], answer?, truncated}` | Web 卡 |
| web_fetch | `{url, statusCode, truncated}` | Web 卡 |

meta 中的绝对路径优先用于 `openFile`；显示用模型写的参数。

---

## 4. 输入框（Composer，ui-conversation InputBar）

### 4.1 结构与状态

| ID | P | 功能 | 行为要点 | iPhone 建议 | 状态 |
|---|---|---|---|---|---|
| C-80 | P0 | Composer 结构 | 自上而下：toast（锚定卡片）→ info 提示行（`role=status`）→ 卡片 [overlay（slash 菜单/命令弹窗/反馈弹窗）| 附件条 | 编辑器 | 控制行] → dock 行 [composer dock（统计胶囊）| 上下文环]；卡片上方另有 input dock（Todo → Goal → Queue）。控制行：左 `+`、权限选择、计划 chip、left 扩展；右 right 扩展、模型选择、activity（语音）、可中断子智能体的 Stop、主按钮 | `.safeAreaInset(edge:.bottom)`：`VStack{ docks; attachmentsRail; textView; controlRow; metaRow }`，随键盘上移 | ☐ |
| C-81 | P0 | 派生状态 | `empty = draft.trim()==="" && 无附件`；`uploadsPending`；`continuable`；`parentOffline`；`locked = removed || inert || !live || blocked || parentOffline`；`machineBusy = phase ∈ {adjudicating, submitting}`；`editable = live && !locked && !machineBusy`；`steeringAvailable = 非子智能体 || continuable`；`canSteerQueue = !locked && !machineBusy && !菜单打开 && empty && running && steeringAvailable && 队列非空`（conversation:L18965-19026） | 作为 `@Observable ComposerModel` 计算属性照抄 | ☐ |
| C-82 | P0 | 主按钮 Send / Stop | `primaryStops = running && 非子智能体 && (empty || blocked)` → **Stop**（方块图标，tooltip「停止生成」+ Esc Esc）→ `cancel()`；否则 **Send**（上箭头），禁用 = empty || locked || machineBusy || uploadsPending。running 时纯消息草稿的标签为「排队发送」/「插话发送」（按 `busyEnter`）。continuable 子智能体运行中 Stop 与 Send 分开两个按钮 | 主按钮同规则；**长按 Send 弹 contextMenu：排队发送 / 插话发送**（替代 Cmd+Enter） | ☐ |
| C-83 | P0 | Placeholder 优先级 | 外部（hero→`placeholder.hero`；惰性→`placeholder.workspace`；blocked→block.reason）> parentOffline > disabled（`placeholder.unavailable`）> canSteerQueue（`placeholder.steerQueue`）> plan 模式（`placeholder.plan`）> `placeholder.default`「发消息或创建任务, / 调用指令, @ 文件或对话」；仅空草稿无附件且无命令 chip 时显示；IME 组合时隐藏 | `UITextView` placeholder label | ☐ |
| C-84 | P0 | 命令参数提示 | 命令 chip 存在且参数为空 → 显示 `hint.<name>`（如 `hint.goal`「输入目标，智能体将持续执行」；已有目标 → `hint.goal.active`），无翻译用 claim.hint | chip 后灰色提示文字 | ☐ |
| C-85 | P0 | 错误呈现 | `session/writer-held` → `error.sessionInUse`；`session/attachment-invalid`/`subagent/attachment-invalid` → 附件原因文案（§13 字符串）；其他 → `"{message} ({code})"`；shell notice error → toast，info → 卡片上方行内 | 顶部 banner / composer 上方 caption | ☐ |
| C-86 | P1 | 焦点管理 | 会话切换/解锁自动聚焦并恢复光标；点击卡片空白恢复光标；工具栏按钮不抢焦点 | `@FocusState`；不自动弹键盘（手机上首次进入不聚焦更佳） | ☐ |
| C-87 | P0 | 状态汇总 | 无会话→惰性；空闲空→Send 禁用；输入中→Send；running+空→Stop（有队列时 steer-all 提示）；running+有字→排队/插话；`/cmd` 执行中→只读；上传中→Send 禁用、Enter toast「文件还在上传…」；blocked→禁用、placeholder=原因；removed→「会话不可用」；parentOffline→禁用但 Stop 可用；审批/提问→被接管 | 状态表照抄 | ☐ |

### 4.2 键盘与编辑器

| ID | P | 功能 | 行为要点 | iPhone 建议 | 状态 |
|---|---|---|---|---|---|
| C-88 | P0 | 发送键位 | Enter：菜单开 → 选中候选；否则按 `resolveSubmitMode(busyEnter, running, "enter")` 提交（上传中 toast）；Shift+Enter 换行；Cmd/Ctrl+Enter：`canSteerQueue` → 全部插话，否则互补模式；Alt+Enter 等组合保留；IME 组合中 Enter 吞掉。**没有 ↑ 召回上一条消息** | 软键盘回车 = 换行，发送靠按钮；外接键盘 `.onKeyPress(.return)` 判 modifiers，`keyboardShortcut(.return, modifiers:.command)` 互补 | ☐ |
| C-89 | P0 | 双 Esc 停止 | 500ms（`shortcuts.stopSequenceMs`）内两次 Esc（无修饰、非 repeat、焦点在会话区域且不在审批卡/终端/iframe 内）；要求 running、非 removed、子智能体须 continuable、无 pendingInteraction；两次需同会话同 turn | 手机用 Stop 按钮；外接键盘可选支持 | ☐ |
| C-90 | P0 | Chip 语义 | 引用 chip（原子：`source, ref, label, appearance(session|file|folder), clipboardText, invalid`）：方向键一步跨越、Backspace 整块删、插入后自动补空格、单击打开预览；TextRef（文本态 `/name`、`@name`、`@dir/` 装饰）；**命令 chip** 只能在开头，前面插入文本即退化为字面 token；**两步删除**（第一次选中，第二次删除）；undo 可恢复。外部文本剔除 U+E100–E11D、U+FFFC | `UITextView` + `NSTextAttachment`（原子 chip）或自定义 attribute run；删除逻辑在 `shouldChangeTextIn` 中实现 | ☐ |
| C-91 | P0 | 提交状态机 | phase `plain | claimed | adjudicating | submitting`。命令 chip 开头 → claimed，Enter → `claim.submit(args)`；无 chip 但以 `/` 开头 → adjudicating（`inputTriggers.adjudicate`）结果 `handled` / `{claim}` / `undefined`（当普通消息发）；普通消息**乐观提交**（立即清草稿与撤销历史，后台发送，可继续输入）；仅附件 → 直接发；命令不收附件 → `command.attachmentsUnsupported`。失败恢复：失败草稿按顺序 `\n\n` 拼接，仅当输入框为空（或仍是上次恢复内容）时放回，附件总是放回 | 同状态机；引用 chip 在发送时序列化为模型文本（`serializeReference`） | ☐ |
| C-92 | P0 | 草稿持久化 | 每会话 `dsh.conversation.<sid>` = `{draft, view, viewRequest}`；draft = `{text, references:[{source,ref,offset,length,label,appearance?,clipboardText,invalid?}], command?:{token}}`（校验：引用有序不重叠、在命令 token 之后）；**附件不持久化**；`requestDraftInitialization({prompt, whenDraftExists: replace|keep|append})` 预填 | 文件或 `UserDefaults` 按 sessionId 存同一 JSON | ☐ |
| C-93 | P1 | 异步插入 | `inputActions.captureInsertion()` / `insertText(text, span)`：仅在草稿 revision 未变时插入（语音转写用），独立撤销步 | 记录选区 + revision | ☐ |

### 4.3 排队 / 插话 / 停止

| ID | P | 功能 | 行为要点 | 数据 / RPC | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-94 | P0 | 发送模式决策 | `resolveSubmitMode`：未运行或不可插话 → `queue`；Enter/Send → 设置 `busyEnter`（默认 `queue`）；Cmd/Ctrl+Enter → 反面。Session 决定 echo placement：空闲→`transcript`，忙+queue→`queued`（队列 dock），忙+steer→`steering`。Steer 尽力而为：窗口关闭则转为下一个队列项 | `session.beginSubmission({mode, text, attachments, onRetire})` → `{requestId, abandon}`；`session.prompt(content, mode, signal, requestId)` → `session/prompt {requestId, sessionId, mode, content, clientTimeZone?}`；content = `[{type:'image', mediaType, data(base64), name?} | {type:'file', receiptId} | {type:'text', text}]` | 同逻辑；`prompt` ok 后还需等 retirement `observed` 才算成功 | ☐ |
| C-95 | P0 | 队列 Dock | 数据：`inbox['next-turn']`（排除已在 transcript 的 rpcId）+ 本地 `pendingSubmissions.placement==='queued'`。0 行不显示；1 行直接显示；>1 行可折叠 header「{n} 条排队消息」（默认折叠，有发送中显示「发送中…」）。行：附件缩略 + 文本预览（空白折叠、单行省略、会话引用显示 label）。操作（可变时）：**编辑**（仅纯文本行；内联编辑器，✓保存/✕取消）→ `updateQueue(id,{kind:'edit',content:[{type:'text',text}]})`；**删除** → `{kind:'remove'}`；**插话** → `{kind:'steer'}`（非运行禁用）；同时只允许一个操作；失败提示「编辑/删除失败：这条消息可能已经开始发送。」/「插话发送失败，请重试。」；`session/steer-unavailable`、`session/queue-item-not-found` 静默。本地 echo 行显示「发送中…」，按钮禁用。**全部插话**：空草稿 + Cmd/Ctrl+Enter 按 FIFO 逐个 steer | `session/updateQueue {sessionId, itemId, action}` | composer 上方 `DisclosureGroup` 卡片；行 `swipeActions`：删除 / 插话；点按进入编辑；header 提供「全部插话」按钮 | ☐ |
| C-96 | P0 | 停止 | Stop 按钮 / Esc Esc → `session.cancel()`；**队列保留**，Host 静默后按 FIFO 继续；失败 → `promptError {op:'stop'}` | `session/cancel {sessionId}` | Stop 按钮 + 触感 | ☐ |

---

## 5. 输入辅助：`/` 命令、`@` 引用、附件

| ID | P | 功能 | 行为要点 | 数据 / RPC | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-97 | P0 | 触发检测（input-trigger） | `@`：光标处 `(^|\s)@"…`（引号可含空格）或 `(^|\s)@\S*`；单词内 `@`（邮箱）不触发。`/`：在草稿开头或空白/标点后有效，单词字符后、另一个 `/` 后、URL 冒号后无效。命中 `{trigger, query, quoted, position: leading|inline, span:{start,end,draftRev}}`；命令 chip 已存在时 `/` 失效 | — | 监听 `UITextView` 文本+选区跑同样正则 | ☐ |
| C-98 | P0 | 候选菜单 | 每个 source 一组，并行拉取（新按键取消旧请求）；pending 保留旧项，无项显示 2 行骨架；全空/全失败自动关闭；高亮首项，↑↓ 跨组循环；Enter 选中；Tab：可下钻 → drill，否则选中；Esc / Shift+Tab 关闭并记住（同 token+query 不再自动打开）；行：图标 + 标题 + 别名 + 右侧描述；可选 section 标题；可下钻行显示「进入目录 Tab」+ chevron；面包屑固定在列表上方；最大高 400 | slot `conversation.input.overlay` id `slash-menu` | 键盘上方停靠的候选 `List` 面板（非浮层）；下钻 = 行尾 chevron 按钮；面包屑 = 横向 chips；外接键盘 `UIKeyCommand` | ☐ |
| C-99 | P0 | `/` 命令目录 | `commands/list(sessionId)` → `CommandDescriptor[] {definitionId?, name, description, input?:{hint, attachments?}}`，每会话缓存；`commands/change` 软刷新、`agent-preset/selected` 重置该会话、`connection/reset` 全清；子智能体会话为空。内置：`goal`、`plan`、`feedback`、`compact`、`permission`、`export`（中文别名 `/目标 /计划 /反馈 /压缩 /权限 /导出`），客户端贡献 `model`、`file`。空查询分组：**添加** = 文件、目标、计划、反馈；**指令** = 压缩、权限、模型、导出、其余按目录顺序；有查询 → 模糊子序列排名（前缀优先）。带参数的命令在 inline 位置隐藏 | `commands/list`、`commands/execute(sessionId, line, attachments[])` → `CommandExecution {commandId, result:{kind:'success', text?, sourceEventSeq?}|{kind:'error', text}} | undefined` | `+` 按钮 → sheet：「添加」「指令」两段；输入 `/` → 候选面板 | ☐ |
| C-100 | P0 | 命令分派决策 | 菜单选中：客户端贡献 → popup/action；Host 带 input → 插入命令 chip `/<token> ` + 参数提示；Host 无参 → 消费 token 并后台执行 `/<name>`。行首 token 后空格 → chip。Enter：claim → `execute(line+args)`。有附件只允许 `input.attachments===true`。执行失败 → 错误提示并保留草稿；结果以 `command/run`/`command/done` 出现在流中（composer 不回显） | `session.command(line)` → `{matched}` | 同决策表 | ☐ |
| C-101 | P1 | PopupSelect（`/model`、`/permission`） | 卡片（最大高 320）自带搜索框（抢焦点）；选项一次加载；过滤 `substring`（默认）或 `fuzzy-label`（/model）；分组粘性标题；高亮初始在 `active`；Enter/Tab 选中，Esc 关闭回到 composer；状态：「正在加载选项…」「正在应用…」「无选项」、失败 + 重试；带 `confirmation` 的选项弹风险确认（须勾选知情）；成功消费 `/cmd` token | overlay id `command-popup` | `.sheet` + `.searchable` `List`（分组 Section、✓）；风险确认见 C-110 | ☐ |
| C-102 | P0 | `@` 引用候选 | 并行：`fileReferences/list(sessionId, query)` → `[{path, kind:'file'|'directory'}]`（Host 排序，默认 20 条）；`sessionReferenceResolver/candidates(sessionId, query)` → `[{sessionId, label, displayTitle?, cwd?, sameWorkspace, createdAt, mention}]`；引号 `@"` 只查文件。顺序：「文件与文件夹」→「子智能体」（当前会话运行中的直接子）→「对话」。文件行：名称（目录带 `/`）+ 父路径；会话行：标题 + `[cwd（home→~）· ]时间`（同工作区不显示 cwd，缺失「（无工作目录）」）。下钻后面包屑「工作区 › seg › seg」 | 需会话已打开历史后才请求 | 同面板 + section 标题；SF Symbol doc / folder / bubble.left | ☐ |
| C-103 | P0 | `@` 选中结果 | 文件 → 原子 chip（label=basename，appearance file，ref=mention）；文件夹点选 → chip `name/`；文件夹下钻（Tab/chevron）→ 纯文本 `@dir/` 继续菜单。语法：`@path`，含空白 `@"path"`，目录引号保持开放 `@"dir/`；含控制符/引号的路径丢弃。会话 → chip（appearance session），ref = `@[label](dsh-session:…)` 原样进 prompt。点文件 chip → 右侧栏预览 `dsh-resource://file/session/<sid>/<relpath>` | — | chip 点按 push 文件预览 | ☐ |
| C-104 | P0 | 附件：添加与校验 | 来源：粘贴（文件项；同时有文本则文本另插入）、拖放、`+`/「文件」命令。拒绝：locked/machineBusy、one-shot 子智能体、continuable 子智能体非图片。图片（png/jpeg/webp/gif）客户端预检（projection `imageLimits {mediaTypes, maxImagesPerMessage, maxImageBytes, maxMessageImageBytes, maxImagePixels, maxImageDimension}`，默认 20 张 / 单张 20MiB / 总 200MiB / 64MP / 8192px）：张数、单张、总量。目录：桌面有 `__DSH_HOST_PATHS__` 桥 → 插入 `@path` chip，浏览器 → 「只有桌面端支持添加文件夹…」 | `imageLimits` | `+` 菜单：照片（`PhotosPicker`，maxSelection = 剩余张数）、相机、文件（`.fileImporter`）；`UIPasteboard` 粘贴图片；iPad 拖放；HEIC→JPEG 并按限制缩放后再 base64；文件夹不支持（显示同文案） | ☐ |
| C-105 | P0 | 附件：上传与发送 | 图片**不预上传**，发送时 base64 内联 `{type:'image', mediaType, data, name?}`；文件添加即后台上传（FIFO，并发 `maxConcurrentFileUploads`=2）：`uploading{loaded,total?}` → `ready{receiptId, file}` / `error{message}`，失败点击重试，移除即 abort；上传中禁止发送；发送 `{type:'file', receiptId}`（receipt 绑定该会话，入队时消费）。Host 拒绝原因映射：`MODEL_DOES_NOT_SUPPORT_IMAGES`、`FILE_NOT_STAGED`、`IMAGE_TOO_MANY_PIXELS`、`IMAGE_DIMENSION_TOO_LARGE`、`INVALID_IMAGE|IMAGE_TYPE_MISMATCH`、`TOO_MANY_IMAGES`、`IMAGE_TOO_LARGE`、`IMAGES_TOO_LARGE`、其他 → `image.sendFailed` | HTTP `POST /api/session/uploadFileBinary?sessionId=&name=`（`application/octet-stream`，响应恒 200 JSON `{ok, value:{receiptId, file:{attachmentId, name, bytes}}}`）；或 RPC `fileUploads/upload(sessionId, {data: base64, name?})` | `URLSession.uploadTask(fromFile:)` + 进度代理；security-scoped URL | ☐ |
| C-106 | P0 | 附件条 | 横向不换行条，64px 高；图片 64px 方块（点开 lightbox，✕ 移除）；文件卡 240×64：类型图标（上传中转圈）、文件名、`EXT size` /「上传中…」/「上传失败，点击重试」+ 底部进度条（未知总量为不确定进度）；溢出边缘箭头；新增滚到末尾；拖放全屏遮罩「文件或图片拖动到此处即可添加」+「图片限制：最多 {count} 张，每张 {size}」/ 禁止态 | slot `conversation.input.attachments` | 输入框上方 `ScrollView(.horizontal)`，文件卡 `ProgressView(value:)`，长按移除 | ☐ |

---

## 6. 选择器（控制行）

| ID | P | 功能 | 行为要点 | 数据 / RPC | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-107 | P0 | 模型 + 推理等级选择 | 按钮：模型名（slot `conversation.input.model.label`）+ 推理等级（caption，先收缩）+ chevron；选择中显示转圈；窄时只剩图标；加载中「正在加载模型…」，无模型「请选择模型」。锁定仅在 removed/inert/离线（**运行中不锁**，选择作用于下一次请求）；子智能体会话不显示。菜单（向上弹出）：根层「模型 ›」「推理等级 ›」（仅模型有 `reasoning` 时）；模型层：>4 个模型显示搜索（模糊子序列，前缀优先），按 provider 分组（`deepseek-account` 显示「DeepSeek 账号」，顺序 deepseek-account、deepseek-official、其余），✓ 当前，失败 provider 警告条 + 重试，「正在刷新模型列表…」，空「暂无可用模型」/「没有匹配的模型。」；推理层：无 `defaultEffort` 时有「Default」行 + 各 effort。选模型只发 `{provider, model}`；选等级发 `{provider, model, reasoningEffort}`；失败保持打开 + toast（`session/writer-held` 特判） | `session/modelCatalog()` → `ModelCatalog {default, routableProviders, groups[{id,name,models[{id,name,description?,reasoning?{efforts[{id,name,description?}], defaultEffort?}}]}], failures[{id,name,message}]}`；`session/selectModel {sessionId, provider, model, reasoningEffort?}` → `{selected}`；projection `modelSelection {lastUsed, next}`（current = next ?? catalog.default）；刷新事件 `llm/adapters-updated`、`settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated`、`connection/reset` | composer 中短名 `Button` → `.sheet`(.medium/.large) 内 `NavigationStack`：根 List（模型 / 推理等级）→ 分组 List + `.searchable` → 等级 `Picker(.inline)`；或目录小时用原生 `Menu` 嵌套 | ☐ |
| C-108 | P1 | `/model` 命令 | PopupSelect（fuzzy-label，始终显示搜索），行 `{id:'provider/model', label, group}`，失败 provider 行不可选；选模型时：同模型保留当前等级，否则用模型 `defaultEffort` | 同上 | 同 sheet | ☐ |
| C-109 | P2 | 1017 徽标 | provider ∈ {deepseek-account, deepseek-official} 且 `model.id==='deepseek-flash'` 且 `model.name==='DeepSeek-V4.1-Flash'` → 名称后加 info 色 Tag「1017」（触发器、根层值、选项行；不用于 /model、tooltip） | ui-deepseek-model-label-1017 | `Text("1017").font(.caption2)` 胶囊 | ☐ |
| C-110 | P0 | 权限模式选择 | 控制行左侧；仅当 projection `permissions` 存在且目录已加载才显示；按钮：图标（read-only / workspace-write / danger-full-access / auto）+ 名称 + chevron；aria「访问模式，当前：{name}」；锁定 = locked 或进行中/确认中。菜单向上：目录选项顺序，`auto` 带 `EXP` 徽标。选中：同值无操作；`danger-full-access`/`auto` → **风险确认**（必须勾选知情才可确认）；其他直接提交。提交 = 会话命令 **`/permission <preset>`**；乐观值在 promise 结束后清除，真实值来自投影。`custom` 只展示不可选 | `permissionPresets/catalog()` → `{options[{value,name,description?}], defaultOptions, defaultPreset}`；`session.command("/permission <preset>")`；projection `permissions {currentValue}`；事件 `permission-presets/catalog-changed` | `Menu{Picker}`；图标 eye / pencil / exclamationmark.shield / wand.and.stars；风险确认用小 sheet + `Toggle("我已了解风险…")` 才能点确认 | ☐ |
| C-111 | P0 | Agent 预设（新任务） | 不在控制行，在 hero 区工作区 chip 旁：图标 + 预设名 + chevron；菜单列出健康预设（名称 + 描述/「暂无描述。」）；「代码工具」开关关闭时隐藏内置 `ptc`、`minimal`。选择：无会话 → 暂存（下一个 blank 会话绑定时应用）；会话非 blank 或已是该预设 → 不变；否则 `agentPresets/select(agentId: sessionId, agentPreset: id)`；拒绝 → toast「无法切换到「{name}」：{reason}」（8s）。会话开始后不可改（`agent-preset/locked`）。header 只读标签显示本会话预设（tooltip「本任务的 Agent 预设，在任务开始时确定」，窄 ≤540 隐藏） | `agentPresets/list()` → `{presets[{id, isDefault, name?, description?, broken?}]}`；`agentPresets/select(agentId, agentPreset)` → 生效 id；`agentPresets/read(id)` → `{agentPreset, content(YAML), name?, description?}`；`settings/update("agent-preset-registry", {selectedDefault:id}, rev)`；projection `agentPreset`；内置 `standard`/`ptc`/`minimal`/`cordis`（创造模式） | 新任务页 `Menu{Picker}`；会话导航栏副标题小胶囊；设置页预设管理不在本文范围（见设置清单） | ☐ |
| C-112 | P1 | 计划模式 chip | `conversation.input.plan`：projection `plan {active, pending}`，有效 = pending ? !active : active；为真显示蓝色「计划」按钮（hover 变 ⊗），点击 → `commands/execute(sessionId, "/plan off", [])`，失败行内「退出计划模式失败」；进入用 `/plan`。plan 模式下 placeholder「描述你的任务以生成计划」 | `commands/execute` | composer 控制行 capsule `Label("计划")`，点按退出（确认可选） | ☐ |

---

## 7. Composer 接管：审批 / 提问 / 计划审阅

| ID | P | 功能 | 行为要点 | 数据 / RPC | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-113 | P0 | 接管机制 | `uiSession.registerPendingInteraction(precedence)`；每会话只显示一个：approval 0 > question 1 > plan-review 2，同级后发布者胜；以 `pendingInteraction` 传给 slot chain `conversation.composer`，各域 `select` 匹配后替换 composer（原 composer 仍挂载）。会话状态 `{running, pendingInteraction, completionUnread}`（后台会话完成 → `completionUnread`，用于侧栏「完成未读」角标） | Host→Client **waterfall** 远程事件（客户端返回答案或 `next()` 交给下一应答者） | composer 区 `switch pendingInteraction {.approval, .question, .planReview, nil}`；App 在后台时发本地通知 | ☐ |
| C-114 | P0 | 工具审批卡 | 触发：waterfall `approval/request(req, next)`，`req = {agent, toolName, callId?, reason?, displayReason?:{en, [locale]}, signal?}`，返回 `'allowed-once' | 'rejected'`（无「总是允许」）。卡：警告条「等待审批」（答复后变进行中点）；标题 = displayReason（按 UI 语言）?? reason ??「工具 {toolName} 请求越权执行」；详情 = 对应工具调用的命令文本（等宽，slot `conversation.approval.detail`，ui-chat 提供）；按钮 [拒绝] [允许一次]，答后都禁用（单飞），抛错且仍可答则恢复。键盘：卡内 Enter=允许、Esc=拒绝（输入框/IME 内忽略）。`signal` 中止 → 卡消失 | 审计事件 `approval/asked`、`approval/decided`（仅日志） | 底部卡片替换输入栏：命令 `ScrollView` 等宽（≤40% 高）；两个全宽按钮（拒绝 `.bordered`、允许一次 `.borderedProminent`）；到达时 `.warning` 触感；外接键盘 `.keyboardShortcut(.return)`/`.cancelAction` | ☐ |
| C-115 | P0 | 提问卡（ask_user_question） | waterfall `user-questions/request` → `AskUserQuestionAnswer {answers:[{id, selected:string[], custom?}]}`；拒绝码 `ASK_CANCELLED`（关闭无 callId 的卡 / 计划「要求修改」）、`ASK_TIMED_OUT`（倒计时到 0，**卡保留**）、`ASK_ABORTED`。一页一题：header（eyebrow `header`、标题 `question`；右侧倒计时「{seconds} 秒后继续工作」/「已暂停 · 剩余 {s} 秒」+ **[慢慢回答]**、「会一直等你回答」、「已继续工作，仍可回答」；最小化、关闭 ✕（有 callId = 收起可从工具行重开；否则 = 放弃整组）。正文：`detail` Markdown；单选（编号徽标，点选**自动下一题**，清除自定义）；多选（勾选，可同时填自定义）；`(推荐)`/`(Recommended)` 后缀去掉并显示「推荐」徽标，首个推荐项预选；自定义输入「输入你的答案」（Enter 继续，Shift+Enter 换行）。底部：‹ i/n ›、状态行、[跳过]、[下一题]/[提交]/[提交中…]（当前题未答禁用）。提交：先跳到未完成题 + 「请先完成这道问题。」；跳过 → `{id, selected:[]}`；单选且有自定义 → `selected:[]`+custom | `userQuestions/attachWait(sessionId, callId)` 流（首帧 `{remainingMs}`，仅 `wait.timed`）；`userQuestions/answer(sessionId, callId, answer)` → boolean（投影为 `continued` 后用；false = 不可再答；错误 `BAD_ANSWER`、`REPLY_QUEUED`）；projection `userQuestions {active[{callId, questions, state:'open'|'continued'}], settled[{callId, answers}]}`、`inbox` | 底部卡（≤60% 高，头尾固定，中间滚动）；选项大行（circle / checkmark.circle.fill / square / checkmark.square.fill）；`TabView(.page)` 或 chevron 翻页；`TextField(axis:.vertical)`；焦点在卡内暂停倒计时，`scenePhase` 非 active 恢复倒计时 | ☐ |
| C-116 | P0 | 倒计时与等待状态 | `counting` → `focused`（焦点在卡内冻结剩余）→ `editing`（首次编辑后无限等待，持久化）/ `waiting`（「慢慢回答」）/ `continued`；1s tick 显示 `ceil(remainingMs/1000)`；窗口失焦/隐藏释放暂停 | — | 同状态机 | ☐ |
| C-117 | P1 | 提问草稿与只读回顾 | 草稿按会话+key（`question:<sid>:<callId>`）持久化 `{index, drafts:[{selected,custom,skipped}], wait?}`，store `dsh.user-questions.drafts.v1`；从工具行「查看回答」打开只读卡（全禁用，跳过显示「这道问题当时被跳过。」） | localStorage | `UserDefaults`/SwiftData | ☐ |
| C-118 | P1 | 迟到回复气泡 | `user/message source {kind:'user-question-reply', callId, outcome:'answered'}` → 右对齐气泡「回答先前等待中的问题」，折叠摘要 = 答案逗号连接（或「已跳过」），展开 = header — question / detail / 选项 /「回答：」；底部 HH:mm + 复制（`header — question\n回答：v1, v2`，空行分隔） | chat node `question-reply` | 气泡 + DisclosureGroup | ☐ |
| C-119 | P0 | 计划审阅卡 | 单问题且 `intent.kind==='plan-review'`、有 detail、≤2 选项含 `intent.approve`、非多选 → 计划审阅卡：条「计划待审」+「查看全文」（slot `conversation.plan-review.actions`，首次提交自动打开右侧栏计划预览）；标题 = 计划首行，描述 = 首段（2 行）；[要求修改]（→ `ASK_CANCELLED`，回到 composer 写反馈）[同意执行]（tooltip=选项描述）→ `{answers:[{id, selected:[approve.label]}]}` | `exit_plan_mode` 结果 `{approved}` | 紧凑卡 +「查看全文」push Markdown 阅读页；底栏 同意执行（prominent）/ 要求修改 | ☐ |

---

## 8. Dock：任务 / 目标 / 上下文

| ID | P | 功能 | 行为要点 | 数据 / RPC | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-120 | P0 | 任务清单 Dock（Todo） | input dock order 0（最上）；空不显示；header：清单图标 +「任务」+ 进度（「{done} 已完成 · {active} 进行中 · {pending} 待处理」，省略 0 项）+ chevron，**默认折叠**；展开：状态圆点（done/ongoing/idle）+ 内容 | projection `todos [{content, status: completed|in_progress|pending}]` | `DisclosureGroup` 卡片 | ☐ |
| C-121 | P0 | 目标条（Goal） | input dock order 10（Todo 后、Queue 前）：图标 + 「进行中的目标」/「已暂停的目标」（active+disarmed 或 paused）/「受阻的目标」（tooltip=blockedReason.message）+ objective；按钮：暂停（active+armed）、恢复（paused 或 active+disarmed）、编辑（内联多行，✓/✕）、清除（清除后本地抑制直到投影追上）。complete/无目标/加载中不显示；错误行内 `"{message} ({code})"`；操作单飞。创建用 `/goal <objective>` | projection `goal {goal:{id, revision, objective, phase:active|paused|blocked|complete, blockedReason?, maxGoalRounds}, roundsStarted, createdAt, updatedAt}`；`goals/get(sessionId)` → GoalView + `activation:'armed'|'disarmed'`（订阅 `goal/activation-changed`）；`goals/edit(sessionId, {id,revision}, {objective})`、`goals/pause`、`goals/resume`、`goals/clear`（CAS ref） | Banner：图标 + `Text(objective).lineLimit(2)` + `Menu`（暂停/恢复/编辑/清除）；编辑用 sheet `TextEditor`；清除 `confirmationDialog` | ☐ |
| C-122 | P1 | 上下文占用环 | dock 行：14px 圆环 + `NN%`，`used = projectedTokens ?? pressureTokens`，`percent = min(100, round(used/window×100))`，缺数据不显示；点击弹面板：「上下文已用 45%」+ `~used / window`（K/M）+ 分段条（系统提示词/工具定义/对话消息）+ 三行明细 | projection `contextPressure {projectedTokens, pressureTokens, contextWindow}`、`contextBreakdown {systemTokens, toolsTokens, messageTokens}` | `Gauge(.accessoryCircularCapacity)` 或 `Circle().trim` + `.popover`/小 sheet | ☐ |

---

## 9. 会话内业务插件

| ID | P | 功能 | 行为要点 | 数据 / RPC | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-123 | P1 | 子智能体目录（header） | header 动作「N 个子智能体（，正在运行）」：hover 150ms 打开、点击钉住；树形：状态列（运行 loader / 完成绿点 / 空闲灰点）+ label + 次行 `title · 模式（一次性/可继续/外部任务/模式未知|需要迁移）· 活动（正在运行/已完成/当前未运行）` + 右列 tokens / 活跃耗时；行尾「在侧边栏打开」；展开按需加载下级；失败「无法加载子智能体」+ 重试 | `projectionsBySession[id].values.subagentCatalog {entries[{id, label?, mode, activity}]}`、`subagentTiming`、`tokenUsage`；`sessions.refreshProjections(id)`；打开 `uiWorkspace.openSession({parentSessionId, childSessionId, mode})` | toolbar 按钮 + badge → sheet `List` + `OutlineGroup`（懒加载）；点行 push 子会话；`TimelineView` 刷新耗时 | ☐ |
| C-124 | P1 | 子智能体会话 composer | one-shot → 只读「一次性子智能体记录」；unknown →「读取子会话后才能确定是否可继续。」；continuable 父离线且未运行 →「此子智能体暂时只读」；continuable 正常 → 普通 composer，发送走 `subagents/prompt`、停止走 `subagents/interruptByParent`（由会话层发）；面包屑可回父会话 | snapshot.subagent `{address{kind:'subagent', parentSessionId, childSessionId, mode:'one-shot'|'continuable'|'unknown'}, parentAvailable}` | 只读提示条替换输入框 | ☐ |
| C-125 | P1 | 工作流运行节点 | 每个顶层 run 一个流节点：run 行（chevron + 状态点 + 名称 +「N 个成员」+ 状态）→ phase 行（标题/「未分阶段」+ 成员数 + 聚合计数）→ 成员行（点 + 名称 + 状态）；运行中/失败/取消/中断默认展开，完成收起；成员与子都运行中且可解析时可点打开子会话 | 事件 `tool-workflow/run-start{runId,name}`、`agent-start{runId,seq,label,phase?,childId}`、`agent-end{runId,seq,outcome}`、`run-end{runId,stopReason}`；turn 以 interrupted/forked 结束 → 中断 | 三层 `DisclosureGroup` | ☐ |
| C-126 | P1 | 后台任务（Jobs）面板 | header 按钮仅有任务时显示「N 个后台任务运行中」/「N 个后台任务」；弹出：「进行中」（运行时长、kind、状态/progress、label）+「已结束 {count}」折叠段 +「清空」（仅客户端隐藏）；停止两段式（3s 内「再次点击确认停止」），失败「停止失败」；可展开内嵌实时输出（复制命令、「……较早的输出已丢弃……」、「实时输出流中断：{error}」），收起即关流 | `job/list({sessionId})` 流 `{type:'rows', jobs: JobView[]}`；`job/follow({jobId, sessionId?, from?})` 流 `opened | output{chunks, next, lossy?} | status`；`job/kill({sessionId, jobId})` → `{outcome:'requested'|'already-finished'}`；`JobView {id, kind, label, status: running|stopping|completed|killed|failed, progress?, detail?, startedAt, finishedAt?, output:{total, earliest, spillPaths?}}` | toolbar 按钮 + badge → sheet（Section 进行中/已结束）；停止 `swipeActions(role:.destructive)` + `confirmationDialog`；输出 push 全屏等宽视图跟随底部 | ☐ |
| C-127 | P1 | 交付文件卡（present） | turn 尾：单个占满一行，多个两列网格，>4 折叠「全部 N 个文件」；卡 = 类型图标 + basename + description/文件类型 + 原生打开控件（默认应用 / 关联应用 / 在文件管理器中显示）；点卡 → 右侧栏预览；状态「正在打开…」「已请求打开」「打开失败，点击重试」「此文件没有可用的主机路径…」 | 事件 `deliverables/presented{turn, callId, files[{path, description?}]}`；HTTP `POST api/present.open?sessionId&seq&index[&action=reveal|&application=]`、`GET api/present.host` | 手机单列卡片；点按 push 文件预览/QuickLook；「原生打开」改为 `ShareLink`/导出到「文件」 | ☐ |
| C-128 | P1 | 本轮改动卡 | 需「显示代码工作视图」开关：单文件「已编辑 {name}」+ `+A -D`/二进制/过大；多文件「已编辑 N 个文件」+ 总计数；行可点 → 右侧栏 Review tab（标题「第 {turn} 轮改动」：文件选择、左右/单栏对比、自动换行、打开整个文件；提示新建/删除/相同/超时/只显示前 5000 行）；hover 500ms diff 预览 | 事件 `tool/call`（write/edit/str_replace_editor）、`tool/result`、`workspace/changes{turn}`；HTTP `GET api/changes.summary?sessionId&seq`、`GET api/changes.diff?sessionId&seq&index`、`POST api/changes.open` | 行 push `DiffView`（默认 unified）；长按 `.contextMenu(preview:)` 预览 | ☐ |
| C-129 | P0 | 消息反馈 👍/👎 | 收尾助手消息操作行（复制与分支之间）：赞/踩，已评分为实心常显；首次 hover/focus 懒加载列表；点同一评分 → 撤销（delete，带 ifVersion，串行）；点另一个 → 打开反馈弹窗「提交反馈」：7 个分类 chip（单选可取消）+ 文本框（「填写详情以帮助我们改进体验，提交内容会包括当前对话的日志」）+ 提交；成功 toast「感谢你的反馈」，失败 toast（版本冲突/过长/通用）弹窗保留。`/feedback` 无参 → 会话级反馈弹窗；`/feedback <text>` 走 Host 命令 | `messageFeedback/list({sessionId})` → `{items[{messageId, rating, note?, category?, version, createdAt, updatedAt}]}`；`messageFeedback/put({sessionId, messageId, rating:'positive'|'negative', note?, category?, ifVersion})`；`messageFeedback/delete({sessionId, messageId, ifVersion})`；`sessionFeedback/record({sessionId, text?, category?})`；分类 `task-result | instruction-following | product-interaction | service-stability | resource-cost | security-privacy-permission | other` | 操作行 `hand.thumbsup(.fill)` + contextMenu；弹窗 `.sheet(.medium)`：chip FlowLayout + `TextEditor` + 工具栏提交 | ☐ |
| C-130 | P1 | 计划卡 | turn 尾：匹配 `exit_plan_mode` 调用，`args.plan` 首行 `# Title` → 卡（Markdown 图标 + 标题 +「计划 · Markdown」+「打开」）→ 右侧栏计划预览（资源 `dsh-resource://plan/<sessionId>/<callId>`，通过 `session/follow` + `session/page` 回读历史找 callId） | Definition `submitted-plan` | 卡片 → push Markdown 阅读页 | ☐ |
| C-131 | P1 | 技能 | `/` 触发源「技能」：`skills/list({sessionId})` → `{skills[{name, description, modelInvocable, path?, whenToUse?}]}`，模糊排名，`modelInvocable:false` 描述前缀「仅用户 · 」，选中插入 `/<name> `；缓存按会话，`agent-preset/selected` 失效，`plugin-manager/changed`/`connection/reset` 全清；子智能体会话无。已发送文本中 `/name` 渲染为 chip，点击打开 SKILL.md | `skills/list` | 候选面板「技能」分组；chip 点开 Markdown sheet | ☐ |
| C-132 | P1 | 密钥遮罩 | 只影响绘制（复制与模型输入保持原文）。规则：PEM 私钥（保留 BEGIN/END 行）、`scheme://user:PASSWORD@host`、前缀 token 保留前 8 字符其余遮：`sk-`(≥20 且含数字) `AIza` `ghp_/gho_/ghu_/ghs_/ghr_` `github_pat_` `glpat-` `npm_` `hf_` `AKIA/ASIA` `LTAI` `AKID` `xoxa-/xoxb-/xoxp-/xoxr-/xoxs-` `sk_live_/sk_test_/rk_live_/rk_test_` `whsec_` JWT `eyJ…`；等宽显示，`*` 画成圆点；可交互文本末尾眼睛按钮「显示密钥/隐藏密钥」，每次挂载默认遮，记住被揭示的原值；队列/echo 无按钮 | ui-secret-mask | Swift `Regex` 复刻；`•` 替换；行内 eye / eye.slash 按钮；复制菜单给原文 | ☐ |

---

## 10. Trajectory 开发者视图（P2）

| ID | P | 功能 | 行为要点 | iPhone 建议 | 状态 |
|---|---|---|---|---|---|
| C-133 | P2 | 入口 | `conversation.view` id `trajectory`（「轨迹」），仅「显示代码工作视图」开启时出现；工具行 Inspect → `openView("trajectory", callId)` 定位记录（展开所在 turn、居中、打开概述） | 设置开关 + 导航栏 segmented；contextMenu「查看」深链 | ☐ |
| C-134 | P2 | 账本（Ledger） | 记录类别 system/user/context/compacted/assistant/tool/subtool；按 turn 分节（「第 {turn} 轮」/「轮次之间」）、step 分组；行 = 请求徽标「请求 #{n}」+ turn 标记 + 类别 + 文本 `→ 结果`；失败行显示错误码；单击选中、双击切换 turn/调用折叠；首行「加载更早的历史」（距顶 48px 自动）；初始 50 节点、每次 +50；>100 虚拟化；跟随尾部 | `List` + `Section`（`DisclosureGroup`）+ `ScrollViewReader` | ☐ |
| C-135 | P2 | 工具栏 | 时长切换（`dsh.trajectory.duration`）、轮次全展开/收起、调用全展开/收起、搜索（空格分隔 AND、不区分大小写，**过滤**而非高亮） | `.searchable` + toolbar Menu | ☐ |
| C-136 | P2 | 时间线 | Input/Model/Tools 三泳道，助手区分 TTFT/解码；模式 sequence/duration/actual/time；拖拽选区间、点选记录、滚轮缩放、右键清除/平移、双击/Esc 清除、hover 500ms tooltip | 横向 `Canvas` 条：拖动=区间、`MagnifyGesture`=缩放、点按=选择、双击=清除 | ☐ |
| C-137 | P2 | 检查器 | 按类别的 tab：system（System Prompt / Tools / Diff）、compacted（Summary / Raw Output）、消息（Summary / Preview / Raw / Source）、tool（Summary / Payload 或 Code / Result / Schema / Timing）、request（Summary / Options / Usage / Timing）；Usage 含本次与会话累计；Timing 开始时间可切本地/Unix；Code tab 行号高亮、换行、`{}` 原始 JSON、复制代码/输出；JSON 可折叠树；附件缩略图 lightbox。`dsh.trajectory.jsonStringWrapping` | `.sheet(.medium/.large)` + `Picker(.segmented)` tabs；JSON `OutlineGroup` | ☐ |

---

## 11. 实验插件

| ID | P | 功能 | 行为要点 | 数据 / RPC | iPhone 建议 | 状态 |
|---|---|---|---|---|---|---|
| C-138 | P2 | 思维链翻译 | 需启用 `dsh-experimental-cot-translation-bundle`；替换推理展开体：顶部按钮「查看原文」↔「查看译文」（失败禁用）、翻译中转圈、失败「翻译暂不可用，已显示原文」+ 重试；默认显示译文，折叠预览始终原文；按空行分段，只翻译已完成段落（超 `maxTextChars` 在空白处切分），流式尾段保持原文；顺序请求、每个展开体内存缓存；目标语言 `auto` = UI 语言；关闭/卸载取消请求 | `cotTranslation/limits()` → `{maxTextChars, preferences{provider: google|bing|deepseek-account|deepseek-official, targetLanguage}, availableProviders}`；`cotTranslation/translate({text, targetLanguage, sourceLanguage?, provider, sessionId})` → string；config `cot-translation.provider`（默认 bing）/ `targetLanguage`（默认 auto） | 推理 DisclosureGroup 内顶部 `HStack{Button; ProgressView; 失败文案+重试}`；`Task` 在 `.onDisappear` 取消 | ☐ |
| C-139 | P2 | 语音输入 | 控制行 activity 位：28px 麦克风（「听写」）；不可用（未连接或 provider 未就绪）→ 设置引导弹窗（「使用语音输入前需要安装」/「语音识别尚未就绪」+ 前往设置/稍后）；可用 → 阶段 `idle → requesting（请允许使用麦克风…）→ recording（80 柱实时波形 + ■「停止并识别」）→ transcribing（识别中…/唤醒中…）→ idle | feedback`；录音时展开占满右侧（隐藏模型选择）；左侧 ✕ 取消/丢弃；`maxDurationSeconds`（默认 120s）自动停止；转 16kHz 单声道 PCM16 WAV，> `maxAudioBytes`（默认 4MiB）→「录音超过服务限制…」；结果插入开始时记录的光标处，草稿已变 → 保留并显示「插入文字」；空 →「未识别到语音」；Esc/失焦(录音中)/页面隐藏(非识别中)/切会话 取消；**不自动发送** | `speech/follow()` 流（`SpeechCatalog {maxAudioBytes, maxDurationSeconds, providers[{id, name, location:'host-local'|'cloud', languages, setupEstimate?, downloadSources?, preparation{phase…}}], selection{providerId, language}}`）；`speech/transcribe({audioBase64, providerId?, language?})` → `{text, audioSeconds, inferenceSeconds}`；`speech/configure`、`speech/prepare`、`speech/cancelPreparation`（设置页） | `AVAudioEngine` tap 直接录 16k mono PCM16 WAV；`NSMicrophoneUsageDescription`；拒绝 → 提示 + 跳系统设置；录音条 `HStack{xmark; Waveform(Canvas 20fps); stop}`；`scenePhase` 后台取消 | ☐ |
| C-140 | P2 | 智能体团队 | header 动作「智能体团队」（窄时只图标）：hover/点击打开面板；「成员」（状态点 + 名称 +「当前会话」标签 + 状态 · 模型 + 错误；当前/失败/准备中不可点；点击打开成员会话）+「共享任务」（标题 + 状态；描述 2 行可展开；id、owner/未分配、可开始/被依赖阻塞、依赖、写入范围、警告）或「暂无共享任务，可以通过对话创建」；只读 | 无 RPC；`projectionsBySession[lead].values.agentTeam {members[{id, name, role, phase, error?}], tasks[{id, revision, subject, description, status, blockedBy, writeScopes, ownerName?, ready, writeScopeWarnings}], failure?}`；lead = `subagent.address.parentSessionId ?? sessionId` | toolbar `person.3` → sheet `List`（成员 / 共享任务） | ☐ |

---

## 12. 设置项（会话体验相关）

| ID | 命名空间.字段 | 取值（默认） | UI 位置 | 文案 zh / en |
|---|---|---|---|---|
| C-141 | `ui-conversation.busyEnter` | `queue` \| `steer`（`queue`） | 通用 › composer-enter（order 20） | 繁忙时的发送行为 / Send behavior while busy；排队发送 / 插话发送 |
| C-142 | `ui-chat.transcriptView` | `compact|standard|detailed|verbose`（桌面 standard / Web detailed；旧值 normal、expanded→detailed） | 通用 › transcript-view（12） | 工作步骤展示 / Work details：简洁 / 标准 / 详细 / 完全展开 |
| C-143 | `ui-chat.collapseTiming` | `completion` \| `next-input`（completion） | 同上第二个选择器 | 工作步骤收起时机：回答结束后 / 下次有新消息时 |
| C-144 | `ui-chat.linkOpening` | `sidebar` \| `new-tab`（sidebar；仅有侧栏浏览器时显示） | 通用 › link-opening（17） | 网页链接默认打开方式：应用内侧边栏 / 默认浏览器 |
| C-145 | `ui-chat.performanceUsage` | `detailed` \| `compact`（detailed） | 通用 › performance-usage（30） | 性能与用量：简洁 / 详细 |
| C-146 | `developerTools.enabled`（`ui-settings.enabled`） | bool | 通用 | 显示代码工作视图 / Show coding view（控制 Trajectory、改动卡、内置 ptc/minimal 预设） |
| C-147 | `permission.defaultPreset` | 目录 `defaultOptions`（不含 auto） | 通用 › permission（-20）；`settings/mutate("permission", [{op:'set', path:['defaultPreset'], value}], rev)` | 权限 / 选择新会话的默认权限模式 |
| C-148 | `agent-preset-registry.selectedDefault` | 预设 id | 设置 › Agent 预设 | 设为新任务默认 |
| C-149 | `shortcuts.stopSequenceMs` | 500 | — | 双 Esc 间隔 |
| C-150 | config `ui-conversation.maxConcurrentFileUploads` | ≥1（2） | — | 文件上传并发 |

写入均为乐观（先本地后 `configForms.set`），以 Host 接受值为准。客户端本地存储键：`dsh.conversation.<sid>`、`dsh.conversation.contentWidth`、`dsh.user-questions.drafts.v1`、`dsh.trajectory.duration`、`dsh.trajectory.jsonStringWrapping`、`dsh.voice-input.microphone`。

---

## 13. 关键文案表（key | zh | en）

> 完整 zh/en 表可从各包 client.js 的 `const zh/en` 对象提取（命名空间：`conversation`、`chat`、`model`、`permission.access`、`settings.permission`、`settings.agentPreset`、`slash.menu`、`commands`、`reference`、`user-questions`、`approval`、`message-feedback`、`job`、`subagent`、`workflow-run`、`deliverables`、`skill`、`secretMask`、`plan`、`goal`、`trajectory`、`cotTranslation`、`voice-input`、`agent-team`）。工具行文案在 `conversation` 命名空间（`tool.*`、`detail.*`）。

### 13.1 Composer

| key | zh | en |
|---|---|---|
| placeholder.default | 发消息或创建任务, / 调用指令, @ 文件或对话 | Message or run a task, / commands, @ files or sessions |
| placeholder.hero | 描述你想要构建的内容, / 调用指令, @ 文件或对话 | Describe what you want to build, / commands, @ files or sessions |
| placeholder.workspace | 选择一个工作区开始 | Choose a workspace to start |
| placeholder.unavailable | 会话不可用 | Session unavailable |
| placeholder.parentOffline | 父会话已离线，无法继续发送；仍可停止当前运行 | Parent session offline; sending is unavailable but you can still stop the run |
| placeholder.steerQueue | Cmd/Ctrl+Enter 插话发送全部排队消息 | Cmd/Ctrl+Enter steers all queued messages |
| placeholder.plan / hint.plan | 描述你的任务以生成计划 | describe your task to generate plan |
| hint.goal | 输入目标，智能体将持续执行 | describe the objective for a long-running task |
| hint.goal.active | 当前目标进行中。可输入 edit 修改 / pause 暂停 / resume 继续 / clear 清除 | goal active — edit / pause / resume / clear |
| input.commands / input.file | 添加文件或调用指令 / 文件 | Add files or run commands / File |
| input.send / send.queue / send.steer | 发送消息 / 排队发送 / 插话发送 | Send message / Queue message / Steer message |
| input.stop | 停止生成 | Stop generating |
| queue.count / queue.sending | {n} 条排队消息 / 发送中… | {n} queued messages / Sending… |
| queue.edit / save / cancelEdit / remove / steer | 编辑排队消息 / 保存排队消息 / 取消编辑 / 删除排队消息 / 插话发送 | Edit queued message / Save queued message / Cancel editing / Remove queued message / Steer queued message |
| queue.edit.unsupported | 包含非文本内容，暂不支持编辑 | Contains non-text content; editing is not supported yet |
| queue.steer.unavailable | 仅运行中可插话发送 | Steering is available only while the agent is running |
| queue.editFailed / removeFailed | 编辑失败：这条消息可能已经开始发送。 / 删除失败：这条消息可能已经开始发送。 | Edit failed: this message may have already started sending. / Removal failed: … |
| queue.steerFailed | 插话发送失败，请重试。 | Steering failed. Try again. |
| context.aria | 上下文已用 {percent} | {percent} of context used |
| context.system / tools / messages | 系统提示词 / 工具定义 / 对话消息 | System prompt / Tool definitions / Messages |
| todo.title | 任务 | To-dos |
| todo.progress.done / active / pending | {done} 已完成 / {active} 进行中 / {pending} 待处理 | {done} completed / {active} in progress / {pending} pending |
| hero.headline / hero.preview / hero.chooseWorkspace | 探索未至之境 / 预览版 / 选择工作区 | Into the Unknown / Preview / Choose workspace |
| error.sessionInUse | 当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。 | This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app). Quit other running DSH instances and try again. |
| command.attachmentsUnsupported | /{command} 不接受附件，请先移除附件 | /{command} does not accept attachments; remove them first |
| file.uploading / uploadFailed / stillUploading | 上传中… / 上传失败，点击重试 / 文件还在上传，请等待上传完成后发送 | Uploading… / Upload failed; click to retry / Files are still uploading; send after they finish |
| file.sessionUnavailable / notStaged | 会话不可用，无法上传文件 / 文件尚未上传成功，请重新添加后再试 | Session unavailable; files cannot be uploaded / The file has not finished uploading; re-add it and try again |
| attachment.dropTitle / dropDesc / dropBlocked | 文件或图片拖动到此处即可添加 / 图片限制：最多 {count} 张，每张 {size} / 当前无法添加文件或图片 | Drag files or images here to add them / Image limit: up to {count} images, {size} each / Files and images cannot be added right now |
| attachment.directoryDesktopOnly | 只有桌面端支持添加文件夹，浏览器里请添加单个文件 | Folders can only be added in the desktop app; add individual files in the browser |
| image.unsupportedType | 仅支持 PNG、JPG、WebP、GIF 格式的图片 | Only PNG, JPG, WebP, and GIF images are supported |
| image.tooMany / fileTooLarge / totalTooLarge | 一条消息最多添加 {count} 张图片 / 单张图片不能超过 {size} / 图片总大小超过 {size}，请移除部分图片 | A message can include up to {count} images / Each image must be smaller than {size} / Images exceed {size} in total; remove some and try again |
| image.tooManyPixels / dimensionTooLarge | 图片分辨率过大，请压缩后重试 / 图片宽高不能超过 {size}px，请缩小后重试 | Image resolution is too high; compress it and try again / Image sides must be at most {size}px; downscale it and try again |
| image.modelUnsupported / sendFailed | 当前模型不支持图片，请切换支持图片的模型 / 图片发送失败（{reason}），请重新添加图片后再试 | The current model does not support images; switch to a model that does / Sending images failed ({reason}); re-add them and try again |
| settings.enter.title / description | 繁忙时的发送行为 / 智能体运行时 Enter 键和发送按钮的行为；Cmd/Ctrl+Enter 使用另一行为 | Send behavior while busy / What Enter and the Send button do while the agent is running; Cmd/Ctrl+Enter uses the other behavior |

### 13.2 Transcript

| key | zh | en |
|---|---|---|
| message.stepProcess.thinking / read / readImage / write | 正在分析请求 / 正在读取文件 / 正在读取图片 / 正在写入文件 | Analyzing the request / Reading files / Reading images / Writing files |
| …search / edit / commands / code | 正在搜索代码 / 正在编辑文件 / 正在运行命令 / 正在运行代码 | Searching code / Editing files / Running commands / Running code |
| …webSearch / webFetch / subagents / plan / questions / tools | 正在搜索网页 / 正在访问网页 / 正在协调子智能体 / 正在更新计划 / 等待你的操作 / 正在调用工具 | Searching the web / Visiting web pages / Coordinating subagents / Updating the plan / Waiting for your action / Calling tools |
| …prepare.<kind> | 准备读取文件 …（「准备…」） | Preparing to read files … |
| …done.thinking / read / readImage / write | 已完成分析 / 已读取文件 / 已读取图片 / 已写入文件 | Analysis completed / Read files / Read images / Wrote files |
| …done.search / edit / commands / code | 已搜索代码 / 修改了文件 / 执行了命令 / 运行了代码 | Searched code / Edited files / Ran commands / Ran code |
| …done.webSearch / webFetch / subagents / plan / questions / tools | 已搜索网页 / 已访问网页 / 已协调子智能体 / 更新了计划 / 向用户提出了问题 / 已调用工具 | Searched the web / Visited web pages / Coordinated subagents / Updated the plan / Asked questions / Called tools |
| …joinTwo / comma / more | {first}并{second} / ， / {title}等 | {first} and {second} / , / {title}, etc. |
| message.turnProcess.worked / took / failed | 已完成 / 已完成，用时  / 处理失败 | Completed / Completed in  / Failed |
| message.stopped / message.think | 已停止 / 思考 | Stopped / Think |
| chat.deepDiving / deepDivingFor | 深度求索中 / 深度求索中，用时 {duration} ··· | Deep diving / Deep diving for {duration} ··· |
| chat.loadingHistory / loadOlder / toBottom / loadError | 载入历史… / 加载更早 / 回到底部 / 历史加载失败：{message}（{code}） | Loading history… / Load earlier / Back to bottom / Failed to load history: {message} ({code}) |
| message.branch / branchUnavailable | 在新对话中分支 / 仅可从已完成轮次的最后一条消息分支 | Branch into a new conversation / Available only on the last message of a completed turn |
| copy / copied | 复制 / 复制成功 | Copy / Copied |
| message.retry.active / cancelled / started / scheduled | 正在重试模型请求 / 模型请求重试已取消 / 已重试模型请求 / 等待重试模型请求 | Retrying model request / Model request retry cancelled / Retried model request / Waiting to retry model request |
| message.retry.status / delay / failure | {label}（{retry}/{maximum}） · {seconds}s / 重试延迟： / 失败原因： | {label} ({retry}/{maximum}) · {seconds}s / Retry delay:  / Failure reason:  |
| message.turnError / taskStopped | 本轮运行失败 / 任务已停止 | This turn failed / Task stopped |
| message.failure.auth / quota | API 密钥无效 / 当前请求的额度已用尽 | API key is invalid / Request quota exhausted. |
| message.failure.accountSignedOut / accountSignInRequired | 任务已因退出 DeepSeek 登录而停止。 / 请先登录 DeepSeek，并确认请求地址支持账号认证。 | Stopped because you signed out of DeepSeek. / Sign in to DeepSeek and ensure the request destination supports account authentication. |
| message.maxTokens / hint | 已达到输出 token 上限 / 回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出。 | Output token limit reached / The reply was cut off; … Send "continue" to let the model resume. |
| message.compaction / running / completed | 上下文已压缩 / 正在压缩… / 已压缩 {items} 条历史记录（约 {tokens} tokens） | Context compacted / Compacting context… / Compacted {items} history items (~{tokens} tokens) |
| command.running / failed / done | 执行中… / 指令失败 / 已完成 | Running… / Command failed / Completed |
| message.toolAdded / toolRemoved / toolsUpdated | 已添加工具：{name} / 已移除工具：{name} / 工具已更新 | Tool added: {name} / Tool removed: {name} / Tools updated |
| message.referenceSummary | 引用会话 · {labels} | Referenced session · {labels} |
| message.trigger.request / goal / agent / team / subagent / github / webhook / schedule / job / plugin | 收到执行请求 / 继续执行目标 / 收到任务消息 / 收到团队消息 / 子任务状态更新 / 收到 GitHub 事件 / 收到外部事件 / 自动化任务 / 后台任务状态更新 / 插件状态更新 | Execution requested / Continuing goal / Task message received / Team message received / Subtask status updated / GitHub event received / External event received / Automation task / Background task updated / Plugin status updated |
| message.trigger.explanation | 这条通知触发了本轮回复。 | This notification triggered this response. |
| message.turnUsage.title / consumed | 本轮用量 / 用量 {total} | Turn usage / Usage {total} |
| message.turnUsage.input / cacheRead / cacheWrite / output / cacheHit | 未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 缓存命中 | Uncached input / Cached input / Cache write / Output / Cache hit |
| stats.counts / cacheHit / dialog.title / dialog.usageTitle | {turns} 轮 {steps} 步 / 缓存命中 {percent}% / 会话统计 / Token 用量 | {turns} turns {steps} steps / Cache hit {percent}% / Session statistics / Token usage |
| stats.dialog.llmTime / toolTime / ttft / speed | 模型用时 / 工具调用用时 / 首 token 平均（TTFT） / 输出速度（TPS） | LLM time / Tool time / Avg time to first token (TTFT) / Tokens per second (TPS) |
| clock.md / clock.ymd | {m}月{d}日 / {y}年{m}月{d}日 | {m}/{d} / {y}-{m}-{d} |
| view.chat / view.trajectory | 对话 / 轨迹 | Chat / Trajectory |

### 13.3 工具行（命名空间 `conversation`）

| key | zh | en |
|---|---|---|
| tool.title.generic / bash / read / readImage / write / edit | 工具调用 / 运行命令 / 读取 / 读取图片 / 写入 / 编辑 | Tool call / Bash / Read / Read image / Write / Edit |
| tool.title.grep / glob / webSearch / webFetch / code | 搜索文件内容 / 查找文件 / 网页搜索 / 网页获取 / 代码 | Grep / Glob / Search / Fetch / Code |
| tool.title.subagent / listJobs / readJob / killJob | 创建子智能体 / 查看后台任务 / 读取任务输出 / 取消后台任务 | Create subagent / List background jobs / Read job output / Cancel background job |
| row.preparing / running / failed / stopped | 正在准备调用 / 运行中 / 失败 / 已停止 | Preparing tool call / Running / Failed / Stopped |
| row.input / output / inspect | 输入 / 输出 / 查看 | IN / OUT / Inspect |
| terminal.exitCode / signal / noExitCode / noOutput | 退出码 {code} / 信号 {signal} / 未正常退出 / 无输出 | exit code {code} / signal {signal} / no exit code / No output |
| terminal.expandRest / read.window | … 其余 {n} 行 / 显示 {shown} / {total} 行 | … {n} more lines / Showing {shown} of {total} lines |
| search.matches / paths / noResults | {shown} 处匹配 · {files} 个文件 / {shown} 个路径 / 无结果 | {shown} matches · {files} files / {shown} paths / No results |
| web.sourcesTruncated / contentTruncated | 来源列表已截断 / 内容已截断 | Source list truncated / Content truncated |
| todo.rowTitle / todo.completed | 更新任务清单 / {done}/{total} 已完成 | Update to-do list / {done}/{total} completed |
| ask.rowTitle / waiting / pending / reopen / review | 提问 / 等待回答 / 已继续工作，仍可回答 / 回答 / 查看回答 | Ask question / waiting / continued; answer still available / Answer / View answers |
| tool.autoReviewRejected / autoReviewNotExecuted | Auto review 已拒绝 / 工具未执行。原因：{reason} | Rejected by Auto review / Tool was not executed. Reason: {reason} |

### 13.4 审批 / 提问 / 反馈 / 命令 / 引用

| key | zh | en |
|---|---|---|
| approval: waiting / escalation / reject / allowOnce | 等待审批 / 工具 {toolName} 请求越权执行 / 拒绝 / 允许一次 | Waiting for approval / Tool {toolName} requests privileged execution / Reject / Allow once |
| questions: wait.takeTime / countdown / paused / held / continued | 慢慢回答 / {seconds} 秒后继续工作 / 已暂停 · 剩余 {seconds} 秒 / 会一直等你回答 / 已继续工作，仍可回答 | Take time / Continuing in {seconds}s / Paused · {seconds}s remaining / Waiting until you answer / Work continued — you can still answer |
| questions: error.incomplete / unavailable / resubmit | 请先完成这道问题。 / 当前无法提交，请稍候再试。 / 回答未送达，工作已继续，请再提交一次。 | Please complete this question first. / Cannot submit right now; try again in a moment. / The answer did not arrive before work continued; submit it again. |
| questions: option.recommended / custom.placeholder / action.skip / action.next | 推荐 / 输入你的答案 / 跳过 / 下一题 | Recommended / Type your answer / Skip / Next |
| questions: nav.cancel / nav.close | 放弃整组问题 / 收起问题面板，可从工具调用重新打开 | Dismiss all questions / Close the panel — reopen it from the tool call |
| questions: plan.header / approve / discuss | 计划待审 / 同意执行 / 要求修改 | Plan review / Approve / Request changes |
| questions: reply.label | 回答先前等待中的问题 | Reply to earlier pending questions |
| feedback: action.like / dislike / dialog.title | 好的回答 / 有问题的回答 / 提交反馈 | Good response / Bad response / Submit feedback |
| feedback: category.* | 任务结果 / 指令理解与遵循 / 产品功能与交互 / 稳定性和速度 / 资源使用与费用 / 安全隐私与权限 / 其他 | Task result / Instruction understanding and following / Product features and interaction / Stability and speed / Resource usage and cost / Security, privacy, and permissions / Other |
| feedback: toast.recorded / error.generic | 感谢你的反馈 / 反馈保存失败 | Thanks for your feedback / Could not save feedback |
| commands: section.add / section.commands | 添加 / 指令 | Add / Commands |
| commands: label.goal / plan / feedback / compact / permission / export | 目标 / 计划 / 反馈 / 压缩 / 权限 / 下载日志 | Goal / Plan / Feedback / Compact / Permission / Export |
| commands: description.goal / plan / compact / permission / export | 设置或查看长期任务目标 / 进入或退出计划模式 / 压缩以上对话内容 / 切换权限预设（沙箱模式与审批策略） / 将当前会话内容导出为 ZIP | Set or view the goal for a long-running task / Enter or leave plan mode / Compact older conversation history / Switch the permission preset (sandbox mode + approval policy) / Download this Session log as a ZIP archive |
| commands: status.loading / applying / empty | 正在加载选项… / 正在应用… / 无选项 | Loading options… / Applying… / No options |
| slash.menu: command / skill / subagent / loading / drill.hint | 指令 / 技能 / 子智能体 / 正在加载… / 进入目录 | Commands / Skills / Subagents / Loading… / Browse folder |
| reference: section.files / subagents / sessions / crumb.root / candidate.noCwd | 文件与文件夹 / 子智能体 / 对话 / 工作区 / （无工作目录） | Files & folders / Subagents / Sessions / Workspace / (no cwd) |

### 13.5 选择器

| key | zh | en |
|---|---|---|
| model: trigger.fallback / trigger.loading | 请选择模型 / 正在加载模型… | Select model / Loading models… |
| model: menu.model / menu.effort / effort.providerDefault | 模型 / 推理等级 / Default | Model / Effort / Default |
| model: provider.account / status.loading | DeepSeek 账号 / 正在刷新模型列表… | DeepSeek Account / Refreshing model list… |
| model: search.placeholder / search.empty / empty.models / empty.efforts | 搜索模型… / 没有匹配的模型。 / 暂无可用模型 / 当前模型未提供推理等级。 | Search models… / No matching models. / No models available. / This model provides no reasoning effort levels. |
| model: error.action / warning.groupLoad | 模型操作失败：{message} / {name} 加载失败：{message} | Model operation failed: {message} / {name} failed to load: {message} |
| permission: mode | 访问模式，当前：{name} | Access mode, current: {name} |
| permission: preset.readOnly / workspaceWrite / fullAccess / auto.label | 仅可查看 / 工作区内修改 / 完全权限 / 自动审查 | Read Only / Workspace Write / Full access / Auto review |
| permission: confirm.title / acknowledge / enable | 确认启用完全权限？ / 我已了解风险，并愿意继续 / 启用完全权限 | Enable Full access? / I understand the risks and want to continue / Enable Full access |
| permission: confirm.description | 启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。 | Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task. |
| permission: auto.confirm.title / enable | 确认启用自动审查（实验）？ / 启用自动审查 | Enable Auto review (experimental)? / Enable Auto review |
| agentPreset: seatHint / headerHint / switchRefused | 选择新任务使用的 Agent 预设 / 本任务的 Agent 预设，在任务开始时确定 / 无法切换到「{name}」：{reason} | Choose the agent preset for your new task / The agent preset chosen when this task started / Could not switch to {name}: {reason} |
| agentPreset: presetStandardName / Ptc / Minimal / Cordis | 标准模式 / PTC 模式 / 极简模式 / 创造模式 | Standard mode / PTC mode / Minimal mode / Creator mode |
| plan: chip.label / chip.exitFailed / preview.full | 计划 / 退出计划模式失败 / 查看全文 | Plan / Failed to exit plan mode / View full plan |
| goal: phase.active / paused / blocked | 进行中的目标 / 已暂停的目标 / 受阻的目标 | Ongoing Goal / Paused Goal / Blocked Goal |
| goal: action.pause / resume / edit / clear | 暂停目标 / 恢复目标 / 编辑目标 / 清除目标 | Pause goal / Resume goal / Edit goal / Clear goal |
| voice: dictate / stop / recording / transcribingShort / empty | 听写 / 停止并识别 / 正在录音… / 识别中… / 未识别到语音 | Dictate / Stop and transcribe / Recording… / Transcribing… / No speech recognized |
| cot: translation / original / failed | 查看译文 / 查看原文 / 翻译暂不可用，已显示原文 | View translation / View original / Translation failed. Showing the original. |

---

## 14. RPC 汇总（会话体验用到的）

> 线协议 endpoint（`rpc-methods.json` 中的 `endpoint`）。返回统一为 `{ok:true, value} | {ok:false, error:{code, message, details?}}`；部分功能在 value 内再嵌一层业务结果。

| Endpoint | 模式 | 用途（ID） | 参数 → 结果 |
|---|---|---|---|
| `session/prompt` | unary | 发送（C-94） | `{requestId, sessionId, mode:'queue'|'steer', content: PromptContentPart[], clientTimeZone?}` → `{accepted:true}` |
| `session/updateQueue` | unary | 队列编辑/删除/插话（C-95） | `{sessionId, itemId, action:{kind:'edit',content:TextBlock[]}|{kind:'remove'}|{kind:'steer'}}` → `{accepted:true}` |
| `session/cancel` | unary | 停止（C-96） | `{sessionId}` → `{accepted:true}` |
| `session/page` | unary | 加载更早 / loadThrough（C-11/C-14） | `{address, throughSeq, beforeSeq?, maxMessages?, turnWindow?{minMessages,minTurns}}` → `{records, hasMore}` |
| `session/follow` | stream | 实时事件 + 助手流（全局） | `{address, maxMessages?, turnWindow?, assistantStream?:true}` → 快照帧 / 事件 / assistant stream `start|chunk|end` |
| `session/projections` | unary | 投影基线 | `{sessionId}` → `{kind:'sequenced', asOfSeq, values}` |
| `session/attachment` | unary | 读图片（C-26） | `{sessionId, attachmentId}` → `{attachment: ImageAttachmentRef, data(base64)}` |
| `session/fork` | unary | 分支（C-36） | `{sessionId, atSeq?, allowMigration?}` → `{sessionId}` |
| `session/rename` | unary | 重命名（header） | `{sessionId, title}` → `{title, seq}` |
| `session/modelCatalog` | unary | 模型目录（C-107） | — → `ModelCatalog` |
| `session/selectModel` | unary | 选模型（C-107） | `{sessionId, provider, model, reasoningEffort?}` → `{selected}` |
| `commands/list` | unary | `/` 目录（C-99） | `(sessionId)` → `CommandDescriptor[]` |
| `commands/execute` | unary | 执行命令（C-100、`/plan off`、`/permission x`） | `(sessionId, line, attachments[])` → `CommandExecution | undefined` |
| `fileReferences/list` | unary | `@` 文件（C-102） | `(sessionId, query)` → `[{path, kind}]` |
| `sessionReferenceResolver/candidates` | unary | `@` 会话（C-102） | `(sessionId, query)` → `SessionReferenceMentionCandidate[]` |
| `skills/list` | unary | 技能（C-131） | `({sessionId})` → `{skills[]}` |
| `fileUploads/upload` | unary | 文件上传（C-105，备选） | `(sessionId, {data: base64, name?})` → `{receiptId, file}`（主路径为 HTTP `POST /api/session/uploadFileBinary`） |
| `userQuestions/attachWait` | stream | 提问倒计时（C-115） | `(sessionId, callId)` → 帧 `{remainingMs}` |
| `userQuestions/answer` | unary | continued 后回答（C-115） | `(sessionId, callId, answer)` → boolean |
| `messageFeedback/list|put|delete` | unary | 👍/👎（C-129） | 见 C-129 |
| `sessionFeedback/record` | unary | 会话反馈（C-129） | `({sessionId, text?, category?})` → `{recorded:true}` |
| `goals/get|edit|pause|resume|clear` | unary | 目标条（C-121） | `(sessionId[, ref{id,revision}][, {objective}])` |
| `job/list` / `job/follow` | stream | 后台任务（C-126） | 见 C-126 |
| `job/kill` | unary | 停止任务 | `({sessionId, jobId})` → `{outcome}` |
| `agentPresets/list|read|select` | unary | 预设（C-111） | 见 C-111 |
| `permissionPresets/catalog` | unary | 权限目录（C-110） | — → `PermissionCatalog` |
| `settings/update` / `settings/mutate` | unary | 默认预设 / 默认权限（C-147/137） | `(ns, patch|ops, expectedRevision?)` |
| `subagents/prompt` / `subagents/interruptByParent` | unary | 可继续子智能体发送/停止（C-124） | 由会话层代发 |
| `cotTranslation/limits|translate` | unary | 思维链翻译（C-138） | 见 C-138 |
| `speech/follow` | stream | 语音目录（C-139） | → `SpeechCatalog` 快照 |
| `speech/transcribe|configure|prepare|cancelPreparation` | unary | 语音（C-139） | 见 C-139 |
| HTTP `api/changes.summary|diff|open`、`api/present.open|host` | HTTP | 改动/交付（C-127/109） | 见 C-127/109 |

**Host→Client 远程事件**：waterfall `approval/request`、`user-questions/request`；emit `commands/change`、`agent-preset/selected`、`api-session/status(sessionId, running)`、`goal/activation-changed`、`permission-presets/catalog-changed`、`llm/adapters-updated`、`settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated`、`plugin-manager/changed`、`deepseek-account/session-expired`、`deepseek-account/model-sign-in-required`；本地 `connection/reset`（清缓存重读）。

**常见错误码**（`session/*`）：`session/writer-held`、`session/attachment-invalid {reason}`、`session/queue-item-not-found`、`session/steer-unavailable`、`session/fork-unavailable`、`session/migration-required`、`session/model-unavailable`、`session/provider-credentials-unavailable`、`session/agent-busy`、`agent-preset/locked|not-found|invalid`、`subagent/attachment-invalid`。

---

## 15. Session 事件类型汇总（消费方）

| 事件 | 消费 / 产出 |
|---|---|
| `turn/start`、`turn/end`（`reason.kind`: `error{error{code,message}}`、`aborted{reason{kind:'hook'}}`、`interrupted`、`max-tokens`、`forked`…） | 位置边界、整轮折叠、turn 尾、错误/截断节点、配额提示（仅实时） |
| `step/start`、`step/end` | 助手步、用量推导 |
| `user/message`（surfaceOp `append`；`source.kind`: `user`(+`rpcId`) / `compact-checkpoint` / `user-question-reply` / 其他注入） | 用户 / 插话 / context / 触发通知 / 压缩 / 迟到回复 |
| `developer/message` | context（工具增减等） |
| `system/message`、`request/header` | 系统提示（Chat 隐藏，Trajectory 显示） |
| `assistant/live-chunk`（瞬态） | 流式文本/推理/工具参数 |
| `assistant/message`、`assistant/attempt` | 助手完成、用量 |
| `tool/call`、`tool/result`、`tool/ptc-dispatch-start`、`tool/ptc-dispatch` | 工具卡、子调用树、改动/交付统计 |
| `llm/retry`、`llm/retry-started` | 重试条 |
| `command/run`、`command/done` | 命令卡、`/goal` 气泡、手动压缩 |
| `compaction/start|summary|end` | 压缩卡 |
| `agent/inbox/spliced`（`target 'next-step'|'next-turn'`） | 插话/触发分类 |
| `tool-workflow/run-start|agent-start|agent-end|run-end` | 工作流节点 |
| `deliverables/presented`、`workspace/changes` | 交付卡、改动卡 |
| `todo/write`（经 todo_write） | Todo diff 基线 |
| `session/end-seed` | Trajectory |
| 仅日志：`model/selection`、`agent-preset/selected`、`approval/asked|decided`、`feedback/*`、`permission/preset`、`sandbox/mode`、`approval/policy` | 投影来源，UI 不直接渲染 |

---

## 16. Slot 清单（官方包注册的内容 → 原生必须覆盖）

| Slot | 内容（来源包） |
|---|---|
| `conversation.view` | `chat`（ui-chat，order 0）、`trajectory`（ui-trajectory，order 10） |
| `conversation.composer`（chain） | 默认 composer bar；ApprovalPanel（approval）；QuestionComposer / PlanReview（user-questions）；子智能体只读 composer（subagent，priority -10） |
| `conversation.input.dock` | `todo`(0)、`goal`(10)、`queue`(20) |
| `conversation.input.overlay` | `slash-menu`(0)、`command-popup`(1)、`feedback-dialog`(2) |
| `conversation.input.attachments` | ComposerAttachments（attachment） |
| `conversation.input.permission` / `.plan` / `.model` / `.activity` | 权限选择 / 计划 chip / 模型选择（+ 子 slot `conversation.input.model.label`：1017 徽标）/ 语音输入 |
| `conversation.composer.dock` | `activity`(0)、`usage`(1) 统计胶囊 |
| `conversation.session.header.*` | actions：agent-team(-20)、agent-preset(-10)、subagent-catalog(10)、job-list(20)；lineage（subagent） |
| `conversation.hero.*` | workspace picker、agentPreset、options、brand.mark |
| `conversation.chat.node`（keyed by kind） | `user`、`steering`、`context`、`turn-trigger`、`system-prompt`、`assistant-step`、`command`、`manual-compaction`、`compaction`、`model-retry`、`turn-error`、`turn-max-tokens`、`turn-process`、`turn-tail`、`unknown`（chat）；`tool-call`（tool）；`command-input`（goal）；`workflow-run`（workflow-run）；`question-reply`（user-questions） |
| `tool.call.toolview`（keyed by toolName） | `bash`、`read`、`read_image`、`edit`、`write`、`grep`、`glob`、`web_search`、`web_fetch`、`todo_write`、`ask_user_question`、DetailsRow 系列、`skill`、`present`、`cordis_*`；fallback GenericToolCard |
| `conversation.chat.turnTail` | 计划卡（plan）、交付/改动（deliverables）、定时任务（schedule） |
| `conversation.chat.assistant-actions` | feedback(10)、cordis-runner |
| `conversation.chat.reasoning.body` | 默认（chat，priority 100）/ 翻译（cot-translation） |
| `conversation.user.text.node`（keyed） | `text`、`session`、`secret`、`file`、`folder`、`skill`、`command` |
| `conversation.approval.detail` | ApprovalCommand（chat） |
| `conversation.plan-review.actions` | 查看全文（plan） |
| 图片：`conversation.chat.message.images`、`conversation.chat.user.images`、`conversation.trajectory.images`、`tool.call.images`、factory `conversation.images.content` | MessageImages（attachment） |
| `settings.general.item` | composer-enter(20)、transcript-view(12)、link-opening(17)、performance-usage(30)、permission(-20) |
| `shell.quota-notice` | 配额提示（settings-account） |

---

## 17. Projection 汇总

| 键 | 形状 | 用于 |
|---|---|---|
| `inbox` | `{'next-step': Item[], 'next-turn': Item[]}`，Item `{id, content[], source{kind, rpcId?, callId?}}` | 插话气泡、队列 dock、迟到回复 |
| `modelSelection` | `{lastUsed, next}`（`ModelSelection {provider, model, reasoningEffort?}`） | 模型选择 |
| `plan` | `{active, pending}` | 计划 chip、placeholder |
| `goal` | `GoalProjection | null` | 目标条、`hint.goal.active` |
| `todos` | `[{content, status}]` | Todo dock |
| `agentPreset` | `string | null` | header 标签 |
| `permissions` | `{currentValue}` | 权限选择 |
| `contextPressure` / `contextBreakdown` | 见 C-122 | 上下文环 |
| `imageLimits` | `ImageAttachmentLimits` | 附件预检 |
| `turnOutline` | `[{turn, seq, prompt, response}]` | 轮次跳转 |
| `sessionStats` / `tokenUsage` | 见 C-42 | 统计胶囊 |
| `userQuestions` | `{active, settled}` | 提问卡、工具行状态 |
| `subagentCatalog` / `subagentTiming` / `subagent` | 见 C-123 | 子智能体目录 |
| `agentTeam` | `TeamProjection` | 智能体团队 |
| `sessionListMetadata` | `{blank, lastPromptAt}` | 外壳相位 |

---

## 18. 桌面 → iPhone 布局映射总表

| 桌面模式 | 出现处 | iPhone 原生替代 |
|---|---|---|
| hover 才显示的操作（消息操作、Inspect、diff 着色、文件卡 ✕） | C-19/39/57/66/109x | 最新回复常显精简操作；其他统一 `.contextMenu`；触屏常显 |
| hover 预览 / tooltip | C-14/109/101s | 长按 `.contextMenu(menuItems:preview:)`；`accessibilityLabel` |
| 锚定弹出菜单 / popover（模型、权限、统计、上下文、header 面板） | C-107/73p/41/42/112/101s/104j/122 | 短列表 `Menu`；两级/可搜索/长列表 `.sheet` + `NavigationStack` + `presentationDetents` |
| 右侧栏（文件预览、计划、改动 Review、子会话、浏览器） | C-23/108/109/114/101s | `NavigationStack` push（iPad 用 `NavigationSplitView` detail）；网页 `SFSafariViewController` |
| 视图标签行 + More + pin | C-07 | `Picker(.segmented)` / `Menu` |
| 轮次导航条（>900px） | C-14 | 工具栏「跳转到轮次」sheet |
| 物理键盘快捷键（Enter、Cmd+Enter、Esc Esc、↑↓/Tab 菜单、审批 Enter/Esc） | C-88/89/96/101 | 软键盘回车换行、按钮发送、长按 Send 选模式、Stop 按钮；外接键盘用 `keyboardShortcut`/`UIKeyCommand` |
| 浮动候选菜单 | C-98 | 键盘上方停靠的候选列表面板 |
| 拖放 / 粘贴文件 / 文件夹路径桥 | C-104 | PhotosPicker、相机、fileImporter、粘贴图片；iPad 拖放；文件夹不支持 |
| 内容宽度拖拽、macOS 拖拽条 | C-08 | 省略 |
| 两段式点击确认（停止后台任务） | C-126 | `swipeActions(role:.destructive)` + `confirmationDialog` |
| 原生打开 / 在 Finder 中显示 | C-127 | `ShareLink` / 导出到「文件」/ QuickLook |
| 风险确认模态（勾选知情） | C-110/104x | 小 sheet + `Toggle` 解锁确认按钮 |
| 鲸鱼 APNG、流光文字 | C-16/29/57 | 动画图标 + gradient mask shimmer，尊重 reduce motion |

---

## 19. 原生重写的主要难点（排序）

1. **事件投影引擎**（C-21/27–34/54–55）：节点 Definition、seq 偏移排序、process group 切分、整轮折叠、流式 live-chunk 与 settle 的对账、PTC 子调用配对——须移植成纯 Swift reducer，且要对历史分页 prepend 稳定。
2. **富文本 Composer**（C-90–93）：原子引用 chip、开头命令 chip 两步删除、TextRef 装饰、IME、撤销边界、草稿语义快照（offset 校验）、乐观发送与失败恢复——`UITextView` 需大量自定义。
3. **Queue / Steer 语义**（C-94–95）：`pendingSubmissions` 与 `inbox` 合并、rpcId 认领、本地 echo 生命周期（`onRetire observed/failed`）、全部插话。
4. **接管卡片状态机**（C-113–99）：waterfall 应答、倒计时（焦点暂停、慢慢回答、超时后 `continued` 改走 `userQuestions/answer`）、草稿持久化、计划审阅分支。
5. **流式 Markdown + 滚动锚定**（C-11/12/21）：流式渲染性能、LazyVStack 中 prepend 不跳动、跟随阈值。
6. **工具卡模型**（C-60–79）：每种工具的 meta 校验与回退、退出码尾标解析、diff/read/search 内折叠、todo diff 基线依赖已加载历史。
7. **附件**（C-104–109x）：HEIC 转换与按 `imageLimits` 缩放、后台上传进度、receipt 只对单会话有效。
8. **语音输入**（C-139）：AVAudioSession 生命周期、16k PCM16 WAV、草稿冲突插入。
