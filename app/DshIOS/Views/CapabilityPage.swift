import SwiftUI

/// 设置里的「能力地图」：治理层在后台做了什么，一次看全。
///
/// 为什么单独一页：原来这块只在**空会话页**出现，一旦有对话就再也看不到——
/// 而「治理层有没有在跑」恰恰是长期使用才关心的事。设置是常驻入口，
/// 也和旁边的「插件／自动化」属于同一类：这些东西在替我做什么。
///
/// 页面分两段：
/// 当前计划（`plan-view.json`，由 auto-guard 在 turn/start 从工作区 `.plan.md` 读出）。
struct PlanProgress {
    let total: Int
    let done: Int
    let next: String?

    static func load() -> PlanProgress? {
        let url = EnginePaths.real(EnginePaths.shared + "/plan-view.json")
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (obj["ok"] as? Bool) == true else { return nil }
        let total = obj["total"] as? Int ?? 0
        guard total > 0 else { return nil }
        return PlanProgress(
            total: total,
            done: obj["done"] as? Int ?? 0,
            next: (obj["next"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        )
    }
}

/// 1. 运行状态（`CapabilityPanel`，数据来自引擎写的 capability.json）
/// 2. 这层到底比原生 DSH 多了什么（静态说明，回答「我到底装了个啥」）
struct CapabilityPage: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Form {
            if let plan = PlanProgress.load() {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("计划进度 \(plan.done)/\(plan.total)")
                                .foregroundStyle(Palette.ink)
                            Spacer()
                            if plan.total > 0 {
                                ProgressView(value: Double(plan.done), total: Double(plan.total))
                                    .frame(width: 90)
                            }
                        }
                        if let next = plan.next {
                            Text("下一步：\(next)")
                                .font(.caption)
                                .foregroundStyle(Palette.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            Text("全部完成")
                                .font(.caption)
                                .foregroundStyle(Palette.running)
                        }
                    }
                    .padding(.vertical, 4)
                } header: {
                    Text("当前计划")
                } footer: {
                    Text("来自工作区的 .plan.md。多步骤任务会让它把计划写进文件，压缩上下文或中途重启都能接上。")
                }
                .groupedRow()
            }

            Section {
                CapabilityPanel(status: app.capability, bare: true)
                    .padding(.vertical, 4)
            } header: {
                Text("运行状态")
            } footer: {
                Text("这些数字由引擎在后台写入，App 每 3 秒读一次。没跑过就显示「还没有记录」，不会显示成「一切正常」。")
            }
            .groupedRow()

            Section {
                // 任务队列的完整视图。运行状态那块只给数字和「等你确认」的短列表，
                // 看不到全貌；出问题时需要一个能翻全部任务的地方。
                NavigationLink {
                    TaskListPage()
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("任务队列")
                        Text(taskSummary)
                            .font(.caption)
                            .foregroundStyle(Palette.secondary)
                            .lineLimit(1)
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                Text("任务")
            } footer: {
                Text("引擎把每轮对话记成一条任务。失败的不自动重跑，需要你在这里确认。")
            }
            .groupedRow()

            Section {
                // 经验页的完整视图：运行状态那块只给「经验 N 条」一个数字，
                // 「它到底学到了什么」需要一个能看统计和候选技能的地方。
                NavigationLink {
                    LearnPage()
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("经验")
                        Text(learnSummary)
                            .font(.caption)
                            .foregroundStyle(Palette.secondary)
                            .lineLimit(1)
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                Text("进化")
            } footer: {
                Text("引擎每轮对话都记一条经验，攒够后会提炼出候选技能。候选不会自动生效，需要你确认。")
            }
            .groupedRow()

            Section {
                ForEach(CapabilityCatalog.groups) { group in
                    NavigationLink {
                        CapabilityGroupPage(group: group)
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(group.title)
                            Text(group.summary)
                                .font(.caption)
                                .foregroundStyle(Palette.secondary)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 2)
                    }
                }
            } header: {
                Text("比原生 DSH 多出来的")
            } footer: {
                Text("原生 DSH 靠 subprocess + sandbox 执行命令；iOS 禁止 fork/exec，所以执行层整套换掉了。其余原生自带的能力（workflow、subagent、schedule、goal、jobs、skill、present、MCP）不计入这里。")
            }
            .groupedRow()
        }
        .navigationTitle("能力地图")
        .navigationBarTitleDisplayMode(.inline)
        // 项目统一用 GroupedListStyle（.groupedList()）：insetGrouped + 玻璃行背景 +
        // 52pt 行高下限。`.groupedListStyle()` 是 SwiftUI 在 iOS 上不存在的方法。
        .groupedList()
    }

    /// 任务队列那行右侧的摘要。
    /// 只统计，不判断好坏——「3 个待确认」比「有异常」更能促使人点进去看。
    private var taskSummary: String {
        guard let stats = app.capability?.taskStats, stats.ok else {
            return String(localized: "还没有任务记录")
        }
        var parts = [String(localized: "\(stats.total) 个")]
        if !stats.needsAttention.isEmpty {
            parts.append(String(localized: "\(stats.needsAttention.count) 个待确认"))
        }
        return parts.joined(separator: " · ")
    }

    /// 经验那行右侧的摘要。同样只说事实：引擎没写过 trace 就写「还没有经验记录」，
    /// 不显示成 0 条——「还没有记录」和「记录是 0」对用户不是一个意思。
    private var learnSummary: String {
        guard let trace = app.capability?.trace, trace.ok, trace.total > 0 else {
            return String(localized: "还没有经验记录")
        }
        var parts = [String(localized: "\(trace.total) 条")]
        if trace.failures > 0 { parts.append(String(localized: "失败 \(trace.failures)")) }
        return parts.joined(separator: " · ")
    }
}

/// 一组能力的详情。
struct CapabilityGroupPage: View {
    let group: CapabilityCatalog.Group

    var body: some View {
        Form {
            Section {
                ForEach(group.items) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            Text(item.name).font(.subheadline.weight(.medium))
                            Spacer(minLength: 0)
                            StatusBadge(state: item.state)
                        }
                        Text(item.detail)
                            .font(.caption)
                            .foregroundStyle(Palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        if let note = item.note {
                            Text(note)
                                .font(.caption)
                                .foregroundStyle(item.state == .broken ? Palette.removed : Palette.faint)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.vertical, 3)
                }
            } header: {
                Text(group.title)
            } footer: {
                if let footer = group.footer {
                    Text(footer)
                }
            }
            .groupedRow()
        }
        .navigationTitle(group.title)
        .navigationBarTitleDisplayMode(.inline)
        .groupedList()
    }
}

/// 一个条目的实际状态。**「配了」不等于「生效了」**，所以分开写。
private struct StatusBadge: View {
    let state: CapabilityCatalog.State

    var body: some View {
        Text(state.label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(state.tint)
            .padding(.horizontal, 8)
            .frame(height: 20)
            .background(state.tint.opacity(0.12), in: Capsule())
    }
}

extension CapabilityCatalog.State {
    var label: String {
        switch self {
        case .working: String(localized: "生效")
        case .partial: String(localized: "部分生效")
        case .broken: String(localized: "没生效")
        }
    }

    var tint: Color {
        switch self {
        case .working: Palette.running
        case .partial: Palette.waiting
        case .broken: Palette.removed
        }
    }
}

/// 能力清单：写死的静态事实，不是探测结果。
///
/// 为什么写死：这些「有哪些东西」不随运行状态变，探测反而会给出假阴性
/// （比如插件文件在、但这轮没触发，探测会说没有）。真正会变的是运行状态，
/// 那部分在 `CapabilityPanel` 里由引擎写。这里只回答「装了什么」。
enum CapabilityCatalog {
    enum State {
        case working, partial, broken
    }

    struct Item: Identifiable {
        let id = UUID()
        let name: String
        let detail: String
        var state: State = .working
        var note: String?
    }

    struct Group: Identifiable {
        let id = UUID()
        let title: String
        let summary: String
        let items: [Item]
        var footer: String?
    }

    static let groups: [Group] = [
        Group(
            title: "iOS 执行层",
            summary: "把 subprocess + sandbox 两个接缝整个换掉，让命令能在手机上跑",
            items: [
                Item(name: "subprocess-ios", detail: "just-bash 进程内执行 + 在 worker 里跑 node。iOS 不允许 fork/exec，所以 bash 是进程内模拟的，node 走 worker 线程。"),
                Item(name: "sandbox-ios", detail: "用解释器自身当围栏：路径和命令都在 JS 层校验，没有内核级沙箱可用。"),
                Item(name: "ios-host", detail: "只改插件就能重启引擎，不用重新装 App。"),
            ],
            footer: "原生 DSH 在这台机器上起不来——它依赖的 fork/exec iOS 直接禁止。"
        ),
        Group(
            title: "每轮自动守卫",
            summary: "挂四个钩子，在每一轮里盯着越界、连错和压缩时机",
            items: [
                Item(name: "轮次上限", detail: "单轮超过 40 轮就报警，避免一个任务把上下文耗光。"),
                Item(name: "同错连击", detail: "同一个工具连续错 3 次就报警，而不是一直重试同一个错。"),
                Item(name: "压缩提醒", detail: "上下文压缩前提醒先写交接，防止压缩把关键信息吃掉。"),
                Item(name: "派活前查负载", detail: "内存吃紧时不派新活，避免把引擎压垮。"),
            ]
        ),
        Group(
            title: "技能层",
            summary: "19 个技能，每个带可执行的自查脚本",
            items: [
                Item(name: "cost-guard", detail: "算每轮成本与轮次，超预算就提醒。"),
                Item(name: "dispatch-protocol", detail: "派活的协议与哨兵，防止派出去没人接。"),
                Item(name: "evolve", detail: "记录每轮结果，按话题聚类出候选技能；候选永远待确认，不自动生效。"),
                Item(name: "selfaudit · self-review", detail: "自查脚本：技能体检、统计、撤销。"),
            ],
            footer: "这些脚本可以直接跑（退出码 0 表示通过），不是只有文档。"
        ),
        Group(
            title: "七层记忆",
            summary: "meow-memory，跨会话记住你",
            items: [
                Item(
                    name: "meow-memory 0.32.6",
                    detail: "soul / user / project / fact / lesson / topic / rules 七张表，跨会话累积。",
                    state: .working,
                    note: "0.32.6 曾在打包时把 lib/prompts/*.md 当成文档剪掉，导致启动时读不到 zh/tools.md、整层没激活。已在打包脚本里保留 prompts 目录。"
                ),
            ],
            footer: "如果状态回到「没生效」，先看启动日志里有没有 ENOENT 指向 prompts。"
        ),
        Group(
            title: "治理层（本机新增）",
            summary: "任务表、整理、告警、飞行记录——原生 DSH 没有这一层",
            items: [
                Item(name: "飞行记录", detail: "每轮开始记一条，结束清掉；崩溃留下的残迹在下次启动时报告成「上一轮中断」。"),
                Item(name: "任务表", detail: "任务状态机，带租约和幂等键，防止同一件事被派两次。"),
                Item(name: "通知准入", detail: "出事类提醒（中断、注入、派活失败）不受冷却；高频类按会话+类型限流。"),
                Item(name: "Dream 整理", detail: "间隔 ≥1 小时且新增记录 ≥20 条才跑，产出候选技能，不直接改行为。"),
                Item(name: "注入防护", detail: "识别信息外泄、系统伪装、角色劫持、指令覆盖四类，先归一化再匹配。"),
            ]
        ),
    ]
}
