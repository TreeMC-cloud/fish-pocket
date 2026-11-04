import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct DshWidgets: WidgetBundle {
    var body: some Widget { DshLiveActivity() }
}

/// Agent status on the lock screen and in the Dynamic Island: a status dot and
/// the elapsed time when compact; the session, the step it waits on and the
/// approval buttons when expanded.
struct DshLiveActivity: Widget {
    typealias State = DshActivityAttributes.ContentState

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DshActivityAttributes.self) { context in
            LockScreenView(state: context.state)
                .widgetURL(context.state.url)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Dot(phase: state.phase)
                        Mark()
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Elapsed(state: state)
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            Text(state.title).font(.headline).lineLimit(1)
                            Spacer(minLength: 0)
                            Text(Label.phase(state)).font(.caption.weight(.semibold)).foregroundStyle(Tint.of(state.phase))
                        }
                        if let detail = state.detail {
                            Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        }
                        if let approval = state.approval { ApprovalButtons(approval: approval).padding(.top, 4) }
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                HStack(spacing: 5) {
                    Dot(phase: state.phase)
                    Mark()
                }
                .padding(.leading, 2)
            } compactTrailing: {
                if state.phase == .approval || state.phase == .question {
                    Text(state.phase == .approval ? "待允许" : "待回答")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Tint.of(state.phase))
                } else {
                    Elapsed(state: state)
                        .font(.caption2.monospacedDigit())
                        .frame(maxWidth: 44)
                }
            } minimal: {
                Dot(phase: state.phase)
            }
            .widgetURL(state.url)
            .keylineTint(Tint.of(state.phase))
        }
    }
}

private struct LockScreenView: View {
    let state: DshActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Dot(phase: state.phase)
                Text(Label.phase(state)).font(.caption.weight(.semibold)).foregroundStyle(Tint.of(state.phase))
                Spacer(minLength: 0)
                Elapsed(state: state).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Text(state.title).font(.headline).lineLimit(1)
            if let detail = state.detail {
                Text(detail).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            if let approval = state.approval { ApprovalButtons(approval: approval).padding(.top, 4) }
        }
        .padding(16)
    }
}

private struct ApprovalButtons: View {
    let approval: DshActivityAttributes.ContentState.Approval

    var body: some View {
        HStack(spacing: 8) {
            Button(intent: AnswerApprovalIntent(eventId: approval.eventId, agentId: approval.agentId, allow: false)) {
                Text("拒绝").frame(maxWidth: .infinity)
            }
            .tint(.gray)
            Button(intent: AnswerApprovalIntent(eventId: approval.eventId, agentId: approval.agentId, allow: true)) {
                Text("允许").fontWeight(.semibold).frame(maxWidth: .infinity)
            }
            .tint(Tint.waiting)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .font(.subheadline)
    }
}

/// Counts up while working; the total once done.
private struct Elapsed: View {
    let state: DshActivityAttributes.ContentState

    var body: some View {
        if let end = state.endedAt {
            Text(Duration.seconds(max(0, end.timeIntervalSince(state.startedAt))).formatted(.time(pattern: .minuteSecond)))
        } else {
            Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
                .multilineTextAlignment(.trailing)
        }
    }
}

/// The brand mark: the Dynamic Island has no room for the full name.
private struct Mark: View {
    var body: some View {
        Image(systemName: "fish.fill").font(.system(size: 14, weight: .bold)).accessibilityLabel("Fish Pocket")
    }
}

private struct Dot: View {
    let phase: DshActivityAttributes.ContentState.Phase

    var body: some View {
        Circle().fill(Tint.of(phase)).frame(width: 8, height: 8)
    }
}

/// The app's status colours (StatusRunning / StatusWaiting, dark values: readable on the island and the lock screen).
private enum Tint {
    static let running = Color(red: 0x3D / 255, green: 0xD6 / 255, blue: 0x8C / 255)
    static let waiting = Color(red: 0xF5 / 255, green: 0xA5 / 255, blue: 0x24 / 255)

    static func of(_ phase: DshActivityAttributes.ContentState.Phase) -> Color {
        switch phase {
        case .running: running
        case .approval, .question: waiting
        case .done: .secondary
        }
    }
}

private enum Label {
    static func phase(_ state: DshActivityAttributes.ContentState) -> String {
        let base: String = switch state.phase {
        case .running: String(localized: "进行中")
        case .approval: String(localized: "等你允许")
        case .question: String(localized: "等你回答")
        case .done: String(localized: "已完成")
        }
        return state.others > 0 ? base + String(localized: " · 另有 \(state.others) 个") : base
    }
}
