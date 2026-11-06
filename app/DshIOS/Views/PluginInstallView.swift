import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The install sheet, presented from UIKit over whatever is on screen: a hidden
/// install's toast must be able to bring it back from any page, and the plugin
/// page that started it may be long gone.
@MainActor
enum PluginInstallPresenter {
    private final class Delegate: NSObject, UIAdaptivePresentationControllerDelegate {
        weak var app: AppModel?
        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            MainActor.assumeIsolated {
                PluginInstallPresenter.controller = nil
                app?.pluginInstall.sheetDismissed()
            }
        }
    }

    private static weak var controller: UIViewController?
    private static let delegate = Delegate()

    static func show(_ app: AppModel) {
        guard controller == nil else { return }
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard var top = scene?.keyWindow?.rootViewController else { return }
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        let host = UIHostingController(rootView: PluginInstallSheet().environment(app))
        host.modalPresentationStyle = .pageSheet
        host.sheetPresentationController?.prefersGrabberVisible = true
        delegate.app = app
        host.presentationController?.delegate = delegate
        controller = host
        top.present(host, animated: true)
    }

    static func hide() {
        guard let controller else { return }
        self.controller = nil
        if controller.presentingViewController != nil, !controller.isBeingDismissed { controller.dismiss(animated: true) }
    }
}

/// 添加插件: the form, then the install's progress, its result or its failure (P-10).
struct PluginInstallSheet: View {
    @Environment(AppModel.self) private var app

    private var task: PluginInstallTask { app.pluginInstall }
    private var showsForm: Bool { (task.phase == .idle || task.phase == .checking) && task.confirmed == nil }

    var body: some View {
        NavigationStack {
            Group {
                switch task.phase {
                case .idle where task.confirmed == nil, .checking where task.confirmed == nil:
                    InstallForm()
                case .done:
                    InstallDone()
                case .failed:
                    InstallFailed()
                case .unknown:
                    InstallUnknown()
                case .idle:
                    InstallConfirmedRefused()
                default:
                    InstallProgress()
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if showsForm {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { task.close() } }
                } else {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { task.close() } label: { Image(systemName: "xmark") }
                            .accessibilityLabel(task.pending ? "在后台继续" : "关闭")
                    }
                }
            }
            .background(Palette.background)
        }
        .tint(Palette.ink)
        .overlay(alignment: .top) { ShellNotices() }
        // A lost answer is asked about again on every reconnect.
        .task(id: app.generation) { await task.reconcile() }
    }

    private var title: LocalizedStringKey {
        switch task.phase {
        case .idle where task.confirmed != nil: "无法安装此插件"
        case .idle: "添加插件"
        case .checking: task.confirmed == nil ? "添加插件" : "安装插件"
        case .done: "已安装"
        case .failed: failedTitle
        case .unknown: "未能获取安装结果"
        case .unconfirmed: "安装状态尚未确认"
        default: "插件安装中…"
        }
    }

    private var failedTitle: LocalizedStringKey {
        if task.githubRecovery != nil {
            return task.failure?.kind == "timeout" ? "连接 GitHub 超时" : "无法访问 GitHub"
        }
        return "插件安装失败"
    }
}

/// The first screen: the spec or a folder, and one line on the risk. 安装 is in the toolbar,
/// where the keyboard never covers it; the registry is a page of its own.
private struct InstallForm: View {
    @Environment(AppModel.self) private var app
    @State private var importing = false
    @State private var copying = false
    /// The picked folder, shown by name: its path means nothing to read.
    @State private var folder: (name: String, path: String)?
    @FocusState private var specFocused: Bool

    private var task: PluginInstallTask { app.pluginInstall }
    private var checking: Bool { task.phase == .checking }
    private var empty: Bool { task.spec.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        @Bindable var task = task
        Form {
            Section {
                if let folder, folder.path == task.spec {
                    HStack {
                        Label(folder.name, systemImage: "folder").foregroundStyle(Palette.ink).lineLimit(1)
                        Spacer()
                        Button { self.folder = nil; edit("") } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.faint).hitTarget()
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("取消选择")
                    }
                } else {
                    TextField("dsh-plugin-whale-pet", text: Binding(get: { task.spec }, set: { edit($0) }))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($specFocused)
                        .submitLabel(.go)
                        .onSubmit { task.run() }
                        .disabled(checking)
                }
                if let problem = task.inputProblemText {
                    Text(problem).font(.footnote).foregroundStyle(Palette.removed)
                }
                if let hint = templateHint {
                    Text(hint).font(.footnote).foregroundStyle(Palette.secondary)
                }
            } header: {
                Text("包名或 GitHub 地址")
            } footer: {
                Text("插件以你的权限运行，只安装信任的来源。")
            }
            .groupedRow()

            Section {
                Button { importing = true } label: {
                    HStack {
                        Label("选择文件夹", systemImage: "folder").foregroundStyle(Palette.ink)
                        Spacer()
                        if copying { ProgressView().controlSize(.small) }
                    }
                }
                .disabled(checking || copying)
                Button { task.registryOpen = true } label: {
                    HStack {
                        LabeledContent("安装源", value: chosenName).foregroundStyle(Palette.ink)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Palette.faint)
                    }
                }
                .disabled(checking)
            }
            .groupedRow()
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.folder]) { adopt($0) }
        .navigationDestination(isPresented: $task.registryOpen) { InstallRegistryPage() }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if checking {
                    ProgressView()
                } else {
                    Button("安装") {
                        specFocused = false
                        task.run()
                    }
                    .disabled(empty || copying)
                }
            }
        }
        .onAppear {
            if task.spec.isEmpty { specFocused = true }
        }
    }

    private func edit(_ text: String) {
        guard !checking else { return }
        task.spec = text
        task.clearInputError()
    }

    private func adopt(_ result: Result<URL, Error>) {
        guard case .success(let url) = result else { return }
        copying = true
        Task {
            defer { copying = false }
            do {
                let path = try await Self.readablePath(of: url)
                folder = (url.lastPathComponent, path)
                edit(path)
            } catch {
                app.showToast(String(localized: "无法读取这个文件夹"), duration: 5)
            }
        }
    }

    /// A path the engine can keep reading. A picked folder is outside the engine's tree and
    /// under the picker's security scope, and an installed folder is linked, not copied: it is
    /// copied in first (`~/.plugins` stays out of the workspace browser).
    nonisolated private static func readablePath(of url: URL) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            let files = FileManager.default
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let path = EnginePaths.home + "/.plugins/" + url.lastPathComponent
            let target = EnginePaths.real(path)
            try files.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if files.fileExists(atPath: target.path) { try files.removeItem(at: target) }
            try files.copyItem(at: url, to: target)
            return path
        }.value
    }

    /// A pasted Git template with its placeholders still in it.
    private var templateHint: LocalizedStringKey? {
        let spec = task.spec.trimmingCharacters(in: .whitespaces)
        return spec.contains("<") || spec.contains("your-") || spec.contains("{") ? "请替换为实际的 Git 仓库地址" : nil
    }

    private var chosenName: String {
        switch task.registry {
        case .custom: String(localized: "自定义地址")
        case .offered(let registry): PluginInstallTask.registryName(registry, resolved: task.resolved).name
        }
    }
}

/// 安装源: pushed from the form, and by 更换安装源 or a refused address. A choice goes back; a
/// custom address stays for typing.
private struct InstallRegistryPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var customURL = ""

    private var task: PluginInstallTask { app.pluginInstall }
    private var custom: Bool {
        if case .custom = task.registry { return true }
        return false
    }

    var body: some View {
        List {
            Section {
                ForEach(Array(task.offeredRegistries.enumerated()), id: \.offset) { _, registry in
                    row(.offered(registry), name: PluginInstallTask.registryName(registry, resolved: task.resolved))
                }
                Button {
                    task.choose(.custom(customURL))
                    Haptics.select()
                } label: {
                    HStack {
                        Text("自定义地址").foregroundStyle(Palette.ink)
                        Spacer()
                        if custom { Image(systemName: "checkmark").foregroundStyle(Palette.ink) }
                    }
                }
                if custom {
                    TextField("https://npm.example.com/", text: $customURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: customURL) { _, url in task.choose(.custom(url)) }
                    if task.registryError {
                        Text("请输入以 http:// 或 https:// 开头的地址").font(.caption).foregroundStyle(Palette.removed)
                    }
                }
            }
            .groupedRow()
        }
        .groupedList()
        .navigationTitle("安装源")
        .navigationBarTitleDisplayMode(.inline)
        .keyboardDoneButton()
        .onAppear {
            if case .custom(let url) = task.registry { customURL = url }
        }
    }

    private func row(_ choice: RegistryChoice, name: (name: String, host: String)) -> some View {
        Button {
            task.choose(choice)
            Haptics.select()
            dismiss()
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(name.name).foregroundStyle(Palette.ink)
                    if name.host != name.name { Text(name.host).font(.caption).foregroundStyle(Palette.secondary) }
                }
                Spacer()
                if task.registry == choice { Image(systemName: "checkmark").foregroundStyle(Palette.ink) }
            }
        }
    }
}

/// What the install is about: the Host's name, one-liner and version.
private struct InstallSubject: View {
    @Environment(AppModel.self) private var app

    private var task: PluginInstallTask { app.pluginInstall }

    var body: some View {
        let subject = task.subject
        let name = task.confirmed?.title ?? subject?["name"].string ?? task.spec
        let version = task.confirmed?.version ?? subject?["version"].string
        VStack(spacing: 6) {
            Text(name).font(.callout.weight(.semibold)).foregroundStyle(Palette.ink).multilineTextAlignment(.center)
            // A folder's path is an implementation detail; the name above says which it is.
            if subject?["kind"].string != "path", task.confirmed != nil || name != task.spec {
                Text(task.spec).font(.caption.monospaced()).foregroundStyle(Palette.faint).multilineTextAlignment(.center)
            }
            if let description = subject?["description"].string, !description.isEmpty {
                Text(description).font(.footnote).foregroundStyle(Palette.secondary).multilineTextAlignment(.center)
            }
            if let version { Text("版本 \(version)").font(.footnote).foregroundStyle(Palette.secondary) }
            if let kind = kindText { Text(kind).font(.footnote).foregroundStyle(Palette.secondary) }
        }
        .frame(maxWidth: .infinity)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.stroke))
    }

    private var kindText: LocalizedStringKey? {
        switch task.subject?["kind"].string {
        case "path": "文件夹"
        case "git": "Git 仓库"
        case "tarball": "压缩包"
        default: nil
        }
    }
}

/// The pnpm commands of the run, folded behind 查看安装详情.
private struct InstallDetails: View {
    @Environment(AppModel.self) private var app

    private var task: PluginInstallTask { app.pluginInstall }

    var body: some View {
        @Bindable var task = task
        if !task.runs.isEmpty {
            DisclosureGroup(task.detailsOpen ? "收起安装详情" : "查看安装详情", isExpanded: $task.detailsOpen) {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(task.runs.enumerated()), id: \.element.id) { index, run in
                        InstallRunBlock(run: run, badge: badge(index))
                    }
                }
                .padding(.top, 8)
            }
            .font(.subheadline)
            .foregroundStyle(Palette.secondary)
        }
    }

    private func badge(_ index: Int) -> String? {
        guard let attempts = task.attempts, attempts.total > 1, attempts.registries.indices.contains(index) else { return nil }
        let name = PluginInstallTask.registryName(attempts.registries[index], resolved: task.resolved).name
        return String(localized: "第 \(index + 1) 次 · \(name)")
    }
}

/// One pnpm command: its command line, output (long logs fold their middle), state and exit code.
private struct InstallRunBlock: View {
    let run: InstallRun
    let badge: String?
    @State private var expanded = false

    private static let headLines = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let badge {
                Text(badge).font(.caption2).foregroundStyle(Palette.secondary)
                    .padding(.horizontal, 6).padding(.vertical, 1)
                    .background(Palette.control, in: Capsule())
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(run.command).font(.caption.monospaced()).foregroundStyle(Palette.ink)
            }
            outputText
            HStack(spacing: 8) {
                Text(state).font(.caption2).foregroundStyle(failed ? Palette.removed : Palette.secondary)
                Spacer()
                Button { copyToPasteboard(run.output) } label: {
                    Text("复制").font(.caption2.weight(.medium)).foregroundStyle(Palette.ink).hitTarget()
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.field, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var failed: Bool { run.settled && (run.exitCode ?? 1) != 0 }

    private var state: String {
        if !run.settled { return String(localized: "运行中") }
        if let code = run.exitCode {
            return code == 0 ? String(localized: "已完成") : String(localized: "失败 · 退出码 \(code)")
        }
        return String(localized: "失败 · 未正常退出")
    }

    @ViewBuilder
    private var outputText: some View {
        let lines = run.output.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if run.output.isEmpty {
            Text("无输出").font(.caption2).foregroundStyle(Palette.faint)
        } else if lines.count <= Self.headLines * 2 || expanded {
            Text(run.output).font(.caption2.monospaced()).foregroundStyle(Palette.secondary).textSelection(.enabled)
            if lines.count > Self.headLines * 2 {
                Button("收起") { expanded = false }.font(.caption2.weight(.medium)).foregroundStyle(Palette.ink)
            }
        } else {
            Text(lines.prefix(Self.headLines).joined(separator: "\n")).font(.caption2.monospaced()).foregroundStyle(Palette.secondary)
            Button("… 其余 \(lines.count - Self.headLines * 2) 行") { expanded = true }.font(.caption2.weight(.medium)).foregroundStyle(Palette.ink)
            Text(lines.suffix(Self.headLines).joined(separator: "\n")).font(.caption2.monospaced()).foregroundStyle(Palette.secondary)
        }
    }
}

/// A page of the install sheet past the form.
private struct InstallPage<Actions: View>: View {
    let content: AnyView
    @ViewBuilder let actions: Actions

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    content
                }
                .padding(20)
            }
            HStack(spacing: 12) { actions }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
        }
    }
}

/// `checking` (market entry) / `starting` / `running` / `cancelling` / `applying` / `unconfirmed`.
private struct InstallProgress: View {
    @Environment(AppModel.self) private var app

    private var task: PluginInstallTask { app.pluginInstall }

    var body: some View {
        InstallPage(content: AnyView(content)) {
            if task.phase == .unconfirmed {
                Button("核对安装状态") { Task { await task.reconcile() } }.buttonStyle(.capsule())
            }
            if task.phase == .unconfirmed || task.phase == .starting || task.phase == .running || task.phase == .checking {
                Button(task.phase == .checking ? "取消" : "取消安装") { Task { await task.cancel() } }.buttonStyle(.capsule(.outline))
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            InstallSubject()
            HStack(spacing: 10) {
                if task.phase != .unconfirmed { ProgressView().controlSize(.small) }
                Text(statusText).font(.subheadline).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let attempt = attemptText {
                Text(attempt).font(.footnote).foregroundStyle(Palette.waiting)
            }
            InstallDetails()
            Text("可以关闭此页，安装会在后台继续，结果会提示你。").font(.caption).foregroundStyle(Palette.faint)
        }
    }

    private var statusText: String {
        switch task.phase {
        case .checking: return String(localized: "正在检查…")
        case .cancelling: return String(localized: "正在停止安装…")
        case .applying: return String(localized: "正在应用配置，请稍候…")
        case .unconfirmed:
            let reason = task.failure?.reason ?? ""
            switch task.failure?.uncertainty {
            case "cancellation": return String(localized: "尚未确认安装已停止，请重试取消或等待安装结果。\(reason)")
            case "acceptance": return String(localized: "正在等待后端接收安装任务，收到确认后会自动重试取消。")
            default: return String(localized: "未收到安装结果，请核对安装状态。\(reason)")
            }
        case .running: return String(localized: "正在安装…")
        default: return String(localized: "正在准备安装…")
        }
    }

    /// `{previous} 不可用，正在改用 {registry} 重试（第 {index} 个源，共 {total} 个）`.
    private var attemptText: String? {
        guard let attempts = task.attempts, attempts.registries.count > 1 else { return nil }
        let current = attempts.registries[attempts.registries.count - 1], previous = attempts.registries[attempts.registries.count - 2]
        let name = PluginInstallTask.registryName(current, resolved: task.resolved).name
        let before = PluginInstallTask.registryName(previous, resolved: task.resolved).name
        return String(localized: "\(before) 不可用，正在改用 \(name) 重试（第 \(attempts.registries.count) 个源，共 \(attempts.total) 个）")
    }
}

private struct InstallDone: View {
    @Environment(AppModel.self) private var app

    private var task: PluginInstallTask { app.pluginInstall }

    var body: some View {
        InstallPage(content: AnyView(content)) {
            Button("完成") { task.close() }.buttonStyle(.capsule(.outline))
            if task.subject?["selection"].isNull != false, task.installed != nil {
                Button("立即启用") { Task { await task.enableInstalled() } }
                    .buttonStyle(.capsule())
                    .disabled(task.enabling)
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            InstallSubject()
            ForEach(Array(notes.enumerated()), id: \.offset) { _, note in
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(Palette.ink)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.control, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            InstallDetails()
        }
    }

    private var notes: [String] {
        var notes: [String] = []
        if task.restartRequired {
            notes.append(String(localized: "已安装，请重启 DSH 加载它。\(restartReasonText(task.restartReason))") + String(localized: "没有对话在运行时会自动重启引擎。"))
        }
        if let installed = task.installedVersion, let inspected = task.subject?["version"].string, installed != inspected, (task.attempts?.registries.count ?? 1) <= 1 {
            let exact = "\(task.installed ?? task.spec)@\(inspected)"
            notes.append(String(localized: "新发布的版本要过观察期才会自动安装，所以这次装的是 \(installed)，不是最新的 \(inspected)。确需最新版，请卸载后安装 \(exact)。"))
        }
        if !task.approvedBuilds.isEmpty {
            notes.append(String(localized: "已允许运行安装脚本：\(task.approvedBuilds.joined(separator: String(localized: "、")))"))
        }
        if !task.changed { notes.append(String(localized: "安装完成，没有新增依赖。")) }
        return notes
    }
}

private struct InstallFailed: View {
    @Environment(AppModel.self) private var app

    private var task: PluginInstallTask { app.pluginInstall }

    var body: some View {
        InstallPage(content: AnyView(content)) {
            if let recovery = task.githubRecovery {
                if task.asksMirror || recovery == nil && task.resolved == nil {
                    Button("试试其他方式") { task.useGithubMirror() }.buttonStyle(.capsule())
                } else {
                    Button("改用国内镜像") { task.useGithubMirror() }.buttonStyle(.capsule())
                }
            } else {
                if task.failure?.failedAt == "registry", task.confirmed == nil {
                    Button("更换安装源") { task.changeRegistry() }.buttonStyle(.capsule(.outline))
                }
                Button("重试") { task.retry() }.buttonStyle(.capsule())
            }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            InstallSubject()
            Text(task.githubRecovery != nil ? String(localized: "请尝试其他安装来源。") : task.failureText)
                .font(.subheadline)
                .foregroundStyle(Palette.removed)
                .fixedSize(horizontal: false, vertical: true)
            if let pending = task.failure?.pendingBuilds, !pending.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("需要允许安装脚本").font(.subheadline.weight(.semibold))
                    Text("以下包带安装脚本，默认不运行。").font(.footnote).foregroundStyle(Palette.secondary)
                    Text(pending.joined(separator: "\n")).font(.caption.monospaced())
                    Text("允许后，脚本以你的权限在本机运行，之后不再询问。").font(.footnote).foregroundStyle(Palette.secondary)
                    Text("只在信任这些包时允许。").font(.footnote.weight(.medium)).foregroundStyle(Palette.secondary)
                    Button("允许这些脚本并重试") { Task { await task.approveBuildsAndRetry() } }
                        .buttonStyle(.capsule(height: 44))
                    Button("跳过脚本并继续") { Task { await task.skipBuildsAndRetry() } }
                        .buttonStyle(.capsule(.outline, height: 44))
                    Text("跳过后插件仍可安装，依赖这些脚本的功能可能用不了。").font(.footnote).foregroundStyle(Palette.secondary)
                }
                .padding(12)
                .background(Palette.waiting.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else if !task.skippableBuilds.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("安装脚本运行失败").font(.subheadline.weight(.semibold))
                    Text("以下包的脚本没能运行，它们可能不支持 iOS。").font(.footnote).foregroundStyle(Palette.secondary)
                    Text(task.skippableBuilds.joined(separator: "\n")).font(.caption.monospaced())
                    Button("跳过脚本并继续") { Task { await task.skipBuildsAndRetry() } }
                        .buttonStyle(.capsule(height: 44))
                    Text("跳过后插件仍可安装，依赖这些脚本的功能可能用不了。").font(.footnote).foregroundStyle(Palette.secondary)
                }
                .padding(12)
                .background(Palette.waiting.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            InstallDetails()
        }
    }
}

/// The Host has no such request: the outcome cannot be told.
private struct InstallUnknown: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        InstallPage(content: AnyView(
            VStack(alignment: .leading, spacing: 16) {
                InstallSubject()
                Text("后端当前没有此安装任务。请检查插件列表后再尝试安装。").font(.subheadline).foregroundStyle(Palette.secondary)
                InstallDetails()
            }
        )) {
            Button("完成") { app.pluginInstall.close() }.buttonStyle(.capsule())
        }
    }
}

/// A market entry refused at the check: there is no form to go back to.
private struct InstallConfirmedRefused: View {
    @Environment(AppModel.self) private var app

    private var task: PluginInstallTask { app.pluginInstall }

    var body: some View {
        InstallPage(content: AnyView(
            VStack(alignment: .leading, spacing: 16) {
                InstallSubject()
                Text(task.inputProblemText ?? "").font(.subheadline).foregroundStyle(Palette.removed)
            }
        )) {
            Button("关闭") { task.close() }.buttonStyle(.capsule(.outline))
            Button("重试") { task.run() }.buttonStyle(.capsule())
        }
    }
}
