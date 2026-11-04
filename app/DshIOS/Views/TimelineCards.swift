import SwiftUI

/// Formats shared by the timeline, as the web's `formatRunDuration` and `formatMessageClock`.
enum TimelineFormat {
    /// 45秒, 1分2秒, 1小时0分0秒.
    static func duration(_ seconds: Int) -> String {
        let total = max(0, seconds)
        if total < 60 { return String(localized: "\(total)秒") }
        if total < 3600 { return String(localized: "\(total / 60)分\(total % 60)秒") }
        return String(localized: "\(total / 3600)小时\(total / 60 % 60)分\(total % 60)秒")
    }

    /// `HH:mm` today, with the date otherwise, the year only when it differs.
    static func clock(_ date: Date, now: Date = .now) -> String {
        let calendar = Calendar.current
        let time = date.formatted(Date.FormatStyle().hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
        if calendar.isDate(date, inSameDayAs: now) { return time }
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let (y, m, d) = (parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        let day = calendar.component(.year, from: now) == y ? String(localized: "\(m)月\(d)日") : String(localized: "\(String(y))年\(m)月\(d)日")
        return "\(day) \(time)"
    }

    /// 987, 1.2K, 340K, 2.5M.
    static func compact(_ value: Int) -> String {
        func short(_ number: Double) -> String {
            let rounded = number >= 100 ? number.rounded() : (number * 10).rounded() / 10
            return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
        }
        if value < 1000 { return String(value) }
        if value < 1_000_000 { return short(Double(value) / 1000) + "K" }
        return short(Double(value) / 1_000_000) + "M"
    }

    static func exact(_ value: Int) -> String { value.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US"))) }
}

/// A row that opens to show more: a grey line, its chevron at the end.
private struct FoldRow<Label: View, Detail: View>: View {
    var enabled = true
    @ViewBuilder let label: () -> Label
    @ViewBuilder let detail: () -> Detail
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    label().frame(maxWidth: .infinity, alignment: .leading)
                    if enabled {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Palette.faint)
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!enabled)
            if open { detail().transition(.opacity) }
        }
    }
}

/// An answer given after the agent moved on (C-118), on the user's side of the timeline.
struct QuestionReplyBubble: View {
    let reply: QuestionReply
    @State private var open = false
    @Environment(\.conversationActions) private var actions

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.snappy) { open.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Text("回答先前等待中的问题").font(.footnote).foregroundStyle(Palette.secondary)
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Palette.faint)
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                    .hitTarget()
                }
                .buttonStyle(.plain)
                .accessibilityLabel(open ? "收起问题详情" : "展开问题详情")
                if open {
                    if reply.entries.isEmpty {
                        Text(reply.raw).font(.footnote)
                    } else {
                        ForEach(Array(reply.entries.enumerated()), id: \.offset) { _, entry in detail(entry) }
                    }
                } else {
                    Text(reply.entries.isEmpty ? reply.raw : reply.summary).font(.callout).lineLimit(2)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .background(Palette.bubble, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .contextMenu {
                Button { copyToPasteboard(reply.copyText) } label: { Label("复制", systemImage: "doc.on.doc") }
                Button { actions.present(.text(reply.copyText)) } label: { Label("选择文本", systemImage: "selection.pin.in.out") }
            }
            Text(TimelineFormat.clock(reply.time)).font(.caption2).foregroundStyle(Palette.faint)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 60)
    }

    private func detail(_ entry: QuestionReply.Entry) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            if let header = entry.header, header != entry.question { Text(header).font(.caption).foregroundStyle(Palette.secondary) }
            Text(entry.question).font(.subheadline.weight(.medium))
            if let detail = entry.detail { Text(detail).font(.footnote).foregroundStyle(Palette.secondary) }
            ForEach(entry.options, id: \.self) { option in Text(option).font(.footnote).foregroundStyle(Palette.secondary) }
            Text(String(localized: "回答：") + (entry.values.isEmpty ? String(localized: "已跳过") : entry.values.joined(separator: ", ")))
                .font(.subheadline)
        }
    }
}

/// What woke this turn when no person did (C-52).
struct TriggerNotice: View {
    let trigger: TurnTrigger

    var body: some View {
        FoldRow {
            HStack(spacing: 8) {
                Image(systemName: trigger.symbol).frame(width: 18).foregroundStyle(Palette.secondary)
                Text(trigger.title).font(.subheadline.weight(.medium)).lineLimit(1)
                Text(TimelineFormat.clock(trigger.time)).font(.caption).foregroundStyle(Palette.faint)
            }
        } detail: {
            VStack(alignment: .leading, spacing: 6) {
                Text("这条通知触发了本轮回复。").font(.footnote).foregroundStyle(Palette.secondary)
                ScrollView {
                    Text(trigger.body).font(.footnote).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 240)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.stroke))
    }
}

/// `/name` run in the conversation (C-48): one line, its output below when it has several.
struct CommandCard: View {
    let command: CommandRun

    var body: some View {
        FoldRow(enabled: (command.text ?? "").contains("\n")) {
            HStack(spacing: 8) {
                Image(systemName: "command").frame(width: 18).foregroundStyle(command.failed ? Palette.removed : Palette.secondary)
                Text(command.name).font(.subheadline.weight(.medium))
                Text(command.summary).font(.subheadline).foregroundStyle(command.failed ? Palette.removed : Palette.secondary).lineLimit(1)
                if !command.done { ProgressView().controlSize(.mini) }
            }
        } detail: {
            Text(command.text ?? "")
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Palette.field, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }
}

/// 「上下文已压缩」: the summary the model continues from, a tap away (C-50).
struct CompactionNotice: View {
    let card: CompactionCard

    var body: some View {
        FoldRow(enabled: card.summary != nil) {
            HStack(spacing: 8) {
                Image(systemName: "archivebox").frame(width: 18).foregroundStyle(Palette.secondary)
                Text("上下文已压缩").font(.subheadline.weight(.medium))
                Text(line).font(.subheadline).foregroundStyle(Palette.secondary).lineLimit(1)
            }
        } detail: {
            MarkdownView(text: card.summary ?? "")
                .padding(12)
                .background(Palette.field, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
    }

    private var line: String {
        if let items = card.items, let tokens = card.tokens { return String(localized: "已压缩 \(items) 条历史记录（约 \(tokens) tokens）") }
        if card.summary != nil { return card.outcome ?? String(localized: "轻点查看压缩摘要") }
        return card.outcome ?? String(localized: "压缩摘要不可用")
    }
}

/// A retried model request (C-44): attempt count and, while waiting, the seconds left.
struct RetryNotice: View {
    let retry: RetryState

    var body: some View {
        FoldRow {
            // Ticks only while the wait runs; a retry long past has no reason to.
            if active(.now) {
                TimelineView(.periodic(from: .now, by: 0.25)) { context in line(context.date) }
            } else {
                line(.now)
            }
        } detail: {
            VStack(alignment: .leading, spacing: 3) {
                Text(String(localized: "重试延迟：") + String(localized: "\(retry.delayMs)毫秒"))
                if !retry.failure.isEmpty { Text(String(localized: "失败原因：") + retry.failure).textSelection(.enabled) }
            }
            .font(.footnote)
            .foregroundStyle(Palette.secondary)
        }
    }

    private var deadline: Date { retry.scheduledAt.addingTimeInterval(Double(retry.delayMs) / 1000) }

    private func active(_ now: Date) -> Bool { retry.phase == .scheduled && deadline > now }

    private func line(_ now: Date) -> some View {
        let isActive = active(now)
        let label: String = switch retry.phase {
        case .cancelled: String(localized: "模型请求重试已取消")
        case .started: String(localized: "已重试模型请求")
        case .scheduled: isActive ? String(localized: "正在重试模型请求") : String(localized: "等待重试模型请求")
        }
        let milliseconds = isActive ? deadline.timeIntervalSince(now) * 1000 : Double(retry.delayMs)
        let seconds = max(1, Int((milliseconds / 1000).rounded(.up)))
        let maximum = retry.maximum.map(String.init) ?? "∞"
        return HStack(spacing: 8) {
            if isActive { ProgressView().controlSize(.mini) }
            Text("\(label)（\(retry.retry)/\(maximum)） · \(seconds)s").monospacedDigit().lineLimit(1)
        }
        .font(.footnote)
        .foregroundStyle(Palette.secondary)
    }
}
