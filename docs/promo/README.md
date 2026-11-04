# 宣传片

| 文件 | 用途 |
|---|---|
| `fish-pocket-promo-zh.mp4` / `-en.mp4` | 36 秒成片，1080p60，9.0MB，低于 GitHub 免费计划 10MB 的视频附件上限 |
| `poster-zh.png` / `-en.png` | 封面，即成片第一帧 |

画面含吉祥物，这部分按 CC BY-NC-SA 4.0 使用，不可商用，见 `THIRD_PARTY_NOTICES.md`。

## 怎么做的

App 画面是 iOS 模拟器里的真实截图，模型换成了本地脚本接口 `src/capture/mock-llm.mjs`，所以回复是写好的，但写文件、`git clone`、`node`、审批、灵动岛和锁屏实时活动都是 App 真实执行的结果。`simctl recordVideo` 在这台机器上会报错，所以用 `src/capture/shots.sh` 连拍，放慢模型回复，合成时再加速并做相邻帧融合。

- `src/promo.js`、`src/index.html`：时间线，每一帧都是时间 `t` 的纯函数，文案在 `COPY` 里
- `src/render.py`：用 Chrome 无头模式逐帧截图，交给 ffmpeg 编码
- `src/audio.py`：用 numpy 从零合成配乐和音效，不含第三方音频

`src/frames/` 是采集帧（约 105MB），不进 git。重新渲染需要先重新采集。

iPad 场景用的是 `docs/assets/ipad.png` 和 `terminal.png` 两张真实截图，不依赖采集帧。

### 底图模式：没有采集帧时改文案

画面的布局是固定的：每个用到采集帧的场景，手机都只在左半边或右半边，文字在另一半。所以可以把上一版成片逐帧拆成 JPEG 当底图（`src/plates/`，不进 git），`promo.js` 只在手机那一半露出底图，交界处在空背景里羽化，文字、iPad 场景、结尾全部重新渲染。前提是 `T` 里的场景时间和各场景的手机位置都不变，否则底图对不上。

```bash
mkdir -p src/plates/zh && ffmpeg -i fish-pocket-promo-zh.mp4 -q:v 2 src/plates/zh/%05d.jpg
```

```bash
python3 src/render.py video --lang zh --plate plates/zh --fps 60 --out src/out/master-zh.mp4 --audio src/out/audio.wav
```

Linux 上没有 Chrome 时加 `--browser <chromium 路径>`。苹方和 SF 字体只有 macOS 有，其他系统会依次回退到 Inter、Noto Sans SC、JetBrains Mono，需要先装好这几个字体。当前这一版成片就是在 Linux 上用底图模式渲染的，所以字体是 Inter 和 Noto Sans SC。

```bash
python3 src/audio.py src/out/audio.wav
```

```bash
python3 src/render.py video --lang zh --fps 60 --out src/out/master-zh.mp4 --audio src/out/audio.wav
```
