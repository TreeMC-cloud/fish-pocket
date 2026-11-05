import SwiftUI
import WebKit

/// The Host's task catalog (`schedule/catalog`: every session, active and
/// inactive, by target time), shared by the list and the detail it pushes.
@MainActor
@Observable
final class ScheduleCatalog {
    enum Status { case loading, ready, error }

    private(set) var records: [JSON] = []
    private(set) var status = Status.loading
    /// A read has succeeded at least once.
    private(set) var settled = false
    @ObservationIgnored private var epoch = 0

    func load(_ client: EngineClient) async {
        epoch += 1
        let current = epoch
        status = .loading
        do {
            let value = try await client.call("schedule/catalog")
            guard current == epoch else { return }
            records = value.array
            status = .ready
            settled = true
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
        } catch {
            if current == epoch { status = .error }
        }
    }

    func entry(_ id: String) -> JSON? { records.first { $0["id"].string == id } }
}

/// 自动化任务 (S-99): every task the agent scheduled, filtered by status and
/// searched by title / instruction / session id, in target-time order; it
/// re-reads on `schedule/changed` and on reconnect (S-107).
///
/// `sessionId` narrows the list to one session (the session header's entry);
/// `openSession` opens a session and leaves this page. Without it the page
/// dismisses itself and opens `dsh://session/<id>`, which `MainView` handles.
struct SchedulesView: View {
    var sessionId: String? = nil
    var openSession: ((String) -> Void)? = nil

    enum StatusFilter: String, CaseIterable, Identifiable {
        case all, active, inactive
        var id: String { rawValue }
        var label: LocalizedStringKey {
            switch self {
            case .all: "全部"
            case .active: "已开启"
            case .inactive: "已结束"
            }
        }
    }

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @AppStorage("dsh.currentWorkspace") private var workspaceId = ""
    @State private var catalog = ScheduleCatalog()
    @State private var filter = StatusFilter.all
    @State private var query = ""
    @State private var confirming: JSON?
    @State private var creating = false

    private var scoped: [JSON] {
        catalog.records.filter { sessionId == nil || $0["target"]["sessionId"].string == sessionId }
    }

    private var shown: [JSON] {
        let needle = query.trimmed.lowercased()
        return scoped
            .filter { filter == .all || ScheduleRule.isArmed($0) == (filter == .active) }
            .filter { record in
                needle.isEmpty || ["title", "prompt"].contains { (record[$0].string ?? "").lowercased().contains(needle) }
                    || (record["target"]["sessionId"].string ?? "").lowercased().contains(needle)
            }
            .sorted { (ScheduleFormat.date($0["scheduledAt"].string) ?? .distantFuture) < (ScheduleFormat.date($1["scheduledAt"].string) ?? .distantFuture) }
    }

    var body: some View {
        List {
            Section {
                if catalog.status == .error && !catalog.records.isEmpty {
                    HStack {
                        Text("无法加载任务").foregroundStyle(Palette.removed)
                        Spacer()
                        Button("重试") { Task { await catalog.load(app.client) } }
                    }
                    .font(.footnote)
                }
                // By task id: a row keeps its pushed detail when its next run moves.
                ForEach(shown, id: \.["id"]) { record in
                    NavigationLink {
                        ScheduleDetailView(catalog: catalog, taskId: record["id"].string ?? "", withinSession: sessionId, openSession: open, delete: delete)
                    } label: {
                        ScheduleRow(record: record)
                    }
                    .swipeActions {
                        Button(role: .destructive) { confirming = record } label: { Label("删除", systemImage: "trash") }
                    }
                    .contextMenu {
                        Button { copyToPasteboard(record["id"].string ?? "") } label: { Label("复制任务 ID", systemImage: "number") }
                        Button(role: .destructive) { confirming = record } label: { Label("删除", systemImage: "trash") }
                    }
                }
            } header: {
                VStack(alignment: .leading, spacing: 10) {
                    if let sessionId {
                        Text("会话：\(app.title(of: sessionId))").lineLimit(1)
                    }
                    Picker("任务状态", selection: $filter) {
                        ForEach(StatusFilter.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                .textCase(nil)
                .padding(.bottom, 6)
            }
            .groupedRow()
        }
        .overlay { overlay }
        .groupedList()
        .searchable(text: $query, prompt: "搜索自动化任务")
        .navigationTitle("自动化任务")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if sessionId == nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Task { await newTask() } } label: { Label("新建", systemImage: "plus") }
                        .disabled(creating)
                }
            }
        }
        .refreshable { await catalog.load(app.client) }
        .task(id: app.revision("schedule/changed")) { await catalog.load(app.client) }
        .confirmationDialog("删除此任务？", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible, presenting: confirming) { record in
            Button("确认删除", role: .destructive) { Task { _ = await delete(record) } }
            Button("取消", role: .cancel) {}
        } message: { record in
            Text("「\(record["title"].string ?? "")」\n任务将停止触发，并连同其已保存的任务运行记录一并删除。原会话及其消息仍然保留；已排队的消息不会被撤回。")
        }
    }

    @ViewBuilder
    private var overlay: some View {
        if !catalog.settled && catalog.status != .error {
            ProgressView()
        } else if catalog.status == .error && catalog.records.isEmpty {
            ContentUnavailableView {
                Label("无法加载任务", systemImage: "exclamationmark.triangle")
            } actions: {
                Button("重试") { Task { await catalog.load(app.client) } }
            }
        } else if shown.isEmpty {
            ContentUnavailableView {
                Label(emptyTitle, systemImage: "clock")
            } description: {
                if scoped.isEmpty { Text("在对话里让 DSH 安排，例如「每天早上 9 点总结提交」。") }
            } actions: {
                if sessionId == nil && scoped.isEmpty {
                    Button("新建") { Task { await newTask() } }.disabled(creating)
                }
            }
        }
    }

    private var emptyTitle: LocalizedStringKey {
        if scoped.isEmpty { return "还没有自动化任务" }
        if filter == .inactive && query.trimmed.isEmpty { return "没有已结束的任务" }
        return "没有匹配的任务"
    }

    /// The web's 新建 opens a new session: tasks are created by the agent there.
    private func newTask() async {
        guard let workspace = app.workspaces.first(where: { $0.id == workspaceId }) ?? app.workspaces.first else { return }
        creating = true
        defer { creating = false }
        do {
            open(try await app.createSession(in: workspace))
        } catch {
            app.lastError = error.localizedDescription
        }
    }

    private func open(_ id: String) {
        if let openSession { openSession(id); return }
        dismiss()
        if let url = URL(string: "dsh://session/\(id)") { UIApplication.shared.open(url) }
    }

    /// Hard delete (with its delivery history); the outcome goes to the shell toast (S-104).
    private func delete(_ record: JSON) async -> Bool {
        do {
            _ = try await app.client.call("schedule/edit", ["request": ["id": record["id"], "action": "delete"]])
            Haptics.success()
            app.showToast(String(localized: "任务已删除"))
            await catalog.load(app.client)
            return true
        } catch {
            Haptics.error()
            app.showToast(String(localized: "无法删除任务"))
            return false
        }
    }
}

/// One catalog row: title, then [已结束 ·] frequency, then the next run with its countdown.
private struct ScheduleRow: View {
    let record: JSON

    var body: some View {
        let armed = ScheduleRule.isArmed(record)
        let stopped = record["status"].string == "paused" ? String(localized: "已暂停") : String(localized: "已结束")
        VStack(alignment: .leading, spacing: 4) {
            Text(record["title"].string ?? "任务").font(.callout).foregroundStyle(armed ? Palette.ink : Palette.secondary).lineLimit(2)
            Text(([armed ? nil : stopped, ScheduleFormat.frequency(record)].compactMap { $0 }).joined(separator: " · "))
                .font(.footnote).foregroundStyle(Palette.secondary)
            if armed, let at = record["scheduledAt"].string {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text("下次运行：\(ScheduleFormat.nextRun(at, now: context.date))")
                        .font(.caption).foregroundStyle(Palette.faint).monospacedDigit()
                }
            }
        }
        .padding(.vertical, 3)
    }
}

/// Kept for callers outside this file: the rule as one line.
func describe(_ task: JSON) -> String { ScheduleFormat.frequency(task) }

// MARK: Detail

/// 任务详情 (S-100): the rule (name, instruction, run time — editable while
/// active, S-101…S-103) and the delivery records (S-105); the linked session
/// (B9) and deletion (S-104). Saving is in the toolbar; unsaved edits hold the
/// page, and every way out asks first.
struct ScheduleDetailView: View {
    enum Tab: String, CaseIterable { case rule, records }
    enum Failure: Equatable { case local, message(String) }

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let catalog: ScheduleCatalog
    let taskId: String
    /// The session this page was opened from: its link is hidden.
    var withinSession: String?
    let openSession: (String) -> Void
    let delete: (JSON) async -> Bool

    @State private var tab = Tab.rule
    /// The last record seen in the catalog, kept while it is being deleted or saved.
    @State private var retained: JSON?
    @State private var stored: RuleValues?
    @State private var shown: RuleValues?
    @State private var unit = IntervalUnit.hour
    @State private var explicitUnit = false
    /// The weekday set last chosen, carried when switching back to weekly.
    @State private var memory: [Int]?
    @State private var pending = false
    @State private var failure: Failure?
    @State private var confirmingDelete = false
    @State private var confirmingDiscard = false
    @State private var deleting = false

    private var task: JSON? { catalog.entry(taskId) ?? retained }
    private var active: Bool { task.map(ScheduleRule.isArmed) ?? true }
    private var dirty: Bool {
        guard let shown, let stored, active else { return false }
        return shown.key != stored.key
    }
    private var busy: Bool { pending || deleting || catalog.status == .loading && !catalog.settled }

    private var failureText: String? {
        switch failure {
        case .local: return shown.flatMap { ScheduleRule.draftError($0, unit: unit) }
        case .message(let text): return text
        case nil: return nil
        }
    }

    var body: some View {
        let page = Group {
            if let task {
                VStack(spacing: 0) {
                    Picker("任务详情视图", selection: $tab) {
                        Text("规则").tag(Tab.rule)
                        Text("运行记录").tag(Tab.records)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    switch tab {
                    case .rule: rule(task)
                    case .records: DeliveryHistoryView(task: task)
                    }
                }
                .background(Palette.background)
            } else if catalog.settled {
                ContentUnavailableView("任务已不可用，可能已被删除", systemImage: "clock")
            } else {
                ProgressView()
            }
        }
        .navigationTitle(task?["title"].string ?? String(localized: "任务详情"))
        .navigationBarTitleDisplayMode(.inline)
        // 取消 takes the back button's place while there is something to lose.
        .navigationBarBackButtonHidden(dirty)
        .interactiveDismissDisabled(dirty)

        Group {
            if active {
                page.saveToolbar(canSave: dirty && !busy, saving: pending, cancel: dirty ? { confirmingDiscard = true } : nil) {
                    Task { await save() }
                }
            } else {
                page
            }
        }
        .background { if dirty { EdgeSwipeAttempt { confirmingDiscard = true } } }
        .confirmationDialog("删除此任务？", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("确认删除", role: .destructive) {
                guard let task else { return }
                deleting = true
                Task {
                    if await delete(task) { dismiss() }
                    deleting = false
                }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("任务将停止触发，并连同其已保存的任务运行记录一并删除。原会话及其消息仍然保留；已排队的消息不会被撤回。")
        }
        .confirmationDialog("有未保存的修改", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("放弃修改", role: .destructive) { cancel(); dismiss() }
            Button("继续编辑", role: .cancel) {}
        }
        .onAppear(perform: sync)
        .onChange(of: catalog.entry(taskId)) { _, _ in sync() }
        // The save button is at the top; the reason may be under the fold.
        .onChange(of: failure) { _, failure in
            if failure != nil, let failureText { app.showToast(failureText, tone: .warning) }
        }
        .onChange(of: shown?.kind) { _, kind in
            // A switch into the interval picks the unit that states it, unless one was chosen.
            guard kind == .every else { explicitUnit = false; return }
            if !explicitUnit, let seconds = shown?.draft.seconds { unit = .preferred(seconds) }
        }
    }

    // MARK: Rule tab

    @ViewBuilder
    private func rule(_ task: JSON) -> some View {
        // 0.2.2 added the `rrule` kind, which this editor cannot represent: such a rule
        // stays read-only, so a save can never rewrite it into a one-shot.
        let editable = active && ScheduleRule.editableKind(task) && !busy
        Form {
            Section {
                if active, shown != nil {
                    TextField("自动化任务名称", text: binding(\.title))
                        .font(.headline)
                        .disabled(!editable)
                } else {
                    Text(task["title"].string ?? "").font(.headline)
                }
                Group {
                    if active, let at = task["scheduledAt"].string {
                        TimelineView(.periodic(from: .now, by: 30)) { context in
                            LabeledContent("下次运行", value: ScheduleFormat.nextRun(at, now: context.date))
                        }
                    } else {
                        LabeledContent("状态", value: String(localized: "已结束"))
                    }
                }
                .contextMenu {
                    Button { copyToPasteboard(task["id"].string ?? "") } label: { Label("复制任务 ID", systemImage: "number") }
                }
            }
            .groupedRow()

            Section("指令") {
                if active, shown != nil {
                    TextField("自动化任务内容", text: binding(\.prompt), axis: .vertical)
                        .lineLimit(3...12)
                        .disabled(!editable)
                } else {
                    Text(task["prompt"].string ?? "").textSelection(.enabled)
                }
            }
            .groupedRow()

            if let shown {
                RuleEditor(
                    task: task,
                    values: shown,
                    unit: unit,
                    editable: editable,
                    failure: failureText,
                    choose: chooseKind,
                    chooseZone: { zone in edit { $0.draft.timeZone = zone } },
                    toggleWeekday: toggleWeekday,
                    editDraft: { draft in edit { $0.draft = draft } }
                )
            }

            if withinSession != task["target"]["sessionId"].string, let session = task["target"]["sessionId"].string {
                linkedSession(session)
            }

            Section {
                Button(role: .destructive) { confirmingDelete = true } label: {
                    Text(deleting ? "正在删除…" : "删除任务")
                }
                .foregroundStyle(Palette.removed)
                .disabled(busy || catalog.entry(taskId) == nil)
            }
            .groupedRow()
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            // The number pad has no return key.
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("完成") { dismissKeyboard() }
            }
        }
    }

    /// B9: opens the task's session (the only action here that activates one; an archived session stays archived).
    private func linkedSession(_ id: String) -> some View {
        let exists = app.sessions[id] != nil
        let archived = app.isArchived(id)
        return Section {
            Button { openSession(id) } label: {
                HStack {
                    Label { Text(exists ? app.title(of: id) : id).lineLimit(1) } icon: { Image(systemName: "bubble.left") }
                    Spacer()
                    Image(systemName: "chevron.forward").font(.footnote).foregroundStyle(Palette.faint)
                }
                .foregroundStyle(Palette.ink)
            }
            .disabled(!exists || archived)
            .accessibilityLabel(exists ? "关联会话 \(app.title(of: id))：打开原会话" : "关联会话：打开原会话")
        } header: {
            Text("关联会话")
        } footer: {
            if archived { Text("原会话已归档") } else if !exists { Text("原会话当前不可用") }
        }
        .groupedRow()
    }

    // MARK: Editing

    private func binding(_ key: WritableKeyPath<RuleValues, String>) -> Binding<String> {
        Binding(get: { shown?[keyPath: key] ?? "" }, set: { value in edit { $0[keyPath: key] = value } })
    }

    private func edit(_ change: (inout RuleValues) -> Void) {
        guard var values = shown else { return }
        change(&values)
        shown = values
    }

    /// Adopt a refreshed catalog row: a clean draft takes it, a staged one merges field by field (B25).
    private func sync() {
        guard let record = catalog.entry(taskId) else { return }
        retained = record
        let values = ScheduleRule.values(record)
        guard values.key != stored?.key else { return }
        if let current = shown, let previous = stored, ScheduleRule.isArmed(record) {
            if memory == previous.weekdays { memory = nil }
            shown = ScheduleRule.merge(values, draft: current, stored: previous)
        } else {
            shown = values
            unit = .preferred(values.draft.seconds)
        }
        stored = values
    }

    private func setOf(_ kind: RuleKind, _ weekdays: [Int]) -> [Int]? { kind == .weekdays || kind == .weekly ? weekdays : nil }

    /// Switching the Repeat choice seeds the new rule from the committed occurrence (B17).
    private func chooseKind(_ kind: RuleKind, _ chosenUnit: IntervalUnit?) {
        guard let task, let current = shown, let stored else { return }
        if let chosenUnit { explicitUnit = true; unit = chosenUnit }
        guard kind != current.kind else { return }
        if let leaving = setOf(current.kind, current.weekdays) ?? (memory == nil ? setOf(stored.kind, stored.weekdays) : nil) { memory = leaving }
        let restore = kind == stored.kind
        let carriesClock = !restore && kind.hasClock && current.kind.hasClock
        let carried = kind == .weekly ? setOf(current.kind, current.weekdays) ?? memory ?? setOf(stored.kind, stored.weekdays) : nil
        var draft: RuleDraft
        if restore {
            draft = stored.draft
        } else {
            draft = ScheduleRule.seedDraft(task, kind)
            if carriesClock { draft.time = current.draft.time; draft.timeZone = current.draft.timeZone }
            if chosenUnit != nil { draft.seconds = "3600" }
        }
        let weekdays: [Int]
        if kind == .weekdays { weekdays = ScheduleRule.weekdayRule }
        else if kind == .weekly, let carried { weekdays = carried }
        else if restore { weekdays = stored.weekdays }
        else if kind == .weekly && carriesClock { weekdays = [ZonedClock.weekday(task["scheduledAt"].string ?? "", zone: current.draft.timeZone)] }
        else { weekdays = ScheduleRule.seedWeekdays(task) }
        edit { $0.kind = kind; $0.draft = draft; $0.weekdays = weekdays }
    }

    /// At least one weekday stays selected.
    private func toggleWeekday(_ day: Int) {
        guard let current = shown else { return }
        if current.weekdays == [day] { return }
        let next = current.weekdays.contains(day) ? current.weekdays.filter { $0 != day } : (1...7).filter { $0 == day || current.weekdays.contains($0) }
        memory = next
        Haptics.select()
        edit { $0.weekdays = next }
    }

    private func cancel() {
        memory = nil
        shown = stored
        failure = nil
    }

    /// Compare-and-set `schedule/edit` (S-103): only the changed fields, against the
    /// `updatedAt` read when editing began.
    private func save() async {
        guard let task, let current = shown, let stored else { return }
        if ScheduleRule.draftError(current, unit: unit) != nil { failure = .local; Haptics.warning(); return }
        pending = true
        failure = nil
        var patch = ScheduleRule.contentChange(current, stored)
        if current.timingKey != stored.timingKey { patch["timing"] = ScheduleRule.change(current.draft, current.kind, current.weekdays) }
        var request: [String: JSON] = ["id": task["id"], "action": "update", "patch": .object(patch)]
        if let updatedAt = task["updatedAt"].string { request["expectedUpdatedAt"] = .string(updatedAt) }
        do {
            let value = try await app.client.call("schedule/edit", ["request": .object(request)])
            pending = false
            if let code = value["code"].string {
                failure = .message(ScheduleRule.errorMessage(code, unit: unit))
                Haptics.error()
                if ["schedule_conflict", "schedule_not_found"].contains(code) { await catalog.load(app.client) }
                return
            }
            let saved = ScheduleRule.values(value)
            self.stored = saved
            shown = saved
            memory = nil
            Haptics.success()
            await catalog.load(app.client)
        } catch {
            pending = false
            // 0.2.2 rejects an invalid patch instead of answering with a code;
            // `schedule/input-invalid` carries the reason in its details.
            let code = (error as? EngineError)?.detail["details"]["code"].string
            failure = .message(code.map { ScheduleRule.errorMessage($0, unit: unit) } ?? ScheduleRule.unknownError)
            Haptics.error()
        }
    }
}

/// A hidden back button also turns off the system's edge swipe. While this is on
/// screen a swipe from the edge calls `attempt` instead, so the gesture still works
/// and the page gets to ask before anything is lost.
private struct EdgeSwipeAttempt: UIViewRepresentable {
    let attempt: () -> Void

    func makeUIView(context: Context) -> Catcher { Catcher(attempt: attempt) }
    func updateUIView(_ view: Catcher, context: Context) { view.attempt = attempt }

    final class Catcher: UIView, UIGestureRecognizerDelegate {
        var attempt: () -> Void
        private lazy var recognizer: UIScreenEdgePanGestureRecognizer = {
            let recognizer = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(swiped))
            recognizer.edges = .left
            recognizer.delegate = self
            return recognizer
        }()

        init(attempt: @escaping () -> Void) {
            self.attempt = attempt
            super.init(frame: .zero)
            isUserInteractionEnabled = false
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        /// On the window, above the form; a page pushed on top takes this view out of it.
        override func didMoveToWindow() {
            recognizer.view?.removeGestureRecognizer(recognizer)
            window?.addGestureRecognizer(recognizer)
        }

        @objc private func swiped(_ recognizer: UIScreenEdgePanGestureRecognizer) {
            if recognizer.state == .began { attempt() }
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}

// MARK: Delivery records

/// 任务运行记录 (S-105): the latest 20 deliveries, more on demand, each with the prompt it delivered.
private struct DeliveryHistoryView: View {
    let task: JSON
    @Environment(AppModel.self) private var app
    @State private var records: [JSON] = []
    @State private var nextBefore: String?
    @State private var pruned = false
    @State private var retention: JSON = .null
    @State private var loading = true
    @State private var failure: (text: String, before: String?, cursor: Bool)?
    @State private var showRetention = false

    var body: some View {
        List {
            if let failure, !records.isEmpty {
                HStack {
                    Text(failure.text).foregroundStyle(Palette.removed)
                    Spacer()
                    Button(failure.cursor ? "刷新" : "重试") { Task { await load(failure.before) } }
                }
                .font(.footnote)
                .groupedRow()
            }
            Section {
                ForEach(records, id: \.self) { record in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: "clock").font(.footnote).foregroundStyle(Palette.secondary)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(ScheduleFormat.occurrence(record["scheduledAt"].string ?? "", timeZone: ScheduleFormat.recordZone(task)))
                                .font(.callout).monospacedDigit()
                            if let prompt = record["prompt"].string { SavedPrompt(text: prompt) }
                        }
                    }
                    .padding(.vertical, 2)
                }
                // The tail of the list: reaching it reads the next page.
                if let nextBefore, failure == nil {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 36)
                        // A new row per page, so a short page that leaves it on screen still reads on.
                        .id(nextBefore)
                        .onAppear { if !loading { Task { await load(nextBefore) } } }
                }
            } footer: {
                if !records.isEmpty && pruned && nextBefore == nil && !loading && failure == nil {
                    VStack(alignment: .leading, spacing: 6) {
                        Button { withAnimation { showRetention.toggle() } } label: {
                            Label("更早的运行记录已清理", systemImage: "info.circle")
                        }
                        .accessibilityHint("保留规则")
                        if showRetention {
                            Text("每个任务最多保留近 \(retention["days"].int ?? 30) 天内的 \(retention["records"].int ?? 200) 条运行记录。")
                            Text("产生新记录时，超出范围的旧记录会自动清理。清理记录不影响任务继续运行。")
                        }
                    }
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
                }
            }
            .groupedRow()
        }
        .groupedList()
        .overlay {
            if records.isEmpty {
                if loading {
                    ProgressView()
                } else if let failure {
                    ContentUnavailableView {
                        Label(failure.text, systemImage: "exclamationmark.triangle")
                    } actions: {
                        Button(failure.cursor ? "刷新" : "重试") { Task { await load(failure.before) } }
                    }
                } else {
                    ContentUnavailableView("暂无任务运行记录", systemImage: "clock")
                }
            }
        }
        .refreshable { await load(nil) }
        // A new delivery re-reads the latest page.
        .task(id: task["lastDelivery"]["messageId"].string ?? "") { await load(nil) }
    }

    private func load(_ before: String?) async {
        loading = true
        failure = nil
        var request: [String: JSON] = ["id": task["id"], "limit": 20]
        if let before { request["before"] = .string(before) }
        do {
            let value = try await app.client.call("schedule/history", ["request": .object(request)])
            loading = false
            if let code = value["code"].string {
                failure = code == "schedule_not_found" ? ("任务已不可用", nil, false) : ("记录已更新", nil, true)
                return
            }
            let page = value["records"].array
            if before == nil {
                records = page
            } else {
                let seen = Set(records.compactMap { $0["messageId"].string })
                records += page.filter { !seen.contains($0["messageId"].string ?? "") }
            }
            nextBefore = value["nextBefore"].string
            pruned = value["earlierRecordsPruned"].bool ?? false
            retention = value["retention"]
        } catch is CancellationError {
        } catch let error as URLError where error.code == .cancelled {
        } catch {
            loading = false
            failure = ("无法加载任务运行记录", before, false)
        }
    }
}

/// A delivered prompt clamped to two lines; 展开 / 收起 appears only when the clamp hides text.
private struct SavedPrompt: View {
    let text: String
    @State private var expanded = false
    @State private var fullHeight: CGFloat = 0
    @State private var clampedHeight: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text)
                .font(.footnote)
                .foregroundStyle(Palette.secondary)
                .lineLimit(expanded ? nil : 2)
                .textSelection(.enabled)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { if !expanded { clampedHeight = $0 } }
                .background {
                    Text(text).font(.footnote).fixedSize(horizontal: false, vertical: true).hidden()
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
                }
            if expanded || fullHeight > clampedHeight + 1 {
                Button { withAnimation(.snappy) { expanded.toggle() } } label: {
                    Label(expanded ? "收起" : "展开", systemImage: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.ink)
            }
        }
    }
}

// MARK: Web fallback

/// The engine's own web UI, for plugin interfaces that only exist in the browser.
struct WebFallbackView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            EngineWebView(url: app.client.launchURL)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle("网页版")
                .navigationBarTitleDisplayMode(.inline)
                .closeButton(dismiss)
        }
    }
}

struct EngineWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        view.isInspectable = true
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}
