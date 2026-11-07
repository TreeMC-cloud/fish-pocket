<p align="center">
  <img src="docs/assets/mascot.png" width="220" alt="Fish Pocket 吉祥物：眨眼笑的鲸鱼娘大肥鱼">
</p>

<h3 align="center">Fish Pocket</h3>

<h1 align="center">在 iPhone 和 iPad 上本机运行 DeepSeek Harness，界面完全原生</h1>

<p align="center">
  <b>不连电脑，不连服务器，不是网页套壳。引擎就跑在 App 里，每个页面都用 SwiftUI 重写。</b>
</p>

<p align="center">如果你也想把大肥鱼装进口袋，<a href="https://testflight.apple.com/join/2SCftb2M"><b>加入 TestFlight 公测</b></a>（推荐，全球可用）或<a href="https://apps.apple.com/app/id6830703602">从 App Store 下载</a>（非中国大陆），再点个 ⭐ 支持一下吧。</p>

<p align="center"><a href="README.en.md">English</a></p>

https://github.com/user-attachments/assets/d149b48d-ef15-4ba7-9fc3-2c627ea66ec0

## iOS

<p align="center">
  <img src="docs/assets/tool.png" width="24%" alt="工具详情：命令和真实输出">
  <img src="docs/assets/terminal.png" width="24%" alt="iPhone 上的终端：node 和 git 都在本机运行">
  <img src="docs/assets/plugins.png" width="24%" alt="原生插件管理">
  <img src="docs/assets/island.png" width="24%" alt="灵动岛显示任务进度">
</p>

## iPad

<p align="center">
  <img src="docs/assets/ipad.png" width="98%" alt="iPad 横屏：侧栏、对话和右侧工作台同屏">
</p>

## 能做什么

- **完全原生的界面：** 对话、审批、工作台、插件和设置都用 SwiftUI 重写，交互按 iOS 习惯设计，不是把网页塞进 WebView。支持深色模式，可以跟随系统，也可以在设置里手动切换。官方 Web UI 也保留着，需要时可以在设置里打开。
- **完整的 Agent：** 对话、工具调用、文件编辑、搜索、计划模式和审批，功能对齐官方 Web UI。
- **真能用的终端：** 内置 bash、`node`、`pnpm`、`git`，还有 `rg`、`jq`、`curl`、`sed`、`awk` 等常用命令。
- **内置 Git：** 基于静态链接的 libgit2，不靠子进程。`clone`、`commit`、`branch`、`merge`、`stash`、`pull`、`push` 等日常操作都能用，输出和真 git 一致，Agent 照常读懂。私有仓库用 HTTPS 加 Token 认证。
- **DSH 插件生态：** 从 npm 安装纯 JavaScript 插件，手机上直接启用。
- **工作台：** 终端、文件预览、内置浏览器和改动查看都放在一个面板里。
- **iOS 专属体验：** 灵动岛和锁屏 Live Activity，切到后台任务也能继续。
- **iPad 适配：** 常驻侧栏、右侧工作台、多窗口、拖放文件，外接键盘支持常用快捷键。
- **更私密：** 会话和工作区留在设备上。

模型调用仍然需要联网，用 DeepSeek 账号或 API Key 都可以。

## 和其他方案的区别

|  | Fish Pocket | 远程客户端 | 手机里跑网页版 | iOS 上的 Linux 模拟器（iSH、UTM SE） |
|---|---|---|---|---|
| 引擎在哪里 | 手机 | 电脑或服务器 | 手机 | 手机 |
| 界面 | 完全原生 SwiftUI | 看具体项目 | 官方 Web UI | 终端或官方 Web UI |
| 电脑要开着吗 | 不用 | 要 | 不用 | 不用 |
| 灵动岛和锁屏状态 | 有 | 看具体项目 | 看具体项目 | 没有 |
| 完整的 Linux 工具 | 没有，只有内置命令和 Node | 有 | 看具体项目 | 有 |
| 运行速度 | Node 原生运行，比桌面慢数倍 | 电脑原生速度 | 看具体项目 | 特别慢，CPU 指令要逐条解释执行 |

## 快速开始

直接安装，需要 iOS 17 或更高版本：

- **TestFlight（推荐，全球可用）**：在 iPhone 或 iPad 上打开 [TestFlight 公测链接](https://testflight.apple.com/join/2SCftb2M)。新版本最先发到这里，和开源仓库保持同步。
- **App Store（非中国大陆）**：[在 App Store 下载](https://apps.apple.com/app/id6830703602)。目前只在中国大陆以外的地区上架。App Store 每个版本都要等审核，所以会比 TestFlight 和开源仓库晚一些。

自己编译：你需要 macOS、Xcode 26、Node 24 和 `xcodegen`，构建 libgit2 还需要 `cmake` 或 `uv`。

```bash
git clone https://github.com/imsai-sh/fish-pocket.git
```

```bash
cd fish-pocket && scripts/run-sim.sh
```

脚本会自动下载 nodejs-mobile、构建 libgit2、组装引擎，然后装到模拟器上运行。默认设备是 `iPhone 17 Pro`，可以用 `SIM_DEVICE` 指定。

想装到真机上，先把 `app/project.yml` 和 `scripts/run-device.sh` 里的 `com.wsw.dsh-ios` 换成你自己的 Bundle ID，再运行：

```bash
DEVELOPMENT_TEAM=<你的团队 ID> scripts/run-device.sh
```

## 怎么做到的

iOS 不允许 App 创建子进程，也不允许运行下载的二进制。所以这里不模拟 Linux 虚拟机，而是把 Node 嵌进 App，再用 DSH 自己的服务接缝换掉“执行世界”。引擎文件一行都没改。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-zh-dark.svg">
    <img src="docs/assets/architecture-zh.svg" width="100%" alt="Fish Pocket 架构：SwiftUI 界面通过本地 HTTP 连接 App 内的 DSH 引擎，引擎再把 bash、node、git 和原生 addon 分别交给 just-bash、Worker 线程、libgit2 和纯 JS 替身">
  </picture>
</p>

## 插件兼容性

我们按下载量从 DSH 社区抽取了前 50 个第三方插件作为样本，在 iOS 引擎上逐个走完安装、启用、冷启动和卸载。**这只是抽样，不代表只支持这 50 个，其他插件同样可以安装。**

| 结果 | 数量 |
|---|---:|
| 直接可用 | 42 |
| 允许或跳过安装脚本、指定版本或重启 App 后可用 | 6 |
| 暂不可用 | 2 |

这里的“可用”指插件能被引擎加载，功能没有逐个试用。逐个插件的结果见 [#18](https://github.com/imsai-sh/fish-pocket/issues/18)。

## 路线图

- [x] 抽样测试社区热门插件的兼容性
- [ ] 确定插件兼容分级和适配规范（[#4](https://github.com/imsai-sh/fish-pocket/issues/4)）
- [ ] 预置第三方插件商店（[#5](https://github.com/imsai-sh/fish-pocket/issues/5)）
- [ ] bash 解释器移出引擎线程

## 参与贡献

欢迎提 issue 和 PR，让你的 Agent 看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 致谢

**特别感谢 [DSH Go](https://github.com/ccch1mneyyy/dsh-go)**，是它启发我们做了这个 iOS 版本。

Fish Pocket 还站在这些优秀项目的肩膀上。

**直接使用：**

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：引擎本身，一切的基础
- [nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile) 及其 [digidem 分支](https://github.com/digidem/nodejs-mobile)：让 Node 24 跑在 iOS 上
- [just-bash](https://github.com/vercel-labs/just-bash)：TypeScript 写的 bash 解释器
- [libgit2](https://github.com/libgit2/libgit2)：App 内的 git 能力
- [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm)：终端界面

**参考过的思路：**

- [dsh-mobile](https://github.com/saya-ch/dsh-mobile)：DSH 的远程访问方案
- [a-Shell](https://github.com/holzschu/a-shell)：证明了 iOS 上可以有真正好用的本地终端

也感谢 DSH 社区的朋友们，“大肥鱼”这个外号来自大家的二创。吉祥物鲸鱼娘的原始角色来自[上善无形](https://space.bilibili.com/4456176)，女仆版二次设计来自 [ZipZipPipe](https://www.pixiv.net/artworks/148186519)。第三方许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 作者

由 [sai](https://imsai.cc) 开发，更多内容见[个人主页](https://imsai.cc)。

我的其他开源项目：

- [awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)：DSH 插件商店与导航，收录 11000+ 插件（[deepseek1024.com](https://deepseek1024.com/)）
- [竹知了](https://github.com/imsai-sh/zhuzhiliao)：一转就哇哇叫的传统玩具，Web 模拟版

## 许可证

代码使用 [MIT](LICENSE)。

吉祥物图片（App 图标、启动图和 README 头图）不适用 MIT，它们基于他人作品，按 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) 使用，**不可商用**。如果你要商用这份代码，请先换掉这些图片，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

> 这是独立的社区项目，与深度求索（DeepSeek）不存在隶属、合作、授权或背书关系。“大肥鱼”是社区对 DeepSeek 的昵称。吉祥物基于社区二创的鲸鱼娘形象，用 AI 重新生成了表情，原形象版权归上善无形和 ZipZipPipe，没有使用 DeepSeek 的 Logo。
