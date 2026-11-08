import SwiftUI
import WebKit

/// 消息里 ```html 代码块的预览。
///
/// 为什么需要它：AI 经常直接把一个网页的源码贴在回复里——一个几百行的
/// ```html 块。用户想看效果只能复制出去、存成文件、再找浏览器打开。
/// 而这台机器上本来就有 WebView，直接渲染就行。
///
/// 为什么写临时文件而不是 `loadHTMLString`：
///   很多页面用相对路径引本地资源，`loadHTMLString` 的 baseURL 是 about:blank，
///   相对路径全废。落到工作区的临时文件再 loadFileURL，相对路径就能对上。
struct HTMLPreviewSheet: View {
    let html: String
    /// 相对路径的基准目录（会话工作区）。没有就落在临时目录。
    var baseDirectory: URL?
    var title: String = String(localized: "网页预览")

    @Environment(\.dismiss) private var dismiss
    @State private var fileURL: URL?
    @State private var failed: String?

    var body: some View {
        NavigationStack {
            Group {
                if let fileURL {
                    HTMLWebView(url: fileURL)
                        .ignoresSafeArea(edges: .bottom)
                } else if let failed {
                    ContentUnavailableView {
                        Label("无法预览", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(failed)
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("完成") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        if let fileURL {
                            ShareLink(item: fileURL) { Label("分享网页文件", systemImage: "square.and.arrow.up") }
                        }
                        Button {
                            copyToPasteboard(html)
                        } label: {
                            Label("复制源码", systemImage: "doc.on.doc")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .task { write() }
        .onDisappear {
            // 临时文件用完就删：预览是随手看的东西，不该在工作区留垃圾。
            if let fileURL, fileURL.path.contains("/tmp/") {
                try? FileManager.default.removeItem(at: fileURL)
            }
        }
    }

    private func write() {
        let directory = baseDirectory ?? FileManager.default.temporaryDirectory
        let name = "preview-\(UUID().uuidString.prefix(8)).html"
        let url = directory.appendingPathComponent(name)
        do {
            try html.write(to: url, atomically: true, encoding: .utf8)
            fileURL = url
        } catch {
            failed = "写入临时文件失败：\(error.localizedDescription)"
        }
    }
}

/// 只读预览用的 WebView：不给导航，不允许跳出到系统浏览器。
private struct HTMLWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // 预览是本地内容，不需要持久化存储。
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .clear
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        // 内容不变就不重载：SwiftUI 会频繁调用这里，重载会闪。
        guard view.url != url else { return }
        view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        /// 点外链不在预览里跑（预览是只读的一张快照），交给系统浏览器。
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.allow) }
            if url.isFileURL { return decisionHandler(.allow) }
            if action.navigationType == .linkActivated {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }
    }
}

/// 引擎送来的预览请求。单独一个类型是因为 `.sheet(item:)` 要求 Identifiable。
struct PreviewItem: Identifiable {
    let url: URL
    let title: String
    var id: String { "\(url.path)#\(title)" }
}
