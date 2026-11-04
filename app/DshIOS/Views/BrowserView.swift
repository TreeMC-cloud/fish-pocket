import SwiftUI
import WebKit

/// The workbench browser (S-87): one WKWebView that lives as long as the conversation
/// (closing the workbench keeps the page), its address, and the last page of the session. There is no proxy and no RPC;
/// the engine runs in this app, so `localhost` reaches a dev server the agent started.
@MainActor
@Observable
final class BrowserModel: NSObject {
    var address = ""
    /// The refused address's reason, shown under the bar.
    var addressError: String?
    private(set) var started = false
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var loading = false
    private(set) var failure: String?
    private(set) var lastURL: String?
    /// What is on screen now, for the bar's menu.
    private(set) var page: URL?

    @ObservationIgnored let webView: WKWebView
    @ObservationIgnored private let storageKey: String
    @ObservationIgnored private let origin: URL
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []

    init(sessionId: String, origin: URL) {
        storageKey = "dsh.browser.last.\(sessionId)"
        self.origin = origin
        let configuration = WKWebViewConfiguration()
        // Pages stay away from the store the engine's web view keeps its session cookie in.
        configuration.websiteDataStore = .nonPersistent()
        configuration.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        lastURL = UserDefaults.standard.string(forKey: storageKey)
        super.init()
        webView.isInspectable = true
        webView.allowsBackForwardNavigationGestures = true
        webView.navigationDelegate = self
        webView.uiDelegate = self
        observations = [
            webView.observe(\.canGoBack) { [weak self] view, _ in MainActor.assumeIsolated { self?.canGoBack = view.canGoBack } },
            webView.observe(\.canGoForward) { [weak self] view, _ in MainActor.assumeIsolated { self?.canGoForward = view.canGoForward } },
            webView.observe(\.isLoading) { [weak self] view, _ in MainActor.assumeIsolated { self?.loading = view.isLoading } },
            webView.observe(\.url) { [weak self] view, _ in MainActor.assumeIsolated { self?.navigated(to: view.url) } },
        ]
    }

    private func navigated(to url: URL?) {
        guard let url, url.scheme == "http" || url.scheme == "https" else { return }
        page = url
        address = url.absoluteString
        lastURL = url.absoluteString
        UserDefaults.standard.set(url.absoluteString, forKey: storageKey)
    }

    /// Open what the bar holds, or say why not.
    func go(_ input: String? = nil) {
        switch Self.parse(input ?? address, applicationOrigin: origin) {
        case .success(let url):
            addressError = nil
            failure = nil
            started = true
            address = url.absoluteString
            webView.load(URLRequest(url: url))
        case .failure(let refusal):
            addressError = refusal.message
        }
    }

    func reload() {
        failure = nil
        if webView.url == nil, let lastURL { go(lastURL) } else if loading { webView.stopLoading() } else { webView.reload() }
    }

    func back() { webView.goBack() }
    func forward() { webView.goForward() }

    fileprivate func failed(_ error: Error) {
        let error = error as NSError
        // A newer navigation replaced this one.
        if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled { return }
        failure = String(localized: "页面加载失败 (\(error.code)): \(error.localizedDescription)")
    }

    fileprivate func clearFailure() { failure = nil }

    enum Refusal: Error {
        case empty, invalid, credentials, applicationOrigin, unsupportedScheme

        var message: String {
            switch self {
            case .empty: String(localized: "请输入地址。")
            case .invalid: String(localized: "这个地址无效或过长。")
            case .credentials: String(localized: "地址不能包含用户名或密码。")
            case .applicationOrigin: String(localized: "不能在嵌入浏览器中打开 DSH 应用自身。")
            case .unsupportedScheme: String(localized: "只支持 HTTP 和 HTTPS 地址；本地文件请使用文档预览。")
            }
        }
    }

    /// `parseBrowserAddress`, with one change: a bare loopback address means `http`
    /// here, because that is what a dev server on this device speaks.
    static func parse(_ input: String, applicationOrigin: URL) -> Result<URL, Refusal> {
        let trimmed = input.trimmed
        if trimmed.isEmpty { return .failure(.empty) }
        if trimmed.count > 16384 { return .failure(.invalid) }
        let hasScheme = trimmed.range(of: #"^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))"#, options: .regularExpression) != nil
        let candidate = hasScheme ? trimmed : (isLoopback(trimmed) ? "http://" : "https://") + trimmed
        guard let url = URL(string: candidate), let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return .failure(.invalid) }
        if components.user != nil || components.password != nil { return .failure(.credentials) }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return .failure(.unsupportedScheme) }
        guard let host = url.host(), !host.isEmpty else { return .failure(.invalid) }
        if sameOrigin(url, applicationOrigin) { return .failure(.applicationOrigin) }
        return .success(url)
    }

    private static func isLoopback(_ address: String) -> Bool {
        let host = address.prefix { !"/?#".contains($0) }
        return host == "localhost" || host.hasPrefix("localhost:") || host.hasPrefix("127.") || host.hasPrefix("0.0.0.0") || host.hasPrefix("[::1]")
    }

    private static func sameOrigin(_ url: URL, _ origin: URL) -> Bool {
        func port(_ url: URL) -> Int? { url.port ?? (url.scheme == "https" ? 443 : url.scheme == "http" ? 80 : nil) }
        let hosts: Set<String> = ["localhost", "127.0.0.1", "[::1]", "::1"]
        let sameHost = url.host() == origin.host() || (hosts.contains(url.host() ?? "") && hosts.contains(origin.host() ?? ""))
        return sameHost && port(url) == port(origin)
    }
}

extension BrowserModel: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { clearFailure() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(error) }

    /// `target=_blank` and `window.open` stay in the one page this bar controls.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }
}

struct WorkbenchBrowser: View {
    @Bindable var model: BrowserModel
    @FocusState private var editing: Bool

    /// Where dev servers usually listen; the agent's own port goes in the bar.
    private static let commonPorts = [3000, 5173, 8000, 8080]

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                BrowserWebView(webView: model.webView).opacity(model.started ? 1 : 0)
                if !model.started { start }
            }
            if let error = model.addressError {
                notice(error)
            } else if let failure = model.failure {
                notice(failure)
            }
            bar
        }
        .background(Palette.background)
    }

    /// Under the thumb, as in Safari; it rides up on the keyboard while typing an address.
    private var bar: some View {
        HStack(spacing: 0) {
            button("chevron.backward", "后退", enabled: model.canGoBack) { model.back() }
            button("chevron.forward", "前进", enabled: model.canGoForward) { model.forward() }
            HStack(spacing: 6) {
                TextField("输入 HTTP(S) 地址", text: $model.address)
                    .font(.subheadline)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($editing)
                    .onSubmit { model.go() }
                if model.loading { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .background(Palette.bubble, in: Capsule())
            .padding(.horizontal, 4)
            more
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }

    private var more: some View {
        Menu {
            Button { model.reload() } label: {
                Label(model.loading ? "停止" : "刷新", systemImage: model.loading ? "xmark" : "arrow.clockwise")
            }
            .disabled(!model.started && model.lastURL == nil)
            Button {
                if let url = model.page { UIApplication.shared.open(url) }
            } label: {
                Label("在系统浏览器中打开", systemImage: "safari")
            }
            .disabled(model.page == nil)
            if let url = model.page { ShareLink("分享", item: url) }
        } label: {
            Image(systemName: "ellipsis")
                .font(.body)
                .foregroundStyle(Palette.ink)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("更多")
    }

    private func button(_ icon: String, _ label: LocalizedStringKey, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button { Haptics.tap(); action() } label: {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(enabled ? Palette.ink : Palette.faint)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .disabled(!enabled)
        .accessibilityLabel(label)
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Palette.removed)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 8)
    }

    /// Before the first page: where the session left off, and the local ports.
    private var start: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if let last = model.lastURL {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("上次打开").font(.footnote).foregroundStyle(Palette.secondary)
                        Text(last).font(.callout).lineLimit(2).truncationMode(.middle)
                        Button("恢复页面") { model.go(last) }.buttonStyle(.capsule(height: 44, fill: false))
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("本机服务").font(.footnote).foregroundStyle(Palette.secondary)
                    Text("智能体在这台设备上启动的开发服务器，用 localhost 打开。").font(.footnote).foregroundStyle(Palette.secondary)
                    HStack(spacing: 8) {
                        ForEach(Self.commonPorts, id: \.self) { port in
                            Button(":\(String(port))") { model.go("localhost:\(port)") }
                                .buttonStyle(.capsule(.secondary, height: 44, fill: false))
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(24)
        }
        .scrollDismissesKeyboard(.interactively)
    }
}

private struct BrowserWebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
