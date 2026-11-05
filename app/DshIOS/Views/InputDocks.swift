import SwiftUI

/// One line above the composer for what the session has going: 「任务 2/5 · 编译中 ·
/// 排队 2」, this client's messages on their way, a full context and a deferred
/// approval. Everything behind it opens in a sheet. With the keyboard up the timeline
/// has little room left: only the queue and a waiting approval keep their place.
struct ComposerStatusBar: View {
    let model: SessionModel
    var keyboardUp = false
    /// 「等你允许」 / 「等你回答」: an interaction swiped away, still unanswered.
    var waiting: String?
    var reveal: () -> Void = {}
    /// An interaction wants the screen: the sheet gives way to it.
    var interactionArrived = false
    /// On from opening the sheet until it is gone; the conversation's own sheets wait for it.
    @Binding var sheetUp: Bool
    @Environment(AppModel.self) private var app
    @State private var showSheet = false
    /// The keyboard was up when the sheet opened: it comes back after.
    @State private var refocus = false

    private var composer: ComposerModel { model.composer }

    var body: some View {
        let summary = summary
        let tail = tail
        let hasStatus = !summary.characters.isEmpty || !tail.isEmpty
        VStack(spacing: 0) {
            if waiting != nil || hasStatus {
                bar(summary: summary, tail: tail, hasStatus: hasStatus)
                    .padding(.bottom, 8)
                    .transition(.opacity)
            }
        }
        .animation(.snappy, value: hasStatus)
        .animation(.snappy, value: waiting)
        // Whether the goal continues on its own: re-read on goal changes, run edges and `goal/activation-changed`.
        .task(id: "\(composer.goal?.id ?? "")-\(composer.goal?.revision ?? 0)-\(model.running)-\(app.revision("goal/activation-changed"))") {
            await composer.refreshGoalActivation()
        }
        .sheet(isPresented: $showSheet, onDismiss: {
            sheetUp = false
            if refocus || composer.editingQueue != nil { composer.requestFocus() }
        }) {
            ComposerStatusSheet(model: model, waiting: waiting, reveal: reveal)
        }
        .onChange(of: interactionArrived) { _, arrived in
            if arrived { showSheet = false }
        }
    }

    private func bar(summary: AttributedString, tail: String, hasStatus: Bool) -> some View {
        HStack(spacing: 0) {
            if let waiting {
                Button(action: reveal) {
                    HStack(spacing: 6) {
                        StatusDot(state: .waiting)
                        Text(waiting).font(.footnote.weight(.semibold)).foregroundStyle(Palette.ink)
                        if !hasStatus {
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.up").font(.caption2.weight(.bold)).foregroundStyle(Palette.secondary)
                        }
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 40)
                    .background(Palette.waiting.opacity(0.18))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .layoutPriority(1)
            }
            if hasStatus {
                Button(action: open) {
                    HStack(spacing: 0) {
                        if !summary.characters.isEmpty {
                            Text(summary).lineLimit(1)
                        }
                        if !tail.isEmpty {
                            Text(summary.characters.isEmpty ? tail : " · " + tail).lineLimit(1).layoutPriority(1)
                        }
                        Spacer(minLength: 8)
                    }
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
                    .padding(.leading, 14)
                    .frame(minHeight: 40)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("查看任务、目标和排队")
                if showsCompact {
                    Button("压缩") { Haptics.tap(); composer.compact() }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(canCompact ? Palette.ink : Palette.faint)
                        .disabled(!canCompact)
                        .hitTarget()
                }
                Button(action: open) {
                    Image(systemName: "chevron.up").font(.caption2.weight(.bold)).foregroundStyle(Palette.secondary)
                        .frame(minWidth: 36, minHeight: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.grouped)
        .clipShape(Capsule())
    }

    private func open() {
        refocus = keyboardUp
        sheetUp = true
        showSheet = true
    }

    /// The manual compaction needs an idle agent (the engine refuses it otherwise).
    private var canCompact: Bool { !model.running && !composer.compacting }

    private var showsCompact: Bool { !keyboardUp && composer.contextNearlyFull }

    /// What may give way when the line runs short: plan mode, the tasks, the goal, sends in flight.
    private var summary: AttributedString {
        var parts: [AttributedString] = []
        func add(_ text: String, color: Color? = nil) {
            var part = AttributedString(text)
            if let color { part.foregroundColor = color }
            parts.append(part)
        }
        if !keyboardUp {
            if composer.planActive { add(String(localized: "计划模式")) }
            // A finished list has nothing left to report once the run is over; the sheet still has it.
            let todos = composer.todos
            let progress = TodoProgress(todos)
            let tasksLive = !todos.isEmpty && (model.running || progress.done < progress.total)
            if tasksLive {
                add(progress.text)
                if let current = todos.first(where: { $0.status == "in_progress" }) { add(current.content) }
            }
            if let goal = composer.visibleGoal {
                if goal.phase == "blocked" {
                    add(String(localized: "目标受阻"), color: Palette.removed)
                } else if composer.goalPaused(goal) {
                    add(String(localized: "目标已暂停"))
                } else if !tasksLive {
                    add(String(localized: "目标"))
                    add(goal.objective)
                }
            }
        }
        if let echo = composer.visiblePending.first(where: { $0.placement != .queued }) {
            add(echo.placement == .steering ? String(localized: "插话发送中…") : String(localized: "发送中…"))
        }
        var joined = AttributedString()
        for (index, part) in parts.enumerated() {
            if index > 0 { joined += AttributedString(" · ") }
            joined += part
        }
        return joined
    }

    /// What stays whole however long the rest is.
    private var tail: String {
        let queued = composer.queueRows.count + composer.visiblePending.filter { $0.placement == .queued }.count
        return [
            queued > 0 ? String(localized: "排队 \(queued)") : nil,
            !keyboardUp && composer.contextNearlyFull ? String(localized: "上下文快满了") : nil,
        ].compactMap { $0 }.joined(separator: " · ")
    }
}

extension View {
    /// Follows the software keyboard (a hardware keyboard's short accessory bar doesn't count).
    func trackKeyboard(_ up: Binding<Bool>) -> some View {
        onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { note in
            up.wrappedValue = ((note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect)?.height ?? 0) > 120
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            up.wrappedValue = false
        }
    }
}

/// 「2/5」: finished over all.
private struct TodoProgress {
    let done: Int
    let total: Int

    init(_ todos: [TodoItem]) {
        done = todos.filter { $0.status == "completed" }.count
        total = todos.count
    }

    var text: String { String(localized: "任务 \(done)/\(total)") }
}

/// What the status bar stands for, one section each: the agent's tasks (C-120), the
/// goal (C-121) and the queue (C-95), under whatever needs a decision now. Every
/// section comes and goes on its own, so the sheet closes itself once the last one
/// leaves rather than standing there empty.
struct ComposerStatusSheet: View {
    let model: SessionModel
    var waiting: String?
    var reveal: () -> Void = {}
    @Environment(\.dismiss) private var dismiss

    private var composer: ComposerModel { model.composer }

    var body: some View {
        NavigationStack {
            List {
                attention
                let todos = composer.todos
                if !todos.isEmpty {
                    Section(TodoProgress(todos).text) {
                        ForEach(Array(todos.enumerated()), id: \.offset) { _, todo in TodoRow(item: todo) }
                    }
                    .groupedRow()
                }
                GoalSection(composer: composer)
                QueueSection(model: model) { row in
                    composer.beginQueueEdit(row)
                    dismiss()
                }
            }
            .groupedList()
            .navigationTitle("状态")
            .navigationBarTitleDisplayMode(.inline)
            .closeButton(dismiss)
            // 「插话」 on the last queued row (or 「全部插话」, a delete, the agent picking
            // the queue up) leaves nothing to show: close, so the conversation behind
            // shows where the message went instead of a blank panel.
            .onChange(of: hasContent) { _, has in
                if !has { dismiss() }
            }
        }
        .presentationDetents([.medium, .large])
        .sheetNotices()
    }

    /// Whether any section still has something in it. The status bar hides on the same
    /// terms, so an empty sheet has no bar left to have opened it either.
    private var hasContent: Bool {
        waiting != nil
            || composer.contextNearlyFull
            || composer.planActive
            || !composer.todos.isEmpty
            || composer.visibleGoal != nil
            || !composer.queueRows.isEmpty
            || !composer.visiblePending.isEmpty
    }

    @ViewBuilder
    private var attention: some View {
        let occupancy = composer.contextNearlyFull ? composer.contextOccupancy : nil
        if waiting != nil || occupancy != nil || composer.planActive {
            Section {
                if let waiting {
                    Button(action: reveal) {
                        HStack(spacing: 8) {
                            StatusDot(state: .waiting)
                            Text(waiting).foregroundStyle(Palette.ink)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Palette.secondary)
                        }
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if let occupancy {
                    HStack {
                        Text("上下文已用 \(occupancy.percent)%")
                        Spacer(minLength: 8)
                        Button("压缩") { Haptics.tap(); composer.compact() }
                            .buttonStyle(.borderless)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(model.running || composer.compacting ? Palette.faint : Palette.ink)
                            .disabled(model.running || composer.compacting)
                            .hitTarget()
                    }
                }
                if composer.planActive {
                    Toggle("计划模式", isOn: Binding(get: { composer.planActive }, set: { on in Haptics.select(); composer.setPlan(on) }))
                        .toggleStyle(.mono)
                        .disabled(composer.planSwitching)
                }
            }
            .groupedRow()
        }
    }
}

// MARK: Goal (C-121)

/// The goal: phase, objective and its actions. Hidden when there is none, it is
/// complete, or it was just cleared (until the projection catches up).
private struct GoalSection: View {
    let composer: ComposerModel
    @State private var busy = false
    @State private var actionError: String?
    @State private var editing = false
    @State private var draft = ""
    @State private var confirmingClear = false

    var body: some View {
        if let goal = composer.visibleGoal {
            let armed = composer.armed(goal)
            Section("目标") {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(composer.goalPhaseName(goal)).font(.caption.weight(.medium)).foregroundStyle(goal.phase == "blocked" ? Palette.removed : Palette.secondary)
                            Text(goal.objective).font(.subheadline).foregroundStyle(Palette.ink).lineLimit(4)
                            if goal.phase == "blocked", let reason = goal.blockedReason {
                                Text(reason).font(.caption).foregroundStyle(Palette.removed).lineLimit(3)
                            }
                        }
                        Spacer(minLength: 0)
                        if busy { ProgressView().controlSize(.small).hitTarget() }
                        else { actions(goal, armed: armed) }
                    }
                    if let actionError {
                        Text(actionError).font(.caption).foregroundStyle(Palette.removed)
                    }
                }
            }
            .groupedRow()
            .task(id: "\(goal.id)-\(goal.revision)-\(goal.phase)") { actionError = nil }
            .sheet(isPresented: $editing) { editSheet }
            .confirmationDialog("清除目标？", isPresented: $confirmingClear, titleVisibility: .visible) {
                Button("清除目标", role: .destructive) { run(.clear) }
            }
        }
    }

    private func actions(_ goal: GoalInfo, armed: Bool?) -> some View {
        Menu {
            if goal.phase == "active" && armed == true {
                Button { run(.pause) } label: { Label("暂停目标", systemImage: "pause") }
            }
            if goal.phase == "paused" || (goal.phase == "active" && armed == false) {
                Button { run(.resume) } label: { Label("恢复目标", systemImage: "play") }
            }
            Button { draft = goal.objective; editing = true } label: { Label("编辑目标", systemImage: "pencil") }
            Button(role: .destructive) { confirmingClear = true } label: { Label("清除目标", systemImage: "trash") }
        } label: {
            Image(systemName: "ellipsis").font(.footnote.weight(.semibold)).foregroundStyle(Palette.secondary)
                .hitTarget()
        }
        .accessibilityLabel("目标操作")
    }

    /// Goal actions run one at a time.
    private func run(_ action: ComposerModel.GoalAction) {
        guard !busy else { return }
        busy = true
        actionError = nil
        Task {
            let error = await composer.goalAction(action)
            busy = false
            actionError = error
            if error == nil {
                Haptics.select()
                if case .edit = action { editing = false }
            }
        }
    }

    private var editSheet: some View {
        NavigationStack {
            TextEditor(text: $draft)
                .font(.body)
                .padding(.horizontal, 12)
                .scrollContentBackground(.hidden)
                .background(Palette.background)
                .overlay(alignment: .bottom) {
                    if let actionError { Text(actionError).font(.footnote).foregroundStyle(Palette.removed).padding() }
                }
                .navigationTitle("编辑目标")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { editing = false } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("保存") {
                            let objective = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                            run(.edit(objective))
                        }
                        .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: Queue (C-95)

/// Messages waiting for the next turn, then this client's on their way. A tap puts a
/// row back in the input to edit (text only), a swipe left removes it, a swipe right
/// or 「插话」 steers it (while running); a long press has them all. One operation at a time.
private struct QueueSection: View {
    let model: SessionModel
    let edit: (QueueRow) -> Void
    @State private var busy: String?

    private var composer: ComposerModel { model.composer }

    var body: some View {
        let rows = composer.queueRows
        let sending = composer.visiblePending
        if !rows.isEmpty || !sending.isEmpty {
            Section {
                ForEach(rows) { row in queueRow(row) }
                ForEach(sending) { echo in
                    HStack(spacing: 8) {
                        Text(echo.text.isEmpty ? echo.attachments.joined(separator: "、") : echo.text).lineLimit(2)
                        Spacer(minLength: 8)
                        Text(echo.placement == .steering ? "插话发送中…" : "发送中…").font(.caption)
                    }
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .frame(minHeight: 44)
                }
            } header: {
                header(rows: rows, sending: sending)
            }
            .groupedRow()
        }
    }

    private func header(rows: [QueueRow], sending: [PendingSubmission]) -> some View {
        let queued = rows.count + sending.filter { $0.placement == .queued }.count
        return HStack {
            Text(queued > 0 ? "排队 \(queued)" : "发送中")
            Spacer(minLength: 8)
            if model.running && !rows.isEmpty {
                Button("全部插话") {
                    Haptics.tap()
                    busy = "*"
                    Task { await composer.steerAll(); busy = nil }
                }
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Palette.ink)
                .disabled(busy != nil)
                .hitTarget()
            }
        }
    }

    private func queueRow(_ row: QueueRow) -> some View {
        HStack(spacing: 8) {
            Button { edit(row) } label: {
                HStack(spacing: 8) {
                    if !row.attachments.isEmpty {
                        Label("\(row.attachments.count)", systemImage: "paperclip").font(.caption).labelStyle(.titleAndIcon).foregroundStyle(Palette.secondary)
                    }
                    Text(row.preview.isEmpty ? row.attachments.joined(separator: "、") : row.preview).lineLimit(2).foregroundStyle(Palette.ink)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(row.editableText == nil || busy != nil)
            if busy == row.id {
                ProgressView().controlSize(.mini).hitTarget()
            } else if model.running {
                Button("插话") { act(row.id, .steer) }
                    .buttonStyle(.borderless)
                    .foregroundStyle(Palette.ink)
                    .disabled(busy != nil)
                    .hitTarget()
            }
        }
        .font(.subheadline)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { act(row.id, .remove) } label: { Label("删除", systemImage: "trash") }
        }
        .swipeActions(edge: .leading) {
            if model.running {
                Button { act(row.id, .steer) } label: { Label("插话", systemImage: "bolt") }
                    .tint(Palette.ink)
            }
        }
        .contextMenu {
            if model.running {
                Button { act(row.id, .steer) } label: { Label("插话", systemImage: "bolt") }
            }
            Button { edit(row) } label: {
                Label(row.editableText == nil ? "包含非文本内容，暂不支持编辑" : "编辑", systemImage: "pencil")
            }
            .disabled(row.editableText == nil)
            Button(role: .destructive) { act(row.id, .remove) } label: { Label("删除", systemImage: "trash") }
        }
    }

    private func act(_ id: String, _ action: ComposerModel.QueueAction) {
        guard busy == nil else { return }
        Haptics.tap()
        busy = id
        Task {
            await composer.updateQueue(id, action)
            if busy == id { busy = nil }
        }
    }
}
