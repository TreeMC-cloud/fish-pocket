import SwiftUI

/// 「经验」页：把引擎的学习闭环（trace 记账 → 候选技能）摆到台面上。
///
/// 为什么需要：每轮对话引擎都会往 `<数据目录>/.trace.jsonl` 追加一条经验，
/// 攒够之后 distill 从重复出现的「坑 + 解法」里提炼出候选技能，写进
/// `.skill-candidates.jsonl`。这两份文件用户完全看不到——「它到底学了什么」
/// 是个黑箱。这一页就是那扇窗：上半段回答「攒了多少、成功率多少、
/// 最近在忙什么话题」，下半段回答「它想固化哪些经验、为什么还不能用」。
///
/// 数据来源是引擎写的文件，不是 RPC：和任务队列同理，引擎没起来时也要能看；
/// 而且这两份文件本来就是追加式、给「读」设计的。
///
/// 统计只读文件尾部（`LearnSnapshot.traceLimit` 条）：trace 会长期追加，
/// 全读大文件会卡住首屏，而这一页关心的本来就只有最近一段。
struct LearnPage: View {
    @State private var snapshot: LearnSnapshot?
    @State private var loading = false

    var body: some View {
        Form {
            if loading && snapshot == nil {
                Section {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("正在读取经验记录…").foregroundStyle(Palette.secondary)
                    }
                }
                .groupedRow()
            } else if let snapshot {
                if snapshot.traces.isEmpty {
                    emptySection
                } else {
                    statsSection(snapshot)
                    weekSection(snapshot)
                    tagsSection(snapshot)
                }
                candidatesSection(snapshot)
                actionsSection(snapshot)
            }
        }
        .groupedList()
        .navigationTitle("经验")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { if snapshot == nil { await load() } }
    }

    // MARK: - 经验统计

    /// 先回答「学了多少」：总数、成功、失败、成功率。
    /// ok 为 nil 的轮次是「没有结论」，单独一格、不算进成功率——
    /// 把它当失败会把成功率压成一个没有意义的数字。
    private func statsSection(_ s: LearnSnapshot) -> some View {
        Section {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 76), spacing: 8)], spacing: 8) {
                statCell("总数", "\(s.total)")
                statCell("成功", "\(s.successes)")
                statCell("失败", "\(s.failures)")
                statCell("成功率", s.successRateText)
                if s.unknown > 0 { statCell("无结论", "\(s.unknown)") }
            }
        } header: {
            Text("经验统计")
        } footer: {
            Text(statsFooter(s))
        }
        .groupedRow()
    }

    private func statCell(_ label: String, _ value: String) -> some View {
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

    /// 统计口径必须一并写出：不说清「只统计最后几条」「成功率怎么算」，
    /// 这组数字就会比没有更容易误导。
    private func statsFooter(_ s: LearnSnapshot) -> String {
        var text = s.truncated
            ? String(localized: "文件里还有更早的记录，这里只统计最后 \(LearnSnapshot.traceLimit) 条。")
            : String(localized: "统计覆盖现有的 \(s.total) 条记录。")
        text += String(localized: "成功率按「成功 ÷（成功 + 失败）」算；没有结论的轮次不计入，单独列出。")
        return text
    }

    // MARK: - 最近 7 天

    /// 最近 7 天每天几条。竖条比数字列表更容易看出「哪几天密集、哪天没干活」；
    /// 空的一天留一点底托，让「这天存在但没有记录」和「这天不存在」能分开。
    private func weekSection(_ s: LearnSnapshot) -> some View {
        Section {
            if !s.days.isEmpty {
                weekBars(s.days)
                    .padding(.vertical, 2)
            }
        } header: {
            Text("最近 7 天")
        } footer: {
            if s.weekTotal == 0 {
                Text("最近 7 天没有新记录。")
            }
        }
        .groupedRow()
    }

    private func weekBars(_ days: [LearnSnapshot.DayCount]) -> some View {
        // 最高的一天决定满格高度；全是 0 时用 1 兜底，避免除以 0。
        let peak = max(days.map(\.count).max() ?? 0, 1)
        return HStack(alignment: .bottom, spacing: 8) {
            ForEach(days) { day in
                VStack(spacing: 4) {
                    Text("\(day.count)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(day.count > 0 ? Palette.ink : Palette.faint)
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(day.count > 0 ? Palette.running : Palette.control)
                        .frame(height: barHeight(day.count, peak: peak))
                    Text(day.label)
                        .font(.caption2)
                        .foregroundStyle(Palette.faint)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }

    /// 柱高：最高的一天满格 56pt，其余按比例；空的一天给 4pt 的底托。
    private func barHeight(_ count: Int, peak: Int) -> CGFloat {
        guard count > 0 else { return 4 }
        return max(8, 56 * CGFloat(count) / CGFloat(peak))
    }

    // MARK: - 话题

    /// top 5 话题：引擎从每轮摘要里认出来的标签，也是候选技能的分组单位。
    /// 没有标签就没有这一段——不是所有轮次都能被归到某个话题。
    @ViewBuilder
    private func tagsSection(_ s: LearnSnapshot) -> some View {
        if !s.topTags.isEmpty {
            Section {
                ForEach(s.topTags) { row in
                    HStack(spacing: 8) {
                        Text("#\(row.tag)")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Palette.ink)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Text("\(row.n) 次")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(Palette.secondary)
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                Text("最常出现的话题")
            } footer: {
                Text("标签由引擎从每轮的摘要里自动认出，用来给经验归类。同一话题反复出现，才可能被提炼成候选技能。")
            }
            .groupedRow()
        }
    }

    // MARK: - 候选技能

    /// 下半段：提炼出的候选。每条给出证据（样本数、失败率、坑与当时的解法）
    /// 和状态（verified）。空的时候如实说「还没有提炼出候选」并把判据写清，
    /// 不写「一切正常」——「提炼没跑」和「跑了但没产出」是两回事。
    private func actionsSection(_ s: LearnSnapshot) -> some View {
        Section {
            if s.actions.isEmpty {
                Text("还没有主动动作。它会在同一个坑反复失败、或有东西等你确认时自己判断要不要动。")
                    .font(.caption)
                    .foregroundStyle(Palette.secondary)
            } else {
                ForEach(s.actions) { row in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: row.action == "enqueue" ? "bolt.fill" : "bell.fill")
                            .font(.caption2)
                            .foregroundStyle(row.action == "enqueue" ? Palette.running : Palette.waiting)
                            .padding(.top, 3)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(row.action == "enqueue" ? "自己派了活" : "提醒你")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Palette.ink)
                            Text(row.reason)
                                .font(.caption)
                                .foregroundStyle(Palette.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        } header: {
            Text("它自己做过什么")
        } footer: {
            Text("「自己派了活」是它判断出同一个坑反复失败后主动去查的；这类只做只读排查。需要你拍板的事只会提醒，不会自动动手。")
        }
        .groupedRow()
    }

    private func candidatesSection(_ s: LearnSnapshot) -> some View {
        Section {
            if s.candidates.isEmpty {
                emptyRow(String(localized: "还没有提炼出候选"))
            } else {
                ForEach(s.candidates) { row in candidateRow(row) }
            }
        } header: {
            Text(s.candidates.isEmpty ? "候选技能" : "候选技能（\(s.candidates.count)）")
        } footer: {
            Text(candidateFooter(s))
        }
        .groupedRow()
    }

    private func candidateRow(_ row: LearnSnapshot.CandidateRow) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("#\(row.tag)")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                Spacer(minLength: 8)
                VerifiedBadge(verified: row.verified)
            }
            HStack(spacing: 8) {
                Text("样本 \(row.samples)")
                Text("失败 \(row.fails)")
                Text("失败率 \(percent(row.failRatio))")
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(Palette.secondary)
            if !row.problem.isEmpty {
                Text("坑：\(row.problem)")
                    .font(.caption)
                    .foregroundStyle(Palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !row.practice.isEmpty {
                Text("当时的解法：\(row.practice)")
                    .font(.caption)
                    .foregroundStyle(Palette.faint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 2)
    }

    /// 判据照抄 trace.mjs 的 distill：同一 tag ≥3 次、失败占比 ≥30%、且有成功样本。
    /// 空的时候解释「为什么还没有」，有候选时解释「为什么还不能用」。
    private func candidateFooter(_ s: LearnSnapshot) -> String {
        let criteria = String(localized: "攒够一定量的经验才会提炼：同一话题至少 3 次、失败占比不低于 30%，而且有过成功样本。")
        guard !s.candidates.isEmpty else { return criteria }
        return criteria + String(localized: "候选的 verified 都是 false——不会自动生效，看过确认后才会变成真技能。")
    }

    private func percent(_ ratio: Double) -> String {
        String(format: "%.0f%%", ratio * 100)
    }

    // MARK: - 空状态与读取

    private var emptySection: some View {
        Section {
            emptyRow(String(localized: "还没有记录"))
        } header: {
            Text("经验统计")
        } footer: {
            Text("引擎每轮对话结束时会记一条经验。这里为空说明还没记过任何一轮——不是「一切正常」。")
        }
        .groupedRow()
    }

    private func emptyRow(_ text: String) -> some View {
        HStack {
            Text(text).foregroundStyle(Palette.secondary)
            Spacer()
        }
    }

    private func load() async {
        loading = true
        let loaded = await Task.detached(priority: .userInitiated) { LearnSnapshot.load() }.value
        snapshot = loaded
        loading = false
    }
}

/// 候选的确认状态，一一对应记录里的 `verified` 字段。
/// false 是设计上的减速带：没被确认过的经验不许自动改变行为。
/// 把它画出来，用户才知道「没生效」不是坏了，而是还没到时候。
private struct VerifiedBadge: View {
    let verified: Bool

    var body: some View {
        Text(verified ? "已验证" : "未验证")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(verified ? Palette.running : Palette.waiting)
            .padding(.horizontal, 8)
            .frame(height: 20)
            .background((verified ? Palette.running : Palette.waiting).opacity(0.12), in: Capsule())
    }
}

// MARK: - 数据

/// `.trace.jsonl` 与 `.skill-candidates.jsonl` 的读取结果。
///
/// 用 `JSONSerialization` 而不是 `Codable`：两份记录都是引擎的追加日志，
/// 字段会随版本增删，而这一页每类只用五六个字段。逐字段建模等于让模型
/// 跟着引擎走、引擎加字段这里就要改；和 `TaskListPage` 同一取舍：
/// 缺字段给默认值，坏行跳过。
struct LearnSnapshot {
    /// 一条经验（一轮的收尾记录）。`ok` 是三态：true 成功 / false 失败 /
    /// nil 没有结论——引擎对拿不准的轮次不猜。
    struct TraceRow {
        let at: Double
        let ok: Bool?
        let summary: String
        let tags: [String]
    }

    /// 一条主动动作。`action` 是 `enqueue`（自己派活）或 `notify`（只提醒）。
    struct ActionRow: Identifiable {
        let id: String
        let at: Double
        let action: String
        let reason: String
    }

    /// 一条候选技能。证据是 `problem`（坑）与 `practice`（当时的解法）两段截断文本，
    /// 它们只是证据片段，不是能直接照抄的操作步骤。
    struct CandidateRow: Identifiable {
        let id: String
        let tag: String
        let samples: Int
        let fails: Int
        let failRatio: Double
        let problem: String
        let practice: String
        let verified: Bool
    }

    /// 最近 7 天里的一天。`id` 是距今天的偏移（0 = 今天），ForEach 用它做标识。
    struct DayCount: Identifiable {
        let id: Int
        let label: String
        let count: Int
    }

    /// 一个话题标签及其出现次数。
    struct TagCount: Identifiable {
        /// 标签名本身就是身份：同一个话题在统计里只会出现一次。
        let tag: String
        let n: Int
        var id: String { tag }
    }

    /// 只读最后这么多条：trace 长期追加，全读大文件会卡住首屏。
    /// 500 和 distill 看最近 300 条是同一个量级，足够回答统计问题。
    static let traceLimit = 500

    var traces: [TraceRow] = []
    var days: [DayCount] = []
    var topTags: [TagCount] = []
    var candidates: [CandidateRow] = []
    /// 它自己主动做过的事（派活 / 提醒），来自 `.proactive.jsonl`。
    /// 这一块是「主动」唯一能被看见的地方——不然用户根本不知道它自己动过。
    var actions: [ActionRow] = []
    /// 文件里还有更早的记录没读进来。界面必须如实标注「只统计尾部」，
    /// 不能把局部说成全部。
    var truncated = false

    var total: Int { traces.count }
    var successes: Int { traces.filter { $0.ok == true }.count }
    var failures: Int { traces.filter { $0.ok == false }.count }
    /// 引擎对拿不准的轮次写 ok: null。这些轮次单独计数，不混进成功率。
    var unknown: Int { traces.filter { $0.ok == nil }.count }
    var weekTotal: Int { days.reduce(0) { $0 + $1.count } }

    /// 成功率只在有结论的轮次上算：把「不知道」混进分母，
    /// 得到的只是噪声比例，不是成功率。
    var successRateText: String {
        let judged = successes + failures
        guard judged > 0 else { return "—" }
        return String(format: "%.0f%%", Double(successes) / Double(judged) * 100)
    }

    // MARK: 读取

    static func load() -> LearnSnapshot {
        var snapshot = LearnSnapshot()
        // 数据目录与引擎、App 其余部分同一口径：DSH_IOS_DATA。
        let dir = EnginePaths.real(EnginePaths.shared)

        // 引擎写 trace 时做过轮转（超过 2MB 换到 .trace.jsonl.1），这里只看
        // 当前这一份——和 capability.json 的统计口径一致，不翻旧档。
        let traceTail = tailLines(of: dir.appendingPathComponent(".trace.jsonl"), limit: traceLimit)
        snapshot.truncated = traceTail.truncated
        var traces: [TraceRow] = []
        for line in traceTail.lines {
            guard let obj = object(from: line) else { continue }
            traces.append(TraceRow(
                at: (obj["at"] as? Double) ?? 0,
                ok: obj["ok"] as? Bool,
                summary: (obj["summary"] as? String) ?? "",
                tags: (obj["tags"] as? [String]) ?? []
            ))
        }
        snapshot.traces = traces
        snapshot.days = weekDays(of: traces)
        snapshot.topTags = topTags(of: traces)

        // 它自己主动做过什么。文件不存在很正常（从没触发过），不报错。
        let actionTail = tailLines(of: dir.appendingPathComponent(".proactive.jsonl"), limit: 100)
        var actions: [ActionRow] = []
        for (index, line) in actionTail.lines.enumerated() {
            guard let obj = object(from: line) else { continue }
            let reason = (obj["reason"] as? String) ?? ""
            guard !reason.isEmpty else { continue }
            actions.append(ActionRow(
                id: "\(index)-\((obj["at"] as? Double) ?? 0)",
                at: (obj["at"] as? Double) ?? 0,
                action: (obj["action"] as? String) ?? "?",
                reason: reason
            ))
        }
        snapshot.actions = Array(actions.suffix(20).reversed())

        // 候选表小得多（distill 先去重再追加），但仍用同一套尾部读取——
        // 万一它哪天变大，这里不应该跟着变成「打开就卡」。
        // 指纹去重：同一指纹重复出现时只留第一条，ForEach 的 id 不会撞。
        let candidateTail = tailLines(of: dir.appendingPathComponent(".skill-candidates.jsonl"), limit: 200)
        var seen = Set<String>()
        var candidates: [CandidateRow] = []
        for line in candidateTail.lines {
            guard let obj = object(from: line) else { continue }
            let tag = (obj["tag"] as? String) ?? ""
            guard !tag.isEmpty else { continue }
            let at = (obj["at"] as? Double) ?? 0
            let fingerprint = (obj["fingerprint"] as? String) ?? "\(tag)-\(at)"
            guard seen.insert(fingerprint).inserted else { continue }
            candidates.append(CandidateRow(
                id: fingerprint,
                tag: tag,
                samples: Int((obj["samples"] as? Double) ?? 0),
                fails: Int((obj["fails"] as? Double) ?? 0),
                failRatio: (obj["failRatio"] as? Double) ?? 0,
                problem: (obj["problem"] as? String) ?? "",
                practice: (obj["practice"] as? String) ?? "",
                verified: (obj["verified"] as? Bool) ?? false
            ))
        }
        snapshot.candidates = candidates
        return snapshot
    }

    /// 一行 JSONL → 字典。坏行返回 nil：一行烂掉不该让整页打不开
    /// （引擎自己的 readJsonl 也是同样的宽容）。
    static func object(from line: String) -> [String: Any]? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { return nil }
        return object
    }

    /// 从文件尾部读最多 limit 行，返回（读到的行，是否还有更早的行）。
    ///
    /// 为什么按窗口翻倍而不是整份读：trace 是长期追加的，几 MB 之后
    /// 「全读再切行」打开这一页要白等，而这一页关心的本来就只有最近一段。
    /// 策略和 `EngineLogView` 读日志尾部一致：从 256KB 起翻倍，
    /// 直到行数够或者到达文件头。
    static func tailLines(of url: URL, limit: Int) -> (lines: [String], truncated: Bool) {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return ([], false) }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        var window = 256 * 1024
        while true {
            let start = size > UInt64(window) ? size - UInt64(window) : 0
            _ = try? handle.seek(toOffset: start)
            var lines = String(decoding: handle.readDataToEndOfFile(), as: UTF8.self)
                .components(separatedBy: "\n")
            // 窗口从文件中间切进来时，第一行只有半截：丢掉。
            // 半条 JSON 既解析不出来，也容易把统计带偏。
            if start > 0 && !lines.isEmpty { lines.removeFirst() }
            // 文件末尾的换行会切出一个空串，那不是一行。
            while lines.last == "" { lines.removeLast() }
            if lines.count > limit || start == 0 || window >= 8 * 1024 * 1024 {
                return (Array(lines.suffix(limit)), start > 0 || lines.count > limit)
            }
            window *= 2
        }
    }

    /// 最近 7 天（含今天）每天几条。
    ///
    /// 用「锚点 + isDate(inSameDayAs:)」分桶，而不是对每天零点做日期减法：
    /// 仓库里没有日历加减的现成用法，而 isDate 在会话列表分组里已经在用，
    /// 跨时区、夏令时都交给 Foundation，不用自己拿 86400 去凑。
    /// 锚点本身来自 `date(from: DateComponents)`——超范围的 day（负数）
    /// 会被日历归一化成「往前推几天」，ScheduleCron 已在用这个 API。
    static func weekDays(of traces: [TraceRow], now: Date = Date()) -> [DayCount] {
        let calendar = Calendar.current
        let parts = calendar.dateComponents([.year, .month, .day], from: now)
        guard let year = parts.year, let month = parts.month, let day = parts.day else { return [] }

        // 从 6 天前排到今天：条形图从旧到新，最新的在最右边。
        let anchors: [Date] = (0..<7).reversed().compactMap { offset in
            calendar.date(from: DateComponents(year: year, month: month, day: day - offset))
        }
        var counts = [Int](repeating: 0, count: anchors.count)
        for trace in traces where trace.at > 0 {
            let date = Date(timeIntervalSince1970: trace.at / 1000)
            for (index, anchor) in anchors.enumerated() where calendar.isDate(date, inSameDayAs: anchor) {
                counts[index] += 1
                break
            }
        }
        let formatter = DateFormatter()
        // 星期几用本地化模板：中文下是「周三」，英文下是「Wed」，不写死语言。
        formatter.setLocalizedDateFormatFromTemplate("EEE")
        return anchors.enumerated().map { index, anchor in
            let offset = anchors.count - 1 - index
            let label: String
            switch offset {
            case 0: label = String(localized: "今天")
            case 1: label = String(localized: "昨天")
            default: label = formatter.string(from: anchor)
            }
            return DayCount(id: offset, label: label, count: counts[index])
        }
    }

    /// 出现最多的话题，前 limit 个。次数相同时按标签名排序：
    /// 顺序稳定，刷新时 ForEach 才不会闪。
    static func topTags(of traces: [TraceRow], limit: Int = 5) -> [TagCount] {
        var freq: [String: Int] = [:]
        for trace in traces {
            for tag in trace.tags { freq[tag, default: 0] += 1 }
        }
        return freq
            .sorted { lhs, rhs in lhs.value == rhs.value ? lhs.key < rhs.key : lhs.value > rhs.value }
            .prefix(limit)
            .map { TagCount(tag: $0.key, n: $0.value) }
    }
}
