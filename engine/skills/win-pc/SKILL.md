---
name: win-pc
description: 操作用户自己的 Windows 电脑——跑命令、装软件、找文件、发文件、控制鼠标键盘、看屏幕。用户说「我电脑上」「帮我打开」「在我电脑里找」时读。
version: 2.0.0
source: handwritten
permissions: [network, runs-commands, reads-files, writes-files]

---

# 用户的 Windows 电脑

用户的电脑上跑着 `SigmaClient.exe`，它对这台手机开放了完整控制权。
**你能在那台电脑上做的事，和一个坐在它前面的人一样多。**

前提：同一 Wi-Fi 直连，或走中继（配对码）。

---

## 先看有没有连

```sh
node "$DSH_TOOLS/win-pc/pc.mjs" status
node "$DSH_TOOLS/win-pc/pc.mjs" caps     # 这台电脑支持什么
```

没连过就走「首次连接」。

## 首次连接

用 `ask_user_question` 一项一项问，别一次抛一堆。

**同一 Wi-Fi**：问地址（`http://192.168.0.49:8092`）+ 令牌
**跨网络**：只问 6 位配对码 + 令牌，中继地址内置

```sh
node "$DSH_TOOLS/win-pc/pc.mjs" connect --url <地址> --token <令牌>
node "$DSH_TOOLS/win-pc/pc.mjs" connect --code <配对码> --token <令牌>
```

记住：**用户重装客户端后配对码和令牌都会变**。

## 能干什么（按使用频率排）

| 需求 | 命令 |
|---|---|
| **跑命令** | `pc.mjs run "dir /s /b *.pdf"` — 走 cmd，管道/重定向都能用 |
| **PowerShell** | `pc.mjs ps "Get-Process \| Sort CPU -Desc \| Select -First 5"` |
| **批量** | `pc.mjs batch "命令1" "命令2" "命令3"` — 一次往返跑多条，省时间 |
| **找文件** | `pc.mjs run "where /r C:\\Users *.pdf"` 或 `pc.mjs ps "Get-ChildItem -Recurse -Filter *.xlsx"` |
| **读文件** | `pc.mjs read "~/Documents/a.txt"` |
| **写文件** | `pc.mjs write "~/a.txt" --content "内容"` 或 `--from 本地文件` |
| **列目录** | `pc.mjs ls "~"` |
| **看屏幕** | 对话页顶部小窗；或 `pc.mjs run` 里查 |
| **点鼠标** | `pc.mjs mouse move 800 600` / `mouse click left` / `mouse scroll -3` |
| **打字** | `pc.mjs type "要输入的文字"` |
| **快捷键** | `pc.mjs key "CTRL+V"` / `key "ALT+TAB"` / `key "ENTER"` |
| **查做过什么** | `pc.mjs audit --n 20` |

## 怎么想问题

**别问「我有什么工具」，问「人在这台电脑前会怎么做」。**

人找文件会先想「大概在哪个盘」，然后一层层看；你就 `Get-ChildItem` 带范围找。
人装软件会去官网下载双击；你就 `winget` 或下载后静默安装。
人在微信发消息会点开窗口、点输入框、打字、回车；你就 `mouse click` + `type` + `key ENTER`。
人要截图会按 Win+Shift+S；你就调 PowerShell 抓屏。

**没有现成路子时，PowerShell 几乎什么都能办：**

| 想做的事 | 用什么 |
|---|---|
| 操作界面元素 | UI Automation（`UIAutomationClient`） |
| 改系统设置 | 注册表 / `Set-ItemProperty` |
| 调 Office 文档 | COM（`New-Object -ComObject Word.Application`） |
| 发邮件 | `Send-MailMessage` 或 Outlook COM |
| 压缩解压 | `Compress-Archive` |
| 下载 | `Invoke-WebRequest` |
| 定时/计划 | `Register-ScheduledTask` |
| 看进程/端口 | `Get-Process` / `Get-NetTCPConnection` |
| 管理系统服务 | `Get-Service` / `Start-Service` |
| 查数据库 | `Invoke-Sqlcmd` 或 ADO.NET |

**写一段临时 PowerShell 就跑，不用怕「技能里没写」。** 那正是 `ps` 命令存在的意义。

## 几个容易踩的坑

**找文件别全盘扫。** `Get-ChildItem C:\ -Recurse` 能跑十分钟。
先问用户大概在哪，或者从 `~`、`Desktop`、`Documents`、`Downloads` 开始。

**点鼠标前先截图确认。** 坐标依赖分辨率和窗口位置，
凭记忆点必歪。先 `screen/one` 看一眼，算好坐标再点。

**装软件前问一句。** 装了什么会改系统状态，用户可能不想装。

**长任务用大 timeout。** 编译、渲染、下载可能几分钟，
`--timeout 300000`，并且告诉用户「正在跑，大概 X 分钟」。

**命令卡住多半在等输入。** 加 `/y`、`-Force`、`--yes` 这类参数；
或者用 `ps` 而不是 `run`（PowerShell 不读 stdin 的概率低一些）。

## 三条铁律

**1. 破坏性操作先问。** 删文件、卸软件、关机、改系统设置——先说清要做什么，等用户点头。
读操作（列目录、读文件、查进程）随便用。

**2. 打字内容不进日志。** 客户端只记录长度。但**你自己不要**把密码之类的写进对话。

**3. 坐标会变。** 涉及鼠标点击时，先用截图确认，别凭记忆点。

## 排查

```sh
pc.mjs status      # 在线吗
pc.mjs caps        # 这台电脑支持什么（exec 是否启用）
pc.mjs audit       # 刚才做了什么、有没有失败
```

- 「令牌不对」→ 客户端重装过，令牌变了
- 「没有这个配对码」→ 同上，配对码也变了
- 命令超时 → 那个程序可能在等输入；换 `ps` 或用带 `/y` 之类参数的版本
