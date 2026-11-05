# DSH Web 客户端 ↔ 引擎：传输与数据协议

> 适用版本：引擎已升级到 `@deepseek-ai/dsh@0.2.2-rc.1`（Host 发布标识 `{"version":"0.2.2-rc.1","commit":"c59d10a"}`）。**正文与附录 A 仍是 `0.2.1-rc.4`（`commit: ec17a2c`）的快照**：两版的方法表差异已逐条导出比对，见 §0.1；其余描述还没有重新复核。
> 来源：`engine/node_modules/@deepseek-ai/*` 的未压缩 JS / `.d.ts` / README（MIT），以及 2026-11-03 在 Mac 上实跑引擎（`DSH_IOS_PORT=3095`，无模型 Key）抓到的真实报文。
> 本文目标：只看这一份文档就能写出与官方 Web 前端行为一致的 Swift 客户端。
> 配套文件：[`rpc-methods.json`](rpc-methods.json)：`0.2.1-rc.4` 全部 144 个 Remote 方法的机器可读描述，含 wire 参数名、JSON Schema、结果 Schema、是否 stream，可直接拿来做 Swift Codable 代码生成。`0.2.2-rc.1` 共 193 个方法，这份文件还没有重新导出，差异见 §0.1。
>
> 示例里的 `<DATA>` 代表引擎数据目录，`<T>` / `<C>` 分别代表 launch token 和 cookie 值，均已脱敏。

## 0. 一页结论

| 项 | 事实 |
|---|---|
| 认证 | `GET /?token=<launch token>` 返回 **303** 和 `Set-Cookie: dsh-auth-<sha256(authority)>=v1.<payload>.<sig>`（HttpOnly，SameSite=Strict，30 天）。之后所有 `/api/*` 请求和 WebSocket 都只认这个 cookie，不接受 `Authorization` 头。 |
| 一元 RPC | `POST /api/<ns>/<method>`，`Content-Type: application/json`，请求体 `{type:'client-request', rpcId, method, payload:{args:{<wire名>:值}}}`。业务失败同样返回 HTTP 200，响应 `result.ok=false`。 |
| 推送 | **WebSocket `ws://host/api/remote.mux`**，一条物理连接复用多条逻辑流。不是 SSE，也不是长轮询。消息是 JSON 文本帧：上行 `open/item/end/cancel`，下行 `item/end/error`。 |
| 全局事件 | 在 mux 上打开逻辑流 `$events`（payload `{"args":{}}`）。第一帧是 `{type:'ready', clientId, host:{home}}`，之后是 `emit`（通知）、`waterfall`（需要客户端答复的审批或提问）和 `cancel`。客户端答复走 `POST /api/$events/result`。 |
| 会话实时 | `session/follow` stream：先给 `snapshot`（窗口内的历史和投影），再推每条持久事件 `{type:'event', event}`，以及进程内的助手流帧 `{type:'assistant-stream', frame}`，用于 token 级增量。 |
| 全局投影 | `session/control` stream：开头一份 `baseline`，之后是 `{type:'projection', sessionId, key, value, seq}`，覆盖所有会话的标题、todo、inbox、token 用量等。 |
| 工作区 | `workspace/follow` stream：开头 `baseline`，之后是 `upsert/remove/order/archived/pinned/replace`。 |
| 方法目录 | 29 个包贡献 Remote 方法，**共 144 个**，其中 14 个是 stream。26 个包由 `dsh-api-remotes` 挂载，`remoteAccess`、`speech`、`cotTranslation` 由各自的客户端包挂载。全量表见附录 A 和 `rpc-methods.json`。（`0.2.2-rc.1`：34 个包、193 个方法、20 个 stream，差异见 §0.1。） |
| 二进制 | 结果里带字节的方法（如 `workspaceFiles/readBytes`）以 `multipart/form-data` 返回：`metadata` 部分是 JSON 信封，`bytes-N` 部分放字节。上传用专用路由 `POST /api/session/uploadFileBinary`（octet-stream）。 |
| 插件 UI | 插件的浏览器端是 JS 包（React 和 slot 系统，通过 `window.__ModuleLoader__` 加载），**原生端无法执行**。原生能拿到的只有数据：RPC 和事件、`tool/result.data.meta`（工具的 presentationMeta）、各类投影。 |

## 0.1 `0.2.2-rc.1` 相对 `0.2.1-rc.4` 的方法表变化

> 口径：两版各自安装后，从生成描述符导出方法表再比对（见 §12 第 9 条），并在 Mac 上实跑 `0.2.2-rc.1` 引擎（`DSH_IOS_PORT=3097`，带 `ios.patch.yml`）逐条验证过下面的请求形状。方法数 144 → 193，stream 14 → 20，贡献方法的包 29 → 34。

**删除的方法**（请求返回 404 `not found`，已实测）

| 删除 | 替代 |
|---|---|
| `schedule/delete` | `schedule/edit`：`{id, action:"delete", expectedUpdatedAt?}` |
| `schedule/update` | `schedule/edit`：`{id, action:"update", patch:{title?,prompt?,timing?,target?,active?}, expectedUpdatedAt?}`；`patch.timing` 就是旧 `change` 的形状（`kind` + snake_case 字段） |

**请求形状变化**

| 方法 | 变化 |
|---|---|
| `session/attachment` | `attachmentId: string` → `attachment: ImageAttachmentRef`（`{attachmentId, mediaType, bytes, width, height, name?, originalDimensions?}`，前五个必填）。日志里的图片块本来就带整个 ref，客户端把它原样回传即可 |
| `schedule/history` | 不再需要 `sessionId`（任务行自带绑定）：`{id, limit, before?}` |
| `session/follow` | 新增可选 `activate`：请求后台激活，省略仍是被动读 |
| `session/page` | `throughSeq` 变可选，省略表示取当前日志末尾 |

**结果与记录形状变化**

- `schedule/edit` 成功时**直接返回任务记录**，不再像旧 `schedule/update` 那样包一层 `{record}`；结果里的失败码只剩 `schedule_not_found` 和 `schedule_conflict`。
- 参数校验不再走结果码，而是**抛** `schedule/input-invalid`，原因在 `error.details.code`（`invalid_time_zone`、`not_future`、`frequency_too_high`、`invalid_prompt`、`invalid_rule`、`time_out_of_range` 等照旧；`schedule_ended` 已不存在）。另有 `schedule/target-archived`（投递目标会话已归档）。
- 任务记录（`schedule/catalog` / `list` / `view` / `edit`）：`sessionId` → `target`（`{kind:"session"|"new_once"|"new", sessionId?, create?}`）加 `involvedSessionIds`；`status` 从 `active|inactive` 变成 `active|paused|ended`；新增 `createdAt`、`updatedAt`（编辑的 compare-and-set 改用它）、`executionActive`、`deliveryFloorEndsAt`；新增 `rrule` 规则种类。
- compare-and-set 由「回传整条记录」变成「回传 `updatedAt`」。

**新增的 51 个方法**

| 包 | 方法 |
|---|---|
| `dsh-api-session-controller` | `session/events`、`session/state`、`session/wait`、`session/observeEvent`、`session/observeProjections`、`session/observeState`（快照与订阅拆成独立接口；`session/follow`、`session/control` 仍在） |
| `dsh-schedule` | `schedule/create`、`schedule/edit`、`schedule/view`、`schedule/run`、`schedule/deleteInactive`、`schedule/deliveryLimits` |
| `dsh-plugin-manager` | `pluginManager/listVersions`、`pluginManager/readBundleDetail`、`pluginManager/updateBundle` |
| `dsh-plugin-market` | `pluginMarket/readEntryDetail` |
| `dsh-action-cards` | `actionCards/act` |
| `dsh-client-ui-trajectory` | `toolResults/watch` |
| `dsh-plugin-recommendations` | `pluginRecommendations/describe`（实验：个性化推荐） |
| `dsh-experimental-client-ui-forge` | `forgePanel/*` 20 个（实验：变更请求与工作树） |
| `dsh-experimental-liveshare` | `liveshareShares/*` 12 个（实验：共享会话） |

**`$events` 转发白名单**（`dsh-api-remotes/lib/index.js` 的 `API_REMOTE_FORWARDED_EVENTS`）：28 → 30，没有删除、没有 mode 变化，新增 `llm/models-updated` 和 `plugin-manager/update-state`。

---

## 1. 认证、握手、可信 Host 规则

### 1.1 Launch token 换 cookie（浏览器路径，推荐原生也走这条）

1. 引擎每次启动（包括 iOS 上 Worker 重启）都会生成新的 launch token，并打印 `dsh web: http://127.0.0.1:<port>/?token=<T>`。iOS 宿主会把这个 URL 写进 `$DSH_IOS_DATA/web-url`（权限 0600）。
2. `GET /?token=<T>`（**只在路径 `/` 上生效**，而且只能带一个 token）返回：

```
HTTP/1.1 303 See Other
cache-control: no-store
location: ./
referrer-policy: no-referrer
set-cookie: dsh-auth-tlMc_dEBq7b7poXsTm9XG-An-JN4IOKRZOk8LzWTwNM=<C>; Max-Age=2592000; Path=/; Expires=Wed, 02 Dec 2026 23:04:04 GMT; HttpOnly; SameSite=Strict
```

   - cookie 名是 `dsh-auth-` 加上 `base64url(sha256(authority))`。HTTP 下 authority 是 `Host` 头的 `host:port`（如 `127.0.0.1:3095`）；TLS 下 authority 是 `https://host:port`。**cookie 与 authority 绑定**：用 `127.0.0.1:3095` 拿到的 cookie，换成 `localhost:3095` 去请求会得到 401（已实测）。
   - cookie 值是 `v1.<base64url(JSON{version:1,authority,issuedAt,expiresAt})>.<base64url(HMAC-SHA256)>`。签名密钥持久化在 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 记录里，所以 **cookie 跨引擎重启依然有效**（这一点按代码推断，未实测；30 天，可用 `cookieMaxAgeDays` 配置），launch token 则每次重启都会变。
   - 原生实现：用 `URLSession`，设 `redirect` 不跟随或者手动处理，从 303 响应里取 `Set-Cookie`，存进 Keychain，之后每个请求和 WS 握手手动带 `Cookie:` 头。也可以交给 `HTTPCookieStorage`，但要确认它对 `127.0.0.1` 的处理符合预期。
3. 不带 cookie 访问 `GET /`，返回 `401 text/plain "dsh web authentication required; reopen the URL printed by dsh web.\n"`。
4. 没有登出接口。删除凭据记录并重启引擎会吊销所有 cookie。

### 1.2 API Peer 路径（`/connect`，不推荐给原生 UI）

`GET /connect?token=<T>&interactions=answer|none`（默认 `none`）返回 `302 location: ./api/remote.mux`，同时下发一个 **v2 cookie**（与浏览器 cookie 同名，payload 里带 `id`）。区别如下：

- 每个 v2 cookie 只能对应**一条** WebSocket，第二条会得到 409（已实测）。socket 一关，这个 Peer 就被销毁，之后用同一个 cookie 发 HTTP 请求得到 401（已实测）。每次重连都要拿 launch token 重新走 `/connect`。
- `interactions=none` 的 Peer 不能打开 `$events`（返回 `gateway/interactions-forbidden`）。

结论：原生 App 应当走 1.1 的浏览器 cookie 路径，得到与网页完全相同的 owner、`interactions:'answer'` 身份。dsh-go（Dart 客户端）也是这么做的。

### 1.3 可信 Host / Origin 防护（先于认证执行）

`isTrustedApiRequest`（`dsh-client-connection/lib/index.js`）的规则：

- `Host` 头必须是 loopback（`localhost`、`127.x.x.x`、`[::1]`），或等于监听的 bind IP，或命中配置的 `trustedHosts`。否则返回 **403**。
- 如果带了 `Origin` 头，它必须与 Host 同 authority，否则 403（已实测：`Origin: http://evil.example` 返回 403）。
- `sec-fetch-site: cross-site` 返回 403。
- **不带 Origin 可以通过**（已实测：WS 握手和 POST 都不带 Origin 也成功）。原生客户端不要发 Origin，或者发与 Host 一致的值。
- 不需要任何 CSRF token 或自定义头。
- 判定顺序：先 403（不可信），再 401（未认证）。

### 1.4 页面注入的配置（原生可以直接用默认值）

`GET /`（带 cookie）返回的 HTML 里注入了这些全局变量（原生不需要解析 HTML，只是作为参考）：

```js
window["__DSH_CONNECTION_RECOVERY__"] = {"backoffBaseMs":500,"backoffFactor":2,"backoffMaxMs":10000,"generationReadyWarnMs":3000,"generationReadyTimeoutMs":15000}
window["__DSH_REMOTE_ACCESS__"] = {"type":"baseline","owner":true}
window["__DSH_MODELS_ONBOARDING__"] = {"credentialOnboarding":true}
window["__DSH_SHORTCUTS_CONFIG__"] = {"stopSequenceMs":500}
window["__DSH_DOCUMENT_PREVIEW_CONFIG__"] = {...}
window["__DSH_CONTACT_CONFIG__"] = {...}
window.__DSH_BOOT__ = { /* 客户端模块启动图，见 §7 */ }
```

### 1.5 服务器能力和插件列表从哪里来

- **Remote 方法集合在构建时就固定了**（`dsh-api-remotes` 显式 import 各个 `/remote` 生成物），客户端不在运行时发现 Host 有哪些方法。请求一个不存在的方法，HTTP 返回 404 `not found`（已实测）。所以原生客户端也应把方法表视为静态契约（按版本钉死，见 `rpc-methods.json`）。第三方插件可以额外挂自己的 Typert Remote（例如 `dsh-cost-meter` 的 `costMeter/*`，信封相同），或者注册专用 Fetch 路由（例如 `dsh-context` 的 `/api/dsh-context/*`，见 §6.3）。
- 运行时可查询的插件和能力：
  - `pluginInventory/list`：所有 loader entry（`entryId`、`moduleName`、`enabled`、`fiberPhase`、`meta.title/description` 的中英文）。
  - `pluginManager/listBundles`、`pluginManager/listPlugins`：bundle 和插件的安装、启用状态。
  - `GET /plugins/events`（SSE，`text/event-stream`）：先发 `: connected`，然后是 `data: {"type":"graph","graph":{rev, release:{version,commit}, entries:[{id,url,rev,inject,immediately}], batches}}`。插件启停时会再推 `graph`，开发重建时推 `{"type":"rebuilt",id,rev}`。`entries[].id` 就是当前启用、带浏览器端的插件包名。这是"Web 端插件列表"的权威来源，原生可以用它判断某个第三方插件（如 `dsh-cost-meter`）是否已启用。
  - `session/projections` 和 `session/control` 返回的投影键集合，本身就反映了当前组合里有哪些能力（例如有 `goal` 键说明 goal 插件在线）。

## 2. 一元 RPC（HTTP）

### 2.1 请求

```http
POST /api/session/create HTTP/1.1
Host: 127.0.0.1:3095
Cookie: dsh-auth-…=<C>
Content-Type: application/json

{"type":"client-request","rpcId":"7d0c…uuid","method":"session/create","payload":{"args":{"request":{"workspaceId":"8cae5d8f-ebb4-4e28-ab82-a5b5648f7beb"}}}}
```

规则（`rpcFetchHandler` 和 `TypertGateway.dispatchRpc`）：

- URL 路径 `/api/<endpoint>` 必须与 `method` 相同，否则返回 `gateway/bad-request`："method \"session/search\" does not match endpoint \"session/list\""。
- `rpcId` 是任意字符串，网页用 UUIDv4。响应会原样带回，客户端要校验。
- `payload` 必须**恰好**是 `{args:{…}}`，`args` 的键必须**恰好**等于该方法描述符里的 wire 参数名集合（可选参数可以省略），多一个或少一个都会失败：

```json
{"type":"server-response","rpcId":"rpc-3","result":{"ok":false,"error":{"code":"gateway/arguments-invalid","message":"typert gateway: session/list: args fields do not match the descriptor: missing \"_request\"; unexpected \"request\"","details":{"endpoint":"session/list"}}}}
```

- **wire 名的坑**：参数名不一定叫 `request`。`session/list` 是 `_request`；Agent 作用域的方法用 `agentId`（值就是 sessionId）；`workspaceFiles/*` 用 `workspaceFileScopeId`（值也是 sessionId）；`settings/*` 用 `ns`、`ops`、`expectedRevision`。一律以 `rpc-methods.json` 里的 `args[].wire` 为准。
- 参数值会按生成的 Zod schema 严格校验，失败返回 `gateway/input-invalid`。对象里多出未声明的字段会被丢弃，不会报错。
- `lookup` 类参数（`agentId`、`workspaceFileScopeId`）在 Host 端解析成活的 Agent 或作用域，**可能触发冷会话的恢复**（resume）。

### 2.2 响应

```json
{"type":"server-response","rpcId":"…","result":{"ok":true,"value":{"sessionId":"session-26be6b14-…","agentPreset":"standard"}}}
{"type":"server-response","rpcId":"…","result":{"ok":false,"error":{"code":"session/not-found","message":"…","details":{"sessionId":"…"}}}}
```

- 返回值为 `void` 的方法：`result` 里**没有** `value` 键。Swift 端要把缺失解码成 `nil`。
- `error` 一定有 `code`、`message`、`details`（object）三个字段。
- HTTP 状态码：业务成功和失败都是 **200**；未知 endpoint 返回 404 `not found`（纯文本）；Content-Type 不对返回 415；body 不是 JSON 返回 400；超过 `maxRequestBodyBytes`（默认 300 MiB）返回 413；handler 抛出非 RemoteError 异常返回 500 `handler failure: …`（纯文本）；401 `unauthorized`；403 `forbidden`。
- **multipart 二进制结果**：`Content-Type: multipart/form-data; boundary=…`。实测 `workspaceFiles/readBytes`：

```
--B
Content-Disposition: form-data; name="bytes-0"; filename="blob"
Content-Type: application/octet-stream

hi there
--B
Content-Disposition: form-data; name="metadata"

{"type":"server-response","rpcId":"r1","result":{"ok":true,"value":{"absolutePath":"<DATA>/…/hello.txt","version":"…","bytes":8,"offset":0,"data":null,"eof":true}},"attachments":[{"path":["data"],"codec":"bytes","part":"bytes-0"}]}
--B--
```

  客户端按 `attachments[].path`（字符串键或数组下标）找到 `value` 里对应的 `null` 占位，用对应 part 的字节替换。只有 `ok:true` 时才会出现 multipart。

### 2.3 取消

一元调用没有协议级的取消消息。客户端取消就是中断 HTTP 请求：Host 端 `request.signal` 会 abort，声明了 `cancellation` 的方法（`rpc-methods.json` 里 `cancellable:true`）会收到这个信号。已经在执行、没有声明取消的方法会继续跑完。

### 2.4 错误码

- Gateway 层（`gateway/*`）：`arguments-invalid`、`input-invalid`、`bad-request`、`internal`、`cancelled`、`interactions-forbidden`、`peer-disposed`、`invocation-unavailable`、`method-unavailable`、`service-unavailable`、`definition-unavailable`、`lookup-not-found`、`lookup-unavailable`、`lookup-failed`、`context-not-found`、`context-unavailable`、`context-failed`、`result-invalid`、`uplink-overflow`、`protocol`、`binding-invalid`、`signature-invalid`、`provider-mismatch`、`ambiguous-endpoint`、`src`。
- 会话层（`RemoteErrorDetailsMap`，`dsh-api-session-controller/lib/types/types.d.ts`）：`session/not-found {sessionId}`、`session/conflict {sessionId, requestedCwd, existingCwd?}`、`session/agent-busy {reason}`、`session/writer-held`、`session/provider-credentials-unavailable`、`session/provider-models-unavailable {provider}`、`session/model-unavailable {provider, model}`、`session/invalid-time-zone {value}`、`session/attachment-invalid {reason}`、`session/queue-item-not-found {itemId}`、`session/steer-unavailable {itemId}`、`session/title-invalid`、`session/fork-unavailable`、`session/migration-required`、`session/projections-unavailable`、`session/workspace-attach-failed`、`agent-preset/conflict`、`subagent/not-found`、`subagent/catalog-diagnostic`、`remote-access/denied {action, reason}`。
- 网页对 carrier 失败（网络断开）的处理是把它折叠成 `{ok:false, error}`，`gateway/cancelled` 表示调用方主动取消。

## 3. 推送：WebSocket mux（`/api/remote.mux`）

### 3.1 物理连接

- `GET ws://127.0.0.1:<port>/api/remote.mux`，带 `Cookie`，Origin 可选（规则同 §1.3）。不带 cookie 返回 HTTP 401，Origin 不对返回 403（已实测）。
- 引擎要等应用启动完成（`appReady`）才注册 WS 升级路由。所以引擎刚启动时连接失败是正常的，应按重连策略重试。
- **只用文本帧**，每帧一个 JSON 对象。发二进制帧会被以 `1003` 关闭。
- 心跳：Host 每 `websocketHeartbeatIntervalMs` 毫秒（默认 **2000ms**）发一次 Ping。如果连续两个周期没有任何活动（Pong、收到任意帧、或者有一次写完成），Host 会 terminate 连接。`URLSessionWebSocketTask` 会自动回 Pong，**但 App 进入后台后大约 4 秒连接就会被 Host 掐断**，回到前台必须重连。
- 关闭码：`1001 peer left`（Peer 被释放）、`1003 text messages required`、`1008 invalid Remote stream request`（上行帧不合法，或重复 `open` 同一个 streamId）、`1011`（错误帧无法送达）。网页主动重连时自己用 `4000 "reconnect requested"`，遇到非法下行帧用 `4002`。

### 3.2 逻辑流帧格式（`dsh-api-gateway/lib/types/stream-protocol.js`，键集合严格匹配）

上行（客户端发给 Host）：

```json
{"type":"open","streamId":"<uuid>","endpoint":"session/follow","payload":{"args":{…}}}
{"type":"item","streamId":"<uuid>","value":<json>}      // 上行数据项（比如 terminal/attach 的输入）；value 可以省略，表示 undefined
{"type":"end","streamId":"<uuid>"}                       // 上行半关闭
{"type":"cancel","streamId":"<uuid>"}                    // 取消这条流
```

下行（Host 发给客户端）：

```json
{"type":"item","streamId":"<uuid>","value":<json>}
{"type":"end","streamId":"<uuid>"}
{"type":"error","streamId":"<uuid>","error":{"code":"…","message":"…","details":{}}}
```

- `streamId` 由客户端生成（UUID）。`open.payload` 的规则与一元 RPC 相同（`{args:{…}}`，严格 wire 名）。参数错误不会导致连接被关，而是返回该流的 `error` 帧（已实测）：

```json
{"type":"error","streamId":"s-bad","error":{"code":"gateway/arguments-invalid","message":"typert gateway: session/follow: args fields do not match the descriptor: missing \"request\"","details":{"endpoint":"session/follow"}}}
```

- `end` 和 `error` 是终止帧。客户端主动结束时发 `cancel`，网页只在还没收到终止帧时才发。对已经结束的流发 `item/end/cancel`，Host 会静默丢弃。
- 上行缓冲上限 `streamInboxBytes`（默认 262144 字节），超出后该流以 `gateway/uplink-overflow` 失败。在 `end` 之后再发 `item` 会得到 `gateway/protocol`。
- 一元方法**不能**通过 mux 打开，会返回 `gateway/signature-invalid "unary Remote methods cannot be opened through the stream carrier"`。反过来，用 HTTP POST 调用 stream 方法，也会得到 `gateway/signature-invalid "stream Remote methods must be opened through the stream carrier"`。

### 3.3 `$events`：全局转发事件

打开：`{"type":"open","streamId":"s-events","endpoint":"$events","payload":{"args":{}}}`（`args` 必须是空对象）。

第一项一定是 ready：

```json
{"type":"item","streamId":"s-events","value":{"type":"ready","clientId":"c5f65096-e196-425e-9d05-c9fc144a590f","host":{"home":"<DATA>/home"}}}
```

`clientId` 标识这一代事件流，答复 waterfall 时要带上；`host.home` 只用来把展示路径缩写成 `~`。

之后的 `value` 有三种：

```ts
{ type: 'emit', event: string, args: JsonValue[] }                       // 单向通知，断线期间的不会重放
{ type: 'waterfall', event: string, eventId: string, agentId: string,    // 需要答复；agentId = sessionId
  request: Record<string, JsonValue> }
{ type: 'cancel', eventId: string }                                       // Host 撤回一个待答复的 waterfall
```

实测的 emit 帧：

```json
{"type":"emit","event":"api-session/status","args":["session-26be6b14-…",true]}
{"type":"emit","event":"api-session/activity","args":["session-26be6b14-…",1793660647722]}
{"type":"emit","event":"api-session/error","args":["session-26be6b14-…","llm-deepseek: no API key for provider route \"deepseek-official\"; …"]}
{"type":"emit","event":"api-session/added","args":[{"sessionId":"…","updatedAt":1793660647032,"agentAvailable":true,"formatStatus":"current","running":false,"blank":true,"cwd":"<DATA>/…/default-workspace","projections":{"kind":"sequenced","asOfSeq":2,"values":{…}}}]}
```

**转发事件白名单**（`dsh-api-remotes/lib/types/remote-events.js`，共 28 个）：

| 事件 | 模式 | args |
|---|---|---|
| `api-session/added` | emit | `[SessionSummary]`（会话出现，或其 Agent 被创建、销毁；按 sessionId upsert） |
| `api-session/removed` | emit | `[sessionId]` |
| `api-session/status` | emit | `[sessionId, running:boolean]` |
| `api-session/activity` | emit | `[sessionId, updatedAt:number]`（用户消息推进了列表排序） |
| `api-session/error` | emit | `[sessionId, message:string]`（不在持久回合里的失败） |
| `agent-preset/selected` | emit | 预设切换 |
| `approval/request` | **waterfall** | `request: {toolName, callId?, reason?, displayReason?:{en, zh?…}}`，答复值：`'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'` |
| `user-questions/request` | **waterfall** | `request: {questions: AskUserQuestionItem[], wait?:{callId, timed?}}`，答复值：`{answers:[{id, selected:string[], custom?}]}` |
| `commands/change` | emit | 命令表变化，重新调用 `commands/list` |
| `credentials/record-updated`、`credentials/reference-updated` | emit | 凭据变化，重新调用 `credentials/describe` |
| `deepseek-account/session-expired`、`deepseek-account/model-sign-in-required` | emit | 账号状态 |
| `goal/activation-changed` | emit | goal 开关 |
| `llm/adapters-updated` | emit | 无参数，模型适配器变化，重新调用 `session/modelCatalog` |
| `permission-presets/catalog-changed` | emit | 无参数，重新调用 `permissionPresets/catalog` |
| `plugin-manager/changed`、`plugin-manager/install-log`、`plugin-manager/install-state` | emit | 插件管理进度 |
| `plugin-market/changed` | emit | |
| `settings/document-updated` | emit | 配置文档变化 |
| `schedule/changed` | emit | 无参数，重新调用 `schedule/list` |
| `cordis/request-run`、`cordis/request-run-resolved`、`cordis/dynamic-package`、`cordis/dynamic-retract`、`cordis/inspect-query`、`cordis/inspect-query-resolved` | emit | 动态 cordis 插件（cordis 预设），原生可以忽略 |

`AskUserQuestionItem = {id, question, detail?, header?, options?:[{label, description?}], multiSelect?, intent?}`。

**答复 waterfall**：一元 RPC `POST /api/$events/result`（endpoint 字面量就是 `$events/result`，`$` 在路径里合法）：

```json
{"type":"client-request","rpcId":"…","method":"$events/result","payload":{"args":{
  "clientId":"c5f65096-…","eventId":"<eventId>",
  "outcome":{"kind":"result","value":"allowed-once"}}}}
```

`outcome` 有三种：`{"kind":"result","value":<json>}`、`{"kind":"next"}`（交给下一个 answerer）、`{"kind":"rejected","error":{"name","message","code?","details?"}}`。

> **关键约束**：只要原生客户端打开了 `$events`，它就是一个"活的答复方"（`hasLiveClient()` 返回 true）。Host 会把审批和提问转发给它，然后**一直等待**。所以客户端必须答复每一个 waterfall：不认识、不想处理的事件要立刻回 `{kind:'next'}`，否则工具调用会一直挂起，直到回合被取消。网页的做法是：对没有打开的会话（`ctx.sessions.scopeOf` 拿不到），直接调用 `next()`。
> 如果同时开着 WKWebView 网页版，它也会收到同样的 waterfall。

### 3.4 连接代（generation）与重连（与网页一致的做法）

`ConnectionController`（`dsh-client-connection/lib/client.browser.js`）的行为：

1. 打开 WS，在上面 `open $events`。**收到 `ready` 才算一代连接建立**。3 秒还没收到会告警，15 秒（`generationReadyTimeoutMs`）超时则放弃这次尝试。
2. 只有在 ready 之后，才开始读取基线：`workspace/follow`、`session/control`、`session/list`、已打开会话的 `session/follow`、各种查询。Host 保证 ready 时增量监听已经挂好，所以先 ready 再读基线不会漏事件。
3. 以下任一情况都视为这一代失效：`$events` 结束或报错、WS 断开、首帧不是 ready、收到非法帧。之后按指数退避重连：上限依次是 500ms、1s、2s、4s、8s、10s，之后保持 10s，实际延迟取上限的 50% 到 100%（随机抖动）。每次重试都**新建物理 WS** 并重新打开 `$events`。
4. 系统报告离线时暂停重连；恢复在线后从 500ms 档重新开始。手动重连则重置计数、立即重试。
5. 每建立一代新连接，网页会清空投影缓存和水位（watermark），重新打开 `session/control`（拿到新的 baseline）和 `workspace/follow`，重新读取 `session/list`，并重开所有 `session/follow`。**断线期间的 emit 通知不会重放**，状态一律通过新的 baseline 恢复。还没答复的 waterfall 会以**同一个 eventId** 重新下发。
6. 没有协议级的序号或续传游标。会话事件的连续性靠 `seq`（见 §4.3）。

### 3.5 全部 stream 方法（14 个）

`session/follow`、`session/control`、`workspace/follow`、`job/list`、`job/follow`、`account/watch`、`account/watchExpiry`、`remoteAccess/follow`、`terminal/attach`（有上行）、`terminal/retain`、`workspaceFiles/changes`、`userQuestions/attachWait`、`speech/follow`、`productAnalytics/watchPolicy`。完整签名见附录 A。

stream 的帧形状：

- `workspace/follow`：`{type:'baseline', value:{items:Workspace[], archivedSessionIds:string[], pinnedSessionIds:string[]}}`，之后是 `{type:'upsert', workspace}`、`{type:'remove', workspaceId}`、`{type:'order', workspaceIds}`、`{type:'archived', archivedSessionIds}`、`{type:'pinned', pinnedSessionIds}`、`{type:'replace', value}`。其中 `Workspace = {workspaceId, path, title, sessionIds:string[], createdAt:ISO, updatedAt:ISO}`。
- `session/control`：`{type:'baseline', value:{projections: {[sessionId]: {asOfSeq, values}}}}`，之后是 `{type:'projection', sessionId, key, value, seq}`。
- `job/list`（参数 `request:{sessionId}`）：每一帧都是**全量** `{type:'rows', jobs:[{id, kind, label, owner?, status, startedAt, …}]}`。打开时发一帧，之后每批生命周期变化合并后再发一帧，流不会自然结束。
- `job/follow`（参数 `request:{sessionId?, jobId, from?}`）：`{type:'opened', job, from}`，之后是 `{type:'output', chunks, next, lossy?}` 和 `{type:'status', job}`。
- `terminal/attach`：`{type:'snapshot', sequence, screen, info, writable, inputWindow}`，之后是 `{type:'output', sequence, data}`、`{type:'state', …}`、`{type:'ack', sequence, refusal?}`。上行用 `item` 帧发送输入。
- `userQuestions/attachWait`（参数 `agentId, callId`）：`{remainingMs}`。持有这条流就表示客户端在占用一个限时提问，关闭流即释放。
- `workspaceFiles/changes`：`{kind:'ready'}`，之后是 `{kind:'change', change}`。

## 4. 会话数据模型

### 4.1 打开一个会话的标准时序（网页 `SessionEventStream`）

```
open session/follow {request:{address:{kind:'session',sessionId}, assistantStream:true, maxMessages:500, turnWindow:{minMessages:50,minTurns:2}}}
  ← item {type:'snapshot', header, cursor, records[], hasMore, projections:{asOfSeq,values}, assistantStream:{revision, activeAttempt?}}
  ← item {type:'event', event:SessionWireEvent}               // 每一条新持久事件，seq 连续
  ← item {type:'assistant-stream', frame:…}                   // 进程内 token 增量（仅当 assistantStream:true）
需要向上翻页时：
POST session/page {request:{address, throughSeq:<snapshot.cursor 或之后的水位>, beforeSeq:<当前窗口最小 seq>, maxMessages:500, turnWindow:{minMessages:50,minTurns:2}}}
  → {records[], hasMore}
```

- 网页常量：`HISTORY_PAGE_OPTIONS = {maxMessages:500, turnWindow:{minMessages:50, minTurns:2}}`；跳转到指定回合时 `minMessages:200`。Host 端默认 `maxMessages=50`。
- `throughSeq` 必须小于等于 Host 当前游标，否则返回 `gateway/bad-request "session page through seq 100 is past cursor 18"`（已实测）。`beforeSeq` 是**开区间**（实现为 `end = min(throughSeq+1, beforeSeq)`）。
- `address` 也可以是子代理：`{kind:'subagent', parentSessionId, childSessionId, mode:'one-shot'|'continuable'|'unknown'}`（`mode` 来自父会话 `subagentCatalog` 投影里的条目）。
- 实测的 snapshot（新建会话）：

```json
{"type":"snapshot","header":{"version":4,"id":"session-26be6b14-…","createdAt":1793660647032,"cwd":"<DATA>/…/default-workspace","isSeeded":false,"agentPreset":"standard"},
 "cursor":2,
 "records":[{"type":"event","event":{"type":"permission/preset","seq":0,"time":1793660647040,"data":{"preset":"workspace-write"}}},
            {"type":"event","event":{"type":"sandbox/mode","seq":1,"time":1793660647044,"data":{"mode":"workspace-write"}}},
            {"type":"event","event":{"type":"approval/policy","seq":2,"time":1793660647045,"data":{"policy":"ask"}}}],
 "hasMore":false,
 "projections":{"asOfSeq":2,"values":{"title":null,"todos":null,"inbox":{"next-turn":[],"next-step":[]},…}},
 "assistantStream":{"revision":0}}
```

### 4.2 持久事件信封 `SessionWireEvent`

```ts
{ type: string; seq: number /* 从 0 开始、连续 */; time: number /* epoch ms */; data: JsonValue;
  ignorable?: true;          // 不认识的 type 只有带这个标记才可以跳过
  surfaceOp?: 'append' | {op:'replace', startSeq, endSeq};   // 仅 surface 事件有
  sourceEventSeqs?: number[] }
```

surface 事件（会进入模型可见历史）：`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`。其余都是仅记录日志的事件。`surfaceOp` 为 replace 表示压缩把 `[startSeq, endSeq]` 这段 surface 替换掉了（例如 `user/message` 的 `source.kind === 'compact-checkpoint'`）。

### 4.3 事件类型全集（`KNOWN_SESSION_EVENT_TYPES`，并按渲染关注度标注）

核心字段（`dsh-session/lib/types/types.d.ts`、`dsh-llm/lib/types/*.d.ts`）：

| type | data | 渲染建议 |
|---|---|---|
| `turn/start` | `{turn}` | 回合边界 |
| `turn/end` | `{turn, reason}`，`reason.kind` 取值：`completed`、`aborted {reason:{kind:'user'\|'parent'\|'hook'\|'disposed'\|'legacy'}}`、`blocked`、`error {error:LlmFailure}`、`max-tokens`、`interrupted`、`forked` | 结束状态；`error` 时显示错误卡片 |
| `step/start` / `step/end` | `{turn, step}` | 一个 step = 一次模型调用加上它请求的工具执行 |
| `user/message` | `UserMessage = {id, role:'user', content:ContentBlock[], source}` + `surfaceOp` | 见 §4.5，按 `source.kind` 分类 |
| `system/message` | `{turn, step, message:{role:'system', content, source:{kind:'system-prompt'}}}` | 网页折叠显示为"系统提示词"卡片 |
| `developer/message` | `{turn, step, message:{role:'developer', content:[{type:'tool-addition',toolName}\|{type:'tool-removal',toolName}]}, headerSeq?}` | 工具增减，作为上下文行 |
| `assistant/message` | `{turn, step, message:{id, role:'assistant', content:ContentBlock[], source:{kind:'model', provider, model, replayState?}}, stream:AssistantStreamRecord[], usage?:TokenUsage, interrupted?:true}` | **最终的助手消息**（含 text、reasoning、tool-call 块） |
| `assistant/attempt` | `{turn, step, stream:AssistantStreamRecord[]}` | 没有提交成消息的尝试（失败、重试、取消）。实测无 Key 时：`stream:[{type:'chunk', chunk:{type:'finish', reason:{kind:'error', failure:{message, code:'MISSING_CREDENTIAL'}}}}]` |
| `tool/call` | `{turn, step, callId, name, arguments:string /* 模型原始 JSON 字符串，未解析 */}` | 工具卡片开始 |
| `tool/result` | `{turn, step, message:{id, role:'tool', toolCallId, isError?, content:ContentBlock[], source:{kind:'tool', callId}}, error?:{name, code, reason?}, meta?:JsonValue}` + `surfaceOp` | 用 `message.toolCallId` 或 `source.callId` 关联到 `tool/call.callId`；`meta` 即工具的 presentationMeta（§7.3） |
| `tool/ptc-dispatch-start` / `tool/ptc-dispatch` | `{rootCallId, parentCallId, subCallId, name, arguments}`，后者另含 `{isError, content, meta?, error?}` | PTC（`run_code`）里嵌套的子工具调用，挂在 `parentCallId` 下 |
| `request/header` | `{header:{config:{provider, model, maxTokens, reasoningEffort…}, adapterDefaults?, tools?:ToolSchema[]}, reason:'initial'\|'resume'\|'change'\|'series', startsSeries?}` | 隐藏（可能很大，实测约 28KB） |
| `request/context` | `{provider, model, contextWindow?, systemPromptUpdate?}` | 隐藏 |
| `llm/retry` | `{retryId, turn, step, provider, mode:'normal'\|'always', policyKey, retry, maxRetries?, delayMs, failure:LlmFailure}` | "第 N 次重试，延迟 X 毫秒" |
| `llm/retry-started` | `{retryId, turn, step, retry}` | |
| `compaction/start` | `{compactionId, sourceCommandId?, turn:number\|null}` | 压缩开始 |
| `compaction/summary` | `{compactionId, summary:ContentBlock[], shadowedRange:{start,end}, shadowedSeqs, shadowedTokenCount, provider, model, usage?, rawOutput?, llmStreamCall?}` | 压缩摘要卡片 |
| `compaction/end` | `{compactionId, turn, error?}` | |
| `compaction/prune` | `{shadowedRange, shadowedSeqs, shadowedTokenCount}` | |
| `image/offload` | `{targets:[…]}` | 隐藏 |
| `session/title` | `{title, messageSeqs:number[], source:{kind:'fallback'\|'user'\|…}}` | 实测：首条消息先产生 `fallback` 标题，改名时产生 `{kind:'user'}` |
| `session/title-llm-request` | 标题请求审计 | 隐藏 |
| `agent/inbox/spliced` | `{target:'next-turn'\|'next-step', start, removedCount?, inserted:UserMessage[], outcome?:'canceled'}` | 输入队列变化（发送、排队、steer） |
| `command/run` / `command/done` | `{commandId, name, args?, source}` / `{commandId, kind:'success'\|'error', text?, sourceEventSeq?}` | 斜杠命令执行 |
| `job/registered` / `job/settled` | `{jobId, owner, kind, label, startedAt, toolCall?}`，后者另含 `{finishedAt, status, cause, producerReported, detail?}` | 后台任务 |
| `todo/write` | `{todos:[{content, status:'pending'\|'in_progress'\|'completed'}]}` | todo 面板（也可以直接读 `todos` 投影） |
| `deliverables/presented` | `{turn, callId, files:[{path, description?}]}` | 交付文件卡片（`present` 工具） |
| `goal/change`、`plan/mode {active}`、`schedule/change`、`model/selection {provider,model,reasoningEffort?}`、`permission/preset {preset}`、`sandbox/mode {mode, source?}`、`approval/policy {policy, source?}`、`approval/asked {id, toolName, callId?, reason?}`、`approval/decided {id, outcome}`、`agent-preset/selected {agentPreset}`、`working-directory/change {cwd}`、`workspace/changes {turn}` | 状态和审计 | 多数通过投影展示；`workspace/changes` 的详情走 `/api/changes.summary`（§6） |
| `subagent/catalog`、`subagent/descriptor`、`subagent/model-selection-policy` | 子代理目录 | 读 `subagentCatalog` 投影更省事 |
| `tool-workflow/run-start|agent-start|agent-end|run-end` | workflow 工具 | |
| `hook/invoked`、`hook/result`、`feedback/*`、`team/*`、`session-log-deepseek/delivery-accepted`、`session/end-seed`、`web/deepseek-search-llm-request` | 审计和实验性事件 | 隐藏 |
| `plugin:<name>` | 第三方插件记录 | 隐藏 |

`ContentBlock`（按 `type` 区分，可扩展）：`{type:'text', text}`、`{type:'reasoning', text}`、`{type:'image', attachment:{attachmentId, mediaType, bytes, width, height, name?, originalDimensions?}, offloaded?}`、`{type:'file', attachment:{attachmentId, name, bytes}}`、`{type:'tool-call', id, name, arguments}`、`{type:'tool-addition', toolName}`、`{type:'tool-removal', toolName}`。

`TokenUsage = {inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?}`（各项互不重叠，`inputTokens` 只计未命中缓存的输入）。`LlmFailure = {message, code, status?, providerRetryAfterMs?, requestId?, offloadImages?}`。

### 4.4 助手增量流（token 级）

`session/follow` 必须传 `assistantStream:true` 才会收到。帧（`SessionAssistantStreamFrame`）：

```ts
{type:'start', attemptId, revision, startedAfterSeq, turn, step}
{type:'chunk', attemptId, revision, index /* 0,1,2… 连续 */, time, chunk: StreamChunk}
{type:'end',   attemptId, revision, index /* chunk 总数 */,
               outcome: {kind:'committed', eventType:'assistant/message'|'assistant/attempt', seq} | {kind:'abandoned'}}
```

`StreamChunk`：`{type:'block-start', index, blockType}`、`{type:'text-delta', index, text}`、`{type:'reasoning-delta', index, text}`、`{type:'tool-call-delta', index, id, name?, argumentsDelta}`、`{type:'block-end', index, block:ContentBlock}`、`{type:'usage', usage}`、`{type:'finish', reason:{kind:'stop'|'tool-calls'|'max-tokens'|'aborted'|'error', failure?}, replayState?}`。其中 `index` 是**内容块下标**，不同于帧的 `index`。

实测（无 Key 时只有一个 finish chunk）：

```json
{"type":"assistant-stream","frame":{"type":"start","attemptId":"session-26be6b14-…:1","revision":1,"turn":1,"step":1,"startedAfterSeq":12}}
{"type":"assistant-stream","frame":{"type":"chunk","attemptId":"session-26be6b14-…:1","revision":2,"index":0,"time":1793660647742,"chunk":{"type":"finish","reason":{"kind":"error","failure":{"message":"…","code":"MISSING_CREDENTIAL"}}}}}
{"type":"event","event":{"type":"assistant/attempt","seq":15,…}}
{"type":"assistant-stream","frame":{"type":"end","attemptId":"session-26be6b14-…:1","revision":3,"index":1,"outcome":{"kind":"committed","eventType":"assistant/attempt","seq":15}}}
{"type":"event","event":{"type":"step/end","seq":16,…}}
{"type":"event","event":{"type":"turn/end","seq":17,"data":{"turn":1,"reason":{"kind":"error","error":{…,"code":"MISSING_CREDENTIAL"}}}}}
```

网页的合并规则（`ClientAssistantStream`，原生照做即可）：

1. `revision` 在一条 follow 连接内对每个 assistant-stream 帧严格 +1，起点是 snapshot 里的 `assistantStream.revision`。出现跳号就**重开 follow**（rebaseline）。
2. `start`：开始一个活动 attempt，`nextIndex=0`。如果已有活动 attempt 或待处理的结算，重开 follow。
3. `chunk`：`index` 必须等于 `nextIndex`，否则重开 follow；然后按 chunk 累积成临时的文本、推理、工具调用参数。
4. 持久的 `assistant/message` 或 `assistant/attempt`（seq 大于 `startedAfterSeq`，且 turn、step 匹配）在 `end` 到达之前**先暂存不显示**。`end.outcome.seq` 与之对上后，再用持久事件替换临时内容。对于成功的 `assistant/message`（非 interrupted），网页让临时行保留到同一 step 的 `step/end` 才撤掉，以免工具卡片闪烁。失败、中断的 attempt 立刻撤掉临时行。`abandoned` 表示没有持久事件，直接撤掉临时行。
5. 重连后 snapshot 里的 `assistantStream.activeAttempt = {attemptId, startedAfterSeq, turn, step, nextIndex, stream:AssistantStreamRecord[]}`。用 `stream` 展开出已经收到的 chunk（见下），再从 `nextIndex` 继续接收。

`AssistantStreamRecord`（压缩格式，`assistant/message.stream`、`assistant/attempt.stream` 和 `activeAttempt.stream` 都用它）：

```ts
{type:'text-chunks',      time0, index /* 块下标 */, dt:number[], texts:string[]}       // 第 i 段的时间 = time0 + dt 的前 i 项之和
{type:'reasoning-chunks', time0, index, dt:number[], texts:string[]}
{type:'tool-call-chunks', time0, index, dt:number[], id, name?, args:string[]}
{type:'chunk', time, chunk: StreamChunk}                                                 // 其余 chunk 原样保存
```

渲染最终消息时直接用 `assistant/message.data.message.content`，不需要回放 stream。stream 只在需要精确的时间信息，或者展示失败 attempt 的部分输出时才用。

### 4.5 用户消息分类与输入队列

`user/message.data.source.kind` 的取值：

- `'user'`：**真人输入**。由 `session/prompt` 写入时带 `rpcId`（等于客户端生成的 `requestId`）和 `clientTimeZone`；非 owner 调用时还会带 `principal`。原生端用 `rpcId` 把乐观显示的气泡与持久消息对上。
- 其他取值都是**注入的上下文**，网页渲染为可折叠的"上下文"行，不显示成用户气泡：`runtime-context`（每个 step 的运行时快照，`form:'snapshot'`）、`time-context`、`agent-instructions`（AGENTS.md）、`model-selection`、`compact-checkpoint`（压缩检查点，surfaceOp 为 replace）、`team-message`、skill 注入、goal 续轮等。可能带 `form`：`instructions`、`catalog`、`snapshot {sections}`、`notice {summary}`、`relay`、`recall`。

实测一个回合里，第一个 step 依次出现 `system/message`(seq7)、`user/message{source:{kind:'user',rpcId:'req-1'}}`(seq8)、`user/message{source:{kind:'runtime-context'…}}`(seq9)、`user/message{source:{kind:'time-context',form:'snapshot'}}`(seq10)、`request/header`(seq11)、`request/context`(seq12)。

输入队列：`inbox` 投影 `{'next-turn': UserMessage[], 'next-step': UserMessage[]}`，加上 `agent/inbox/spliced` 事件。`session/prompt` 的 `mode:'queue'` 进入 next-turn；`mode:'steer'` 进入 next-step，即插入当前回合的下一个 step。消息被认领时会产生一条 `removedCount:1` 的 splice 事件，之后以 `user/message` 的形式出现。网页用 `next-step` 里 `source.kind==='user'` 的条目显示"steering"气泡。队列操作用 `session/updateQueue {request:{sessionId, itemId:<message id>, action:{kind:'edit', content:[{type:'text',text}]}|{kind:'remove'}|{kind:'steer'}}}`。

### 4.6 投影（projections）

`SessionProjectionValues`：键是可选的，缺失表示当前组合没有该能力。实测完整的值：

```json
{"title":"hello","goal":null,
 "tokenUsage":{"uncachedInputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},
 "contextPressure":{"contextWindow":1048576},            // {pressureTokens?, projectedTokens?, contextWindow?}
 "contextBreakdown":{"systemTokens":1406,"toolsTokens":6902,"messageTokens":324},
 "inbox":{"next-turn":[],"next-step":[]},
 "sessionStats":{"turns":1,"steps":1,"llmMs":0,"toolMs":0,"ttftMs":0,"ttftSteps":0,"decodeMs":0,"decodeTokens":0},
 "turnOutline":[{"turn":1,"seq":4,"prompt":"hello","response":""}],
 "agentPreset":"standard",
 "userQuestions":{"active":[],"settled":[]},              // active: [{callId, questions, state:'open'|'continued'}]
 "permissions":{"currentValue":"workspace-write"},
 "workingDirectory":"<DATA>/…/default-workspace",
 "subagentCatalog":[],                                    // [{id, createdAt, mode:'one-shot'|'external'|'continuable'|'unknown', label?}]
 "subagentTiming":{"settledMs":0},
 "subagent":null,                                         // 子会话自身的身份 {mode, label?, seq}
 "todos":null,                                            // TodoItem[] | null
 "plan":{"active":false,"pending":false},
 "modelSelection":{"lastUsed":{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"high"},"next":{…}},
 "sessionListMetadata":{"blank":false,"lastPromptAt":1793660647722},
 "imageLimits":{"maxImageBytes":20971520,"maxImagesPerMessage":20,"maxMessageImageBytes":209715200,"maxImagePixels":64000000,"maxImageDimension":8192,"mediaTypes":["image/png","image/jpeg","image/webp","image/gif"]}}
```

可能还有：`agentTeam`（实验功能）。第三方插件也可以贡献任意 JSON 键。

三个来源、两种序号空间：

- `session/projections {request:{sessionId}}`：返回 `{kind:'sequenced', asOfSeq, values}`、`{kind:'migration-required', values}` 或 `null`（会话不存在）。不会激活 Agent。
- `session/follow` 的 snapshot 里的 `projections:{asOfSeq, values}`。
- `session/control` 的 `baseline` 和 `projection` 帧（`seq` 是该值对应的持久事件水位）。
- `session/list` 每行的 `projections:{kind:'cached'|'sequenced', asOfSeq, values}`：`cached` 是从持久缓存读出的提示值，其 `asOfSeq` **不能**与 live 序号比较。

合并规则：同一连接代内，`sequenced` 的值按 `seq/asOfSeq` 取大者；`cached` 只用来填补空缺。每建立一代新连接，清空投影缓存，用新的 baseline 重建。

### 4.7 会话列表

`session/list {_request:{cursor?}}` 返回 `{items: SessionSummary[]}`：

```ts
SessionSummary = { sessionId, updatedAt, running, blank, agentAvailable, formatStatus?: 'current'|'migration-required',
                   parentSessionId?, origin?: 'subagent', cwd?, projections?: {kind, asOfSeq, values} }
```

`api-session/added`（upsert）、`api-session/removed`、`api-session/status`、`api-session/activity` 用于增量维护列表。标题从 `projections.values.title` 读取。工作区分组、置顶、归档来自 `workspace/follow`（`Workspace.sessionIds` 给出手动排序）。

### 4.8 发送消息时序（实测）

```
POST session/prompt {request:{requestId:'req-1', sessionId, mode:'queue', content:[{type:'text',text:'hello'}], clientTimeZone:'Asia/Shanghai'}}
  → {accepted:true}
follow ← agent/inbox/spliced{target:'next-turn',start:0,inserted:[{…source:{kind:'user',rpcId:'req-1',clientTimeZone}}]} (seq3)
$events ← emit api-session/status [sid, true]
follow ← turn/start{turn:1} (seq4) → agent/inbox/spliced{removedCount:1} (seq5) → step/start (seq6)
       → system/message (7) → user/message[user] (8) → user/message[runtime-context] (9) → user/message[time-context] (10)
       → request/header (11) → request/context (12)
follow ← assistant-stream start → session/title{source:{kind:'fallback'}} (13) → session/title-llm-request (14)
       → assistant-stream chunk… → assistant/attempt 或 assistant/message (15) → assistant-stream end
       →（有工具调用时：tool/call → tool/result …，然后进入下一个 step）
       → step/end (16) → turn/end (17)
$events ← emit api-session/status [sid, false]
control ← 期间每个投影变化各推一帧 projection（inbox、turnOutline、title、tokenUsage…）
```

prompt 的 `content` 元素：`{type:'text', text}`、`{type:'image', mediaType:'image/png'|'image/jpeg'|'image/webp'|'image/gif', data:<base64>, name?}`、`{type:'file', receiptId}`。`receiptId` 来自先调用的 `POST /api/session/uploadFileBinary` 或 `fileUploads/upload`。至少要有一段非空白文本或一个附件。用同一个 `requestId` 重试是幂等的。

取消回合：`session/cancel {request:{sessionId}}`。重命名：`session/rename {request:{sessionId, title}}` 返回 `{title, seq}`。fork：`session/fork {request:{sessionId, atSeq?, allowMigration?}}`。切换模型：`session/selectModel {request:{sessionId, provider, model, reasoningEffort?}}`。模型目录：`session/modelCatalog` 返回 `{default, routableProviders, groups:[{id,name,models:[{id,name,description?,reasoning?:{efforts:[{id,name}],defaultEffort?}}]}], failures}`。

## 5. RPC 方法目录（按领域）

全量签名见附录 A（自动从生成的 Typert 描述符导出），机器可读版见 `rpc-methods.json`。下面列出原生 MVP 最常用的方法：

| 领域 | 方法 |
|---|---|
| 会话 | `session/create {request:{workspaceId?\|cwd?, sessionId?, agentPreset?}}` 返回 `{sessionId, agentPreset?}`；`session/list`、`session/search {request:{query}}` 返回 `{items:[{sessionId,snippet}], hasMore}`；`session/follow`(S)、`session/page`、`session/projections`、`session/control`(S)、`session/prompt`、`session/cancel`、`session/updateQueue`、`session/rename`、`session/fork`、`session/attachment {request:{sessionId, attachmentId}}` 返回 `{attachment, data:base64}`（显示用户消息里的图片）、`session/modelCatalog`、`session/selectModel`、`session/initializeDefaultModel`、`skills/list {request:{sessionId}}`、`fileReferences/list`（@ 文件补全） |
| 工作区 | `workspace/follow`(S)、`workspace/initializeDefault` 返回 `{workspace}`、`workspace/create`、`workspace/rename`、`workspace/delete`、`workspace/insertBefore`、`workspace/insertSessionBefore`、`workspace/pinSession`、`workspace/unpinSession`、`workspace/archiveSession`、`workspace/unarchiveSession`、`directoryPicker/list|pick|createDirectory` |
| 交互 | `userQuestions/answer {agentId, callId, answer}`（回答"已转为新回合"的问题）、`userQuestions/attachWait`(S)；审批和实时提问走 `$events` waterfall |
| 命令 | `commands/list {agentId}` 返回 `[{definitionId?, name, description, input?:{hint?, attachments?}}]`；`commands/execute {agentId, line, submittedAttachments?}` |
| 任务 | `job/list`(S)、`job/follow`(S)、`job/kill` |
| 文件 | `workspaceFiles/list|read|readBytes|stat|changes`（参数 `workspaceFileScopeId` 即 sessionId）、`fileUploads/upload {agentId, request:{data:base64, name?}}`、`officeToPdf/render` |
| 设置与凭据 | `settings/describe` 返回 `{writable, hasDocument, namespaces:[{ns, schema, …}]}`；`settings/update {ns, patch, expectedRevision?}`、`settings/mutate`、`settings/replace`；`credentials/describe {refs}`、`credentials/set {ref, value}`（**用于写入 API Key**）、`credentials/unset`；`llm/listProviders`、`llm/listConfigurableProviders`、`llm/discoverModels`；`permissionPresets/catalog`；`agentPresets/list|read|select` |
| 账号 | `account/getState|watch(S)|startSignIn|cancelSignIn|signOut|getBalance|getProfile|…` |
| 插件 | `pluginManager/listBundles|listPlugins|installBundle|waitForInstall|cancelInstall|removeBundle|setBundleEnabled|setPluginEnabled|inspect|registries|…`、`pluginMarket/search|listIndexes|setIndexes`、`pluginInventory/list`、`pluginRegistryProbe/fastest` |
| 其他 | `goals/*`、`schedule/*`、`messageFeedback/*`、`sessionFeedback/record`、`subagents/prompt|interruptByParent`、`terminal/*`、`speech/*`、`cotTranslation/*`、`dynamicCordisRunner/*`（cordis 预设专用，原生不需要）、`productAnalytics/*`（仅 Desktop）、`remoteAccess/follow`(S)、`sessionReferenceResolver/candidates` |

> 附录 A 的"web 使用方"一列是用 `ns.method` 字面量 grep 客户端 bundle 得到的，供参考。很多方法经 `dsh-api-*-controller/lib/client.js` 包装后调用，所以这一列为空并不代表网页不用。

## 6. 非 JSON-RPC 的 HTTP 路由（专用 Fetch 路由）

`/api/*` 下的路由与 RPC 一样需要 cookie，且只对 owner Peer 开放。`/plugins/*` 属于静态资源和 HMR，不需要认证。

### 6.1 官方

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/file?path=<绝对路径>` | GET/HEAD | 按绝对路径读取文件（Markdown 里的本地图片、交付文件预览），`Content-Type` 由扩展名推断，最大为 `maxImageBytes`。实测返回 200 `text/plain` |
| `/api/session/uploadFileBinary?sessionId=<id>&name=<文件名>` | POST，`Content-Type: application/octet-stream`，流式请求体 | 上传附件，返回 `{"ok":true,"value":{"receiptId":"fd46…","file":{"attachmentId":"sha256:4f85…","name":"a.txt","bytes":10}}}`（注意外层**没有** server-response 信封）。之后在 prompt 里用 `{type:'file', receiptId}` 引用 |
| `/api/session.export?sessionId=<id>&includeDescendants=true\|false` | GET/HEAD | 下载会话日志 ZIP（对应 `/export` 命令） |
| `/api/changes.summary?sessionId&seq` | GET | `workspace/changes` 事件对应的改动摘要 `{turn, files, total, added, deleted}` |
| `/api/changes.diff?sessionId&seq&index` | GET | 单个改动文件在回合开始和结束时的对比 |
| `/api/changes.open?sessionId&seq&index&action=open\|reveal` | GET/POST | 在 Host 桌面上打开文件（iOS 上不可用，返回 409） |
| `/api/present.host` | GET | `workspaceDesktop()`：Host 桌面能否打开文件 |
| `/api/present.open?sessionId&seq&index&action` | GET/POST | 打开 `deliverables/presented` 里声明的文件 |
| `/plugins/events` | GET（SSE） | 客户端模块图（§1.5） |
| `/plugins/??<pkg>/client.js&rev=…` | GET | 插件浏览器端 JS 包（原生用不上） |

### 6.2 你看到的"裸 `{sessionId}` POST"是什么

这不是官方协议，而是**第三方插件 `dsh-context` 注册的专用 Fetch 路由**（在网页插件里用 `fetch(\`api/dsh-context/…\`)` 调用）。请求体是普通 JSON，没有 client-request 信封：

- `POST /api/dsh-context/fleet` `{sessionId, full?:true}`
- `POST /api/dsh-context/detail` `{…}`
- `POST /api/dsh-context/commands` `{sessionId, beforeSeq, limit?}`
- `POST /api/dsh-context/attachment` `{sessionId, attachmentId}`
- `POST /api/dsh-context/skills` `{cwd?, sessionId?}`
- `POST /api/dsh-context/balance`、`/recom` `{}`、`/backfill`

### 6.3 其他第三方插件的接口形式（供参考）

- `dsh-cost-meter`：Typert Remote `costMeter/*`（`getState`、`getSessionCost`、`getTurnCost`、`getSessionListCosts`、`refreshBalance`…），信封与官方方法相同（`POST /api/costMeter/<m>`，`{args:{…}}`）。方法表没有进入 `rpc-methods.json`（不属于引擎包），需要时从插件的 `lib/typert.host.js` 导出。
- `dsh-genui`：`/api/dsh-genui/prompt`。
- `meow-memory`：`/meow-memory/*`（不在 `/api` 下，不受 Connection 认证保护）。

## 7. 插件如何扩展 Web UI，以及原生能做到什么

### 7.1 机制

- 插件包在 `package.json` 里声明 `dsh.client {platform:'web', external…}`，导出 `./client` 浏览器包（lazy-CJS 工厂，用 `window.__ModuleLoader__.load({id, factory})` 注册）。Host 把启用的条目组成启动图（`window.__DSH_BOOT__`，或 SSE `/plugins/events` 推送的 `graph`），以 combo URL 的形式提供。
- 浏览器端是 Cordis 上下文：通过 `ctx.remote.<ns>.<method>()` 调用 RPC，通过 `ctx.remote.$on(event)` 订阅转发事件。UI 用 React 组件注册到 slot（`slots.register/inject`，比如 `main` 全局面板、`rightbar.*`、`shell.bottom`、`shell.overlay`、设置页），会话渲染用 `ctx.uiConversation.events.register({kind, match, start, update, buildViewNode})`，即对事件做模式匹配后产出视图节点。
- 工具卡片：`dsh-client-ui-tool` 按工具名和 `tool/result.data.meta`（工具 `output.presentationMeta(args, value)` 的输出）渲染。Host 端 session-controller **不做任何 presenter 计算**，原样透传 `meta`。

### 7.2 原生能和不能支持的部分

| 能（只依赖数据） | 不能，或需要变通 |
|---|---|
| 所有 RPC、事件、投影；会话、工作区、设置、凭据、插件管理（安装、启停都是 RPC） | 执行插件的 `client.js`（React、slot、Cordis 浏览器运行时）。必须在原生里实现等价 UI，或者嵌一个 WKWebView "岛"来加载网页版的单个面板（但 slot 系统依赖整个 shell，单独嵌很难） |
| 官方工具卡片：按工具名和 `meta` 原生实现（见 7.3） | 第三方插件自定义的卡片和面板（cost-meter 面板、dsh-context 面板、genui 组件）。只能针对具体插件原生重写，或在原生里显示通用卡片 |
| 设置页可以按 `settings/describe` 返回的 schemastery JSON 生成通用表单 | `dynamicCordisRunner/getClientCode`（cordis 预设下模型现场写的插件前端代码）无法执行 |
| 通过 `GET /plugins/events` 或 `pluginInventory/list` 判断插件是否启用，据此显示或隐藏原生对应功能 | 插件新增的 Remote 方法无法运行时发现，只能按插件版本硬编码 |

### 7.3 `tool/result.data.meta`（presentationMeta）的已知形状，可以原生渲染

视图类型定义在 `dsh-tools/lib/types/presentation.d.ts`：`GenericResultView`、`TerminalResultView {output?, exitCode?, signal?}`、`DiffResultView {diffs:[{path, oldText|null, newText}]}`、`SearchResultView {shape:'matches', files:[{path, matches:[{lineNumber, line}]}], truncated, total} | {shape:'paths', paths, truncated, total}`、`ReadResultView {path, offset, lines:[{number, text}], totalLines, lang?}`、`WebResultView {kind:'search', sources:[{url, title?, snippet?, publishedAt?}], answer?, truncated} | {kind:'fetch', url, statusCode, truncated}`。

各工具实际写入 `meta` 的内容：

- `bash`：`{cwd}`。输出文本在 `message.content`（带 `[exit code: N]` 标记），命令在 `tool/call.arguments`（JSON：`{command, workdir?, …}`）。
- `read`：`{path, offset, lines:[{number, text}], totalLines, lang?}`
- `write`：`{operation, path, diffs:[{path, oldText, newText}]}`
- `edit` / `str_replace`：`{path, diffs:[…]}`
- `grep` / `glob`：search 视图（`meta` 上限 64 KiB）
- `web_search` / `web_fetch`：web 视图
- `todo_write`：读 `arguments` 或 `todos` 投影
- `ask_user_question`：读 `userQuestions` 投影和 `$events` waterfall
- `present`：`deliverables/presented` 事件
- 子代理工具：`subagentCatalog` 投影，用 `address:{kind:'subagent',…}` 打开子会话的 follow

`meta` 缺失或形状不认识时，回退为通用卡片：标题为工具名，参数显示 JSON，结果显示 `message.content` 里的文本。`message.isError` 和 `data.error.reason` 用来显示错误。

### 7.4 关于 "`dsh-ui` 代码块"

官方包（0.2.1-rc.4）里**找不到** `dsh-ui` 代码块约定。最接近的是第三方插件 `dsh-genui`：它在系统提示里让模型输出 ```` ```schemaJson ```` 代码块（OpenTiny GenUI schema），由网页插件实时渲染成表单、图表、按钮，提交结果回到对话。原生可以选择：(a) 当作普通代码块显示；(b) 只实现常用组件子集（form、chart、button group）；(c) 嵌 WKWebView 渲染。Markdown 本身（助手 `text` 块）以及 `![alt](<path>)`、`[label](<path>#L24)` 文件链接（`deliverables` 提示词约定，路径相对工作目录）都可以原生渲染：图片走 `/api/file?path=` 或 `workspaceFiles/readBytes`。

## 8. 对原生客户端的坑、阻碍与建议

1. **必须答复 waterfall**，否则审批和提问会一直挂起（§3.3）。MVP 可以先实现审批和提问 UI；对其余 waterfall，以及不在当前视图里的会话，一律回 `next`。
2. **后台断连**：Host 每 2 秒 ping 一次，4 秒没有活动就断开。iOS 挂起后连接必断（另外 iOS 上引擎本身也会被挂起）。回到前台要走完整的"新一代"流程：先 ready，再读 baseline，再重开 follow。
3. **严格 wire 名**：`_request`、`agentId`、`workspaceFileScopeId` 等。建议用 `rpc-methods.json` 生成 Swift 方法桩，不要手写。
4. **cookie 绑定 authority**：始终用同一个 host（建议 `127.0.0.1:<port>`）。端口变了需要重新换 cookie（引擎重启时如果端口不变、凭据记录还在，旧 cookie 仍然有效）。iOS 宿主需要把最新的 token 交给原生层（现在写在 `web-url` 文件里）。
5. **没有 SSE 或长轮询兜底**：唯一的推送通道是 WebSocket mux；`/plugins/events` SSE 只推模块图。
6. **`request/header`、`system/message` 很大**（实测分别约 28KB、6KB），历史窗口可能达到 MB 级。解码时要懒处理，或者先跳过不关心的类型。
7. **不认识的事件类型**：没有 `ignorable` 标记的未知类型，Host 的持久化读路径会拒绝。客户端渲染时直接忽略即可（网页有 `registerFallback`），但要保留其 `seq`，以维持序号连续性的判断。
8. **WKWebView 和原生并存**时，二者共享同一个 browser Peer，都会收到 waterfall，会出现竞争答复（先到先得）。
9. 本文的协议形状是从 0.2.1-rc.4 的生成描述符直接导出的，引擎升级后需要重新运行导出脚本生成 `rpc-methods.json`，再做差异比对。导出口径：遍历 `engine/node_modules/@deepseek-ai/*` 里 `exports["./typert"]` 指向的 `lib/typert.host.js`，取 `TYPERT.invocations`（`namespace`/`method`/`mode`/`parameters[].codec.jsonSchema`/`result`）。升到 `0.2.2-rc.1` 的比对结果见 §0.1；完整重新导出还差两件事：`source: "lookup"` 的参数 wire 名是 `<lookup 类型>Id`（不是形参名），以及结果 schema 为联合类型时描述符只给 zod 对象，要用 `z.toJSONSchema` 转一次。

---

## 附录 A：全部 Remote 方法（144 个，29 个包）

说明："模式"为 **stream** 的方法只能通过 mux 的 `open` 调用，其余用 `POST /api/<endpoint>`。args 一列是 `payload.args` 的键（wire 名）及其类型；`lookup agent` / `lookup workspaceFileScope` 的值都是 sessionId 字符串。类型是从 JSON Schema 自动压缩而来的，`…` 表示被截断，完整内容见 `rpc-methods.json`。

#### dsh-agent-preset-registry

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `agentPresets/list` | unary | — | { presets: { id: string; isDefault: boolean; name?: string; description?: string; broken?: string }[] } | Read the selection roster. | client-ui-agent-preset |
| `agentPresets/read` | unary | agentPreset: string | { agentPreset: string; content: string; name?: string; description?: string } | Read one declaration's child plugin list as YAML, for viewing only. | client-ui-agent-preset |
| `agentPresets/select` | unary | agentId: string (lookup agent)<br>agentPreset: string | string | Select a preset before a session starts its first turn. | client-ui-agent-preset |

#### dsh-api-account-controller

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `account/ackBonusNotified` | unary | accountId: string<br>orderId: string<br>client: { version: string; locale: string; timezoneOffsetSeconds: number } | boolean | Record one displayed bonus as notified for the account it belongs to. | client-ui-settings-account |
| `account/cancelSignIn` | unary | attemptId: string | { status: "signed-out"\|"credential-stored"; links: { usageUrl: string; topUpUrl: string }; attempt: null \| { id: string; phase: "initializing"\|"waiting-browser"\|"exchanging"\|"committing"\|"succeeded"\|"cancelled"\|"expired"\|"failed"; authorizeUrl?: string; expiresAt?: number; … } } | Cancel the named local attempt. | client-ui-settings-account |
| `account/getBalance` | unary | client: { version: string; locale: string; timezoneOffsetSeconds: number } | null \| { status: "ready"; value: { currency: "CNY"\|"USD"; balance: string }[]; bonusWallets: { currency: "CNY"\|"USD"; balance: string }[] } \| { status: "failed" } | Query Platform recharge-wallet balances. | client-ui-settings-account |
| `account/getProfile` | unary | client: { version: string; locale: string; timezoneOffsetSeconds: number } | null \| { status: "ready"; value: { id: null \| string; name: null \| string; contact: null \| string; avatarUrl?: null \| string } } \| { status: "failed" } | Query display-safe Platform profile data. | client-ui-settings-account |
| `account/getState` | unary | — | { status: "signed-out"\|"credential-stored"; links: { usageUrl: string; topUpUrl: string }; attempt: null \| { id: string; phase: "initializing"\|"waiting-browser"\|"exchanging"\|"committing"\|"succeeded"\|"cancelled"\|"expired"\|"failed"; authorizeUrl?: string; expiresAt?: number; … } } | Read the safe account projection. | — |
| `account/getUnnotifiedBonuses` | unary | client: { version: string; locale: string; timezoneOffsetSeconds: number } | null \| { accountId: string; bonuses: { title?: string; orderId: string; campaign?: any; amount?: any; currency?: any; grantedAt?: any; expiresAt: string; message: string }[] } | Query the granted bonuses Platform has not yet recorded as displayed. | client-ui-settings-account |
| `account/hasRunningAccountTasks` | unary | — | boolean | Inspect the latest logged request providers of running tasks, including tools and retries. | client-ui-settings-account |
| `account/signOut` | unary | client: { version: string; locale: string; timezoneOffsetSeconds: number } | { status: "signed-out"\|"credential-stored"; links: { usageUrl: string; topUpUrl: string }; attempt: null \| { id: string; phase: "initializing"\|"waiting-browser"\|"exchanging"\|"committing"\|"succeeded"\|"cancelled"\|"expired"\|"failed"; authorizeUrl?: string; expiresAt?: number; … } } | Remove the local account grant and revoke it through Platform in the background, without deleting API keys. | client-ui-settings-account |
| `account/startSignIn` | unary | client: { version: string; locale: string; timezoneOffsetSeconds: number }<br>callbackOrigin: string<br>loginSource: "web"\|"desktop" | { status: "signed-out"\|"credential-stored"; links: { usageUrl: string; topUpUrl: string }; attempt: null \| { id: string; phase: "initializing"\|"waiting-browser"\|"exchanging"\|"committing"\|"succeeded"\|"cancelled"\|"expired"\|"failed"; authorizeUrl?: string; expiresAt?: number; … } } | Begin browser sign-in. | client-ui-settings-account |
| `account/watch` | **stream** | — | { status: "signed-out"\|"credential-stored"; links: { usageUrl: string; topUpUrl: string }; attempt: null \| { id: string; phase: "initializing"\|"waiting-browser"\|"exchanging"\|"committing"\|"succeeded"\|"cancelled"\|"expired"\|"failed"; authorizeUrl?: string; expiresAt?: number; … } } | Stream the safe account projection. | client-ui-settings-account |
| `account/watchExpiry` | **stream** | — | "session-expired" | Subscribe to credential expiry without replaying prior notifications. | — |

#### dsh-api-job-controller

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `job/follow` | **stream** | request: { sessionId?: string; jobId: string; from?: number } | { type: "opened"; job: { id: string; kind: string; label: string; owner?: string; outputLimitBytes?: number; status: "failed"\|"running"\|"stopping"\|"completed"\|"killed"; progress?: string; detail?: string; startedAt: number; finishedAt?: number; output: { total: number; earliest: number; spillPaths?: string[] } }; … } \| … \| … | Stream one job's retained output from an absolute byte offset, then its terminal projection once settled and drained. | api-job-controller |
| `job/kill` | unary | request: { sessionId: string; jobId: string } | { outcome: "requested"\|"already-finished" } | Kill one background job on a human's behalf. | api-job-controller |
| `job/list` | **stream** | request: { sessionId: string } | { type: "rows"; jobs: { id: string; kind: string; label: string; owner?: string; outputLimitBytes?: number; status: "failed"\|"running"\|"stopping"\|"completed"\|"killed"; progress?: string; detail?: string; startedAt: number; finishedAt?: number; output: { total: number; earliest: number; spillPaths?: string[] } }[] } | Stream the jobs one session can see — its own plus every unowned job — as whole-set frames: one on open, then one after each coalesced burst of lifecycle commit | api-job-controller |

#### dsh-api-remote-access

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `remoteAccess/follow` | **stream** | — | { type: "baseline"; owner: true } \| { type: "baseline"; owner: false; grants: { resource: { kind: "global" } \| { kind: "session"; id: string } \| { kind: "workspace"; id: string }; actions: string[] }[] } \| … \| … | Stream the calling Peer's access snapshot: one baseline, then `upsert` and `remove` frames after each `invalidate()` and each policy registration or removal tha | api-remote-access |

#### dsh-api-session-controller

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `fileReferences/list` | unary | agentId: string (lookup agent)<br>query: string | { path: string; kind: "file"\|"directory" }[] | List file and directory candidates for one Agent's working directory. | client-ui-reference |
| `session/attachment` | unary | request: { sessionId: string; attachmentId: string } | { attachment: { attachmentId: string; mediaType: "image/png"\|"image/jpeg"\|"image/webp"\|"image/gif"; bytes: number; width: number; height: number; name?: string; originalDimensions?: { width: number; height: number } }; … } | Read one image proven reachable from the addressed Session log. | api-session-controller |
| `session/cancel` | unary | request: { sessionId: string } | { accepted: true } | Cancel one active Agent turn without dropping its pending inbox. | api-session-controller |
| `session/canOpenWorkspacePath` | unary | — | boolean | Report whether this deployment can hand a Session workspace path to a native desktop. | client-ui-open-in-app |
| `session/control` | **stream** | — | { type: "baseline"; value: { projections: Record<string, {…}> } } \| { type: "projection"; sessionId: string; key: string; value: any; seq: number } | Stream a complete live-control baseline followed by replacement frames. | api-session-controller |
| `session/create` | unary | request: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string } | { sessionId: string; agentPreset?: string } | Create one ordinary Session for a new conversation, reusing the named blank Session while it is reusable. | api-session-controller |
| `session/follow` | **stream** | request: { address: { kind: "session"; sessionId: string } \| { kind: "subagent"; parentSessionId: string; childSessionId: string; mode: "one-shot"\|"continuable"\|"unknown" }; … } | { type: "event"; event: { type: string; seq: number; time: number; data: any; ignorable?: true; sourceEventSeqs?: any; surfaceOp?: any } } \| { type: "snapshot"; header: { version: number; id: string; … }; … } \| … | Follow one Session log from its opening or resume cursor. | api-session-controller |
| `session/fork` | unary | request: { sessionId: string; atSeq?: number; allowMigration?: boolean } | { sessionId: string } | Fork one cold-readable exact event prefix into a new Session. | api-session-controller, client-ui-shortcuts, client-ui-workspace |
| `session/initializeDefaultModel` | unary | — | any | Select the first available account model after login when no provider API key is configured. | client-ui-settings-account |
| `session/list` | unary | _request: { cursor?: string } | { items: { agentAvailable: boolean; formatStatus?: "current"\|"migration-required"; sessionId: string; updatedAt: number; running: boolean; blank: boolean; parentSessionId?: string; origin?: "subagent"; cwd?: string; projections?: { kind: "cached"\|"sequenced"; asOfSeq: number; values: {…} } }[] } | Read all visible Session rows without resuming an Agent. | api-session-controller |
| `session/modelCatalog` | unary | — | { default: { provider: string; model: string; reasoningEffort?: string }; routableProviders: string[]; groups: { id: string; name: string; models: { id: string; name: string; description?: string; reasoning?: {…} }[] }[]; … } | Describe every currently routable model for Host-generation selectors. | client-ui-model-selection, client-ui-settings-models, client-ui-settings-subagent |
| `session/openWorkspacePath` | unary | request: { action?: "reveal"; application?: string; path: string } | { opened: true } | Verify one path through the composed filesystem and open it on the Host desktop. | client-ui-open-in-app |
| `session/page` | unary | request: { address: { kind: "session"; sessionId: string } \| { kind: "subagent"; parentSessionId: string; childSessionId: string; mode: "one-shot"\|"continuable"\|"unknown" }; … } | { records: { type: "event"; event: { type: string; seq: number; time: number; data: any; ignorable?: true; sourceEventSeqs?: any; surfaceOp?: any } }[]; … } | Read one cold-safe, message-aligned Session history page. | api-session-controller |
| `session/projections` | unary | request: { sessionId: string } | null \| { asOfSeq: number; values: { inbox?: { "next-turn": any[]; "next-step": any[] }; workingDirectory?: null \| string; agentPreset?: null \| string; title?: null \| string; todos?: null \| { content: string; status: "completed"\|"pending"\|"in_progress" }[]; … }; … } \| … | Read exact projections, returning cached hints only when migration is required. | api-session-controller, client-ui-conversation, client-ui-goal |
| `session/prompt` | unary | request: { requestId: string; sessionId: string; mode: "queue"\|"steer"; content: { type: "text"; text: string } \| { type: "image"; mediaType: "image/png"\|"image/jpeg"\|"image/webp"\|"image/gif"; data: string; name?: string } \| { type: "file"; receiptId: string }[]; … } | { accepted: true } | Admit one prompt after explicitly resuming its Session. | api-session-controller, client-ui-conversation |
| `session/rename` | unary | request: { sessionId: string; title: string } | { title: string; seq: number } | Rename one Session after explicitly resuming it. | api-session-controller, client-ui-shortcuts, client-ui-workspace |
| `session/search` | unary | request: { query: string } | { items: { sessionId: string; snippet: string }[]; hasMore: boolean } | Search visible Session content without resuming an Agent. | api-session-controller, client-ui-shortcuts, client-ui-workspace |
| `session/selectModel` | unary | request: { sessionId: string; provider: string; model: string; reasoningEffort?: string } | { selected: { provider: string; model: string; reasoningEffort?: string } } | Select one Session-local model after explicitly resuming the Session; save the default in the background. | — |
| `session/updateQueue` | unary | request: { sessionId: string; itemId: string; action: { kind: "edit"; content: { type: "text"; text: string }[] } \| { kind: "remove" } \| { kind: "steer" } } | { accepted: true } | Mutate one still-pending queue occurrence, resuming a cold Agent first. | api-session-controller, client-ui-conversation |
| `session/workspacePathApplications` | unary | request: { path: string } | { id: string; name: string; default: boolean; icon: null \| string }[] | Query current file handlers on the serving desktop without activating an Agent. | client-ui-open-in-app |
| `skills/list` | unary | request: { sessionId: string } | { skills: { path?: string; name: string; description: string; whenToUse?: string; modelInvocable: boolean }[] } | List the user-invocable skills visible to one Session composition. | client-ui-skill |

#### dsh-api-settings-controller

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `credentials/describe` | unary | refs: string[] | Record<string, { configured: boolean; source?: string; writable: boolean }> | Describe several references for one configuration surface. | client-ui-settings-models, client-ui-settings-web-search |
| `credentials/set` | unary | ref: string<br>value: string | any | Store one value from a configuration surface. | client-ui-settings-models, client-ui-settings-web-search |
| `credentials/unset` | unary | ref: string | any | Remove one reference from a configuration surface. | client-ui-settings-models |
| `settings/describe` | unary | — | { writable: boolean; hasDocument: boolean; namespaces: { autoGenerate: boolean; ns: string; schema: any; value: any; base?: any; user?: any; applies: "live"; secrets: { path: string[]; set: boolean }[]; revision: number }[] } | Describe every registered namespace for a configuration page: redacted layered values plus the serialized schema the page renders its form from. | client-ui-settings |
| `settings/mutate` | unary | ns: string<br>ops: { op: "set"; path: string[]; value: any } \| { op: "unset"; path: string[] }[]<br>expectedRevision?: number | { autoGenerate: boolean; ns: string; schema: any; value: any; base?: any; user?: any; applies: "live"; secrets: { path: string[]; set: boolean }[]; revision: number } | Apply path-addressed edits to one namespace's user section, resolved against the section as stored rather than against whatever the caller last read, then answe | client-ui-permission-presets, client-ui-settings, client-ui-settings-models |
| `settings/openSettingsDocument` | unary | — | { opened: true } | Materialize the provider-owned settings document and open it in a native text editor. | client-ui-settings-general |
| `settings/replace` | unary | ns: string<br>section: object<br>expectedRevision?: number | { autoGenerate: boolean; ns: string; schema: any; value: any; base?: any; user?: any; applies: "live"; secrets: { path: string[]; set: boolean }[]; revision: number } | Replace one namespace's stored user section wholesale. | — |
| `settings/update` | unary | ns: string<br>patch: object<br>expectedRevision?: number | { autoGenerate: boolean; ns: string; schema: any; value: any; base?: any; user?: any; applies: "live"; secrets: { path: string[]; set: boolean }[]; revision: number } | Merge a patch into one namespace's stored user section. | client-ui-agent-preset |

#### dsh-api-terminal-controller

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `terminal/attach` | **stream** | agentId: string (lookup agent)<br>id: string | { type: "snapshot"; sequence: number; screen: string; info: { id: string; title: string; shell: { path: string; args: string[]; name: string }; cwd: string; cols: number; rows: number; state: "failed"\|"running"\|"exited"; exitCode: null \| number; error?: string }; … } \| … \| … \| … | Attach terminal input and output to one physical Remote stream. | — |
| `terminal/close` | unary | agentId: string (lookup agent)<br>id: string | any | Close an identity to future creation and kill its process range; repeated closes succeed. | api-terminal-controller, client-ui-sidebar-terminal |
| `terminal/create` | unary | agentId: string (lookup agent)<br>request: { shellPath?: string; id: string; cols: number; rows: number } | { id: string; title: string; shell: { path: string; args: string[]; name: string }; cwd: string; cols: number; rows: number; state: "failed"\|"running"\|"exited"; exitCode: null \| number; error?: string } | Allocate a user shell once for a caller-generated identity, without Agent sandbox or approval restrictions. | — |
| `terminal/environment` | unary | agentId: string (lookup agent) | { cwd: string; maxInputBytes: number; maxBufferedBytes: number; maxCols: number; maxRows: number; scrollback: number } | Read the Session's current directory and terminal limits without filesystem validation or shell lookup. | — |
| `terminal/list` | unary | sessionId: string | { id: string; title: string; shell: { path: string; args: string[]; name: string }; cwd: string; cols: number; rows: number; state: "failed"\|"running"\|"exited"; exitCode: null \| number; error?: string }[] | List retained terminals without resolving or activating an Agent. | — |
| `terminal/rename` | unary | agentId: string (lookup agent)<br>id: string<br>title: string | any | Rename a terminal without changing its shell. | — |
| `terminal/retain` | **stream** | sessionId: string<br>id: string | { type: "retained" } | Retain an existing terminal for a window without activating its Agent or taking input control. | — |
| `terminal/shells` | unary | agentId: string (lookup agent) | { path: string; args: string[]; name: string }[] | Discover installed shells in the Session's execution environment. | — |

#### dsh-api-workspace-controller

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `directoryPicker/createDirectory` | unary | path: string<br>name: string | string | Create one child directory for a Remote caller's in-app browser. | client-ui-workspace |
| `directoryPicker/list` | unary | path?: string | { path: string; home: string; crumbs: { name: string; path: string; hidden: boolean }[]; entries: { name: string; path: string; hidden: boolean }[]; truncated: boolean } | List one directory level for a Remote caller's in-app browser. | client-ui-workspace |
| `directoryPicker/pick` | unary | — | null \| string | Open the host's OS chooser for a Remote caller. | client-ui-workspace |
| `workspace/archiveSession` | unary | request: { sessionId: string; stopActivity?: boolean } | { archivedSessionIds: string[] } | Hide one known Session from Workspace grouping surfaces. | — |
| `workspace/create` | unary | request: { path: string } | { workspace: { workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string }; created: boolean } | Create or idempotently resolve one Workspace over an existing directory. | — |
| `workspace/delete` | unary | request: { workspaceId: string } | { deleted: true } | Remove one Workspace registration while retaining files and Sessions. | — |
| `workspace/follow` | **stream** | — | { type: "baseline"; value: { items: { workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string }[]; archivedSessionIds: string[]; … } } \| … \| … \| … \| … \| … \| … | Stream a complete Workspace baseline followed by ordered increments. | api-workspace-controller |
| `workspace/initializeDefault` | unary | — | any \| { workspace: { workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string } } | Initialize or reuse the default Workspace during first-use startup. | — |
| `workspace/insertBefore` | unary | request: { workspaceId: string; beforeWorkspaceId?: string } | { workspaceIds: string[] } | Move one Workspace within the registry display order. | — |
| `workspace/insertSessionBefore` | unary | request: { workspaceId: string; sessionId: string; beforeSessionId?: string } | { workspace: { workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string } } | Move one accounted Session within a Workspace. | — |
| `workspace/pinSession` | unary | request: { sessionId: string } | { pinnedSessionIds: string[] } | Surface one known unarchived Session ahead of unpinned Sessions. | — |
| `workspace/rename` | unary | request: { workspaceId: string; title: string } | { workspace: { workspaceId: string; path: string; title: string; sessionIds: string[]; createdAt: string; updatedAt: string } } | Rename one Workspace to a unique non-blank title. | — |
| `workspace/unarchiveSession` | unary | request: { sessionId: string } | { archivedSessionIds: string[] } | Restore one archived Session to Workspace grouping surfaces. | — |
| `workspace/unpinSession` | unary | request: { sessionId: string } | { pinnedSessionIds: string[] } | Remove one Session's pin without changing its saved Session order. | — |

#### dsh-api-workspace-files

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `workspaceFiles/changes` | **stream** | workspaceFileScopeId: string (lookup workspaceFileScope)<br>path: string | { kind: "ready" } \| { kind: "change"; change: { absolutePath: string; version: string } \| { absolutePath: string; absent: true } } | Watch one file or a directory's direct entries in the Session's filesystem. | api-workspace-files, client-ui-sidebar-files |
| `workspaceFiles/list` | unary | workspaceFileScopeId: string (lookup workspaceFileScope)<br>path: string | { path: string; entries: { name: string; type: "file"\|"directory"\|"other"; size?: number }[]; truncated: boolean } | List the direct children of one directory inside the Session's workspace. | client-ui-sidebar-files |
| `workspaceFiles/read` | unary | workspaceFileScopeId: string (lookup workspaceFileScope)<br>path: string<br>range: { offset?: number; limit?: number } | { offset: number; text: string; lines: number; eof: boolean; absolutePath: string; version: string; bytes?: number } | Read one page of lines from a UTF-8 file readable by the filesystem backend. | client-ui-sidebar-documentpreview |
| `workspaceFiles/readBytes` | unary | workspaceFileScopeId: string (lookup workspaceFileScope)<br>path: string<br>options: { range?: { offset?: number; length?: number }; baseFile?: string } | { offset: number; data: any; eof: boolean; absolutePath: string; version: string; bytes?: number } | Read a complete regular file or one byte range without text decoding. | client-ui-sidebar-documentpreview |
| `workspaceFiles/stat` | unary | workspaceFileScopeId: string (lookup workspaceFileScope)<br>path: string | { absolutePath: string; version: string; bytes?: number } | Report one regular file's identity, version, and size without its content. | api-workspace-files, client-ui-sidebar-documentpreview |

#### dsh-client-file-upload

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `fileUploads/upload` | unary | agentId: string (lookup agent)<br>request: { data: string; name?: string } | { receiptId: string; file: { attachmentId: string; name: string; bytes: number } } | Persist one encoded upload and stage it under the Agent receiver selected by Typert. | client-file-upload |

#### dsh-client-product-analytics

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `productAnalytics/enabled` | unary | — | boolean | Read the collection policy. | — |
| `productAnalytics/report` | unary | event: { eventName: "desktop_app_launch"; attributes: Record<string, any>; timestamp: number } \| { eventName: "auth_page_view"; attributes: Record<string, any>; timestamp: number } \| { eventName: "auth_page_click"; attributes: { button_name: "sign_in" \| "api-key" }; … } \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … | any | Submit selected Desktop fields with cached static environment and fresh identity. | client-product-analytics |
| `productAnalytics/watchPolicy` | **stream** | — | boolean | Stream the effective policy initially and after live configuration edits. | client-product-analytics |

#### dsh-client-ui-plugin-manager

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `pluginRegistryProbe/fastest` | unary | — | null \| string | Race npm and npmmirror HTTPS ping responses through the Host's fetch proxy. | client-ui-plugin-manager |

#### dsh-command-feedback

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `sessionFeedback/record` | unary | request: { sessionId: string; text?: string; category?: "other"\|"task-result"\|"instruction-following"\|"product-interaction"\|"service-stability"\|"resource-cost"\|"security-privacy-permission" } | { ok: true; value: { recorded: true } } \| { ok: false; error: { code: "session-not-found"; sessionId: string } } | Record one remark on a live Session. | client-ui-message-feedback |

#### dsh-commands

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `commands/execute` | unary | agentId: string (lookup agent)<br>line: string<br>submittedAttachments: { type: "image"; mediaType: "image/png"\|"image/jpeg"\|"image/webp"\|"image/gif"; data: string; name?: string } \| { type: "file"; receiptId: string }[] | any \| { commandId: string; result: { kind: "success"; text?: string; sourceEventSeq?: number } \| { kind: "error"; text: string } } | Parse and execute a known command without sending it to the model. | api-session-controller, client-ui-commands, client-ui-plan |
| `commands/list` | unary | agentId: string (lookup agent) | { definitionId?: string; name: string; description: string; input?: { hint: string; attachments?: boolean } }[] | List the effective immutable command descriptors for one agent. | client-ui-commands |

#### dsh-cordis-host-runner

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `dynamicCordisRunner/getClientCode` | unary | agentId: string (lookup agent)<br>pluginId: string<br>pluginRunId: string | { code: string; name: string; pluginId: string; packageId: string; pluginRunId: string } | Fetch Client code for the exact active run. | cordis-client-runner |
| `dynamicCordisRunner/inventory` | unary | — | { pluginId: string; agentId: string; packages: { packageId: string; name: string; purpose: string; hasHostHalf: boolean; hasClientHalf: boolean }[]; currentPackageId?: string; nextPackageId?: string; … }[] | Frame-wide inventory, grouped as one row per stable Plugin. | client-ui-cordis |
| `dynamicCordisRunner/invoke` | unary | pluginId: string<br>pluginRunId: string<br>method: string<br>args: any | { ok: true; value: any } \| { ok: false; code: "plugin-not-running"\|"stale-run"\|"method-not-found"\|"handler-error"; message: string; stack?: string } | Invoke an active Host method while rejecting stale Client runs. | cordis-client-runner |
| `dynamicCordisRunner/reportClientGuardFailure` | unary | agentId: string (lookup agent)<br>pluginId: string<br>pluginRunId: string<br>failure: { message: string; stack?: string } | null | Report a Client guard rejection that happened after the Package completed activation. | cordis-client-runner |
| `dynamicCordisRunner/reportRenderFailure` | unary | agentId: string (lookup agent)<br>pluginId: string<br>pluginRunId: string<br>failure: { slot: string; message: string; stack?: string; abdicated: boolean } | null | Record a post-load render failure for the exact active run. | cordis-client-runner |
| `dynamicCordisRunner/resolveInspectQuery` | unary | agentId: string (lookup agent)<br>requestId: string<br>resolution: { ok: true; data: any } \| { ok: false; reason: "cancelled"\|"provider-missing"\|"method-missing"\|"invalid-input"\|"provider-error"; message: string } | { accepted: boolean } | Submit a Client inspect result or failure for a pending query. | cordis-client-runner |
| `dynamicCordisRunner/resolveRequestRun` | unary | requestId: string<br>resolution: { ok: true; pluginRunId: string; waitingFor?: string[] } \| { ok: false; reason: "rejected"\|"host-half-failed"\|"client-half-failed"; pluginRunId?: string; startedHere?: boolean; message?: string; stack?: string } | { accepted: boolean } | Resolve one model-driven Client activation request. | cordis-client-runner |
| `dynamicCordisRunner/runHostHalf` | unary | agentId: string (lookup agent)<br>pluginId: string<br>packageId: string<br>mode: "run"\|"update"<br>requestId: null \| string<br>approveFutureVersions: boolean | { ok: true; pluginId: string; packageId: string; pluginRunId: string; waitingFor: string[]; startedHere: boolean } \| { ok: false; message: string; stack?: string } | Start Host code for an approved request or a direct panel gesture. | cordis-client-runner |
| `dynamicCordisRunner/settleUserRun` | unary | agentId: string (lookup agent)<br>pluginId: string<br>resolution: { ok: true; pluginRunId: string; waitingFor?: string[] } \| { ok: false; reason: "rejected"\|"host-half-failed"\|"client-half-failed"; pluginRunId?: string; startedHere?: boolean; message?: string; stack?: string } | { ok: true; status: "running"\|"awaiting-approval"\|"starting"; pluginId: string; packageId: string; pluginRunId: string; waitingFor: string[]; clientWaitingFor?: string[]; currentPackageId?: string; nextPackageId?: string; mode: "run"\|"update" } \| { ok: false; reason: "cancelled"\|"not-running"\|"plugin-missing"\|"rejected"\|"host-half-failed"\|"client-half-failed"\|"package-missing"\|"invalid-mode"\|"transition-in-flight"; … } | Settle a direct panel run after this page loaded or failed its Client half. | cordis-client-runner |
| `dynamicCordisRunner/stopFromPanel` | unary | agentId: string (lookup agent)<br>pluginId: string | { ok: true } \| { ok: false; reason: "not-running"\|"plugin-missing"; message: string } | Stop a Plugin from the user panel and queue the resulting state change for the model's next step. | client-ui-cordis |
| `dynamicCordisRunner/syncInspectManifest` | unary | providers: { id: string; description: string; methods: { name: string; description: string; inputSchema: any; outputSchema: any }[] }[] | null | Replace the Host mirror of the Client inspect provider directory. | cordis-client-runner |
| `dynamicCordisRunner/undefineFromPanel` | unary | agentId: string (lookup agent)<br>pluginId: string | { ok: true; wasRunning: boolean } \| { ok: false; reason: "plugin-missing"; message: string } | Remove a Plugin from the user panel and queue the resulting state change for the model's next step. | client-ui-cordis |

#### dsh-experimental-api-speech-to-text

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `speech/cancelPreparation` | unary | providerId: string | any | Explicitly cancel resource preparation. | experimental-client-ui-voice-input |
| `speech/catalog` | unary | — | { maxAudioBytes: number; maxDurationSeconds: number; providers: { preparation: { phase: "cancelled"\|"ready"\|"unprepared"\|"standby"; step?: "check"\|"model"\|"vad"\|"verify"\|"load"; steps?: {…}[] } \| { phase: "downloading"; resource: string; completedBytes: number; totalBytes?: number; step?: "check"\|"model"\|"vad"\|"verify"\|"load"; … } \| … \| …; … }[]; … } | Read provider choices without preparing a recognizer. | — |
| `speech/configure` | unary | patch: { providerId?: string; language?: string } | any | Persist the user's recognition preferences. | experimental-client-ui-voice-input |
| `speech/follow` | **stream** | — | { maxAudioBytes: number; maxDurationSeconds: number; providers: { preparation: { phase: "cancelled"\|"ready"\|"unprepared"\|"standby"; step?: "check"\|"model"\|"vad"\|"verify"\|"load"; steps?: {…}[] } \| { phase: "downloading"; resource: string; completedBytes: number; totalBytes?: number; step?: "check"\|"model"\|"vad"\|"verify"\|"load"; … } \| … \| …; … }[]; … } | Follow provider readiness independently of Session and preparation lifetimes. | experimental-client-ui-voice-input |
| `speech/prepare` | unary | providerId: string<br>options?: { downloadSource?: string } | any | Start or join one Host-owned preparation task. | experimental-client-ui-voice-input |
| `speech/transcribe` | unary | request: { audioBase64: string; providerId?: string; language?: string } | { text: string; audioSeconds: number; inferenceSeconds: number } | Validate and transcribe one recording through the explicit provider selection. | experimental-client-ui-voice-input |

#### dsh-experimental-client-ui-cot-translation

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `cotTranslation/limits` | unary | — | { maxTextChars: number; preferences: { provider: "google"\|"bing"\|"deepseek-account"\|"deepseek-official"; targetLanguage: string }; availableProviders: ("google"\|"bing"\|"deepseek-account"\|"deepseek-official")[] } | Read accepted translation preferences and the current request limit without sending text. | experimental-client-ui-cot-translation |
| `cotTranslation/translate` | unary | request: { text: string; targetLanguage: string; sourceLanguage?: string; provider?: "google"\|"bing"\|"deepseek-account"\|"deepseek-official"; sessionId?: string } | string | Translate one displayed fragment through the reader's selected provider. | experimental-client-ui-cot-translation |

#### dsh-goal

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `goals/clear` | unary | agentId: string (lookup agent)<br>ref: { id: string; revision: number } | { id: string; revision: number } | Clear the current goal while retaining a durable tombstone and history. | client-ui-goal |
| `goals/complete` | unary | agentId: string (lookup agent)<br>ref: { id: string; revision: number } | { roundsStarted: number; createdAt: number; updatedAt: number; activation: "armed"\|"disarmed"; objective: string; phase: "active"\|"paused"\|"blocked"\|"complete"; blockedReason?: { code: string; message: string }; maxGoalRounds: number; id: string; revision: number } | Mark a current non-complete goal complete and disarm it. | — |
| `goals/create` | unary | agentId: string (lookup agent)<br>request: { objective: string; maxGoalRounds?: number } | { ref: { id: string; revision: number } } | Create one Goal through the remote boundary. | — |
| `goals/edit` | unary | agentId: string (lookup agent)<br>ref: { id: string; revision: number }<br>request: { objective?: string; maxGoalRounds?: number } | { roundsStarted: number; createdAt: number; updatedAt: number; activation: "armed"\|"disarmed"; objective: string; phase: "active"\|"paused"\|"blocked"\|"complete"; blockedReason?: { code: string; message: string }; maxGoalRounds: number; id: string; revision: number } | Edit objective and/or round cap without changing phase. | client-ui-goal |
| `goals/get` | unary | agentId: string (lookup agent) | any \| { roundsStarted: number; createdAt: number; updatedAt: number; activation: "armed" \| "disarmed"; objective: string; phase: "active" \| "paused" \| "blocked" \| "complete"; blockedReason?: { code: string; message: string }; maxGoalRounds: number; id: string; … } | Read the current goal for one exact live agent. | client-ui-goal |
| `goals/pause` | unary | agentId: string (lookup agent)<br>ref: { id: string; revision: number } | { roundsStarted: number; createdAt: number; updatedAt: number; activation: "armed"\|"disarmed"; objective: string; phase: "active"\|"paused"\|"blocked"\|"complete"; blockedReason?: { code: string; message: string }; maxGoalRounds: number; id: string; revision: number } | Pause an active goal and disarm automatic continuation. | client-ui-goal |
| `goals/resume` | unary | agentId: string (lookup agent)<br>ref: { id: string; revision: number } | { roundsStarted: number; createdAt: number; updatedAt: number; activation: "armed"\|"disarmed"; objective: string; phase: "active"\|"paused"\|"blocked"\|"complete"; blockedReason?: { code: string; message: string }; maxGoalRounds: number; id: string; revision: number } | Resume and arm a stopped goal, or rearm an active goal after a session-start edge, while its round budget still has capacity. | client-ui-goal |

#### dsh-host-plugin-inventory

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `pluginInventory/list` | unary | — | { managementAvailable?: boolean; entries: { entryId: string; moduleName: string; meta?: { title?: string \| {…} & Record<string, string>; description?: string \| {…} & Record<string, string>; icon?: string; error?: string }; … }[]; … } | Read the Loader directly on every call. | client-ui-plugin-manager, client-ui-settings-plugin-inventory |

#### dsh-llm

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `llm/discoverModels` | unary | settingsNs: string<br>request: { provider?: string; baseURL?: string; api?: string; apiKey?: string } | { id: string; name?: string; contextWindow?: number; maxTokens?: number; inputModalities?: ("text"\|"image")[] }[] | Remote adapter for one draft provider interrogation. | client-ui-settings-models |
| `llm/listConfigurableProviders` | unary | — | { provider: string; displayName: string; settingsNs: string; settingsPath: string[]; declared?: boolean; defaultBaseURL?: string; baseURLEnv?: string[]; nativeAuth?: { env: string[]; oauth: boolean }; error?: string }[] | List every declared configurable provider, registered or dormant. | client-ui-settings-models |
| `llm/listProviders` | unary | — | { id: string; name: string }[] | Describe provider routes with a registered adapter. | client-ui-settings-models |

#### dsh-message-feedback

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `messageFeedback/delete` | unary | request: { sessionId: string; messageId: string; ifVersion: string } | { ok: true; value: { absent: true } } \| { ok: false; error: { code: "session-not-found"; sessionId: string } \| { code: "version-conflict"; current: null \| { messageId: string; rating: "positive"\|"negative"; note?: string; category?: "other"\|"task-result"\|"instruction-following"\|"product-interaction"\|"service-stability"\|"resource-cost"\|"security-privacy-permission"; … } } } | Delete one item after checking its version; absence succeeds without an event. | — |
| `messageFeedback/list` | unary | request: { sessionId: string } | { ok: true; value: { items: { messageId: string; rating: "positive"\|"negative"; note?: string; category?: "other"\|"task-result"\|"instruction-following"\|"product-interaction"\|"service-stability"\|"resource-cost"\|"security-privacy-permission"; version: string; createdAt: number; updatedAt: number }[] } } \| … | Read current feedback from the canonical log. | — |
| `messageFeedback/put` | unary | request: { sessionId: string; messageId: string; rating: "positive"\|"negative"; note?: string; category?: "other"\|"task-result"\|"instruction-following"\|"product-interaction"\|"service-stability"\|"resource-cost"\|"security-privacy-permission"; ifVersion: null \| string } | { ok: true; value: { messageId: string; rating: "positive"\|"negative"; note?: string; category?: "other"\|"task-result"\|"instruction-following"\|"product-interaction"\|"service-stability"\|"resource-cost"\|"security-privacy-permission"; version: string; createdAt: number; updatedAt: number } } \| … | Create or replace feedback after checking its current version. | — |

#### dsh-office-to-pdf

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `officeToPdf/generation` | unary | — | string | Read the current rendering generation before reusing a Client PDF. | client-ui-sidebar-documentpreview |
| `officeToPdf/render` | unary | workspaceFileScopeId: string (lookup workspaceFileScope)<br>path: string<br>priority: "foreground"\|"background" | { missingFonts: string[]; generation: string; offset: number; data: any; eof: boolean; absolutePath: string; version: string; bytes?: number } | Read and convert one Office file using the Session's ordinary filesystem authorization. | client-ui-sidebar-documentpreview |

#### dsh-permission-presets

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `permissionPresets/catalog` | unary | — | { options: { value: string; name: string; description?: string }[]; defaultOptions: { value: string; name: string; description?: string }[]; defaultPreset: string } | Read the complete process-level catalog exposed to current-session UI. | client-ui-permission-presets |

#### dsh-plugin-manager

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `pluginManager/cancelInstall` | unary | requestId: string | { status: "cancelled"\|"not-running"\|"too-late" } | Stop an installation this manager owns and wait until its files are back. | client-ui-plugin-manager |
| `pluginManager/inspect` | unary | spec: string<br>options?: { registry?: null \| string } | { status: "accepted"; kind: "registry"\|"path"\|"git"\|"tarball"; name?: string; version?: string; description?: string; bundle: null \| false\|true; registry: null \| string; host?: string } \| { status: "refused"; problem: "network"\|"unknown"\|"invalid-spec"\|"already-installed"\|"not-found"\|"not-a-package"\|"not-a-bundle"; … } | Read what a spec names before installing it. | client-ui-plugin-manager |
| `pluginManager/installBundle` | unary | spec: string<br>options?: { enabled?: boolean; saveExact?: boolean; requestId?: string; approvedBuilds?: string[]; registry?: null \| string } | { changed: boolean; application: "cancelled" \| "failed" \| "applied" \| "restart-required" \| "overridden"; restartReason?: "no-hmr" \| "package-moved" \| "host-module" \| "unmanaged-plugin" \| "module-comparison"; stage: "remove" \| "install" \| "enable"; target: string; enabled?: boolean; … } | Install a package using the same pnpm implementation as dsh plugin. | client-ui-plugin-manager |
| `pluginManager/listBundles` | unary | — | { name: string; official: boolean; availability: "profile" \| "installation" \| "missing"; installTarget?: { spec: string; version: string }; version?: string; meta?: { title?: string \| { en: string } & Record<string, string>; description?: string \| { en: string } & Record<string, string>; … }; … }[] | Read installed, installation-provided, and offline Official catalog bundles, plus selected non-bundle names. | client-ui-plugin-manager |
| `pluginManager/listPlugins` | unary | — | { entryId: string; moduleName: string; meta?: { title?: string \| { en: string } & Record<string, string>; description?: string \| { en: string } & Record<string, string>; icon?: string; error?: string }; … } \| …[] | Read current plugins, including why a row cannot be changed through the profile patch. | client-ui-plugin-manager |
| `pluginManager/listVersionExemptions` | unary | — | { exemptions: Record<string, string[]>; warnings: string[] } | Read exact plugin-version exemptions saved in this profile. | — |
| `pluginManager/registries` | unary | — | { registry: null \| string; fallbackRegistries: string[]; resolved: null \| string } | Read the registries this manager asks: the configured first one, its fallbacks in order, and what pnpm's own configuration names. | client-ui-plugin-manager |
| `pluginManager/removeBundle` | unary | name: string | { changed: boolean; application: "cancelled" \| "failed" \| "applied" \| "restart-required" \| "overridden"; restartReason?: "no-hmr" \| "package-moved" \| "host-module" \| "unmanaged-plugin" \| "module-comparison"; stage: "remove" \| "install" \| "enable"; target: string; enabled?: boolean; … } | Unload and remove a profile-owned bundle dependency through dsh plugin's pnpm path; a selected name no dependency holds is only deselected. | client-ui-plugin-manager |
| `pluginManager/setBundleEnabled` | unary | name: string<br>enabled: boolean | { changed: boolean; application: "cancelled" \| "failed" \| "applied" \| "restart-required" \| "overridden"; restartReason?: "no-hmr" \| "package-moved" \| "host-module" \| "unmanaged-plugin" \| "module-comparison"; stage: "remove" \| "install" \| "enable"; target: string; enabled?: boolean; … } | Select or remove a bundle layer while retaining installed dependencies. | client-ui-plugin-manager |
| `pluginManager/setPluginEnabled` | unary | id: string<br>enabled: boolean | { changed: boolean; application: "cancelled" \| "failed" \| "applied" \| "restart-required" \| "overridden"; restartReason?: "no-hmr" \| "package-moved" \| "host-module" \| "unmanaged-plugin" \| "module-comparison"; stage: "remove" \| "install" \| "enable"; target: string; enabled?: boolean; … } | Persist a plugin entry's desired enablement and apply it on live profiles. | client-ui-plugin-manager |
| `pluginManager/setVersionExemption` | unary | packageVersion: string<br>runtimeVersion: string<br>enabled: boolean<br>acceptRisk?: false\|true | { changed: boolean; application: "cancelled" \| "failed" \| "applied" \| "restart-required" \| "overridden"; restartReason?: "no-hmr" \| "package-moved" \| "host-module" \| "unmanaged-plugin" \| "module-comparison"; stage: "remove" \| "install" \| "enable"; target: string; enabled?: boolean; … } | Grant or revoke one exact plugin/runtime exemption and reevaluate live plugins. | — |
| `pluginManager/waitForInstall` | unary | requestId: string | null \| { changed: boolean; application: "cancelled" \| "failed" \| "applied" \| "restart-required" \| "overridden"; restartReason?: "no-hmr" \| "package-moved" \| "host-module" \| "unmanaged-plugin" \| "module-comparison"; stage: "remove" \| "install" \| "enable"; target: string; enabled?: boolean; … } | Recover the result of an active installation without cancelling it. | client-ui-plugin-manager |

#### dsh-plugin-market

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `pluginMarket/listIndexes` | unary | — | { url: string; title?: string \| { en: string } & Record<string, string>; description?: string \| { en: string } & Record<string, string>; error?: string }[] | List the configured index sources without fetching them. | client-ui-plugin-market |
| `pluginMarket/search` | unary | url: string<br>query: { text?: string; category?: string; labels?: string[]; sort: { kind: "index" } \| { kind: "relevance" } \| { kind: "published"; direction: "asc"\|"desc" } \| { kind: "key"; id: string; direction: "asc"\|"desc" }; … } | { url: string; title: string \| { en: string } & Record<string, string>; description?: string \| { en: string } & Record<string, string>; metadata: { categories: Record<string, {…}>; labels: Record<string, {…}>; sortKeys: Record<string, {…}> }; … } | Return one page of the plugins of a configured index that match a query. | client-ui-plugin-market |
| `pluginMarket/setIndexes` | unary | urls: string[] | any | Replace the configured index sources through Settings, without remounting this service. | client-ui-plugin-market |

#### dsh-schedule

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `schedule/catalog` | unary | — | { id: string; kind: "after"; title: string; prompt: string; afterSeconds: number; scheduledAt: string; sessionId: string; status: "active"\|"inactive"; lastDelivery?: { scheduledAt: string; deliveredAt: string; messageId: string } } \| … \| … \| … \| … \| …[] | Read all active and inactive Host reminders with their original Session bindings. | client-ui-schedule |
| `schedule/delete` | unary | request: { id: string; sessionId: string } | { id: string; deleted: true } \| { id: string; deleted: false; code: "schedule_not_found" } | Delete one task belonging to the selected Session, leaving queued messages intact. | client-ui-schedule, cordis-client-runner |
| `schedule/history` | unary | request: { limit: number; before?: string; id: string; sessionId: string } | { id: string; records: { prompt?: string; scheduledAt: string; deliveredAt: string; messageId: string }[]; earlierRecordsUnavailable: boolean; earlierRecordsPruned: boolean; retention: { days: number; records: number }; … } \| … | Read saved inbox deliveries without activating or reading the original Session. | client-ui-schedule |
| `schedule/list` | unary | request: { sessionId: string } | { id: string; kind: "after"; title: string; prompt: string; afterSeconds: number; scheduledAt: string } \| { id: string; kind: "at"; title: string; prompt: string; scheduledAt: string } \| { id: string; kind: "every"; title: string; prompt: string; everySeconds: number; scheduledAt: string } \| { id: string; kind: "daily"; … } \| … \| …[] | Read the selected Session's active tasks without resuming its Agent. | client-ui-schedule |
| `schedule/update` | unary | request: { expected: { id: string; kind: "after"; title: string; prompt: string; afterSeconds: number; scheduledAt: string } \| { id: string; kind: "at"; title: string; prompt: string; scheduledAt: string } \| { id: string; kind: "every"; title: string; prompt: string; everySeconds: number; scheduledAt: string } \| { id: string; kind: "daily"; … } \| … \| …; … } | { id: string; updated: boolean; record: { id: string; kind: "after"; title: string; prompt: string; afterSeconds: number; scheduledAt: string } \| { id: string; kind: "at"; title: string; prompt: string; scheduledAt: string } \| { id: string; kind: "every"; title: string; prompt: string; everySeconds: number; scheduledAt: string } \| … \| … \| … } \| … \| … \| … \| … \| … \| … \| … \| … \| … \| … | Update the name, instruction, and timing of an active task within the original Session binding without activating the Session or changing saved deliveries. | client-ui-schedule |

#### dsh-session-reference

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `sessionReferenceResolver/candidates` | unary | agentId: string (lookup agent)<br>query: string | { mention: string; sessionId: string; label: string; displayTitle?: string; cwd?: string; sameWorkspace: boolean; createdAt: number }[] | Remote face of {@link listCandidates}: the configured candidate limit applies, and every candidate carries the canonical mention a host inserts into the prompt  | client-ui-reference |

#### dsh-subagent

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `subagents/interruptByParent` | unary | childSessionId: string<br>parentSessionId: string<br>mode: "continuable" | { accepted: true } | Remote face of {@link interrupt} under one durable parent address. | api-session-controller |
| `subagents/prompt` | unary | request: { requestId: string; parentSessionId: string; childSessionId: string; mode: "continuable"; delivery: "queue"\|"steer"; content: { type: "text"; text: string } \| { type: "image"; mediaType: "image/png"\|"image/jpeg"\|"image/webp"\|"image/gif"; data: string; name?: string }[]; … } | { messageId: string } | Deliver one browser-authored message to a continuable child through the exact live direct parent, retaining the caller-minted request identity and validated bro | api-session-controller |

#### dsh-user-questions

| endpoint | 模式 | args（wire 名: 类型） | result | 说明 | web 使用方 |
|---|---|---|---|---|---|
| `userQuestions/answer` | unary | agentId: string (lookup agent)<br>callId: string<br>answer: { answers: { id: string; selected: string[]; custom?: string }[] } | boolean | Answer a continued question. | client-ui-user-questions |
| `userQuestions/attachWait` | **stream** | agentId: string (lookup agent)<br>callId: string | { remainingMs: number } | Let one answer UI hold a live timed wait. | client-ui-user-questions |
