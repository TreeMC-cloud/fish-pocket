import SwiftUI

/// 设置 → Agent 预设 (AP-01 / AP-02 / AP-04 / AP-05): tapping a row makes it the default for
/// new tasks (`agent-preset-registry.selectedDefault`), the ⓘ opens a read-only view of it.
struct AgentPresetsPage: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openSession) private var openSession
    @State private var presets: [JSON]?
    @State private var failed = false
    @State private var busy = false
    @State private var reading: JSON?

    private static let builtIn: Set<String> = ["standard", "ptc", "minimal", "cordis"]

    private var codingTools: Bool { app.settings.namespace("ui-settings")?["value"]["enabled"].bool ?? true }
    /// AP-03: with the coding view off only Standard and custom presets show (Creator: `CreatorMode`).
    private var visible: [JSON] {
        (presets ?? []).filter {
            let id = $0["id"].string ?? ""
            // 创造模式 is held back on iOS (`CreatorMode`): it is not offered as a default either.
            return (codingTools || !["ptc", "minimal"].contains(id)) && !CreatorMode.isHidden(id)
        }
    }

    var body: some View {
        List {
            if presets == nil {
                Section {
                    if failed {
                        Button("重试") { Task { await load() } }
                    } else {
                        HStack { Spacer(); ProgressView(); Spacer() }
                    }
                }
                .groupedRow()
            }
            let builtIn = visible.filter { Self.builtIn.contains($0["id"].string ?? "") }
            let custom = visible.filter { !Self.builtIn.contains($0["id"].string ?? "") }
            if !builtIn.isEmpty {
                Section {
                    ForEach(builtIn, id: \.self) { row($0) }
                } header: {
                    Text("内置")
                } footer: {
                    Text("勾选的预设用于新会话。")
                }
                .groupedRow()
            }
            // With 创造模式 held back there is nothing to put in an empty 自定义 section.
            let creatorEntry = !CreatorMode.hidden && (presets ?? []).contains { $0["id"].string == CreatorMode.id }
            if presets != nil, !custom.isEmpty || creatorEntry {
                Section("自定义") {
                    ForEach(custom, id: \.self) { row($0) }
                    if creatorEntry {
                        Button { Task { await createDraft() } } label: {
                            Label("让 Agent 帮我创建预设模式", systemImage: "sparkles").foregroundStyle(Palette.ink)
                        }
                        .disabled(busy)
                    }
                }
                .groupedRow()
            }
        }
        .groupedList()
        .navigationTitle("Agent 预设")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $reading) { preset in
            AgentPresetReader(id: preset["id"].string ?? "", title: presetDisplayName(preset))
        }
        .task(id: app.settingsRevision) { await load() }
        .followSettings()
        .refreshable { await load() }
    }

    private func description(_ preset: JSON) -> String? {
        if let text = localized(preset["description"]), !text.isEmpty { return text }
        switch preset["id"].string {
        case "standard": return String(localized: "处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。")
        case "ptc": return String(localized: "包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。")
        case "minimal": return String(localized: "Agent 使用终端和图片读取工具，并支持上下文压缩，适合测试和对比其基础表现。")
        case "cordis": return String(localized: "用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。")
        default: return nil
        }
    }

    private func row(_ preset: JSON) -> some View {
        let id = preset["id"].string ?? ""
        let isDefault = preset["isDefault"].bool == true
        let broken = !preset["broken"].isNull
        return HStack(spacing: 8) {
            Button {
                if !isDefault { Task { await makeDefault(id) } }
            } label: {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(presetDisplayName(preset)).font(.callout).foregroundStyle(broken ? Palette.secondary : Palette.ink)
                            if broken { PluginTag(text: String(localized: "加载失败"), tone: Palette.removed) }
                        }
                        Text(description(preset) ?? String(localized: "暂无描述。")).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    if isDefault { Image(systemName: "checkmark").font(.callout.weight(.semibold)).foregroundStyle(Palette.ink) }
                }
                .padding(.vertical, 2)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(broken)
            .accessibilityAddTraits(isDefault ? .isSelected : [])
            Button { reading = preset } label: {
                Image(systemName: "info.circle").foregroundStyle(Palette.secondary).hitTarget()
            }
            .buttonStyle(.plain)
            .accessibilityLabel("查看 \(presetDisplayName(preset))")
        }
    }

    private func load() async {
        failed = false
        do {
            let value = try await app.client.call("agentPresets/list")
            presets = value["presets"].array.sorted { ($0["order"].double ?? .infinity) < ($1["order"].double ?? .infinity) }
        } catch {
            failed = presets == nil
        }
    }

    private func makeDefault(_ id: String) async {
        do {
            try await app.settings.update("agent-preset-registry", patch: ["selectedDefault": .string(id)], expectedRevision: app.settings.namespace("agent-preset-registry")?["revision"].int)
            Haptics.select()
            await load()
        } catch {
            app.showToast(describeFailure(error), duration: 5)
        }
    }

    /// AP-05: the Creator entry opens a new task in Creator mode.
    private func createDraft() async {
        guard let workspace = app.workspaces.first else { return }
        busy = true
        defer { busy = false }
        do {
            let session = try await app.createSession(in: workspace)
            try await app.client.call("agentPresets/select", ["agentId": .string(session), "agentPreset": "cordis"])
            if let openSession { openSession(session) }
            else { app.showToast(String(localized: "已新建创造模式会话，可在会话列表中打开")) }
        } catch {
            app.showToast(describeFailure(error), duration: 5)
        }
    }
}

/// AP-04: a preset's YAML, read-only.
private struct AgentPresetReader: View {
    @Environment(AppModel.self) private var app
    let id: String
    let title: String
    @State private var content: String?
    @State private var failure: String?

    var body: some View {
        ScrollView {
            if let content {
                Text(content)
                    .font(.caption.monospaced())
                    .foregroundStyle(Palette.ink)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            } else if let failure {
                Text(failure).font(.footnote).foregroundStyle(Palette.removed).padding(16)
            } else {
                ProgressView().padding(32)
            }
        }
        .background(Palette.grouped)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let content {
                ToolbarItem(placement: .topBarTrailing) { ShareLink(item: content) }
            }
        }
        .task {
            do {
                content = try await app.client.call("agentPresets/read", ["agentPreset": .string(id)])["content"].string ?? ""
            } catch {
                failure = describeFailure(error)
            }
        }
    }
}
