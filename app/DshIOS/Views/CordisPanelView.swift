import SwiftUI

/// 「Cordis 插件」: plugins agents defined, the current session's first; versions,
/// run / stop / remove / retry / roll back. Client parts cannot run here (`CordisModel`).
struct CordisPanelView: View {
    let currentSession: String?
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    private var cordis: CordisModel { app.cordis }
    private var mine: [JSON] { cordis.rows.filter { $0["agentId"].string == currentSession } }
    private var others: [JSON] { cordis.rows.filter { $0["agentId"].string != currentSession } }

    var body: some View {
        NavigationStack {
            List {
                if !mine.isEmpty { Section("当前会话") { ForEach(mine, id: \.self) { CordisRow(row: $0) } }.groupedRow() }
                if !others.isEmpty { Section("其他会话") { ForEach(others, id: \.self) { CordisRow(row: $0) } }.groupedRow() }
                Section {
                    Text("iOS 只能运行插件的 Host 部分；带网页界面（Client）的版本请在网页端运行。")
                        .font(.footnote).foregroundStyle(Palette.secondary)
                }
                .listRowBackground(Color.clear)
            }
            .groupedList()
            .overlay {
                if !cordis.loaded {
                    Text("读取中…").font(.subheadline).foregroundStyle(Palette.secondary)
                } else if let failure = cordis.failure {
                    Text("读取插件清单失败：\(failure)").font(.subheadline).foregroundStyle(Palette.removed).padding()
                } else if cordis.rows.isEmpty {
                    Text("还没有定义任何插件").font(.subheadline).foregroundStyle(Palette.secondary)
                }
            }
            .navigationTitle("Cordis 插件")
            .navigationBarTitleDisplayMode(.inline)
            .closeButton(dismiss)
            .refreshable { await cordis.refresh(app: app) }
            .task { await cordis.refresh(app: app) }
        }
    }
}

private struct CordisRow: View {
    let row: JSON
    @Environment(AppModel.self) private var app
    @State private var selected: String?
    @State private var removing = false

    private var cordis: CordisModel { app.cordis }
    private var pluginId: String { row["pluginId"].string ?? "" }
    private var packages: [JSON] { row["packages"].array }
    private var current: String? { row["currentPackageId"].string }
    private var next: String? { row["nextPackageId"].string.flatMap { $0 == current ? nil : $0 } }
    private var active: String? { row["activeRun"]["packageId"].string }
    private var latest: JSON { row["latestRun"] }
    private var busy: Bool { cordis.pending.contains(pluginId) }

    /// What the panel acts on: the picked version, else the next, current or newest one.
    private var selectedId: String? {
        if let selected, packages.contains(where: { $0["packageId"].string == selected }) { return selected }
        return row["nextPackageId"].string ?? current ?? packages.last?["packageId"].string
    }

    private func package(_ id: String?) -> JSON? { packages.first { $0["packageId"].string == id } }

    private var failed: Bool { latest["status"].string == "failed" && latest["packageId"].string == selectedId }

    private var status: String {
        if latest["status"].string == "awaiting-approval" { return String(localized: "待审批") }
        if failed { return String(localized: "运行失败") }
        guard let active else { return String(localized: "待激活") }
        return package(active)?["hasClientHalf"].bool == true ? String(localized: "Client 待激活") : String(localized: "运行中")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Circle().fill(dot).frame(width: 7, height: 7)
                Text(package(selectedId)?["name"].string ?? pluginId).font(.subheadline.weight(.medium)).foregroundStyle(Palette.ink).lineLimit(1)
                Spacer(minLength: 6)
                if busy { ProgressView().controlSize(.mini) }
                Text(status).font(.caption).foregroundStyle(Palette.secondary)
            }
            Text(purpose).font(.footnote).foregroundStyle(Palette.secondary)
            if packages.count > 1 {
                Picker("版本", selection: Binding(get: { selectedId ?? "" }, set: { selected = $0 })) {
                    ForEach(packages, id: \.self) { item in
                        Text("\(item["name"].string ?? "") · \(item["packageId"].string ?? "")").tag(item["packageId"].string ?? "")
                    }
                }
                .font(.footnote)
                .disabled(busy)
            }
            if let next {
                VStack(alignment: .leading, spacing: 2) {
                    if let current { Text("当前：\(current)") }
                    Text("待切换：\(next)")
                }
                .font(.caption)
                .foregroundStyle(Palette.secondary)
            }
            if failed, let error = latest["error"]["message"].string {
                Text("\(error) (\(latest["error"]["phase"].string ?? ""))").font(.caption).foregroundStyle(Palette.removed)
            }
            if let error = cordis.actionErrors[pluginId] {
                Text(error).font(.caption).foregroundStyle(Palette.removed)
            }
            actions
        }
        .padding(.vertical, 4)
        .confirmationDialog("移除「\(package(selectedId)?["name"].string ?? pluginId)」？", isPresented: $removing, titleVisibility: .visible) {
            Button("移除", role: .destructive) { Task { await cordis.remove(row, app: app) } }
        }
    }

    private var purpose: String {
        let text = package(selectedId)?["purpose"].string ?? ""
        return text.isEmpty ? String(localized: "(未填写用途)") : text
    }

    private var dot: Color {
        if busy { return Palette.running }
        if failed { return Palette.removed }
        return active == nil ? Palette.faint : Palette.running
    }

    private var actions: some View {
        HStack(spacing: 8) {
            if let selectedId, selectedId != active, package(selectedId)?["hasClientHalf"].bool != true {
                Button("运行") { start(selectedId, mode: current != nil && selectedId != current ? "update" : "run") }
            }
            if active != nil {
                Button("停止") { Task { await cordis.stop(row, app: app) } }
            }
            if let next, package(next)?["hasClientHalf"].bool != true {
                Button("重试") { start(next, mode: current == nil ? "run" : "update") }
            }
            if next != nil, let current, package(current)?["hasClientHalf"].bool != true {
                Button("回退") { start(current, mode: "run") }
            }
            Spacer()
            Button("移除", role: .destructive) { removing = true }
        }
        .buttonStyle(.capsule(.outline, height: 34, fill: false))
        .disabled(busy)
    }

    private func start(_ packageId: String, mode: String) {
        Haptics.tap()
        Task { await cordis.run(row, packageId: packageId, mode: mode, app: app) }
    }
}
