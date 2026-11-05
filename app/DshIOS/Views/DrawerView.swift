import SwiftUI

/// The left drawer (the iPad sidebar) does one thing: find a session. Search and
/// new conversation on top, sessions by time with their workspace under the title
/// (or, from the view menu, by workspace), 「已归档」 at the end of the list, and
/// settings at the bottom (docs/design/README.md 4.2).
struct DrawerView: View {
    enum GroupBy: String { case time, workspace }

    /// Where a session sits in the time view.
    enum Period: CaseIterable {
        case pinned, today, week, earlier

        var title: String {
            switch self {
            case .pinned: String(localized: "置顶")
            case .today: String(localized: "今天")
            case .week: String(localized: "本周")
            case .earlier: String(localized: "更早")
            }
        }
    }

    private enum Route: Hashable { case archived }

    @Environment(AppModel.self) private var app
    @EnvironmentObject private var engine: NodeEngine
    let selection: String?
    /// Where a new conversation from the top button goes: the current session's workspace.
    let workspace: Workspace?
    /// Tells the root view where session rows are: a swipe there is the row's.
    let rowFrames: DrawerRowFrames
    let select: (String) -> Void
    let newConversation: (Workspace) -> Void
    let openSettings: () -> Void
    let openSchedules: () -> Void
    let openCordis: () -> Void
    let openSignIn: () -> Void
    /// Bumped to put the cursor in the search field (⌘K).
    var searchRequest = 0
    /// Open a session in a window of its own, where the system has windows.
    var openInWindow: ((String) -> Void)?

    @FocusState private var searchFocused: Bool
    @AppStorage("dsh.drawer.groupBy") private var groupBy = GroupBy.workspace
    /// Groups the user opened or closed, as JSON `{workspaceId: Bool}`.
    @AppStorage("dsh.drawer.expansion") private var expansionJSON = "{}"
    /// How many sessions each group shows beyond the base five.
    @State private var watermark: [String: Int] = [:]
    @State private var search = ""
    @State private var remoteHits: [String: String] = [:]
    @State private var remoteMore = false
    @State private var searching = false
    @State private var removingWorkspace: Workspace?
    @State private var showNewWorkspace = false

    private static let ungrouped = ""
    private static let baseRows = 5
    private static let autoMaxRows = 50
    private static let searchLimit = 20

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                topBar
                newConversationButton

                List {
                    if search.trimmingCharacters(in: .whitespaces).isEmpty {
                        if groupBy == .time { timeList } else { groupList }
                        archivedEntry
                    } else {
                        searchResults
                    }
                }
                .sessionList()
                .refreshable { await app.refreshSessions() }

                settingsRow
            }
            .background(Palette.background)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Route.self) { _ in archivedPage }
        }
        .task(id: search) { await searchRemote() }
        .onChange(of: searchRequest) { searchFocused = true }
        .onChange(of: groupBy) { Haptics.select() }
        .confirmationDialog("删除「\(removingWorkspace?.displayTitle ?? "")」？", isPresented: Binding(get: { removingWorkspace != nil }, set: { if !$0 { removingWorkspace = nil } }), titleVisibility: .visible) {
            Button("删除工作区", role: .destructive) {
                if let workspace = removingWorkspace {
                    Task { await app.perform { try await app.client.call("workspace/delete", ["request": ["workspaceId": .string(workspace.id)]]) } }
                }
            }
        } message: {
            Text("文件夹和会话都会保留，会话移到「未分组」。")
        }
        .sheet(isPresented: $showNewWorkspace) { NewWorkspaceView() }
    }

    // MARK: Header and footer

    /// Search and the view menu; a new conversation has a row of its own under them.
    private var topBar: some View {
        HStack(spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.subheadline).foregroundStyle(Palette.secondary)
                TextField("搜索会话", text: $search).font(.subheadline).submitLabel(.search)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($searchFocused)
                if !search.isEmpty {
                    Button { search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.faint).hitTarget() }
                        .accessibilityLabel("清除搜索")
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, search.isEmpty ? 14 : 2)
            .frame(minHeight: 44)
            .background(Palette.bubble, in: Capsule())
            viewMenu
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .padding(.top, 12)
        .padding(.bottom, 4)
    }

    /// The one thing here that is not about finding a session, so it says its name and
    /// takes the full width, as the web sidebar's 新会话 button does — not an icon among icons.
    /// Outlined: the drawer is for finding sessions, and this must not outweigh them.
    private var newConversationButton: some View {
        Button { if let target = workspace ?? app.workspaces.first { newConversation(target) } } label: {
            HStack(spacing: 8) {
                Image(systemName: "square.and.pencil").font(.callout.weight(.semibold))
                Text("新会话")
            }
        }
        .buttonStyle(.capsule(.outline, height: 44))
        .disabled(app.workspaces.isEmpty)
        .opacity(app.workspaces.isEmpty ? 0.4 : 1)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    private var viewMenu: some View {
        Menu {
            Picker("分组方式", selection: $groupBy) {
                Label("按时间", systemImage: "clock").tag(GroupBy.time)
                Label("按工作区", systemImage: "folder").tag(GroupBy.workspace)
            }
            .pickerStyle(.inline)
            Button { showNewWorkspace = true } label: { Label("添加工作区", systemImage: "folder.badge.plus") }
        } label: {
            Image(systemName: "line.3.horizontal.decrease")
                .font(.subheadline)
                .foregroundStyle(groupBy == .time ? Palette.secondary : Palette.ink)
                .hitTarget()
        }
        .accessibilityLabel("视图选项")
    }

    /// Settings on a tap. Holding it reaches what is not about finding a session:
    /// automations (also in settings), the Cordis panel, signing in.
    /// Signed in, the row carries the account as the web sidebar's account button does:
    /// Platform's picture and `name ?? contact`. The engine shows only when it is not running.
    private var settingsRow: some View {
        Menu {
            Button(action: openSettings) { Label("设置", systemImage: "gearshape") }
            Button(action: openSchedules) {
                if let count = app.scheduleCount, count > 0 {
                    Label("自动化（\(count)）", systemImage: "clock")
                } else {
                    Label("自动化", systemImage: "clock")
                }
            }
            if !app.cordis.rows.isEmpty {
                Button(action: openCordis) {
                    if app.cordis.runningCount > 0 {
                        Label("Cordis 插件（\(app.cordis.runningCount) 运行中）", systemImage: "shippingbox")
                    } else {
                        Label("Cordis 插件", systemImage: "shippingbox")
                    }
                }
            }
            if !app.account.signedIn {
                Button(action: openSignIn) { Label("登录", systemImage: "person") }
            }
        } label: {
            HStack(spacing: 12) {
                if app.account.signedIn {
                    AccountAvatar(url: app.account.profileValue?["avatarUrl"].string.flatMap(URL.init(string:)), size: 32)
                } else {
                    Image(systemName: "slider.horizontal.3").font(.subheadline).foregroundStyle(Palette.ink)
                        .frame(width: 32, height: 32).background(Palette.control, in: Circle())
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(accountTitle).font(.subheadline).foregroundStyle(Palette.ink).lineLimit(1)
                    if let engineStatus {
                        Text(engineStatus).font(.caption).foregroundStyle(Palette.secondary)
                    }
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Palette.faint)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        } primaryAction: {
            openSettings()
        }
        .padding(.horizontal, 8)
        .padding(.bottom, 8)
    }

    private var accountTitle: String {
        guard app.account.signedIn else { return String(localized: "设置") }
        let profile = app.account.profileValue
        return profile?["name"].string ?? profile?["contact"].string ?? String(localized: "已登录 DeepSeek")
    }

    private var engineStatus: String? {
        switch engine.phase {
        case .starting: String(localized: "引擎启动中")
        case .running: nil
        case .exited(let code): String(localized: "引擎已退出（\(code)）")
        }
    }

    // MARK: Groups

    private struct SessionGroup: Identifiable {
        let id: String
        let workspace: Workspace?
        let rows: [SessionSummary]
    }

    /// One group per workspace in host order, then 「未分组」 when it has members.
    private var groups: [SessionGroup] {
        var result = app.workspaces.map { SessionGroup(id: $0.id, workspace: $0, rows: app.sessions(in: $0)) }
        let loose = app.sessions(in: nil)
        if !loose.isEmpty { result.append(SessionGroup(id: Self.ungrouped, workspace: nil, rows: loose)) }
        return result
    }

    @ViewBuilder
    private var groupList: some View {
        let groups = groups
        if groups.isEmpty { emptyRow("暂无会话") }
        ForEach(groups) { group in
            let open = isExpanded(group)
            groupHeader(group, open: open)
            if open {
                let shown = shownCount(group)
                ForEach(group.rows.prefix(shown)) { session in row(session, indent: true) }
                if group.rows.isEmpty {
                    Text("暂无会话")
                        .font(.footnote)
                        .foregroundStyle(Palette.faint)
                        .padding(.leading, 46)
                        .plainRow()
                } else if group.rows.count > Self.baseRows {
                    moreRow(group, shown: shown)
                }
            }
        }
    }

    /// A tap folds the group; holding it starts a session there or manages the workspace.
    private func groupHeader(_ group: SessionGroup, open: Bool) -> some View {
        let holdsCurrent = selection.map { id in group.rows.contains { $0.id == id } } ?? false
        let title = group.workspace?.displayTitle ?? String(localized: "未分组")
        return Button {
            Haptics.select()
            withAnimation(.snappy(duration: 0.2)) { setExpanded(group, !open) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: open ? "folder" : "folder.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(holdsCurrent ? Palette.ink : Palette.secondary)
                    .frame(width: 22)
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Palette.faint)
                    .rotationEffect(.degrees(open ? 90 : 0))
                Spacer(minLength: 0)
            }
            .padding(.leading, 12)
            .padding(.trailing, 2)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title))
        .accessibilityValue(open ? Text("已展开") : Text("已收起"))
        .plainRow()
        .contextMenu {
            if let workspace = group.workspace {
                Button { setExpanded(group, true); newConversation(workspace) } label: { Label("新会话", systemImage: "square.and.pencil") }
                Button { app.renameRequest = RenameRequest(target: .workspace(workspace.id), initial: workspace.displayTitle) } label: { Label("重命名", systemImage: "pencil") }
                Button { copyToPasteboard(workspace.path); app.showToast(String(localized: "已复制"), tone: .success) } label: { Label("复制路径", systemImage: "doc.on.doc") }
                Button(role: .destructive) { removingWorkspace = workspace } label: { Label("删除工作区", systemImage: "trash") }
            }
        }
    }

    /// 「展开其余 n 个会话」 five at a time (all when five or fewer remain), then 「收起」.
    private func moreRow(_ group: SessionGroup, shown: Int) -> some View {
        let hidden = group.rows.count - shown
        return Button {
            withAnimation(.snappy(duration: 0.2)) {
                if hidden > 0 {
                    watermark[group.id] = hidden <= Self.baseRows ? group.rows.count : shown + Self.baseRows
                } else {
                    watermark[group.id] = nil
                }
            }
        } label: {
            Text(hidden > 0 ? "展开其余 \(hidden) 个会话" : "收起")
                .font(.footnote)
                .foregroundStyle(Palette.secondary)
                .padding(.leading, 46)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .plainRow()
    }

    /// The base five, raised (up to fifty) to keep the current, running and waiting sessions in view.
    private func shownCount(_ group: SessionGroup) -> Int {
        if let explicit = watermark[group.id] { return min(explicit, group.rows.count) }
        var count = min(Self.baseRows, group.rows.count)
        for (index, session) in group.rows.enumerated() where index >= count && index < Self.autoMaxRows {
            if session.id == selection || session.running || app.isWaiting(session.id) { count = index + 1 }
        }
        return count
    }

    private var expansion: [String: Bool] {
        (try? JSONDecoder().decode([String: Bool].self, from: Data(expansionJSON.utf8))) ?? [:]
    }

    /// Groups start open (the web opens only the current one; on a phone every
    /// workspace should be a glance away, and each shows five rows); a group the
    /// user closed stays closed unless it holds the current session.
    private func isExpanded(_ group: SessionGroup) -> Bool {
        if let selection, group.rows.contains(where: { $0.id == selection }) { return true }
        return expansion[group.id] ?? true
    }

    private func setExpanded(_ group: SessionGroup, _ open: Bool) {
        var next = expansion
        next[group.id] = open
        if !open { watermark[group.id] = nil }
        if let data = try? JSONEncoder().encode(next), let text = String(data: data, encoding: .utf8) { expansionJSON = text }
    }

    // MARK: Time list, archive and search

    @ViewBuilder
    private var timeList: some View {
        let rows = timeRows
        if rows.isEmpty { emptyRow("暂无会话") }
        let periods = Dictionary(grouping: rows, by: period(of:))
        ForEach(Period.allCases, id: \.self) { period in
            if let members = periods[period] {
                Text(period.title)
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
                    .padding(.leading, 14)
                    .padding(.top, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
                    .plainRow()
                ForEach(members) { session in row(session, subtitle: placeLine(of: session)) }
            }
        }
    }

    /// Every session of the list: pinned, then most recent.
    private var timeRows: [SessionSummary] {
        allSessions(includeArchived: false).sorted { lhs, rhs in
            let lp = app.pinned.firstIndex(of: lhs.id), rp = app.pinned.firstIndex(of: rhs.id)
            if (lp != nil) != (rp != nil) { return lp != nil }
            if let lp, let rp { return lp < rp }
            return lhs.updatedAt > rhs.updatedAt
        }
    }

    private func allSessions(includeArchived: Bool) -> [SessionSummary] {
        app.workspaces.flatMap { app.sessions(in: $0, includeArchived: includeArchived) }
            + app.sessions(in: nil, includeArchived: includeArchived)
    }

    private func period(of session: SessionSummary) -> Period {
        app.isPinned(session.id) ? .pinned : Self.period(of: session.updatedAt)
    }

    static func period(of date: Date, now: Date = .now, calendar: Calendar = .current) -> Period {
        if calendar.isDate(date, inSameDayAs: now) { return .today }
        return calendar.isDate(date, equalTo: now, toGranularity: .weekOfYear) ? .week : .earlier
    }

    private var archivedRows: [SessionSummary] {
        allSessions(includeArchived: true).filter { app.isArchived($0.id) }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// The way to the archive, at the end of the list; nothing archived, nothing to see.
    @ViewBuilder
    private var archivedEntry: some View {
        let count = archivedRows.count
        if count > 0 {
            NavigationLink(value: Route.archived) {
                HStack(spacing: 10) {
                    Image(systemName: "archivebox").font(.system(size: 15)).foregroundStyle(Palette.secondary).frame(width: 22)
                    Text("已归档").font(.subheadline).foregroundStyle(Palette.ink)
                    Spacer(minLength: 4)
                    Text("\(count)").font(.caption).foregroundStyle(Palette.faint)
                }
                .padding(.leading, 12)
            }
            .padding(.top, 8)
            .plainRow()
        }
    }

    private var archivedPage: some View {
        List {
            let rows = archivedRows
            if rows.isEmpty { emptyRow("暂无已归档会话") }
            ForEach(rows) { session in row(session, subtitle: placeLine(of: session)) }
        }
        .sessionList()
        .background(Palette.background)
        .navigationTitle("已归档")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Palette.background, for: .navigationBar)
    }

    private func emptyRow(_ text: LocalizedStringKey) -> some View {
        Text(text).font(.subheadline).foregroundStyle(Palette.secondary).padding(.horizontal, 12).plainRow()
    }

    /// The workspace under a row's title; with a single workspace it would say the same thing on every row.
    private func placeLine(of session: SessionSummary) -> String? {
        app.workspaces.count > 1 ? place(of: session) : nil
    }

    private func place(of session: SessionSummary) -> String {
        app.workspace(of: session.id)?.displayTitle ?? String(localized: "未分组")
    }

    /// Title or workspace-name matches first (newest first), then content hits from `session/search`,
    /// at most twenty. Archived sessions count, after the others: search is how one finds anything.
    private var searchMatches: [SessionSummary] {
        let query = search.trimmingCharacters(in: .whitespaces)
        let pool = allSessions(includeArchived: true)
        let local = pool
            .filter { app.title(of: $0.id).localizedCaseInsensitiveContains(query) || (app.workspace(of: $0.id)?.displayTitle.localizedCaseInsensitiveContains(query) ?? false) }
            .sorted { $0.updatedAt > $1.updatedAt }
        let localIds = Set(local.map(\.id))
        let remote = pool.filter { remoteHits[$0.id] != nil && !localIds.contains($0.id) }
        let matches = local + remote
        let ordered = matches.filter { !app.isArchived($0.id) } + matches.filter { app.isArchived($0.id) }
        return Array(ordered.prefix(Self.searchLimit))
    }

    @ViewBuilder
    private var searchResults: some View {
        let matches = searchMatches
        ForEach(matches) { session in
            row(session, subtitle: place(of: session) + (remoteHits[session.id].map { " · \($0)" } ?? ""))
        }
        if searching {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("正在搜索会话历史…").font(.footnote).foregroundStyle(Palette.secondary)
            }
            .padding(.horizontal, 12)
            .plainRow()
        } else if matches.isEmpty {
            emptyRow("无匹配会话")
        } else if remoteMore || matches.count >= Self.searchLimit {
            Text("仅显示前 \(Self.searchLimit) 条，请缩小范围").font(.footnote).foregroundStyle(Palette.faint).padding(.horizontal, 12).plainRow()
        }
    }

    /// Message-content search, 250 ms after typing stops; a newer query cancels this one.
    private func searchRemote() async {
        remoteHits = [:]
        remoteMore = false
        let query = search.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { searching = false; return }
        searching = true
        defer { if !Task.isCancelled { searching = false } }
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled,
              let value = try? await app.client.call("session/search", ["request": ["query": .string(query)]]),
              !Task.isCancelled else { return }
        var hits: [String: String] = [:]
        for item in value["items"].array {
            if let id = item["sessionId"].string { hits[id] = item["snippet"].string ?? "" }
        }
        remoteHits = hits
        remoteMore = value["hasMore"].bool ?? false
    }

    // MARK: Rows

    /// The leading mark, by the web's status order: waiting, running, subagents
    /// running, an unread completion; an idle row with an active task shows a clock.
    @ViewBuilder
    private func leading(_ session: SessionSummary) -> some View {
        if app.isArchived(session.id) {
            Color.clear
        } else if app.isWaiting(session.id) {
            StatusDot(state: .waiting)
        } else if session.running {
            StatusDot(state: .running)
        } else if app.runningSubagentCount(of: session.id) > 0 {
            StatusDot(state: .running)
                .accessibilityLabel(Text("\(app.runningSubagentCount(of: session.id)) 个子智能体运行中"))
        } else if app.completionUnread.contains(session.id) {
            Circle().fill(Palette.ink).frame(width: 7, height: 7).accessibilityLabel(Text("已完成"))
        } else if !app.activeSchedules(of: session.id).isEmpty {
            Image(systemName: "clock").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.secondary)
                .accessibilityLabel(Text("有定时任务"))
        } else {
            Color.clear
        }
    }

    /// A session: status mark, title (and the small line under it), then a waiting label or the relative time.
    /// An archived row does not open, as on the web: it offers to come back instead.
    private func row(_ session: SessionSummary, indent: Bool = false, subtitle: String? = nil) -> some View {
        let current = session.id == selection
        let archived = app.isArchived(session.id)
        return Button {
            if archived { app.open(session: session.id) } else { search = ""; select(session.id) }
        } label: {
            HStack(alignment: subtitle == nil ? .center : .top, spacing: 8) {
                leading(session)
                .frame(width: 14, height: subtitle == nil ? nil : 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(app.title(of: session.id))
                        .font(.subheadline)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    if let subtitle {
                        Text(subtitle).font(.caption).foregroundStyle(Palette.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                if app.isPinned(session.id) && !archived {
                    Image(systemName: "pin.fill").font(.caption2).foregroundStyle(Palette.faint)
                }
                if archived {
                    Image(systemName: "archivebox").font(.caption).foregroundStyle(Palette.faint)
                } else if let pending = app.pendingLabel(of: session.id) {
                    Text(pending)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Palette.waiting)
                } else {
                    Text(Self.relative(session.updatedAt)).font(.caption).foregroundStyle(Palette.faint)
                }
            }
            .padding(.leading, indent ? 22 : 4)
            .padding(.trailing, 12)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .opacity(archived ? 0.55 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(current ? .isSelected : [])
        .swipeActions(edge: .leading) {
            if !archived {
                Button {
                    Haptics.tap()
                    Task { await app.setPinned(session.id, !app.isPinned(session.id)) }
                } label: {
                    Label(app.isPinned(session.id) ? "取消置顶" : "置顶", systemImage: app.isPinned(session.id) ? "pin.slash" : "pin")
                }
                .tint(Palette.secondary)
            }
        }
        // No full swipe: a long leftward swipe is how the drawer closes, and must not archive.
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button {
                Haptics.tap()
                Task { if archived { await app.unarchive(session.id) } else { await app.archive(session.id) } }
            } label: {
                Label(archived ? "取消归档" : "归档", systemImage: archived ? "tray.and.arrow.up" : "archivebox")
            }
            .tint(Palette.ink)
        }
        .contextMenu { menu(for: session) }
        .reportsFrame(session.id, to: rowFrames)
        // Outermost: below the frame report the list no longer sees them.
        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
        .listRowSeparator(.hidden)
        .listRowBackground(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(current ? Palette.bubble : .clear)
                .padding(.horizontal, 8)
        )
    }

    /// 刚刚 / N分钟 / N小时 / N天 / N个月 / N年 (docs/webui/shell.md A §4.3).
    static func relative(_ date: Date, now: Date = .now) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        let minutes = Int(seconds / 60), hours = minutes / 60, days = hours / 24
        if minutes < 1 { return String(localized: "刚刚") }
        if hours < 1 { return String(localized: "\(minutes)分钟") }
        if days < 1 { return String(localized: "\(hours)小时") }
        if days < 30 { return String(localized: "\(days)天") }
        if days < 365 { return String(localized: "\(days / 30)个月") }
        return String(localized: "\(days / 365)年")
    }

    /// The web row menu, in its order: pin, rename, fork, archive, copy the id.
    @ViewBuilder
    private func menu(for session: SessionSummary) -> some View {
        let archived = app.isArchived(session.id)
        if let openInWindow {
            Button { openInWindow(session.id) } label: { Label("在新窗口中打开", systemImage: "macwindow.badge.plus") }
        }
        if !archived {
            Button {
                Task { await app.setPinned(session.id, !app.isPinned(session.id)) }
            } label: { Label(app.isPinned(session.id) ? "取消置顶" : "置顶会话", systemImage: app.isPinned(session.id) ? "pin.slash" : "pin") }
        }
        Button { app.renameRequest = RenameRequest(target: .session(session.id), initial: app.durableTitle(of: session.id) ?? "") } label: { Label("重命名", systemImage: "pencil") }
        Button {
            Task { await app.fork(session: session.id, from: .menu) }
        } label: { Label("分叉会话", systemImage: "arrow.triangle.branch") }
        Button {
            Task { if archived { await app.unarchive(session.id) } else { await app.archive(session.id) } }
        } label: { Label(archived ? "取消归档" : "归档会话", systemImage: archived ? "tray.and.arrow.up" : "archivebox") }
        Button { app.copySessionId(session.id) } label: { Label("复制会话 ID", systemImage: "doc.on.doc") }
    }
}

/// Where the drawer's session rows are on screen, in `space`: a horizontal swipe
/// that starts on one belongs to the row, anywhere else in the drawer it closes it.
/// Only heights count, since a list cell spans the drawer past the row's insets.
/// A plain reference: rows report while scrolling, nothing redraws for it.
@MainActor
final class DrawerRowFrames {
    static let space = "shell"
    private var frames: [String: CGRect] = [:]
    /// Rows on screen. Frames stay when a row leaves: a row back from behind
    /// a pushed page has not moved, so it does not report again.
    private var shown: Set<String> = []

    func set(_ frame: CGRect, of id: String) { frames[id] = frame }
    func setShown(_ id: String, _ isShown: Bool) { if isShown { shown.insert(id) } else { shown.remove(id) } }
    func hasRow(atY y: CGFloat) -> Bool {
        shown.contains { id in frames[id].map { $0.minY...$0.maxY ~= y } ?? false }
    }
}

private extension View {
    /// A list row with no fill, separator or selection inset (headers, notes).
    func plainRow() -> some View {
        listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    /// The drawer's list look, on the main list and the archive.
    func sessionList() -> some View {
        listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 44)
            .scrollDismissesKeyboard(.immediately)
    }

    func reportsFrame(_ id: String, to frames: DrawerRowFrames) -> some View {
        onGeometryChange(for: CGRect.self) { $0.frame(in: .named(DrawerRowFrames.space)) } action: { frames.set($0, of: id) }
            .onAppear { frames.setShown(id, true) }
            .onDisappear { frames.setShown(id, false) }
    }
}
