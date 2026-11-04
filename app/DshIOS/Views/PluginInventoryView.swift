import SwiftUI

/// 设置 → 内置插件 (I-01…I-06): a read-only snapshot of what runs on this engine,
/// the entry point for finding out why a plugin did not load. Session plugins are
/// the Agent presets' rosters; global plugins are shared by the system and every
/// session. Read once per visit, as on the web.
struct PluginInventoryPage: View {
    @Environment(AppModel.self) private var app
    @State private var snapshot: JSON?
    @State private var failed = false
    @State private var query = ""
    @State private var preset: String?
    @State private var globalOpen = false

    private var presets: [JSON] { snapshot?["agentPresets"].array ?? [] }
    private var selected: JSON? {
        presets.first { $0["id"].string == preset } ?? presets.first { $0["isDefault"].bool == true } ?? presets.first
    }
    private var searching: Bool { !needle.isEmpty }
    private var needle: String { query.trimmingCharacters(in: .whitespaces).lowercased() }

    var body: some View {
        Group {
            if let snapshot {
                list(snapshot)
            } else if failed {
                ContentUnavailableView {
                    Label("暂时无法读取插件。", systemImage: "exclamationmark.triangle")
                } actions: {
                    Button("重试") { Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background)
        .navigationTitle("内置插件")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        failed = false
        do { snapshot = try await app.client.call("pluginInventory/list") } catch { failed = snapshot == nil }
    }

    private func matches(_ entry: JSON) -> Bool {
        guard searching else { return true }
        let fields = [entry["moduleName"].string, entry["entryId"].string, localized(entry["meta"]["title"]), localized(entry["meta"]["description"])]
        return fields.compactMap { $0 }.contains { $0.lowercased().contains(needle) }
    }

    private func list(_ snapshot: JSON) -> some View {
        let global = snapshot["entries"].array.filter(matches)
        let session = (selected?["rows"].array ?? []).filter(matches)
        let elsewhere = searching ? presets.filter { $0["id"] != selected?["id"] }.flatMap { $0["rows"].array }.filter(matches) : []
        return List {
            if !presets.isEmpty {
                Section {
                    if presets.count > 1 {
                        Picker("Agent 预设", selection: Binding(get: { selected?["id"].string ?? "" }, set: { preset = $0 })) {
                            ForEach(presets, id: \.self) { item in
                                Text(presetTitle(item)).tag(item["id"].string ?? "")
                            }
                        }
                    }
                    if let broken = selected?["broken"], !broken.isNull {
                        Text(broken.string ?? broken["reason"].string ?? broken.compactText).font(.caption).foregroundStyle(Palette.removed)
                    }
                    ForEach(session, id: \.self) { InventoryCard(entry: $0, snapshot: snapshot, inPreset: true) }
                    if session.isEmpty {
                        Text(searching ? "没有匹配的插件。" : "暂无插件。").font(.footnote).foregroundStyle(Palette.secondary)
                    }
                    if searching && !elsewhere.isEmpty {
                        Text("其他预设中还有 \(elsewhere.count) 个匹配：").font(.footnote).foregroundStyle(Palette.secondary)
                        ForEach(elsewhere, id: \.self) { InventoryCard(entry: $0, snapshot: snapshot, inPreset: true) }
                    }
                } header: {
                    Text("会话插件")
                } footer: {
                    Text("由 Agent 预设按会话组成")
                }
                .groupedRow()
            }
            Section {
                if searching || globalOpen {
                    ForEach(global, id: \.self) { InventoryCard(entry: $0, snapshot: snapshot, inPreset: false) }
                    if global.isEmpty {
                        Text(searching ? "没有匹配的插件。" : "暂无插件。").font(.footnote).foregroundStyle(Palette.secondary)
                    }
                }
            } header: {
                Button {
                    withAnimation { globalOpen.toggle() }
                } label: {
                    HStack {
                        Text("全局插件")
                        Spacer()
                        Text("\(snapshot["entries"].array.count)").textCase(nil)
                        Image(systemName: searching || globalOpen ? "chevron.down" : "chevron.right").font(.caption2)
                    }
                }
                .buttonStyle(.plain)
            } footer: {
                Text("系统与所有会话共用。iOS 执行层（subprocess-ios、sandbox-ios、ios-host）始终启用。")
            }
            .groupedRow()
        }
        .groupedList()
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索插件")
        .refreshable { await load() }
    }

    private func presetTitle(_ preset: JSON) -> String {
        var title = presetDisplayName(preset)
        if preset["isDefault"].bool == true { title += String(localized: "（默认）") }
        if !preset["broken"].isNull { title += String(localized: "（加载失败）") }
        return title
    }
}

/// A plugin entry: its title, description and, when it is not plainly on, a tag; details on tap.
private struct InventoryCard: View {
    let entry: JSON
    let snapshot: JSON
    let inPreset: Bool
    @State private var expanded = false

    private var module: String { entry["moduleName"].string ?? "" }
    private var entryId: String? { entry["entryId"].string }
    private var phase: String? { entry["fiberPhase"].string }
    private var title: String { localized(entry["meta"]["title"]) ?? Self.shortName(module) }
    private var summary: String? { localized(entry["meta"]["description"]).flatMap { $0.isEmpty ? nil : $0 } }
    private var conditional: Bool { entry["enabled"].string == "conditional" }
    private var enabled: Bool { entry["enabled"].bool == true || conditional }
    private var failed: Bool { phase == "failed" }
    /// Off globally, but some preset turns it on per session.
    private var viaPresets: [String] {
        guard !inPreset, !enabled else { return [] }
        return snapshot["agentPresets"].array.filter { preset in
            preset["rows"].array.contains { $0["moduleName"].string == module && ($0["enabled"].bool == true || $0["enabled"].string == "conditional") }
        }.map(presetDisplayName)
    }

    private static func shortName(_ module: String) -> String {
        var name = module
        if name.hasPrefix("@"), let slash = name.firstIndex(of: "/") { name = String(name[name.index(after: slash)...]) }
        return name.replacingOccurrences(of: #"^(cordis:|cordis-plugin-|dsh-host-|dsh-client-|dsh-)"#, with: "", options: .regularExpression)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                dot
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(enabled ? Palette.ink : Palette.secondary).lineLimit(1)
                tag
                Spacer(minLength: 0)
                Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(Palette.faint)
            }
            if let summary {
                Text(summary).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(expanded ? nil : 2)
            }
            if expanded { details }
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.snappy) { expanded.toggle() } }
    }

    @ViewBuilder
    private var dot: some View {
        switch phase {
        case "loading", "unloading": Circle().fill(Palette.waiting).frame(width: 6, height: 6)
        case "failed": Circle().fill(Palette.removed).frame(width: 6, height: 6)
        case "active": Circle().fill(Palette.running).frame(width: 6, height: 6)
        default: Circle().fill(Palette.faint).frame(width: 6, height: 6)
        }
    }

    @ViewBuilder
    private var tag: some View {
        if failed { PluginTag(text: String(localized: "启动失败"), tone: Palette.removed) }
        else if conditional { PluginTag(text: String(localized: "条件启用")) }
        else if !viaPresets.isEmpty { PluginTag(text: String(localized: "预设中启用")) }
        else if !enabled { PluginTag(text: String(localized: "已停用")) }
    }

    private var phaseText: String {
        switch phase {
        case "pending": String(localized: "等待依赖")
        case "loading": String(localized: "加载中")
        case "active": String(localized: "运行中")
        case "failed": String(localized: "启动失败")
        case "unloading": String(localized: "卸载中")
        default: String(localized: "未运行")
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 4) {
            fact("完整名称", module, mono: true)
            if let entryId { fact("条目 ID", entryId.replacingOccurrences(of: "include:", with: ""), mono: true) }
            fact("运行状态", phaseText)
            if let condition = entry["condition"].string { fact("禁用条件", condition, mono: true) }
            if !viaPresets.isEmpty {
                Text("全局已停用，由 Agent 预设按会话提供").font(.caption).foregroundStyle(Palette.secondary)
                fact("启用于", viaPresets.joined(separator: String(localized: "、")))
            }
        }
        .padding(.top, 4)
    }

    private func fact(_ label: LocalizedStringKey, _ value: String, mono: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).font(.caption).foregroundStyle(Palette.secondary)
            Text(value).font(mono ? .caption.monospaced() : .caption).foregroundStyle(Palette.ink).textSelection(.enabled)
        }
    }
}

/// A preset's name: its own, else the built-in presets' localized names, else its id.
func presetDisplayName(_ preset: JSON) -> String {
    if let name = localized(preset["name"]), !name.isEmpty { return name }
    let id = preset["id"].string ?? ""
    switch id {
    case "standard": return String(localized: "标准模式")
    case "ptc": return String(localized: "PTC 模式")
    case "minimal": return String(localized: "极简模式")
    case "cordis": return String(localized: "创造模式")
    default: return id
    }
}
