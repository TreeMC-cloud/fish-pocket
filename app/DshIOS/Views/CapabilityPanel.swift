import SwiftUI

/// 引擎治理层的运行状态快照，对应 `capability.json`。
///
/// 为什么要有这个：任务表、Dream 整理、技能记账、中断记录、注入告警全在引擎里跑，
/// 用户一个都看不见。跑得好不好、有没有在跑、最近学到什么，都是黑箱。
/// 这份快照只做投影——引擎写，界面读，两边都不改业务数据。
struct CapabilityStatus: Decodable, Equatable {
    struct TaskStats: Decodable, Equatable {
        var ok: Bool = false
        var reason: String?
        var total: Int = 0
        var byStatus: [String: Int] = [:]
    }

    struct Dream: Decodable, Equatable {
        var ok: Bool = false
        var reason: String?
        var runs: Int = 0
        var lastRunAt: Double = 0
        var produced: Int = 0
    }

    struct Skills: Decodable, Equatable {
        var ok: Bool = false
        var reason: String?
        var tracked: Int = 0
        var totalUses: Int = 0
        var weak: [String] = []
    }

    struct RunningTask: Decodable, Equatable, Identifiable {
        var session: String
        var step: String = ""
        var turn: Int?
        var id: String { session }
    }

    struct Interrupts: Decodable, Equatable {
        var ok: Bool = false
        var running: [RunningTask] = []
    }

    struct Trace: Decodable, Equatable {
        struct Tag: Decodable, Equatable {
            var tag: String
            var n: Int
        }
        var ok: Bool = false
        var total: Int = 0
        var successes: Int = 0
        var failures: Int = 0
        var unknown: Int = 0
        var topTags: [Tag] = []
    }

    struct Turns: Decodable, Equatable {
        var ok: Bool = false
        var total: Int = 0
        var lastAt: Double = 0
    }

    struct Alert: Decodable, Equatable, Identifiable {
        var at: Double
        var kind: String
        var message: String
        var id: String { "\(at)-\(kind)-\(message.prefix(24))" }
    }

    var version: Int = 1
    var generatedAt: Double = 0
    var headline: String = "还没开始干活"
    var taskStats = TaskStats()
    var dream = Dream()
    var skills = Skills()
    var interrupts = Interrupts()
    var trace = Trace()
    var turns = Turns()
    var alerts: [Alert] = []

    // 后端字段都是 snake/camel 混排，用自定义 key 省得改引擎命名。
    enum CodingKeys: String, CodingKey {
        case version, generatedAt, headline, taskStats, dream, skills, interrupts, trace, turns, alerts
    }

    /// 引擎还没写过快照时的占位：显示「未知」，不显示「一切正常」。
    static let unknown = CapabilityStatus()
}

/// 能力面板：把治理层的工作摆到台面上。
///
/// 三条设计原则：
/// 1. **先给结论**：顶部一句话（`headline`），不用用户自己拼「3 个任务 + 2 次整理」。
/// 2. **空状态说实话**：没数据就写「还没有记录」，不写「一切正常」——
///    静默失败比失败本身更糟，用户会以为系统在正常工作，其实什么都没跑。
/// 3. **只显示有意义的**：一堆 0 的格子不如不显示。
struct CapabilityPanel: View {
    let status: CapabilityStatus?
    /// 放进已有卡片的容器（设置页的 Form 行）时不画自己的底和描边，
    /// 否则玻璃行里再套一层实心卡，边看不出来但底色会压暗一层。
    var bare = false

    private var s: CapabilityStatus { status ?? .unknown }

    /// 有没有任何真实数据。没有就显示引导，而不是一堆空卡片。
    private var hasAnyData: Bool {
        s.taskStats.total > 0 || s.dream.runs > 0 || s.skills.tracked > 0
            || s.trace.total > 0 || !s.interrupts.running.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header

            if hasAnyData {
                if !s.interrupts.running.isEmpty { runningSection }
                if !s.alerts.isEmpty { alertsSection }
                metricsGrid
                if let lastRun = lastRunText { footer(lastRun) }
            } else {
                emptyState
            }
        }
        .padding(bare ? 0 : 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            if !bare {
                RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Palette.field)
            }
        }
        .overlay {
            if !bare {
                RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Palette.stroke)
            }
        }
    }

    // MARK: - 头部

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("Σ")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.ink)
            Text(s.headline)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Palette.ink)
                .lineLimit(2)
            Spacer(minLength: 0)
        }
    }

    // MARK: - 正在跑

    private var runningSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("正在跑")
            ForEach(s.interrupts.running.prefix(3)) { task in
                HStack(spacing: 6) {
                    Circle()
                        .fill(Palette.waiting)
                        .frame(width: 6, height: 6)
                    Text(task.step.isEmpty ? "任务进行中" : task.step)
                        .font(.caption)
                        .foregroundStyle(Palette.secondary)
                        .lineLimit(1)
                }
            }
        }
    }

    // MARK: - 告警

    private var alertsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionLabel("最近的告警")
            ForEach(s.alerts.prefix(3)) { alert in
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: icon(for: alert.kind))
                        .font(.caption2)
                        .foregroundStyle(tint(for: alert.kind))
                    Text(alert.message)
                        .font(.caption)
                        .foregroundStyle(Palette.secondary)
                        .lineLimit(2)
                }
            }
        }
    }

    private func icon(for kind: String) -> String {
        switch kind {
        case "injection": return "exclamationmark.shield"
        case "interrupted": return "bolt.slash"
        case "gate_failed": return "xmark.seal"
        case "task_needs_redesign": return "arrow.triangle.2.circlepath"
        case "scene_missing": return "questionmark.folder"
        default: return "info.circle"
        }
    }

    private func tint(for kind: String) -> Color {
        switch kind {
        case "injection", "gate_failed": return Palette.removed
        case "interrupted", "task_needs_redesign": return Palette.waiting
        default: return Palette.secondary
        }
    }

    // MARK: - 指标

    private var metricsGrid: some View {
        let cells: [(String, String)] = [
            s.taskStats.total > 0 ? ("任务", "\(s.taskStats.total)") : nil,
            s.dream.runs > 0 ? ("整理", "\(s.dream.runs) 次") : nil,
            s.skills.tracked > 0 ? ("技能", "\(s.skills.tracked) 个") : nil,
            s.trace.total > 0 ? ("经验", "\(s.trace.total) 条") : nil,
            s.turns.total > 0 ? ("轮次", "\(s.turns.total)") : nil,
        ].compactMap { $0 }

        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 8)], spacing: 8) {
            ForEach(cells, id: \.0) { label, value in
                VStack(spacing: 2) {
                    Text(value)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Palette.ink)
                    Text(label)
                        .font(.caption2)
                        .foregroundStyle(Palette.faint)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .background(Palette.background.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
    }

    // MARK: - 空状态

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("还没有可显示的活动")
                .font(.caption)
                .foregroundStyle(Palette.secondary)
            // 说清楚为什么空——不然用户会以为坏了
            Text("任务、整理和经验记录会在你开始用之后逐步出现。")
                .font(.caption2)
                .foregroundStyle(Palette.faint)
        }
    }

    // MARK: - 底部

    private var lastRunText: String? {
        guard s.generatedAt > 0 else { return nil }
        let date = Date(timeIntervalSince1970: s.generatedAt / 1000)
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "zh_CN")
        f.unitsStyle = .short
        return "更新于 " + f.localizedString(for: date, relativeTo: Date())
    }

    private func footer(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(Palette.faint)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Palette.faint)
            .textCase(.uppercase)
    }
}
