import SwiftUI

/// 运行时间 (S-101 / S-102 / B15…B22): the Repeat choice and the rows that
/// state it. The card owns no rule state; every edit goes back through the
/// detail's draft.
struct RuleEditor: View {
    let task: JSON
    let values: RuleValues
    let unit: IntervalUnit
    let editable: Bool
    let failure: String?
    let choose: (RuleKind, IntervalUnit?) -> Void
    let chooseZone: (String) -> Void
    let toggleWeekday: (Int) -> Void
    let editDraft: (RuleDraft) -> Void

    var body: some View {
        Section {
            Picker("重复", selection: Binding(get: { RuleChoice.of(values.kind, unit: unit) }, set: { choice in
                Haptics.select()
                choose(choice.kind, choice.unit)
            })) {
                ForEach(RuleChoice.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.menu)

            switch values.kind {
            case .weekly:
                WeekdayPills(selected: values.weekdays, toggle: toggleWeekday)
                ClockRow(title: "时间", time: draft(\.time))
            case .weekdays, .daily:
                ClockRow(title: "时间", time: draft(\.time))
            case .once:
                DatePicker("日期", selection: dayBinding, displayedComponents: .date)
                    .environment(\.timeZone, zone)
                    .environment(\.calendar, mondayFirst)
                ClockRow(title: "时间", time: draft(\.time))
            case .every:
                intervalRow
            case .cron:
                CronRows(task: task, expression: draft(\.expression), timeZone: values.draft.timeZone)
            }

            if values.kind != .every {
                NavigationLink {
                    TimeZonePicker(selection: values.draft.timeZone) { zone in
                        Haptics.select()
                        chooseZone(zone)
                    }
                } label: {
                    LabeledContent("时区") {
                        Text(ScheduleFormat.zoneName(values.draft.timeZone)).lineLimit(2).multilineTextAlignment(.trailing)
                    }
                }
            }
        } header: {
            Text("运行时间")
        } footer: {
            if let hint { Text(hint).foregroundStyle(failure != nil ? Palette.removed : Palette.secondary) }
        }
        .disabled(!editable)
        .groupedRow()
    }

    /// The line under the card: the failure, or the interval floor / cron sentence / one-shot zone note.
    private var hint: String? {
        if let failure { return failure }
        switch values.kind {
        case .every: return unit.hint
        case .cron: return Cron.parse(values.draft.expression).map(Cron.preview) ?? ScheduleRule.cronInvalid
        case .once where !ScheduleRule.draftZone(task).stored: return "单次任务只保存触发时刻，不保存时区；日期和时间按所选时区换算"
        default: return nil
        }
    }

    private var zone: TimeZone { TimeZone(identifier: values.draft.timeZone) ?? .current }

    /// The web's calendar starts on Monday.
    private var mondayFirst: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        calendar.firstWeekday = 2
        calendar.locale = ScheduleText.locale
        return calendar
    }

    private func draft(_ key: WritableKeyPath<RuleDraft, String>) -> Binding<String> {
        Binding(get: { values.draft[keyPath: key] }, set: { value in
            var next = values.draft
            next[keyPath: key] = value
            editDraft(next)
        })
    }

    private var dayBinding: Binding<Date> {
        Binding(
            get: { ZonedClock.day(values.draft.date, zone: values.draft.timeZone) ?? .now },
            set: { date in
                var next = values.draft
                next.date = ZonedClock.dayText(date, zone: values.draft.timeZone)
                editDraft(next)
            }
        )
    }

    /// 重复间隔, read as a sentence: a whole number of the chosen unit, stored as seconds (≥ 60).
    private var intervalRow: some View {
        let value = Int(values.draft.seconds).map { Double($0) / Double(unit.seconds) }
        return Stepper {
            HStack(spacing: 8) {
                Text("每")
                TextField("", text: Binding(
                    get: {
                        guard let value else { return values.draft.seconds }
                        return value == value.rounded() ? String(Int(value)) : String(value)
                    },
                    set: { text in
                        var next = values.draft
                        if let number = Double(text.trimmed) { next.seconds = String(Int((number * Double(unit.seconds)).rounded())) }
                        else { next.seconds = text.trimmed.isEmpty ? "" : text }
                        editDraft(next)
                    }
                ))
                .keyboardType(.numberPad)
                .multilineTextAlignment(.center)
                .monospacedDigit()
                .frame(width: 64)
                .frame(minHeight: 32)
                .background(Palette.control, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityLabel("重复间隔")
                Text(unit.label)
            }
        } onIncrement: {
            step(value, +1)
        } onDecrement: {
            step(value, -1)
        }
    }

    private func step(_ value: Double?, _ delta: Double) {
        let next = value.map { max(Double(unit.minimum), $0 + delta) } ?? Double(unit.minimum)
        var draft = values.draft
        draft.seconds = String(Int((next * Double(unit.seconds)).rounded()))
        editDraft(draft)
        Haptics.soft()
    }
}

// MARK: Rows

/// Seven pills across a row of their own, Monday first; the caller keeps at least one selected.
struct WeekdayPills: View {
    let selected: [Int]
    let toggle: (Int) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(1...7, id: \.self) { day in
                let on = selected.contains(day)
                Button { toggle(day) } label: {
                    Text(ScheduleText.t("frequency.weekday.\(day)"))
                        .font(.footnote.weight(on ? .semibold : .regular))
                        .foregroundStyle(on ? Palette.onInk : Palette.ink)
                        .frame(minWidth: 36, minHeight: 36)
                        .background(on ? Palette.ink : Palette.control, in: Circle())
                        // Each day takes its seventh of the row, however narrow the phone.
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("星期\(ScheduleText.t("frequency.weekday.\(day)"))")
                .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
            }
        }
    }
}

/// `HH:mm[:ss[.SSS]]` as the system's time row. Seconds are not offered: what the
/// rule stored stays through an edit (`ClockText`).
struct ClockRow: View {
    let title: LocalizedStringKey
    @Binding var time: String

    /// The picker's day: any day without a clock change will do.
    private static let day = Date(timeIntervalSinceReferenceDate: 0)

    var body: some View {
        DatePicker(title, selection: Binding(get: {
            let clock = ClockText.fields(time)
            return Calendar.current.date(bySettingHour: clock.hour, minute: clock.minute, second: 0, of: Self.day) ?? Self.day
        }, set: { date in
            let picked = Calendar.current.dateComponents([.hour, .minute], from: date)
            time = ClockText.replacing(time, hour: picked.hour ?? 0, minute: picked.minute ?? 0)
        }), displayedComponents: .hourAndMinute)
    }
}

/// The custom (cron) choice: structured rows when the expression has a known
/// shape, the raw expression otherwise (B19). Every row edit rewrites the expression.
struct CronRows: View {
    enum Choice: String, CaseIterable, Identifiable {
        case monthly, weekly, daily, hourly, minutely, raw
        var id: String { rawValue }
        var label: String {
            switch self {
            case .monthly: "每月"
            case .weekly: "每周"
            case .daily: "每天"
            case .hourly: "每 N 小时"
            case .minutely: "每 N 分钟"
            case .raw: "Cron 表达式"
            }
        }
    }

    let task: JSON
    @Binding var expression: String
    let timeZone: String
    @State private var rawChosen = false

    private var shape: CronShape? { Cron.parse(expression).flatMap(Cron.shape) }

    var body: some View {
        let builder = rawChosen ? nil : shape
        Picker("频率", selection: Binding(get: { builder.map(choice) ?? .raw }, set: { Haptics.select(); chooseShape($0) })) {
            ForEach(Choice.allCases) { Text($0.label).tag($0) }
        }
        .pickerStyle(.menu)
        switch builder {
        case .monthly(let days, let hour, let minute):
            VStack(alignment: .leading, spacing: 8) {
                Text("在以下日期")
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 7), spacing: 0) {
                    ForEach(1...31, id: \.self) { day in
                        let on = days.contains(day)
                        Button {
                            if days == [day] { return }
                            let next = on ? days.filter { $0 != day } : (1...31).filter { $0 == day || days.contains($0) }
                            Haptics.select()
                            expression = Cron.expression(.monthly(days: next, hour: hour, minute: minute))
                        } label: {
                            Text("\(day)")
                                .font(.footnote.weight(on ? .semibold : .regular)).monospacedDigit()
                                .foregroundStyle(on ? Palette.onInk : Palette.ink)
                                .frame(maxWidth: .infinity, minHeight: 36)
                                .background(on ? Palette.ink : Palette.control, in: Capsule())
                                .padding(.horizontal, 2)
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(day) 日")
                        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
                    }
                }
            }
            .padding(.vertical, 4)
            ClockRow(title: "时间", time: clock(hour, minute) { .monthly(days: days, hour: $0, minute: $1) })
        case .weekly(let weekdays, let hour, let minute):
            WeekdayPills(selected: weekdays) { day in
                if weekdays == [day] { return }
                let next = weekdays.contains(day) ? weekdays.filter { $0 != day } : (1...7).filter { $0 == day || weekdays.contains($0) }
                Haptics.select()
                expression = Cron.expression(.weekly(weekdays: next, hour: hour, minute: minute))
            }
            ClockRow(title: "时间", time: clock(hour, minute) { .weekly(weekdays: weekdays, hour: $0, minute: $1) })
        case .daily(let hour, let minute):
            ClockRow(title: "时间", time: clock(hour, minute) { .daily(hour: $0, minute: $1) })
        case .hourly(let step, let minute):
            Stepper(value: Binding(get: { step }, set: { expression = Cron.expression(.hourly(step: $0, minute: minute)) }), in: 1...23) {
                LabeledContent("重复间隔", value: "每 \(step) 小时")
            }
            Stepper(value: Binding(get: { minute }, set: { expression = Cron.expression(.hourly(step: step, minute: $0)) }), in: 0...59) {
                LabeledContent("在第几分钟", value: "\(minute)")
            }
        case .minutely(let step):
            Stepper(value: Binding(get: { step }, set: { expression = Cron.expression(.minutely(step: $0)) }), in: 1...59) {
                LabeledContent("重复间隔", value: "每 \(step) 分钟")
            }
        case nil:
            TextField("Cron 表达式", text: $expression)
                .font(.callout.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(Cron.parse(expression) == nil ? Palette.removed : Palette.ink)
        }
    }

    private func choice(_ shape: CronShape) -> Choice {
        switch shape {
        case .monthly: .monthly
        case .weekly: .weekly
        case .daily: .daily
        case .hourly: .hourly
        case .minutely: .minutely
        }
    }

    private func clock(_ hour: Int, _ minute: Int, _ make: @escaping (Int, Int) -> CronShape) -> Binding<String> {
        Binding(get: { String(format: "%02d:%02d", hour, minute) }, set: { text in
            let fields = text.split(separator: ":").compactMap { Int($0) }
            guard fields.count >= 2 else { return }
            expression = Cron.expression(make(fields[0], fields[1]))
        })
    }

    /// A new shape keeps the current clock where it has one, else the occurrence's clock in the rule's zone.
    private func chooseShape(_ choice: Choice) {
        if choice == .raw { rawChosen = true; return }
        rawChosen = false
        if let shape, self.choice(shape) == choice { return }
        let at = task["scheduledAt"].string ?? ""
        let wall = Array(ZonedClock.wallClock(at, zone: timeZone))
        func field(_ range: ClosedRange<Int>) -> Int { wall.count > range.upperBound ? Int(String(wall[range])) ?? 0 : 0 }
        var minute = field(14...15)
        var hour = field(11...12)
        switch shape {
        case .hourly(_, let m): minute = m
        case .daily(let h, let m), .weekly(_, let h, let m), .monthly(_, let h, let m): hour = h; minute = m
        default: break
        }
        switch choice {
        case .minutely: expression = Cron.expression(.minutely(step: 5))
        case .hourly: expression = Cron.expression(.hourly(step: 1, minute: minute))
        case .daily: expression = Cron.expression(.daily(hour: hour, minute: minute))
        case .weekly: expression = Cron.expression(.weekly(weekdays: [ZonedClock.weekday(at, zone: timeZone)], hour: hour, minute: minute))
        case .monthly: expression = Cron.expression(.monthly(days: [field(8...9)].filter { (1...31).contains($0) }.ifEmpty([1]), hour: hour, minute: minute))
        case .raw: break
        }
    }
}

private extension Array {
    func ifEmpty(_ fallback: [Element]) -> [Element] { isEmpty ? fallback : self }
}

// MARK: Time zones

/// 时区 (B22): recently chosen zones, then every zone — the device's first,
/// the rest by current UTC offset and id; zones sharing a label share a row.
struct TimeZonePicker: View {
    let selection: String
    let choose: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var catalog: [Item] = []
    @State private var recent = RecentTimeZones.load()

    struct Item: Identifiable, Hashable {
        var id: String
        var label: String
        var zones: [String]
    }

    var body: some View {
        let needle = query.trimmed.lowercased()
        let matches = catalog.filter { needle.isEmpty || ($0.zones.joined(separator: " ") + " " + $0.label).lowercased().contains(needle) }
            .map { item -> Item in
                guard !needle.isEmpty else { return item }
                var named = item
                named.id = item.zones.first { $0.lowercased() == needle } ?? (item.zones.contains(selection) && selection.lowercased().contains(needle) ? selection : item.zones.first { $0.lowercased().contains(needle) } ?? item.id)
                return named
            }
        let recentItems: [Item] = needle.isEmpty ? recent.compactMap { zone in
            catalog.first { $0.zones.contains(zone) }.map { Item(id: zone, label: $0.label, zones: $0.zones) }
        }.reduce(into: []) { result, item in if !result.contains(where: { $0.label == item.label }) { result.append(item) } } : []
        let recentLabels = Set(recentItems.map(\.label))
        List {
            if !recentItems.isEmpty {
                Section("最近使用") { ForEach(recentItems) { row($0) } }
            }
            Section(needle.isEmpty ? "全部时区" : "") {
                ForEach(matches.filter { !recentLabels.contains($0.label) }) { row($0) }
            }
        }
        .groupedList()
        .overlay {
            if catalog.isEmpty { ProgressView() } else if matches.isEmpty { ContentUnavailableView("没有匹配的时区", systemImage: "globe") }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索 UTC 偏移、IANA 标识或城市")
        .navigationTitle("时区")
        .navigationBarTitleDisplayMode(.inline)
        .task { if catalog.isEmpty { catalog = await Self.build(stored: selection) } }
    }

    private func row(_ item: Item) -> some View {
        Button {
            recent = RecentTimeZones.remember(item.id)
            choose(item.id)
            dismiss()
        } label: {
            HStack {
                Text(item.label).foregroundStyle(Palette.ink)
                Spacer()
                if item.zones.contains(selection) { Image(systemName: "checkmark").foregroundStyle(Palette.ink) }
            }
        }
        .groupedRow()
    }

    /// `zoneChoices`, labelled and merged by label (the stored id stays the chosen one in its row).
    private static func build(stored: String) async -> [Item] {
        let system = ScheduleFormat.systemZone
        let now = Date.now
        var zones = Array(Set(["UTC", stored] + TimeZone.knownTimeZoneIdentifiers).subtracting([system, ""]))
        let offsets = Dictionary(uniqueKeysWithValues: zones.map { ($0, ScheduleFormat.zoneOffset($0, at: now) ?? .max) })
        zones.sort { offsets[$0]! != offsets[$1]! ? offsets[$0]! < offsets[$1]! : $0 < $1 }
        var items: [Item] = []
        var index: [String: Int] = [:]
        for zone in [system] + zones {
            let label = ScheduleFormat.zoneName(zone, at: now)
            if let at = index[label] {
                items[at].zones.append(zone)
                if zone == stored { items[at].id = zone }
            } else {
                index[label] = items.count
                items.append(Item(id: zone, label: label, zones: [zone]))
            }
        }
        return items
    }
}
