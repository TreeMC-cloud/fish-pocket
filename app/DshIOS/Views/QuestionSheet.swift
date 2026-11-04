import SwiftUI

/// A sheet as tall as its content, with the actions pinned at the bottom under the thumb: what
/// does not fit scrolls above them. Its handle shows it can be pulled down, and the conversation
/// behind stays usable, to read what led to the question.
struct PinnedActionsSheet<Content: View, Actions: View>: View {
    @ViewBuilder let content: () -> Content
    @ViewBuilder let actions: () -> Actions
    @State private var contentHeight: CGFloat = 240
    @State private var actionsHeight: CGFloat = 80

    var body: some View {
        ScrollView {
            content().onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            actions()
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { actionsHeight = $0 }
                .background(Palette.background)
        }
        // Sized to the sheet's real edge; the actions carry their own margin above the home indicator.
        .ignoresSafeArea(.container, edges: .bottom)
        .presentationDetents([.height(contentHeight + actionsHeight)])
        .presentationCornerRadius(36)
        .presentationDragIndicator(.visible)
        .presentationBackground(Palette.background)
        .presentationBackgroundInteraction(.enabled)
    }
}

/// An open question (ask_user_question) as a bottom sheet (C-115): one question a page, where
/// it stands at the top, with the countdown of a timed wait (C-116). Picking a single choice
/// moves on; the free answer is the last choice, its field only there once picked.
struct QuestionSheet: View {
    let model: SessionModel
    let question: PendingQuestion
    @State private var failure: String?
    @State private var submitting = false
    /// Questions whose 「其他…」 was opened; one with a typed answer stays open by itself.
    @State private var openOthers: Set<String> = []
    @FocusState private var customFocused: Bool

    var body: some View {
        let current = page
        PinnedActionsSheet {
            VStack(alignment: .leading, spacing: 16) {
                header(current)
                if let detail = current.detail { MarkdownView(text: detail).modifier(LinkOpening()) }
                answers(current)
                if let failure { Text(failure).font(.footnote).foregroundStyle(Palette.removed) }
            }
            .padding(EdgeInsets(top: 20, leading: 22, bottom: 8, trailing: 22))
        } actions: {
            footer(current).padding(EdgeInsets(top: 8, leading: 22, bottom: 10, trailing: 22))
        }
        .onAppear(perform: preselectRecommended)
        .onChange(of: customFocused) { _, focused in model.setAnswerFocus(question, focused: focused) }
        .onChange(of: question.eventId) { _, _ in failure = nil }
    }

    // MARK: Pages

    private var draft: QuestionDraft { model.questionDrafts[question.id] ?? QuestionDraft() }

    private func update(_ change: (inout QuestionDraft) -> Void) {
        var next = draft
        change(&next)
        model.questionDrafts[question.id] = next
    }

    private var index: Int { min(draft.index, question.questions.count - 1) }
    private var page: PendingQuestion.Question { question.questions[index] }
    private var isLast: Bool { index == question.questions.count - 1 }

    private func isDone(_ q: PendingQuestion.Question) -> Bool {
        guard let answer = draft.answers[q.id] else { return false }
        return answer.skipped || !answer.selected.isEmpty || !answer.custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The first option marked recommended is a draft, not an answer: it still needs submitting.
    private func preselectRecommended() {
        update { draft in
            for q in question.questions where draft.answers[q.id] == nil {
                if let first = q.options.first, QuestionOption.isRecommended(first.label) {
                    draft.answers[q.id] = .init(selected: [first.label])
                }
            }
        }
    }

    private func move(to page: Int) {
        customFocused = false
        failure = nil
        withAnimation(.snappy(duration: 0.2)) { update { $0.index = page } }
    }

    // MARK: Parts

    private func header(_ q: PendingQuestion.Question) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            let count = question.questions.count
            if count > 1 || q.header != nil {
                HStack(spacing: 8) {
                    if index > 0 {
                        Button { move(to: index - 1) } label: {
                            Image(systemName: "chevron.left").font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink).hitTarget()
                        }
                        .buttonStyle(.plain)
                        .padding(.leading, -14)
                        .accessibilityLabel("上一题")
                    }
                    if count > 1 {
                        Text(verbatim: "\(index + 1)/\(count)").font(.subheadline.monospacedDigit()).foregroundStyle(Palette.secondary)
                    }
                    if let header = q.header { Text(header).font(.footnote).foregroundStyle(Palette.secondary) }
                }
                .frame(minHeight: 24)
            }
            WaitStatus(model: model, question: question)
            Text(q.question).font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
        }
    }

    /// The choices, then 「其他…」; a question with no choices is just the field.
    @ViewBuilder
    private func answers(_ q: PendingQuestion.Question) -> some View {
        if q.options.isEmpty {
            customField(q).background(Palette.field, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        } else {
            VStack(spacing: 0) {
                ForEach(Array(q.options.enumerated()), id: \.offset) { _, option in optionRow(q, option: option) }
                let other = otherOpen(q)
                Button { toggleOther(q, open: other) } label: {
                    HStack(spacing: 12) {
                        marker(q, isOn: other)
                        Text("其他…").font(.callout).foregroundStyle(Palette.ink)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 13)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(other ? .isSelected : [])
                if other { customField(q).padding(.top, -8) }
            }
            .background(Palette.grouped, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
    }

    private func customField(_ q: PendingQuestion.Question) -> some View {
        TextField("输入你的答案", text: customBinding(q), axis: .vertical)
            .font(.callout)
            .lineLimit(1...6)
            .focused($customFocused)
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
    }

    private func otherOpen(_ q: PendingQuestion.Question) -> Bool {
        openOthers.contains(q.id) || draft.answers[q.id]?.custom.isEmpty == false
    }

    /// Closing takes the typed answer with it; opening on a single choice lets go of the pick.
    private func toggleOther(_ q: PendingQuestion.Question, open: Bool) {
        Haptics.select()
        model.stopCountdown(question, held: false)
        update { draft in
            var answer = draft.answers[q.id] ?? .init()
            if open { answer.custom = "" } else if !q.multiSelect { answer.selected = [] }
            answer.skipped = false
            draft.answers[q.id] = answer
        }
        withAnimation(.snappy(duration: 0.2)) {
            if open { openOthers.remove(q.id) } else { openOthers.insert(q.id) }
        }
        if open {
            customFocused = false
        } else {
            // The field has to exist before it can take focus.
            Task {
                try? await Task.sleep(for: .milliseconds(50))
                customFocused = true
            }
        }
    }

    /// A radio circle for one choice, a check for several.
    private func marker(_ q: PendingQuestion.Question, isOn: Bool) -> some View {
        Image(systemName: isOn ? (q.multiSelect ? "checkmark.circle.fill" : "largecircle.fill.circle") : "circle")
            .font(.title3)
            .foregroundStyle(isOn ? Palette.ink : Palette.faint)
    }

    private func optionRow(_ q: PendingQuestion.Question, option: (label: String, description: String?)) -> some View {
        let isOn = draft.answers[q.id]?.selected.contains(option.label) ?? false
        return Button { pick(q, label: option.label, isOn: isOn) } label: {
            HStack(alignment: .top, spacing: 12) {
                marker(q, isOn: isOn)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(QuestionOption.displayLabel(option.label)).font(.callout).foregroundStyle(Palette.ink)
                        if QuestionOption.isRecommended(option.label) {
                            Text("推荐")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Palette.secondary)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1)
                                .background(Palette.control, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                        }
                    }
                    if let description = option.description { Text(description).font(.footnote).foregroundStyle(Palette.secondary) }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isOn ? .isSelected : [])
    }

    private func pick(_ q: PendingQuestion.Question, label: String, isOn: Bool) {
        Haptics.select()
        model.stopCountdown(question, held: false)
        update { draft in
            var answer = draft.answers[q.id] ?? .init()
            answer.skipped = false
            if q.multiSelect {
                if isOn { answer.selected.remove(label) } else { answer.selected.insert(label) }
            } else {
                answer.selected = [label]
                answer.custom = ""
            }
            draft.answers[q.id] = answer
        }
        if !q.multiSelect { openOthers.remove(q.id) }
        if !q.multiSelect, !isLast { move(to: index + 1) }
    }

    private func customBinding(_ q: PendingQuestion.Question) -> Binding<String> {
        Binding(
            get: { draft.answers[q.id]?.custom ?? "" },
            set: { text in
                model.stopCountdown(question, held: false)
                update { draft in
                    var answer = draft.answers[q.id] ?? .init()
                    answer.custom = text
                    answer.skipped = false
                    if !q.multiSelect, !text.isEmpty { answer.selected = [] }
                    draft.answers[q.id] = answer
                }
            }
        )
    }

    /// One big answer button; skipping is there, but quieter.
    private func footer(_ q: PendingQuestion.Question) -> some View {
        VStack(spacing: 0) {
            let done = isDone(q)
            Button {
                if isLast { submit() } else { move(to: index + 1) }
            } label: {
                Text(isLast ? (submitting ? "正在提交…" : "提交") : "下一题")
            }
            .buttonStyle(.capsule(.primary))
            .disabled(!done || submitting)
            .opacity(done ? 1 : 0.4)
            Button { skip(q) } label: {
                Text("跳过").font(.subheadline).foregroundStyle(Palette.secondary).frame(maxWidth: .infinity).hitTarget()
            }
            .buttonStyle(.plain)
            .disabled(submitting)
        }
    }

    private func skip(_ q: PendingQuestion.Question) {
        Haptics.tap()
        model.stopCountdown(question, held: false)
        update { $0.answers[q.id] = .init(skipped: true) }
        if isLast { submit() } else { move(to: index + 1) }
    }

    private func submit() {
        if let missing = question.questions.firstIndex(where: { !isDone($0) }) {
            move(to: missing)
            failure = String(localized: "请先完成这道问题。")
            return
        }
        submitting = true
        Task {
            // On success the sheet closes once the projection catches up; stay disabled until then.
            if let result = await model.answer(question, draft: draft) {
                submitting = false
                failure = result
                Haptics.error()
            } else {
                Haptics.success()
            }
        }
    }
}

/// What the wait is doing. While it counts down the whole bar is one button that stops it.
private struct WaitStatus: View {
    let model: SessionModel
    let question: PendingQuestion

    var body: some View {
        let wait = question.callId.flatMap { model.questionWaits[$0] }
        if question.eventId == nil {
            note("已继续工作，仍可回答")
        } else {
            switch wait {
            case .counting(let deadline):
                bar(action: "暂停") {
                    // Per second, as the web's tick: `Text(timerInterval:)` has no room for the words around it.
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text("\(seconds(deadline.timeIntervalSince(context.date))) 秒后继续工作").monospacedDigit()
                    }
                }
            case .focused(let remaining):
                bar(action: "一直等") { Text("已暂停 · 剩余 \(seconds(remaining)) 秒").monospacedDigit() }
            case .editing, .held:
                note("会一直等你回答")
            case nil:
                EmptyView()
            }
        }
    }

    private func seconds(_ interval: TimeInterval) -> Int { max(0, Int(interval.rounded(.up))) }

    private func note(_ text: LocalizedStringKey) -> some View {
        Text(text).font(.caption).foregroundStyle(Palette.secondary)
    }

    private func bar<Label: View>(action: LocalizedStringKey, @ViewBuilder label: () -> Label) -> some View {
        Button {
            Haptics.tap()
            model.stopCountdown(question, held: true)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "timer")
                label()
                Spacer(minLength: 8)
                Text(action).fontWeight(.semibold).foregroundStyle(Palette.ink)
            }
            .font(.footnote)
            .foregroundStyle(Palette.secondary)
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(Palette.field, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityHint("不再倒计时，一直等你回答")
    }
}

/// `(推荐)` / `(Recommended)` at the end of an option's label: shown as a badge, sent as written.
enum QuestionOption {
    private static let suffix = #/\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/#.ignoresCase()

    static func isRecommended(_ label: String) -> Bool { label.firstMatch(of: suffix) != nil }
    static func displayLabel(_ label: String) -> String { label.replacing(suffix, with: "") }
}

/// Plan review (C-119): the plan's title and first paragraph, the full text one tap away,
/// then 同意执行 or 要求修改 (which ends the turn; the user answers in the composer).
struct PlanReviewSheet: View {
    let model: SessionModel
    let question: PendingQuestion
    let review: PlanReview
    @State private var showPlan = false
    @State private var submitting = false
    @State private var failure: String?

    var body: some View {
        PinnedActionsSheet {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    StatusDot(state: .waiting)
                    Text("计划待审").font(.footnote).foregroundStyle(Palette.secondary)
                    Spacer(minLength: 8)
                    Button { showPlan = true } label: {
                        Text("查看全文").font(.footnote.weight(.semibold)).foregroundStyle(Palette.ink).hitTarget()
                    }
                    .buttonStyle(.plain)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(PlanText.title(review.plan)).font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
                    let description = PlanText.firstParagraph(review.plan)
                    if !description.isEmpty, description != PlanText.title(review.plan) {
                        Text(description).font(.subheadline).foregroundStyle(Palette.secondary).lineLimit(2)
                    }
                }
                if let failure { Text(failure).font(.footnote).foregroundStyle(Palette.removed) }
            }
            .padding(EdgeInsets(top: 20, leading: 22, bottom: 8, trailing: 22))
        } actions: {
            HStack(spacing: 10) {
                Button("要求修改") {
                    Haptics.tap()
                    Task { await model.declineQuestion(question) }
                }
                .buttonStyle(.capsule(.secondary))
                Button("同意执行") {
                    Haptics.success()
                    submitting = true
                    Task {
                        failure = await model.approvePlan(question, review: review)
                        submitting = false
                    }
                }
                .buttonStyle(.capsule())
                .accessibilityHint(Text(review.approveDescription ?? ""))
            }
            .disabled(submitting)
            .padding(EdgeInsets(top: 10, leading: 22, bottom: 22, trailing: 22))
        }
        .sheet(isPresented: $showPlan) { PlanSheet(markdown: review.plan) }
    }
}

@MainActor
enum PlanText {
    /// The first line, without heading marks and emphasis.
    static func title(_ plan: String) -> String {
        let line = plan.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? ""
        return plain(line)
    }

    /// The first block of prose after the title.
    static func firstParagraph(_ plan: String) -> String {
        for block in MarkdownCache.blocks(plan) {
            if case .paragraph(let text) = block { return plain(text) }
        }
        return ""
    }

    private static func plain(_ text: String) -> String {
        let stripped = text.replacing(#/^\s*#{1,6}\s+/#, with: "").trimmingCharacters(in: .whitespaces)
        return String(MarkdownCache.inline(stripped).characters)
    }
}

/// A plan in full.
struct PlanSheet: View {
    let markdown: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView { MarkdownView(text: markdown).padding().modifier(LinkOpening()) }
                .background(Palette.background)
                .navigationTitle("计划")
                .navigationBarTitleDisplayMode(.inline)
                .closeButton(dismiss)
        }
    }
}
