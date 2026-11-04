import SwiftUI

/// The sheets the conversation's top bar opens.
enum SessionHeaderSheet: String, Identifiable {
    case subagents, jobs, reminders, logExport
    var id: String { rawValue }
}

/// A started conversation's title in the top bar; a tap opens the session menu.
/// Its header names the preset the session started with, which cannot change.
struct SessionTitleMenu: View {
    let sessionId: String
    /// The title from the session's own stream, before the list has it.
    let streamTitle: String?
    let catalog: AgentPresetCatalog
    /// More icons share the bar: on a phone the title narrows so it stays between them.
    var crowded = false
    let exportLog: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass

    private var durableTitle: String? { app.durableTitle(of: sessionId) ?? streamTitle }
    private var title: String { durableTitle ?? String(localized: "新会话") }

    var body: some View {
        Menu {
            Section {
                Button { app.renameRequest = RenameRequest(target: .session(sessionId), initial: durableTitle ?? "") } label: {
                    Label("重命名", systemImage: "pencil")
                }
                Button { Task { await app.fork(session: sessionId, from: .current) } } label: {
                    Label("分叉会话", systemImage: "arrow.triangle.branch")
                }
                // The root view leaves an archived session for a new one.
                Button { Task { await app.archive(sessionId) } } label: {
                    Label("归档会话", systemImage: "archivebox")
                }
            } header: {
                if let preset = app.presetId(of: sessionId) { Text(catalog.name(of: preset)) }
            }
            Section {
                Button(action: exportLog) { Label("导出日志", systemImage: "square.and.arrow.up") }
                Button { app.copySessionId(sessionId) } label: { Label("复制会话 ID", systemImage: "doc.on.doc") }
            }
        } label: {
            HStack(spacing: 4) {
                Text(title).font(.callout.weight(.semibold)).foregroundStyle(Palette.ink).lineLimit(1)
                Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(Palette.secondary)
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: crowded && sizeClass == .compact ? 176 : 240)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(Text("会话：\(title)"))
        .accessibilityHint("打开会话菜单")
    }
}

/// Top-bar entries that only appear when there is something to show: subagents,
/// background jobs, this session's reminders (`conversation.session.header.actions`,
/// `.utilities`); a running one carries a dot.
struct SessionHeaderActions: View {
    let sessionId: String
    let jobs: JobsModel
    let open: (SessionHeaderSheet) -> Void
    @Environment(AppModel.self) private var app

    private struct Entry: Identifiable {
        let sheet: SessionHeaderSheet
        let icon: String
        let dot: Bool
        let label: Text
        var id: SessionHeaderSheet { sheet }
    }

    private var entries: [Entry] {
        var entries: [Entry] = []
        let subagents = app.subagentEntries(of: sessionId)
        let running = app.runningSubagentCount(of: sessionId)
        let schedules = app.activeSchedules(of: sessionId)
        if !subagents.isEmpty {
            entries.append(Entry(sheet: .subagents, icon: "person.2", dot: running > 0, label: running > 0 ? Text("\(subagents.count) 个子智能体，正在运行") : Text("\(subagents.count) 个子智能体")))
        }
        if jobs.visibleCount > 0 {
            entries.append(Entry(sheet: .jobs, icon: "list.bullet.rectangle", dot: !jobs.live.isEmpty, label: jobs.live.isEmpty ? Text("\(jobs.visibleCount) 个后台任务") : Text("\(jobs.live.count) 个后台任务运行中")))
        }
        if !schedules.isEmpty {
            entries.append(Entry(sheet: .reminders, icon: "clock", dot: false, label: Text("\(schedules.count) 个提醒")))
        }
        return entries
    }

    var body: some View {
        let entries = entries
        if entries.count > 1 {
            // A phone's bar has room for one more icon next to the workbench.
            Menu {
                ForEach(entries) { entry in
                    Button { open(entry.sheet) } label: { Label { entry.label } icon: { Image(systemName: entry.icon) } }
                }
            } label: {
                icon("ellipsis", dot: entries.contains(where: \.dot))
            }
            .accessibilityLabel("会话活动")
        } else if let entry = entries.first {
            button(entry.icon, dot: entry.dot, label: entry.label) { open(entry.sheet) }
        }
    }

    private func button(_ icon: String, dot: Bool, label: Text, action: @escaping () -> Void) -> some View {
        Button(action: action) { self.icon(icon, dot: dot) }
            .accessibilityLabel(label)
    }

    private func icon(_ name: String, dot: Bool) -> some View {
        Image(systemName: name)
            .overlay(alignment: .topTrailing) {
                if dot { Circle().fill(Palette.running).frame(width: 7, height: 7).offset(x: 3, y: -3) }
            }
    }
}
