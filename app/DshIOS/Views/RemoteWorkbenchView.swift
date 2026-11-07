import SwiftUI

/// 设置 → 远程工作台：把客户自己的 sigma-agent 服务器接进来。
///
/// 设计前提：**不填地址就是纯本地**。这一页留空时 App 行为和没有这个功能完全一样，
/// 只在本机跑引擎和模型；填了地址并通过测试，才会把远程的交付链作为一组工具
/// （`mcp__workbench__*`）挂到 Agent 上。地址可以随时清空退回纯本地。
///
/// 配置落在引擎自己读的 patch 层 `$DSH_IOS_DATA/user.patch.yml`（见 engine/boot.mjs），
/// 与随包分发的只读 ios.patch.yml 分开：前者在用户数据目录，可写、可随 App 更新保留。
/// 连不上不是错误状态——`failOnStartupError: false` 让引擎照常启动，只是没有远程工具。
struct RemoteWorkbenchPage: View {
    @Environment(AppModel.self) private var app

    @State private var endpoint = ""
    @State private var token = ""
    @State private var loaded = false
    @State private var busy = false
    @State private var probe: ProbeResult?
    @State private var failure: String?
    @State private var restartNeeded = false

    private struct ProbeResult: Equatable {
        let ok: Bool
        let detail: String
    }

    private var active: Bool { !endpoint.trimmingCharacters(in: .whitespaces).isEmpty }

    /// 用户 patch 文件：引擎从 $DSH_IOS_DATA 下读它。
    private var patchURL: URL {
        EnginePaths.real(EnginePaths.shared).appendingPathComponent("user.patch.yml")
    }

    var body: some View {
        Form {
            Section {
                Text("留空就是纯本地：引擎和模型都在这台手机上跑，不连接任何服务器。填入你自己的工作台地址后，Agent 会多出一组远程工具，重活可以交给服务器做。")
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
            }
            .groupedRow()

            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text("服务器地址").font(.caption).foregroundStyle(Palette.secondary)
                    TextField("https://你的服务器:8092", text: $endpoint)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .font(.callout)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("访问口令").font(.caption).foregroundStyle(Palette.secondary)
                    SecureField("服务器没设口令就留空", text: $token)
                        .textContentType(nil)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.callout)
                }
            } header: {
                Text("连接")
            } footer: {
                Text("地址指向工作台的 MCP 端口（默认 8092），不是网页端口。口令在服务器的 /opt/wb/data/.access.key。")
            }
            .groupedRow()

            Section {
                Button {
                    Task { await test() }
                } label: {
                    HStack {
                        Text("测试连接").foregroundStyle(Palette.ink)
                        Spacer()
                        if busy { ProgressView().controlSize(.small) }
                    }
                }
                .disabled(busy || !active)

                if let probe {
                    HStack(spacing: 8) {
                        Image(systemName: probe.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundStyle(probe.ok ? Palette.running : Palette.removed)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(probe.ok ? "连接正常" : "连接失败").font(.callout)
                            Text(probe.detail).font(.caption).foregroundStyle(Palette.secondary)
                        }
                    }
                }
            } footer: {
                if active, !restartNeeded {
                    Text("测试连接只验证服务器可达。Agent 是否已拿到远程工具，要看重启后工具列表里有没有 mcp__workbench__ 开头的工具。")
                }
            }
            .groupedRow()

            Section {
                Button {
                    Task { await save() }
                } label: {
                    HStack {
                        Text("保存").foregroundStyle(Palette.ink)
                        Spacer()
                        if busy { ProgressView().controlSize(.small) }
                    }
                }
                .disabled(busy || !active)

                if restartNeeded {
                    Button {
                        restartNeeded = false
                        Task { await restartEngine() }
                    } label: {
                        HStack {
                            Text("应用配置").foregroundStyle(Palette.ink)
                            Spacer()
                            Image(systemName: "arrow.clockwise")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Palette.faint)
                        }
                    }
                    .disabled(busy)
                }

                if active {
                    Button(role: .destructive) {
                        Task { await disable() }
                    } label: {
                        Text("断开并退回纯本地")
                    }
                    .disabled(busy)
                }
            } footer: {
                if restartNeeded {
                    Text("配置已保存。重启引擎后，Agent 才会拿到远程工具。").foregroundStyle(Palette.waiting)
                } else if active {
                    Text("已启用：Agent 可以使用远程工作台的工具（提交任务、查进度、记忆、技能）。")
                } else {
                    Text("纯本地模式，没有任何对外连接。")
                }
            }
            .groupedRow()

            if let failure {
                Section {
                    Text(failure).font(.footnote).foregroundStyle(Palette.removed)
                }
                .groupedRow()
            }
        }
        .navigationTitle("远程工作台")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .keyboardDoneButton()
    }

    // MARK: - 读写

    private func load() async {
        guard !loaded else { return }
        loaded = true
        guard let text = try? String(contentsOf: patchURL, encoding: .utf8) else { return }
        // 从我们写进去的条目回显；文件由本页维护，格式固定。
        if let url = Self.field(in: text, "url") {
            endpoint = url
                .replacingOccurrences(of: "/mcp", with: "")
        }
        if let auth = Self.field(in: text, "Authorization") {
            token = auth.replacingOccurrences(of: "Bearer ", with: "")
        }
    }

    /// 取 `key: value` 的裸值，只用于回显自己写的文件。
    private static func field(in text: String, _ key: String) -> String? {
        for line in text.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix(key + ":") else { continue }
            var value = String(trimmed.dropFirst(key.count + 1))
                .trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("\"") && value.hasSuffix("\"") && value.count > 1 {
                value = String(value.dropFirst().dropLast())
            }
            if value.hasPrefix("'") && value.hasSuffix("'") && value.count > 1 {
                value = String(value.dropFirst().dropLast())
            }
            return value.isEmpty ? nil : value
        }
        return nil
    }

    private func test() async {
        busy = true
        defer { busy = false }
        failure = nil
        probe = nil

        guard let base = normalized() else {
            failure = "地址格式不正确，要以 http:// 或 https:// 开头"
            return
        }
        guard let url = URL(string: base + "/health") else {
            failure = "地址无法解析"
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        if !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                probe = ProbeResult(ok: false, detail: "没有收到有效响应")
                return
            }
            guard http.statusCode == 200 else {
                probe = ProbeResult(ok: false, detail: "服务器返回 \(http.statusCode)，检查地址和口令")
                return
            }
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let tools = json?["tools"] as? Int ?? 0
            let name = (json?["server"] as? [String: Any])?["name"] as? String ?? "未知服务"
            probe = ProbeResult(ok: true, detail: "\(name)，\(tools) 个工具")
        } catch {
            probe = ProbeResult(ok: false, detail: error.localizedDescription)
        }
    }

    private func save() async {
        guard let base = normalized() else {
            failure = "地址格式不正确，要以 http:// 或 https:// 开头"
            return
        }
        busy = true
        defer { busy = false }
        failure = nil
        do {
            try write(base: base, token: token)
            endpoint = base
            restartNeeded = true
            Haptics.success()
            app.showToast(String(localized: "已保存。重启 App 后 Agent 会拿到远程工具。"))
        } catch {
            Haptics.error()
            failure = error.localizedDescription
        }
    }

    /// 引擎只在启动时读 user.patch.yml，所以改完配置要重开一次 App。
    /// iOS 不允许 App 自重启，这里只能把话说清楚，让用户按提示操作。
    private func restartEngine() async {
        app.showToast(String(localized: "请从后台划掉本 App 再重新打开，配置即生效。"), duration: 6)
    }

    private func disable() async {
        busy = true
        defer { busy = false }
        failure = nil
        do {
            try? FileManager.default.removeItem(at: patchURL)
            endpoint = ""
            token = ""
            probe = nil
            restartNeeded = true
            Haptics.success()
            app.showToast(String(localized: "已退回纯本地模式，重启引擎后生效。"))
        }
    }

    /// 写 user.patch.yml。条目 id 固定，重复保存是覆盖而非叠加。
    private func write(base: String, token: String) throws {
        var yaml = """
        # 由 App 的「远程工作台」设置页维护。清空地址会删除本文件。
        # 这一层叠在 app 自带的 ios.patch.yml 之后（见 engine/boot.mjs）。
        - insert:
            - id: mcp-workbench
              name: '@deepseek-ai/dsh-mcp-client'
              config:
                serverName: workbench
                transport: streamable-http
                url: \(yamlScalar(base + "/mcp"))
                failOnStartupError: false
                toolCallTimeoutMs: 120000

        """
        if !token.isEmpty {
            yaml += """
                    headers:
                      Authorization: \(yamlScalar("Bearer \(token)"))

            """
        }
        try FileManager.default.createDirectory(
            at: patchURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try yaml.write(to: patchURL, atomically: true, encoding: .utf8)
    }

    /// 双引号包裹并转义，避免口令里的 `:` `#` 破坏 YAML。
    private func yamlScalar(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }

    /// 补全协议、去掉末尾斜杠；不是合法 http(s) 返回 nil。
    private func normalized() -> String? {
        var text = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.lowercased().hasPrefix("http://") && !text.lowercased().hasPrefix("https://") {
            text = "https://" + text
        }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), url.host != nil else { return nil }
        return text
    }
}
