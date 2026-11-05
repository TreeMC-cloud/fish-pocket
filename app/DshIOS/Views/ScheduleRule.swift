import Foundation

// The Run time card's editing model, translated from the official TaskDetail
// (ruleValues, seedDraft, ruleChange, draftError, mergeRuleDraft…): what a
// draft holds, how switching the Repeat choice seeds it, and the
// `schedule/update` request it saves.

/// The Repeat choices a draft can stand for (`weekdays` saves a weekly rule).
enum RuleKind: String, Equatable {
    case once, every, daily, weekdays, weekly, cron

    /// Monday-to-Friday and weekly both store one Host weekly rule.
    var storedChoice: RuleKind { self == .weekdays ? .weekly : self }
    /// Choices stated with the clock and zone rows.
    var hasClock: Bool { self == .daily || self == .weekdays || self == .weekly }
}

/// The Repeat menu, in the web's order.
enum RuleChoice: String, CaseIterable, Identifiable {
    case weekly, weekdays, daily, everyHour, everyMinute, everySecond, once, cron
    var id: String { rawValue }

    var label: String {
        switch self {
        case .weekly: "每周"
        case .weekdays: "周一至周五"
        case .daily: "每天"
        case .everyHour: "每 N 小时"
        case .everyMinute: "每 N 分钟"
        case .everySecond: "每 N 秒"
        case .once: "仅一次"
        case .cron: "自定义"
        }
    }

    var kind: RuleKind {
        switch self {
        case .weekly: .weekly
        case .weekdays: .weekdays
        case .daily: .daily
        case .everyHour, .everyMinute, .everySecond: .every
        case .once: .once
        case .cron: .cron
        }
    }

    var unit: IntervalUnit? {
        switch self {
        case .everyHour: .hour
        case .everyMinute: .minute
        case .everySecond: .second
        default: nil
        }
    }

    static func of(_ kind: RuleKind, unit: IntervalUnit) -> RuleChoice {
        switch kind {
        case .weekly: .weekly
        case .weekdays: .weekdays
        case .daily: .daily
        case .every: unit == .hour ? .everyHour : unit == .minute ? .everyMinute : .everySecond
        case .once: .once
        case .cron: .cron
        }
    }
}

enum IntervalUnit: String {
    case hour, minute, second

    var seconds: Int {
        switch self {
        case .hour: 3600
        case .minute: 60
        case .second: 1
        }
    }

    var label: String {
        switch self {
        case .hour: "小时"
        case .minute: "分钟"
        case .second: "秒"
        }
    }

    /// The smallest value the row accepts (the Host's floor is 60 s).
    var minimum: Int { Int((60.0 / Double(seconds)).rounded(.up)) }

    var hint: String {
        switch self {
        case .hour: "至少 1 小时。间隔自任务创建或上次修改规则时起计，不受时区影响"
        case .minute: "至少 1 分钟。间隔自任务创建或上次修改规则时起计，不受时区影响"
        case .second: "至少 60 秒。间隔自任务创建或上次修改规则时起计，不受时区影响"
        }
    }

    var invalid: String {
        switch self {
        case .hour: "请输入至少 1 小时的间隔"
        case .minute: "请输入至少 1 分钟的间隔"
        case .second: "请输入至少 60 秒的间隔"
        }
    }

    /// The largest unit that states a whole-second interval exactly.
    static func preferred(_ seconds: String) -> IntervalUnit {
        guard let value = Int(seconds), value > 0 else { return .second }
        if value % 3600 == 0 { return .hour }
        if value % 60 == 0 { return .minute }
        return .second
    }
}

/// The clock of a `HH:mm[:ss[.SSS]]` value. The form picks hours and minutes only;
/// the rest of a stored value goes back unchanged.
enum ClockText {
    static func fields(_ time: String) -> (hour: Int, minute: Int) {
        let parts = time.split(separator: ":").map { Int($0.prefix(2)) ?? 0 }
        return (parts.first ?? 0, parts.dropFirst().first ?? 0)
    }

    static func replacing(_ time: String, hour: Int, minute: Int) -> String {
        let rest = time.split(separator: ":", maxSplits: 2).dropFirst(2).first.map { ":\($0)" } ?? ""
        return String(format: "%02d:%02d", hour, minute) + rest
    }
}

/// Native input values of the card, kept as the web keeps them: ISO date, `HH:mm[:ss[.SSS]]`, IANA zone, seconds and cron as text.
struct RuleDraft: Equatable {
    var date = ""
    var time = ""
    var timeZone = ""
    var seconds = ""
    var expression = ""
}

struct RuleValues: Equatable {
    var title: String
    var prompt: String
    var kind: RuleKind
    var draft: RuleDraft
    var weekdays: [Int]

    /// Changes exactly when a staged timing value changes.
    var timingKey: [String] {
        [kind.rawValue, draft.date, draft.time, draft.timeZone, draft.seconds, draft.expression, weekdays.map(String.init).joined(separator: ",")]
    }

    /// Changes exactly when any shown value changes (texts compare trimmed, as the Host stores them).
    var key: [String] { [title.trimmed, prompt.trimmed] + timingKey }
}

enum ScheduleRule {
    static let weekdayRule = [1, 2, 3, 4, 5]
    static let titleLimit = 120

    static func isWeekdayRule(_ weekdays: [Int]) -> Bool {
        weekdays.count == weekdayRule.count && weekdayRule.allSatisfy(weekdays.contains)
    }

    static func kind(of record: JSON) -> RuleKind {
        switch record["kind"].string {
        case "every": return .every
        case "daily": return .daily
        case "weekly": return isWeekdayRule(record["weekdays"].array.compactMap(\.int)) ? .weekdays : .weekly
        case "cron": return .cron
        default: return .once
        }
    }

    /// The zone a draft starts in: the stored rule's, or the device's when the rule stores none (one-shot, interval).
    static func draftZone(_ record: JSON) -> (zone: String, stored: Bool) {
        if let zone = record["timeZone"].string { return (zone, true) }
        return (ScheduleFormat.systemZone, false)
    }

    static func timingDraft(_ record: JSON) -> RuleDraft {
        switch record["kind"].string {
        case "at", "after":
            let zone = draftZone(record).zone
            let clock = ZonedClock.wallClock(record["scheduledAt"].string ?? "", zone: zone)
            return RuleDraft(date: String(clock.prefix(10)), time: clock.count >= 23 ? String(clock.dropFirst(11).prefix(12)) : "", timeZone: zone)
        case "every":
            return RuleDraft(seconds: String(record["everySeconds"].int ?? 0))
        case "daily", "weekly":
            return RuleDraft(time: record["time"].string ?? "", timeZone: record["timeZone"].string ?? "")
        case "cron":
            return RuleDraft(timeZone: record["timeZone"].string ?? "", expression: record["expression"].string ?? "")
        default:
            return RuleDraft()
        }
    }

    static func values(_ record: JSON) -> RuleValues {
        RuleValues(title: record["title"].string ?? "", prompt: record["prompt"].string ?? "", kind: kind(of: record), draft: timingDraft(record), weekdays: seedWeekdays(record))
    }

    /// Values a rule gets when it switches to `kind`, seeded from its committed occurrence.
    static func seedDraft(_ record: JSON, _ kind: RuleKind) -> RuleDraft {
        let zone = draftZone(record).zone
        let clock = ZonedClock.wallClock(record["scheduledAt"].string ?? "", zone: zone)
        let time = clock.count >= 23 ? String(clock.dropFirst(11).prefix(12)) : "09:00:00.000"
        switch kind {
        case .once: return RuleDraft(date: String(clock.prefix(10)), time: time, timeZone: zone)
        case .every: return RuleDraft(seconds: "3600")
        case .daily, .weekdays, .weekly: return RuleDraft(time: time, timeZone: zone)
        case .cron: return RuleDraft(timeZone: zone, expression: seedCronExpression(record, zone: zone))
        }
    }

    /// The occurrence's clock in `zone` as a daily expression.
    static func seedCronExpression(_ record: JSON, zone: String) -> String {
        let clock = Array(ZonedClock.wallClock(record["scheduledAt"].string ?? "", zone: zone))
        guard clock.count >= 16, let hour = Int(String(clock[11...12])), let minute = Int(String(clock[14...15])) else { return "0 9 * * *" }
        return "\(minute) \(hour) * * *"
    }

    static func seedWeekdays(_ record: JSON) -> [Int] {
        if record["kind"].string == "weekly" { return record["weekdays"].array.compactMap(\.int) }
        return [ZonedClock.weekday(record["scheduledAt"].string ?? "", zone: draftZone(record).zone)]
    }

    private static func withSeconds(_ time: String) -> String { time.count == 5 ? time + ":00" : time }

    /// The `change` of a `schedule/update` (snake_case inside, as the Host reads it).
    static func change(_ draft: RuleDraft, _ kind: RuleKind, _ weekdays: [Int]) -> JSON {
        let zone = JSON.string(draft.timeZone.trimmed)
        switch kind {
        case .once:
            return ["kind": "at", "at": ["date": .string(draft.date), "time": .string(withSeconds(draft.time)), "time_zone": zone]]
        case .every:
            return ["kind": "every", "every_seconds": .number(Double(draft.seconds) ?? 0)]
        case .daily:
            return ["kind": "daily", "daily": ["time": .string(withSeconds(draft.time)), "time_zone": zone]]
        case .cron:
            return ["kind": "cron", "cron": ["expression": .string(draft.expression.trimmed), "time_zone": zone]]
        case .weekdays, .weekly:
            let days = kind == .weekdays ? weekdayRule : weekdays
            return ["kind": "weekly", "weekly": ["time": .string(withSeconds(draft.time)), "time_zone": zone, "weekdays": .array(days.map { .number(Double($0)) })]]
        }
    }

    static func validIsoDate(_ value: String) -> Bool {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return false }
        guard let date = ZonedClock.day(value, zone: "UTC") else { return false }
        return ZonedClock.dayText(date, zone: "UTC") == value
    }

    /// Local validation before a save; the message of the first invalid field.
    static func draftError(_ shown: RuleValues, unit: IntervalUnit) -> String? {
        let title = shown.title.trimmed
        if title.isEmpty || title.count > titleLimit { return "请输入不超过 120 个字符的任务名称" }
        if shown.prompt.trimmed.isEmpty { return "请输入任务内容" }
        if shown.kind == .every {
            let valid = shown.draft.seconds.range(of: #"^\d+$"#, options: .regularExpression) != nil && (Int(shown.draft.seconds) ?? 0) >= 60
            return valid ? nil : unit.invalid
        }
        if shown.kind == .cron { return Cron.parse(shown.draft.expression) == nil ? cronInvalid : nil }
        if (shown.kind == .once && !validIsoDate(shown.draft.date)) || shown.draft.time.range(of: #"^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$"#, options: .regularExpression) == nil {
            return "请输入有效的日期和时间，或检查时间字段"
        }
        return nil
    }

    static let cronInvalid = "请输入 5 字段的 cron 表达式，例如 0 9 * * 1-5"

    /// Name and instruction to send, each only when it differs from the stored value.
    static func contentChange(_ shown: RuleValues, _ stored: RuleValues) -> [String: JSON] {
        var content: [String: JSON] = [:]
        if shown.title.trimmed != stored.title { content["title"] = .string(shown.title.trimmed) }
        if shown.prompt.trimmed != stored.prompt { content["prompt"] = .string(shown.prompt.trimmed) }
        return content
    }

    /// `active` is the only status that still has a timer; 0.2.2 split the rest
    /// into `paused` and `ended`.
    static func isArmed(_ record: JSON) -> Bool { (record["status"].string ?? "active") == "active" }

    /// Rule kinds this editor can represent. 0.2.2 added `rrule`, which it cannot:
    /// those rules stay read-only rather than being rewritten on save.
    static func editableKind(_ record: JSON) -> Bool {
        ["after", "at", "every", "daily", "weekly", "cron"].contains(record["kind"].string ?? "at")
    }

    /// A rejected update, in the card's words (`ruleError`).
    static func errorMessage(_ code: String, unit: IntervalUnit) -> String {
        switch code {
        case "schedule_conflict": return "任务在保存前已发生变化。当前显示已保存的规则，请重试"
        case "schedule_not_found": return "此任务当前不可用"
        case "subagent_session": return "此会话属于子 agent，永远不会收到投递的提醒"
        case "invalid_time_zone": return "请输入有效的 IANA 时区，例如 Asia/Shanghai"
        case "not_future": return "请选择未来的日期和时间"
        case "frequency_too_high": return unit.invalid
        case "invalid_prompt", "invalid_selector", "invalid_rule", "time_out_of_range": return "请输入有效的日期和时间，或检查时间字段"
        default: return unknownError
        }
    }

    static let unknownError = "无法确认规则是否已更新。当前显示已保存的规则"

    /// Merge a refreshed record into a staged draft: fields the user changed keep
    /// the draft, untouched ones take the refreshed record (`mergeRuleDraft`).
    static func merge(_ authoritative: RuleValues, draft: RuleValues, stored: RuleValues) -> RuleValues {
        func text(_ draft: String, _ stored: String, _ fresh: String) -> String { draft.trimmed == stored.trimmed ? fresh : draft }
        func value<T: Equatable>(_ draft: T, _ stored: T, _ fresh: T) -> T { draft == stored ? fresh : draft }
        let title = text(draft.title, stored.title, authoritative.title)
        let prompt = text(draft.prompt, stored.prompt, authoritative.prompt)
        if draft.kind.storedChoice != stored.kind.storedChoice {
            var merged = draft; merged.title = title; merged.prompt = prompt; return merged
        }
        if authoritative.kind.storedChoice != stored.kind.storedChoice {
            var merged = draft.draft != stored.draft || draft.weekdays != stored.weekdays ? draft : authoritative
            merged.title = title; merged.prompt = prompt
            return merged
        }
        let weekdays = draft.weekdays == stored.weekdays ? authoritative.weekdays : draft.weekdays
        let staged = draft.kind != stored.kind || draft.weekdays != stored.weekdays
        let kind: RuleKind = draft.kind.storedChoice == .weekly
            ? (staged ? draft.kind : isWeekdayRule(weekdays) ? .weekdays : .weekly)
            : value(draft.kind, stored.kind, authoritative.kind)
        let merged = RuleDraft(
            date: value(draft.draft.date, stored.draft.date, authoritative.draft.date),
            time: value(draft.draft.time, stored.draft.time, authoritative.draft.time),
            timeZone: value(draft.draft.timeZone, stored.draft.timeZone, authoritative.draft.timeZone),
            seconds: value(draft.draft.seconds, stored.draft.seconds, authoritative.draft.seconds),
            expression: value(draft.draft.expression, stored.draft.expression, authoritative.draft.expression)
        )
        return RuleValues(title: title, prompt: prompt, kind: kind, draft: merged, weekdays: weekdays)
    }
}

/// Recently chosen zones (`dsh.schedule.recent-time-zones.v1`): at most five, newest first.
enum RecentTimeZones {
    private static let key = "dsh.schedule.recent-time-zones.v1"

    static func load() -> [String] {
        let saved = (UserDefaults.standard.stringArray(forKey: key) ?? []).filter { !$0.isEmpty }
        if saved.isEmpty { return Array(NSOrderedSet(array: [ScheduleFormat.systemZone, "UTC"])) as? [String] ?? ["UTC"] }
        return Array(saved.prefix(5))
    }

    @discardableResult
    static func remember(_ zone: String) -> [String] {
        let next = Array(([zone] + load().filter { $0 != zone }).prefix(5))
        UserDefaults.standard.set(next, forKey: key)
        return next
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
