import SwiftUI

/// 创造模式 (`cordis`) is held back on iOS: what it makes are plugins with their own
/// Web views, and there is no good native SwiftUI way to run those yet. Only the entries
/// that start it are hidden — the preset itself still exists, so a session already in it
/// keeps its name everywhere. Drop this flag once the views have a native home.
enum CreatorMode {
    static let id = "cordis"
    static let hidden = true

    /// True for the preset whose entries are held back.
    static func isHidden(_ presetId: String?) -> Bool { hidden && presetId == id }
}

/// The Agent preset roster (`agentPresets/list`) with the display copy the web keeps
/// for shipped presets: a preset that publishes no name is one of these.
@MainActor
@Observable
final class AgentPresetCatalog {
    struct Option: Identifiable, Hashable {
        let id: String
        let name: String
        let description: String?
        /// PTC and Minimal: hidden while 「代码工具」 (`ui-settings.enabled`) is off.
        let needsCodingTools: Bool

        init(_ json: JSON) {
            id = json["id"].string ?? ""
            let shipped = json["name"].string == nil ? AgentPresetCatalog.shippedCopy(id) : nil
            name = shipped?.name ?? json["name"].string ?? id
            description = shipped?.description ?? json["description"].string
            needsCodingTools = shipped != nil && (id == "ptc" || id == "minimal")
        }
    }

    private(set) var options: [Option] = []
    /// The new-task default the Host reports.
    private(set) var fallback = ""
    private(set) var codingTools = true

    var visible: [Option] { options.filter { (codingTools || !$0.needsCodingTools) && !CreatorMode.isHidden($0.id) } }

    func name(of id: String) -> String { options.first { $0.id == id }?.name ?? id }

    func load(_ client: EngineClient) async {
        // An engine without the registry answers `gateway/invocation-unavailable`: an empty roster.
        guard let value = try? await client.call("agentPresets/list") else { return }
        let presets = value["presets"].array
        options = presets.filter { $0["broken"].isNull }.map(Option.init)
        fallback = presets.first { $0["isDefault"].bool == true }?["id"].string ?? presets.first?["id"].string ?? ""
        if let describe = try? await client.call("settings/describe"),
           let enabled = describe["namespaces"].array.first(where: { $0["ns"].string == "ui-settings" })?["value"]["enabled"].bool {
            codingTools = enabled
        }
    }

    fileprivate nonisolated static func shippedCopy(_ id: String) -> (name: String, description: String)? {
        switch id {
        case "standard": (String(localized: "标准模式"), String(localized: "处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。"))
        case "ptc": (String(localized: "PTC 模式"), String(localized: "包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。"))
        case "minimal": (String(localized: "极简模式"), String(localized: "Agent 使用终端和图片读取工具，并支持上下文压缩，适合测试和对比其基础表现。"))
        case "cordis": (String(localized: "创造模式"), String(localized: "用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。"))
        default: nil
        }
    }
}

/// The preset chip beside the workspace chip on a new session (`AgentPresetSeat`); the
/// list opens as a sheet, where the descriptions fit. The choice binds the blank
/// session; once the conversation starts the Host locks it.
struct AgentPresetChip: View {
    let sessionId: String
    let catalog: AgentPresetCatalog
    @Environment(AppModel.self) private var app
    @State private var current: String?
    @State private var choosing = false

    private var chosen: String { current ?? app.presetId(of: sessionId) ?? catalog.fallback }

    var body: some View {
        Group {
            if !catalog.options.isEmpty && !chosen.isEmpty {
                Button { choosing = true } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "cpu").foregroundStyle(Palette.secondary)
                        Text(catalog.name(of: chosen)).foregroundStyle(Palette.ink).lineLimit(1)
                        Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(Palette.secondary)
                    }
                    .font(.subheadline)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 36)
                    .background(Palette.field, in: Capsule())
                    .hitTarget()
                }
                .buttonStyle(.plain)
                .disabled(catalog.visible.isEmpty)
                .accessibilityLabel(Text("模式：\(catalog.name(of: chosen))"))
                .accessibilityHint("选择新会话使用的模式")
            }
        }
        .sheet(isPresented: $choosing) { AgentPresetSheet(catalog: catalog, chosen: chosen, select: select) }
        .task(id: "\(sessionId)-\(app.revision("agent-preset/selected", "settings/document-updated"))") {
            await catalog.load(app.client)
            await readCurrent()
        }
    }

    /// A blank session's preset is not in the shared projections until it is touched.
    private func readCurrent() async {
        guard let value = try? await app.client.call("session/projections", ["request": ["sessionId": .string(sessionId)]]) else { return }
        current = value["values"]["agentPreset"].string
    }

    /// False when the Host refused: the sheet stays open on the toast.
    private func select(_ option: AgentPresetCatalog.Option) async -> Bool {
        do {
            let value = try await app.client.call("agentPresets/select", ["agentId": .string(sessionId), "agentPreset": .string(option.id)])
            current = value.string ?? option.id
            return true
        } catch {
            let reason = (error as? EngineError)?.detail["details"]["reason"].string ?? error.localizedDescription
            Haptics.error()
            app.showToast(String(localized: "无法切换到「\(option.name)」：\(reason)"), tone: .warning, duration: 8)
            return false
        }
    }
}

/// The presets with their full descriptions: a tap moves the tick and, once the Host agrees, closes.
private struct AgentPresetSheet: View {
    let catalog: AgentPresetCatalog
    let chosen: String
    let select: (AgentPresetCatalog.Option) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var pending: String?

    var body: some View {
        NavigationStack {
            List {
                ForEach(catalog.visible) { option in
                    Button { pick(option) } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(option.name).font(.callout).foregroundStyle(Palette.ink)
                                Text(option.description ?? String(localized: "暂无描述。"))
                                    .font(.footnote)
                                    .foregroundStyle(Palette.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 0)
                            if option.id == (pending ?? chosen) {
                                Image(systemName: "checkmark").font(.callout.weight(.semibold)).foregroundStyle(Palette.ink)
                            }
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(pending != nil)
                    .accessibilityAddTraits(option.id == (pending ?? chosen) ? .isSelected : [])
                    .groupedRow()
                }
            }
            .groupedList()
            .navigationTitle("模式")
            .navigationBarTitleDisplayMode(.inline)
            .closeButton(dismiss)
        }
        .tint(Palette.ink)
        .presentationDetents([.medium, .large])
        .sheetNotices()
    }

    private func pick(_ option: AgentPresetCatalog.Option) {
        guard option.id != chosen else { dismiss(); return }
        Haptics.select()
        pending = option.id
        Task {
            let done = await select(option)
            if done {
                // Long enough to see the tick land.
                try? await Task.sleep(for: .milliseconds(200))
                dismiss()
            }
            pending = nil
        }
    }
}
