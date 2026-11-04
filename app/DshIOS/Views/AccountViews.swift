import SafariServices
import SwiftUI

/// What the app can and cannot see of a DeepSeek sign-in, shown wherever sign-in starts.
struct SignInPrivacyNote: View {
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.shield").font(.subheadline).foregroundStyle(Palette.secondary)
            Text("登录在 DeepSeek 官方页面完成，本 App 读不到你的任何登录信息：登录页运行在与 App 隔离的系统 Safari 中。")
                .font(.footnote)
                .foregroundStyle(Palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.control, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// The official SignInDialog: its title and actions follow `account/watch`'s
/// attempt. Platform's authorize page opens in an in-app Safari; the engine
/// receives the callback on 127.0.0.1, and the sheets close on their own
/// once the account is stored.
struct SignInSheet: View {
    /// Start signing in on appear (the 登录 buttons outside this sheet).
    var autoStart = false
    /// The API Key alternative; nil hides it.
    var addAPIKey: (() -> Void)?

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var safari: SFSafariViewController?
    @State private var openedAttempt: String?
    @State private var busy = false
    @State private var localFailed = false
    @State private var copied: Bool?

    private var account: AccountModel { app.account }
    private var phase: String? { account.phase }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Text(title).font(.title3.weight(.semibold)).foregroundStyle(Palette.ink)
                if account.attemptActive { ProgressView().controlSize(.small) }
            }
            description
            SignInPrivacyNote()
            Spacer(minLength: 0)
            actions
        }
        .padding(.horizontal, 20)
        .padding(.top, 28)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Palette.background)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(phase == "committing")
        .task {
            if autoStart && !account.attemptActive && !account.signedIn { await start() }
            else { openBrowserIfNeeded() }
        }
        .onChange(of: account.view) { _, _ in update() }
        .onDisappear {
            // Closing the dialog gives the attempt up, as on the web; Safari covering it does not.
            guard safari?.presentingViewController == nil else { return }
            if account.attemptActive && phase != "committing" { Task { await account.cancelSignIn() } }
        }
    }

    private var title: LocalizedStringKey {
        if localFailed || phase == "failed" { return "登录失败" }
        if phase == "expired" { return "登录已超时" }
        if account.attemptActive { return "等待登录" }
        return "开始使用"
    }

    @ViewBuilder
    private var description: some View {
        Group {
            if localFailed || phase == "failed" {
                Text(account.attempt?["errorCode"].string == "no-response" ? "操作未完成，可能是网络异常，请检查你的网络状况后重试" : "操作未完成，请重试。")
            } else if phase == "expired" {
                Text("请重新登录后继续操作。")
            } else if account.attemptActive {
                VStack(alignment: .leading, spacing: 6) {
                    Text("没有自动打开登录页？也可以复制登录链接，在其他浏览器里完成登录。")
                    Button(copyLabel) { copyLink() }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .disabled(account.authorizeURL(colorScheme) == nil)
                }
            } else {
                Text("登录 DeepSeek 账号，或添加 API Key，即可开始使用。你的项目和文件保存在本地。")
            }
        }
        .font(.subheadline)
        .foregroundStyle(Palette.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var copyLabel: LocalizedStringKey {
        switch copied {
        case true?: "链接已复制"
        case false?: "复制失败"
        case nil: "复制登录链接"
        }
    }

    @ViewBuilder
    private var actions: some View {
        HStack(spacing: 12) {
            if account.attemptActive {
                Button("取消") { Task { await account.cancelSignIn() } }
                    .buttonStyle(.capsule(.outline))
                    .disabled(phase == "committing")
                Button("打开浏览器") { account.authorizeURL(colorScheme).map(openBrowser) }
                    .buttonStyle(.capsule())
                    .disabled(phase == "committing" || account.authorizeURL(colorScheme) == nil)
            } else {
                if let addAPIKey {
                    Button("添加 API Key") { dismiss(); addAPIKey() }
                        .buttonStyle(.capsule(.outline))
                }
                Button(phase == "expired" || phase == "failed" || localFailed ? "重新登录" : "登录") { Task { await start() } }
                    .buttonStyle(.capsule())
                    .disabled(busy)
            }
        }
    }

    private func start() async {
        busy = true
        localFailed = false
        defer { busy = false }
        do {
            try await account.startSignIn()
            openBrowserIfNeeded()
        } catch {
            localFailed = true
            Haptics.error()
        }
    }

    /// Open the authorize page once per attempt, as soon as its URL arrives.
    private func openBrowserIfNeeded() {
        guard account.attemptActive, let id = account.attempt?["id"].string, openedAttempt != id,
              let url = account.authorizeURL(colorScheme) else { return }
        openedAttempt = id
        copied = nil
        openBrowser(url)
    }

    private func openBrowser(_ url: URL) {
        InAppSafari.close(safari)
        safari = InAppSafari.open(url)
    }

    private func closeBrowser() {
        InAppSafari.close(safari)
        safari = nil
    }

    private func update() {
        if account.signedIn {
            Haptics.success()
            // Safari sits on this sheet: take it down first, then the sheet.
            let open = safari?.presentingViewController != nil
            closeBrowser()
            Task {
                if open { try? await Task.sleep(for: .milliseconds(450)) }
                dismiss()
            }
            return
        }
        if ["failed", "expired", "cancelled", "succeeded"].contains(phase ?? "") { closeBrowser() }
        openBrowserIfNeeded()
    }

    private func copyLink() {
        guard let url = account.authorizeURL(colorScheme) else { copied = false; return }
        copyToPasteboard(url.absoluteString)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = nil
        }
    }
}

/// 设置 → 账号与余额 (`settings.section#account`): identity, wallet balances,
/// usage and top-up, with the API Key alternative and sign-out below.
struct AccountPage: View {
    @Environment(AppModel.self) private var app
    @State private var signingIn = false
    @State private var autoStart = false
    @State private var signOutCheck: SignOutCheck?
    @State private var checkingTasks = false
    @State private var signOutFailed = false
    @State private var keySet = false
    @State private var editingKey = false
    @State private var keyDraft = ""

    enum SignOutCheck: Identifiable { case idle, running, unknown; var id: Self { self } }

    private var account: AccountModel { app.account }

    var body: some View {
        List {
            if !account.signedIn && !account.attemptActive {
                signedOut
            } else {
                identity
                if account.signedIn { balances }
            }
            Section {
                Button(action: editKey) {
                    HStack {
                        Text("API Key").foregroundStyle(Palette.ink)
                        Spacer()
                        Text(keySet ? "已设置" : "未设置").foregroundStyle(Palette.secondary)
                    }
                }
            } footer: {
                Text("登录账号或填写 API Key，二选一即可使用 DeepSeek 模型。")
            }
            .groupedRow()
            if account.signedIn {
                Section {
                    Button("退出登录", role: .destructive) { Task { await checkSignOut() } }
                        .disabled(checkingTasks)
                } footer: {
                    if signOutFailed { Text("操作未完成，请重试。").foregroundStyle(Palette.removed) }
                }
                .groupedRow()
            }
        }
        .groupedList()
        .navigationTitle("账号与余额")
        .navigationBarTitleDisplayMode(.inline)
        .task { await account.refresh() }
        .task(id: app.revision("credentials/reference-updated")) { await loadKey() }
        .refreshable { await account.refresh() }
        .sheet(isPresented: $signingIn) {
            SignInSheet(autoStart: autoStart, addAPIKey: { Task { try? await Task.sleep(for: .milliseconds(400)); editKey() } })
                .environment(app)
        }
        // Here, not on 设置: presenting from a covered view waits until it is back on screen.
        .alert("DeepSeek API Key", isPresented: $editingKey) {
            SecureField("sk-…", text: $keyDraft)
            Button("取消", role: .cancel) {}
            if keySet { Button("清除", role: .destructive) { Task { _ = try? await app.client.call("credentials/unset", ["ref": "DEEPSEEK_API_KEY"]); await loadKey() } } }
            Button("保存") {
                Task {
                    await app.perform { try await app.client.call("credentials/set", ["ref": "DEEPSEEK_API_KEY", "value": .string(keyDraft.trimmingCharacters(in: .whitespacesAndNewlines))]) }
                    await loadKey()
                }
            }
            // Saving nothing would wipe the key; 清除 is the way to remove it.
            .disabled(keyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("只保存在本机引擎里，任何读取接口都不会返回它。")
        }
        .alert("退出登录", isPresented: Binding(get: { signOutCheck != nil }, set: { if !$0 { signOutCheck = nil } }), presenting: signOutCheck) { _ in
            Button("取消", role: .cancel) {}
            Button("退出登录", role: .destructive) { Task { await signOut() } }
        } message: { check in
            switch check {
            case .idle: Text("退出登录不会丢失任何数据，你仍可以登录此账号。")
            case .running: Text("当前有进程正在执行中，轻点“退出登录”，将会打断进程，是否即刻退出登录？")
            case .unknown: Text("暂时无法确认任务状态。退出登录可能会中断使用此账号的任务，是否继续？")
            }
        }
    }

    private func loadKey() async {
        if let value = try? await app.client.call("credentials/describe", ["refs": ["DEEPSEEK_API_KEY"]]) {
            keySet = value.array.first?["configured"].bool ?? value["DEEPSEEK_API_KEY"]["configured"].bool ?? false
        }
    }

    private func editKey() {
        keyDraft = ""
        editingKey = true
    }

    private var signedOut: some View {
        Section {
            VStack(spacing: 16) {
                VStack(spacing: 4) {
                    Text("当前未登录 DeepSeek Harness 账号").font(.subheadline).foregroundStyle(Palette.ink)
                    Text(account.streamFailed ? "操作未完成，请重试。" : "登录 DeepSeek Harness 账号获取专属 API Key")
                        .font(.footnote).foregroundStyle(Palette.secondary)
                }
                .multilineTextAlignment(.center)
                Button("登录") { autoStart = true; signingIn = true }
                    .buttonStyle(.capsule(height: 44, fill: false))
                    .disabled(account.view == nil)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        } footer: {
            SignInPrivacyNote().padding(.top, 8)
        }
        .groupedRow()
    }

    private var identity: some View {
        Section {
            HStack(spacing: 12) {
                AccountAvatar(url: account.signedIn ? account.profileValue?["avatarUrl"].string.flatMap(URL.init(string:)) : nil)
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.signedIn ? (account.displayName ?? String(localized: "已登录 DeepSeek")) : String(localized: "尚未登录"))
                        .font(.callout.weight(.medium)).foregroundStyle(Palette.ink).lineLimit(1)
                    Text(statusLine).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(1)
                }
                Spacer(minLength: 8)
                if account.signedIn, let url = account.accountInfoURL {
                    Button { open(url) } label: {
                        HStack(spacing: 2) {
                            Text("更多账号信息")
                            Image(systemName: "arrow.up.right").font(.caption2.weight(.semibold))
                        }
                        .font(.footnote)
                        .foregroundStyle(Palette.ink)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 4)
            if account.attemptActive {
                HStack(spacing: 10) {
                    Button("打开浏览器") { autoStart = false; signingIn = true }
                        .buttonStyle(.capsule(.outline, height: 44, fill: false))
                        .disabled(account.attempt?["authorizeUrl"].string == nil)
                    Button("取消") { Task { await account.cancelSignIn() } }
                        .buttonStyle(.capsule(.outline, height: 44, fill: false))
                        .disabled(account.phase == "committing")
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .groupedRow()
    }

    private var statusLine: String {
        if account.streamFailed || account.phase == "failed" { return String(localized: "操作未完成，请重试。") }
        if account.phase == "expired" { return String(localized: "登录已过期，请重试。") }
        if account.attemptActive {
            switch account.phase {
            case "initializing": return String(localized: "正在发起登录…")
            case "waiting-browser": return String(localized: "请在浏览器中继续")
            default: return String(localized: "正在完成登录…")
            }
        }
        if account.signedIn {
            if let contact = account.profileValue?["contact"].string { return contact }
            return account.profile == nil ? String(localized: "加载中…") : String(localized: "账号资料暂不可用")
        }
        return String(localized: "登录 DeepSeek 账号以开始使用")
    }

    private var balances: some View {
        Section {
            LabeledContent("充值余额") {
                if let wallets = account.wallets, !wallets.isEmpty {
                    amounts(wallets)
                } else if account.balance == nil {
                    Text("加载中…").foregroundStyle(Palette.secondary)
                } else {
                    platformLink
                }
            }
            if account.showsBonusRow {
                LabeledContent("赠金余额") {
                    if !account.bonusWallets.isEmpty {
                        amounts(account.bonusWallets)
                    } else if account.balance == nil {
                        Text("加载中…").foregroundStyle(Palette.secondary)
                    } else {
                        platformLink
                    }
                }
            }
            HStack(spacing: 10) {
                Text("更多").foregroundStyle(Palette.secondary)
                Spacer()
                Button("查询用量") { open(account.usageURL) }
                    .buttonStyle(.capsule(.outline, height: 44, fill: false))
                    .disabled(account.usageURL == nil)
                Button("充值") { open(account.topUpURL) }
                    .buttonStyle(.capsule(height: 44, fill: false))
                    .disabled(account.topUpURL == nil)
            }
        }
        .groupedRow()
    }

    private func amounts(_ wallets: [JSON]) -> some View {
        Text(wallets.map { formatBalance($0["balance"].string ?? "0", currency: $0["currency"].string) }.joined(separator: " + "))
            .font(.title3.weight(.medium).monospacedDigit())
            .foregroundStyle(Palette.ink)
    }

    /// A wallet read that failed still leads to Platform, where the balance can be checked.
    private var platformLink: some View {
        Button("前往开放平台查看") { open(account.usageURL) }
            .font(.subheadline)
            .foregroundStyle(Palette.secondary)
            .underline()
            .buttonStyle(.plain)
            .disabled(account.usageURL == nil)
    }

    /// Platform pages; coming back (from top-up most of all), balances may have moved.
    private func open(_ url: URL?) {
        guard let url else { return }
        InAppSafari.open(url) { Task { await account.refreshDetails() } }
    }

    private func checkSignOut() async {
        checkingTasks = true
        signOutFailed = false
        let running = await account.hasRunningTasks()
        checkingTasks = false
        signOutCheck = running == nil ? .unknown : running! ? .running : .idle
    }

    private func signOut() async {
        do {
            try await account.signOut()
        } catch {
            signOutFailed = true
            Haptics.error()
        }
    }
}

/// Platform's profile picture, or the person glyph when there is none or it fails to load.
struct AccountAvatar: View {
    let url: URL?
    var size: CGFloat = 36

    var body: some View {
        AsyncImage(url: url) { image in
            image.resizable().scaledToFill()
        } placeholder: {
            Image(systemName: "person.fill").font(.system(size: size * 0.45)).foregroundStyle(Palette.faint)
        }
        .frame(width: size, height: size)
        .background(Palette.control)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }
}

/// Shell notices from the account: the toast line and the bonus card stack.
struct AccountNotices: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 8) {
            if let toast = app.account.toast {
                Text(toast)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.onInk)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Palette.ink, in: Capsule())
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: toast) {
                        Haptics.warning()
                        try? await Task.sleep(for: .seconds(3))
                        withAnimation { app.account.toast = nil }
                    }
            }
            if let notice = app.account.bonuses.first(where: { !$0.expired }) {
                BonusCard(notice: notice) { withAnimation { app.account.dismiss(notice) } }
                    .onAppear { app.account.markShown(notice) }
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(.top, 4)
        .animation(.snappy, value: app.account.toast)
        .animation(.snappy, value: app.account.bonuses)
    }
}

private struct BonusCard: View {
    let notice: BonusNotice
    let close: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "gift").font(.callout).foregroundStyle(Palette.ink)
            VStack(alignment: .leading, spacing: 2) {
                Text(notice.title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                if !notice.message.isEmpty {
                    Text(notice.message).font(.footnote).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            Button(action: close) { Image(systemName: "xmark").font(.caption.weight(.semibold)).foregroundStyle(Palette.secondary) }
                .accessibilityLabel("关闭")
        }
        .padding(14)
        .frame(maxWidth: 420)
        .background(Palette.grouped, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.stroke))
        .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
    }
}
