import SwiftUI

/// 设置 → 诊断上报：把日志推到自己的服务器。
///
/// 这一页默认是关的，且**只在开发者自己填了地址之后**才工作。
/// 普通用户看到的是一个「关着、没有地址」的开关，不会产生任何流量。
struct DiagnosticsPage: View {
    /// 单例直接持有：`Diagnostics` 是 `@Observable` 类，`@State` 存引用没问题，
    /// 且能用 `$` 生成绑定（computed property 不行，`@Bindable` 只接受存储属性）。
    @State private var diagnostics = Diagnostics.shared
    @State private var draftEndpoint = ""
    @State private var draftToken = ""
    @State private var loaded = false

    var body: some View {
        Form {
            Section {
                Toggle("开启上报", isOn: $diagnostics.enabled)
                    .toggleStyle(.mono)
            } footer: {
                Text("关闭时不发任何数据。开启后每 20 秒把新增的引擎日志推到下面的地址。")
            }
            .groupedRow()

            Section {
                TextField("https://example.com/sigma/log", text: $draftEndpoint)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .onSubmit { apply() }
                TextField("Bearer token（可选）", text: $draftToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit { apply() }
            } header: {
                Text("服务器")
            } footer: {
                VStack(alignment: .leading, spacing: 6) {
                    Text("App 用 HTTP PUT 把日志增量写过去，请求体就是日志原文，服务器端直接追加到文件即可。")
                    Text("请求头带 X-Sigma-Device / X-Sigma-Version / X-Sigma-Offset / X-Sigma-At，方便按设备和批次归档。")
                }
            }
            .groupedRow()

            Section {
                Button("保存并立即上报") { apply(andPush: true) }
                row("状态", statusText)
                if let error = diagnostics.lastError {
                    row("上次错误", error, tint: Palette.removed)
                }
                row("已上传", "\(diagnostics.sentBatches) 批")
                row("已读位置", "\(diagnostics.cursor) 字节")
                if let last = diagnostics.lastPushAt {
                    row("上次成功", last.formatted(date: .omitted, time: .standard))
                }
            } header: {
                Text("状态")
            } footer: {
                Text("「已读位置」是日志文件里的字节偏移。换服务器后想从头重发，点下面的重置。")
            }
            .groupedRow()

            Section {
                Button("重置上传位置", role: .destructive) { diagnostics.resetCursor() }
            }
            .groupedRow()
        }
        .groupedList()
        .navigationTitle("诊断上报")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard !loaded else { return }
            draftEndpoint = diagnostics.endpoint
            draftToken = diagnostics.token
            loaded = true
        }
    }

    private func row(_ title: String, _ value: String, tint: Color = Palette.secondary) -> some View {
        HStack(alignment: .top) {
            Text(title).foregroundStyle(Palette.ink)
            Spacer(minLength: 12)
            Text(value).foregroundStyle(tint).multilineTextAlignment(.trailing)
        }
    }

    private var statusText: String {
        if diagnostics.lastError != nil { return "有错误" }
        return diagnostics.lastPushAt == nil ? "等待首次上传" : "正常"
    }

    private func apply(andPush: Bool = false) {
        diagnostics.endpoint = draftEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        diagnostics.token = draftToken.trimmingCharacters(in: .whitespacesAndNewlines)
        if andPush { diagnostics.pushNow() }
    }
}
