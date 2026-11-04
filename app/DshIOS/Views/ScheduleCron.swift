import Foundation

// Schedule texts and pure helpers, translated from the official
// `dsh-client-ui-schedule` client (task-cron.js, schedule-format.js,
// task-timing.js) so the native card parses, describes and formats rules the
// same way the web one does.

/// The `schedule.manager` copy (with the shared frequency fragments) this app uses, zh only like the rest of the UI.
enum ScheduleText {
    static let locale = Locale(identifier: "zh-CN")

    static func t(_ key: String, _ params: [String: Any] = [:]) -> String {
        var text = zh[key] ?? key
        for (name, value) in params { text = text.replacingOccurrences(of: "{\(name)}", with: "\(value)") }
        return text
    }

    private static let zh: [String: String] = [
        "frequency.once": "仅一次",
        "frequency.every": "每 {value} {unit}",
        "frequency.daily": "每天 {time}（{timeZone}）",
        "frequency.dailyLocal": "每天 {time}",
        "frequency.weekly": "每周{weekdays} {time}（{timeZone}）",
        "frequency.weeklyLocal": "每周{weekdays} {time}",
        "frequency.cron": "Cron {expression}（{timeZone}）",
        "frequency.cronLocal": "Cron {expression}",
        "frequency.cronRule": "{rule}（{timeZone}）",
        "cron.list.join": "、",
        "cron.part.join": " ",
        "cron.weekday.name": "周{weekday}",
        "cron.weekday.range": "{from}至{to}",
        "cron.months": "（{months}）",
        "cron.day.every": "每天{months}",
        "cron.day.weekdays": "{weekdays}{months}",
        "cron.day.monthDays": "每月 {days} 日{months}",
        "cron.day.both": "每月 {days} 日或{weekdays}{months}",
        "cron.day.bothStarred": "每月 {days} 日且{weekdays}{months}",
        "cron.hours.range": "{from} 至 {to}",
        "cron.hours.list": "{hours}",
        "cron.time.everyMinute": "每分钟",
        "cron.time.everyMinutes": "每 {step} 分钟",
        "cron.time.joinedEveryMinute": "每分钟",
        "cron.time.joinedEveryMinutes": "每 {step} 分钟",
        "cron.time.everyHour": "每小时",
        "cron.time.joinedEveryHour": "每小时",
        "cron.time.everyNHours": "每 {count} 小时",
        "cron.time.joinedEveryNHours": "每 {count} 小时",
        "cron.time.hourlyAt": "每小时的第 {minutes} 分钟",
        "cron.time.joinedHourlyAt": "每小时的第 {minutes} 分钟",
        "cron.time.hoursEveryMinute": "{hours} 点的每分钟",
        "cron.time.hoursEveryMinutes": "{hours} 点内每 {step} 分钟",
        "cron.time.at": "{times}",
        "cron.time.hoursAt": "{hours} 点的第 {minutes} 分钟",
        "frequency.weekday.join": "、",
        "frequency.weekday.1": "一",
        "frequency.weekday.2": "二",
        "frequency.weekday.3": "三",
        "frequency.weekday.4": "四",
        "frequency.weekday.5": "五",
        "frequency.weekday.6": "六",
        "frequency.weekday.7": "日",
        "unit.day": "天",
        "unit.hour": "小时",
        "unit.minute": "分钟",
        "unit.second": "秒",
        "relative.now": "现在到期",
        "relative.future": "{value}{unit}后",
        "relative.overdue": "已逾期 {value}{unit}",
        "rule.zone.system": "（系统）",
    ]
}

// MARK: Cron (task-cron.js)

/// One parsed field: matched values (Sunday folded to 0), whether it was written with a star, whether it matches all.
struct CronField: Equatable {
    var values: [Int]
    var starred: Bool
    var full: Bool
    var unrestricted: Bool { starred && full }
}

struct CronParsed: Equatable {
    var minutes: CronField
    var hours: CronField
    var daysOfMonth: CronField
    var months: CronField
    var daysOfWeek: CronField
}

/// The structured shapes the cron builder edits.
enum CronShape: Equatable {
    case minutely(step: Int)
    case hourly(step: Int, minute: Int)
    case daily(hour: Int, minute: Int)
    /// ISO weekdays, Monday 1 … Sunday 7.
    case weekly(weekdays: [Int], hour: Int, minute: Int)
    case monthly(days: [Int], hour: Int, minute: Int)
}

enum Cron {
    private struct Spec { let min: Int; let max: Int; let count: Int; var foldMax: Int? = nil }

    /// `minute hour day-of-month month day-of-week`.
    private static let fields = [
        Spec(min: 0, max: 59, count: 60),
        Spec(min: 0, max: 23, count: 24),
        Spec(min: 1, max: 31, count: 31),
        Spec(min: 1, max: 12, count: 12),
        Spec(min: 0, max: 7, count: 7, foldMax: 7),
    ]
    private static let timeListLimit = 6
    private static let maxSafeInteger = 9_007_199_254_740_991

    private static func range(_ from: Int, _ to: Int, _ step: Int) -> [Int] {
        guard from <= to else { return [] }
        return Array(stride(from: from, through: to, by: step))
    }

    /// ASCII digits as a safe integer (JS `Number` on `\d+`).
    private static func digits(_ text: Substring) -> Int? {
        guard !text.isEmpty, text.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        guard let value = Int(text), value <= maxSafeInteger else { return nil }
        return value
    }

    private static func value(_ text: Substring, _ spec: Spec) -> Int? {
        guard let value = digits(text), value >= spec.min, value <= spec.max else { return nil }
        return value
    }

    private static func step(_ text: Substring) -> Int? {
        guard let value = digits(text), value >= 1 else { return nil }
        return value
    }

    private static func elementValues(_ element: Substring, _ spec: Spec) -> [Int]? {
        if element.isEmpty { return nil }
        if element == "*" { return range(spec.min, spec.max, 1) }
        if element.hasPrefix("*") {
            // Only `*/n`.
            guard element.hasPrefix("*/"), let step = step(element.dropFirst(2)) else { return nil }
            return range(spec.min, spec.max, step)
        }
        // `a`, `a-b`, `a-b/n` (a bare `a/n` is rejected, as on the Host).
        var body = element
        var stepText: Substring?
        if let slash = body.firstIndex(of: "/") {
            stepText = body[body.index(after: slash)...]
            body = body[..<slash]
        }
        let parts = body.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 1 || parts.count == 2, let start = value(parts[0], spec) else { return nil }
        if parts.count == 1 {
            // Still has to look like the fixed regex: digits only, and no step.
            return stepText == nil ? [start] : nil
        }
        guard let last = value(parts[1], spec), start <= last else { return nil }
        if let stepText {
            guard let step = step(stepText) else { return nil }
            return range(start, last, step)
        }
        return range(start, last, 1)
    }

    private static func fieldValues(_ raw: Substring, _ spec: Spec) -> [Int]? {
        var matched = Set<Int>()
        for element in raw.split(separator: ",", omittingEmptySubsequences: false) {
            guard let values = elementValues(element, spec) else { return nil }
            for value in values { matched.insert(value == spec.foldMax ? spec.min : value) }
        }
        return matched.sorted()
    }

    /// The Host's five-field dialect; nil when the Host would reject the expression.
    static func parse(_ expression: String) -> CronParsed? {
        if expression.isEmpty || expression.trimmingCharacters(in: .whitespacesAndNewlines) != expression { return nil }
        let raw = expression.split(whereSeparator: { $0.isWhitespace })
        guard raw.count == 5 else { return nil }
        var parsed: [CronField] = []
        for (index, field) in raw.enumerated() {
            let spec = fields[index]
            guard let values = fieldValues(field, spec) else { return nil }
            parsed.append(CronField(values: values, starred: field.hasPrefix("*"), full: values.count == spec.count))
        }
        return CronParsed(minutes: parsed[0], hours: parsed[1], daysOfMonth: parsed[2], months: parsed[3], daysOfWeek: parsed[4])
    }

    private static func two(_ value: Int) -> String { value < 10 ? "0\(value)" : String(value) }

    private static func runs(_ values: [Int]) -> [[Int]] {
        var runs: [[Int]] = []
        for value in values {
            if let last = runs.last?.last, last + 1 == value { runs[runs.count - 1].append(value) } else { runs.append([value]) }
        }
        return runs
    }

    private static func numberList(_ values: [Int]) -> String {
        values.map(String.init).joined(separator: ScheduleText.t("cron.list.join"))
    }

    private static func weekdayText(_ values: [Int]) -> String {
        let join = ScheduleText.t("cron.list.join")
        let name = { (day: Int) in ScheduleText.t("cron.weekday.name", ["weekday": ScheduleText.t("frequency.weekday.\(day)")]) }
        return runs(values.map { $0 == 0 ? 7 : $0 }.sorted()).map { run in
            run.count >= 3
                ? ScheduleText.t("cron.weekday.range", ["from": name(run[0]), "to": name(run[run.count - 1])])
                : run.map(name).joined(separator: join)
        }.joined(separator: join)
    }

    private static func monthSuffix(_ values: [Int]) -> String {
        if values.count == 12 { return "" }
        // `Intl.DateTimeFormat("zh-CN", {month: "long"})` names them 一月…十二月.
        let names = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"]
        return ScheduleText.t("cron.months", ["months": values.map { names[$0 - 1] }.joined(separator: ScheduleText.t("cron.list.join"))])
    }

    private static func dayText(_ parsed: CronParsed) -> (everyDay: Bool, text: String) {
        let months = monthSuffix(parsed.months.values)
        let params: [String: Any] = ["days": numberList(parsed.daysOfMonth.values), "weekdays": weekdayText(parsed.daysOfWeek.values), "months": months]
        let dom = parsed.daysOfMonth, dow = parsed.daysOfWeek
        if dom.starred || dow.starred {
            if dom.full && dow.full { return (months.isEmpty, ScheduleText.t("cron.day.every", ["months": months])) }
            if dom.full { return (false, ScheduleText.t("cron.day.weekdays", params)) }
            if dow.full { return (false, ScheduleText.t("cron.day.monthDays", params)) }
            return (false, ScheduleText.t("cron.day.bothStarred", params))
        }
        if dom.full || dow.full { return (months.isEmpty, ScheduleText.t("cron.day.every", ["months": months])) }
        return (false, ScheduleText.t("cron.day.both", params))
    }

    private static func hourText(_ values: [Int]) -> String {
        let hours = values.map(two)
        if hours.count >= 2, values[values.count - 1] - values[0] == values.count - 1 {
            return ScheduleText.t("cron.hours.range", ["from": hours[0], "to": hours[hours.count - 1]])
        }
        return ScheduleText.t("cron.hours.list", ["hours": hours.joined(separator: ScheduleText.t("cron.list.join"))])
    }

    /// The uniform step of values covering a whole field from its minimum, else nil.
    static func fullRangeStep(_ values: [Int], _ min: Int, _ max: Int) -> Int? {
        guard values.count >= 2, values[0] == min else { return nil }
        let step = values[1] - values[0]
        for index in 1..<values.count where values[index] - values[index - 1] != step { return nil }
        return values[values.count - 1] + step > max ? step : nil
    }

    private static func timeText(_ parsed: CronParsed) -> (interval: Bool, text: String, joined: String) {
        let t = ScheduleText.t
        let step = parsed.minutes.unrestricted ? nil : fullRangeStep(parsed.minutes.values, 0, 59)
        if parsed.hours.unrestricted {
            if parsed.minutes.unrestricted { return (true, t("cron.time.everyMinute", [:]), t("cron.time.joinedEveryMinute", [:])) }
            if let step, step >= 2 { return (true, t("cron.time.everyMinutes", ["step": step]), t("cron.time.joinedEveryMinutes", ["step": step])) }
            if parsed.minutes.values == [0] { return (true, t("cron.time.everyHour", [:]), t("cron.time.joinedEveryHour", [:])) }
            let minutes = numberList(parsed.minutes.values)
            return (false, t("cron.time.hourlyAt", ["minutes": minutes]), t("cron.time.joinedHourlyAt", ["minutes": minutes]))
        }
        let hours = hourText(parsed.hours.values)
        if parsed.minutes.unrestricted {
            let text = t("cron.time.hoursEveryMinute", ["hours": hours])
            return (false, text, text)
        }
        if let step, step >= 2 {
            let text = t("cron.time.hoursEveryMinutes", ["hours": hours, "step": step])
            return (false, text, text)
        }
        if parsed.minutes.values == [0], let hourStep = fullRangeStep(parsed.hours.values, 0, 23), hourStep >= 2 {
            return (true, t("cron.time.everyNHours", ["count": hourStep]), t("cron.time.joinedEveryNHours", ["count": hourStep]))
        }
        let times = parsed.hours.values.flatMap { hour in parsed.minutes.values.map { "\(two(hour)):\(two($0))" } }
        let text = times.count <= timeListLimit
            ? t("cron.time.at", ["times": times.joined(separator: t("cron.list.join", [:]))])
            : t("cron.time.hoursAt", ["hours": hours, "minutes": numberList(parsed.minutes.values)])
        return (false, text, text)
    }

    /// One sentence for the rule, e.g. `周一至周五 09:00` or `每 15 分钟`.
    static func preview(_ parsed: CronParsed) -> String {
        let day = dayText(parsed)
        let time = timeText(parsed)
        return day.everyDay && time.interval ? time.text : [day.text, time.joined].joined(separator: ScheduleText.t("cron.part.join"))
    }

    /// The structured shape an expression states, or nil for the raw-expression fallback.
    static func shape(_ parsed: CronParsed) -> CronShape? {
        guard parsed.months.full else { return nil }
        let minuteStep = parsed.minutes.unrestricted ? 1 : fullRangeStep(parsed.minutes.values, 0, 59)
        let hourStep = parsed.hours.unrestricted ? 1 : fullRangeStep(parsed.hours.values, 0, 23)
        let minute = parsed.minutes.values.count == 1 ? parsed.minutes.values[0] : nil
        let hour = parsed.hours.values.count == 1 ? parsed.hours.values[0] : nil
        if parsed.daysOfWeek.unrestricted {
            if parsed.daysOfMonth.unrestricted {
                if let minuteStep, parsed.hours.full { return .minutely(step: minuteStep) }
                if let minute, let hourStep { return .hourly(step: hourStep, minute: minute) }
                if let minute, let hour { return .daily(hour: hour, minute: minute) }
                return nil
            }
            guard let minute, let hour else { return nil }
            return .monthly(days: parsed.daysOfMonth.values, hour: hour, minute: minute)
        }
        guard parsed.daysOfMonth.unrestricted, let minute, let hour else { return nil }
        return .weekly(weekdays: parsed.daysOfWeek.values.map { $0 == 0 ? 7 : $0 }.sorted(), hour: hour, minute: minute)
    }

    private static func runField(_ values: [Int]) -> String {
        runs(values).map { $0.count >= 3 ? "\($0[0])-\($0[$0.count - 1])" : $0.map(String.init).joined(separator: ",") }.joined(separator: ",")
    }

    /// The expression a builder shape saves; `shape` recognizes it as the same shape.
    static func expression(_ shape: CronShape) -> String {
        switch shape {
        case .minutely(let step): return step == 1 ? "* * * * *" : "*/\(step) * * * *"
        case .hourly(let step, let minute): return step == 1 ? "\(minute) * * * *" : "\(minute) */\(step) * * *"
        case .daily(let hour, let minute): return "\(minute) \(hour) * * *"
        case .weekly(let weekdays, let hour, let minute):
            return "\(minute) \(hour) * * \(runField(Set(weekdays.map { $0 % 7 }).sorted()))"
        case .monthly(let days, let hour, let minute):
            return "\(minute) \(hour) \(runField(Set(days).sorted())) * *"
        }
    }
}

// MARK: Formatting (schedule-format.js)

enum ScheduleFormat {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()

    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return fractional.date(from: iso) ?? plain.date(from: iso)
    }

    static var systemZone: String { TimeZone.current.identifier }

    /// `09:00:00.000` → `09:00`, `09:30:15` stays.
    static func clockLabel(_ time: String) -> String {
        var text = time
        if let dot = text.lastIndex(of: "."), case let rest = text[text.index(after: dot)...], !rest.isEmpty, rest.allSatisfy(\.isNumber) { text = String(text[..<dot]) }
        if text.hasSuffix(":00"), text.count > 5 { text.removeLast(3) }
        return text
    }

    static func zoneOffset(_ zone: String, at date: Date = .now) -> Int? {
        TimeZone(identifier: zone).map { $0.secondsFromGMT(for: date) / 60 }
    }

    static func zoneOffsetLabel(_ zone: String, at date: Date = .now) -> String? {
        guard let minutes = zoneOffset(zone, at: date) else { return nil }
        let absolute = abs(minutes)
        return String(format: "UTC%@%02d:%02d", minutes < 0 ? "-" : "+", absolute / 60, absolute % 60)
    }

    /// `UTC+08:00 · 中国标准时间`; just the offset when the system only knows a GMT name.
    static func zoneLabel(_ zone: String, at date: Date = .now) -> String {
        let offset = zoneOffsetLabel(zone, at: date)
        let name = TimeZone(identifier: zone)?.localizedName(for: .generic, locale: ScheduleText.locale)
        guard let offset else { return name ?? zone }
        guard let name, !name.hasPrefix("GMT") else { return offset }
        return "\(offset) · \(name)"
    }

    static func zoneName(_ zone: String, at date: Date = .now) -> String {
        let label = zoneLabel(zone, at: date)
        return zone == systemZone ? label + ScheduleText.t("rule.zone.system") : label
    }

    private static func weekdays(_ values: [Int]) -> String {
        values.map { ScheduleText.t("frequency.weekday.\(min(max($0, 1), 7))") }.joined(separator: ScheduleText.t("frequency.weekday.join"))
    }

    /// The rule as text. `omitSystemZone` leaves out a stored zone equal to the device's
    /// (the list and the detail); without it the zone is always named (session surfaces).
    static func frequency(_ record: JSON, omitSystemZone: Bool = true) -> String {
        let zone = record["timeZone"].string ?? "UTC"
        let local = omitSystemZone && zone == systemZone
        switch record["kind"].string {
        case "after", "at":
            return ScheduleText.t("frequency.once")
        case "cron":
            let expression = record["expression"].string ?? ""
            if let parsed = Cron.parse(expression) {
                let rule = Cron.preview(parsed)
                return local ? rule : ScheduleText.t("frequency.cronRule", ["rule": rule, "timeZone": zoneLabel(zone)])
            }
            return local ? ScheduleText.t("frequency.cronLocal", ["expression": expression]) : ScheduleText.t("frequency.cron", ["expression": expression, "timeZone": zoneLabel(zone)])
        case "daily":
            let time = clockLabel(record["time"].string ?? "")
            return local ? ScheduleText.t("frequency.dailyLocal", ["time": time]) : ScheduleText.t("frequency.daily", ["time": time, "timeZone": zoneLabel(zone)])
        case "weekly":
            let params: [String: Any] = ["weekdays": weekdays(record["weekdays"].array.compactMap(\.int)), "time": clockLabel(record["time"].string ?? "")]
            return local ? ScheduleText.t("frequency.weeklyLocal", params) : ScheduleText.t("frequency.weekly", params.merging(["timeZone": zoneLabel(zone)]) { $1 })
        case "every":
            let seconds = record["everySeconds"].int ?? 0
            let unit = [("day", 86400), ("hour", 3600), ("minute", 60)].first { seconds > 0 && seconds % $0.1 == 0 } ?? ("second", 1)
            return ScheduleText.t("frequency.every", ["value": seconds / unit.1, "unit": ScheduleText.t("unit.\(unit.0)")])
        default:
            return ""
        }
    }

    /// The zone a record's rule is stated in (daily / weekly / cron); one-shot and interval rules store none.
    static func recordZone(_ record: JSON) -> String? {
        switch record["kind"].string {
        case "daily", "weekly", "cron": return record["timeZone"].string
        default: return nil
        }
    }

    /// A delivery's time in the task's zone (or the device's): `11月4日 09:00`, the year only when it is not this year's.
    static func occurrence(_ iso: String, timeZone: String? = nil) -> String {
        guard let date = date(iso) else { return iso }
        let zone = timeZone.flatMap(TimeZone.init(identifier:)) ?? .current
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: .now)
        let formatter = DateFormatter()
        formatter.locale = ScheduleText.locale
        formatter.timeZone = zone
        formatter.setLocalizedDateFormatFromTemplate(sameYear ? "MMMdjmm" : "yMMMdjmm")
        return formatter.string(from: date)
    }

    /// A target in the device's zone, 24-hour, without the year (zh): `11月4日 09:00`.
    static func absolute(_ iso: String) -> String {
        guard let date = date(iso) else { return iso }
        let formatter = DateFormatter()
        formatter.locale = ScheduleText.locale
        formatter.setLocalizedDateFormatFromTemplate("MMMdHHmm")
        return formatter.string(from: date)
    }

    /// `3小时后` / `已逾期 5分钟` / `现在到期`, in the largest whole unit.
    static func relative(_ iso: String, now: Date = .now) -> String {
        guard let date = date(iso) else { return "" }
        let difference = (date.timeIntervalSince1970 - now.timeIntervalSince1970) * 1000
        if difference.rounded() == 0 { return ScheduleText.t("relative.now") }
        let seconds = abs(difference) / 1000
        let unit = [("day", 86400.0), ("hour", 3600.0), ("minute", 60.0)].first { seconds >= $0.1 } ?? ("second", 1.0)
        let value = max(1, Int(difference > 0 ? (seconds / unit.1).rounded(.up) : (seconds / unit.1).rounded(.down)))
        return ScheduleText.t(difference > 0 ? "relative.future" : "relative.overdue", ["value": value, "unit": ScheduleText.t("unit.\(unit.0)")])
    }

    /// `11月4日 09:00 (3小时后)`.
    static func nextRun(_ iso: String, now: Date = .now) -> String {
        "\(absolute(iso)) (\(relative(iso, now: now)))"
    }
}

// MARK: Zoned wall clock (task-timing.js)

enum ZonedClock {
    private static func calendar(_ zone: String) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone) ?? TimeZone(identifier: "UTC")!
        return calendar
    }

    /// `YYYY-MM-DDTHH:MM:SS.mmm` of an instant in a zone; empty when the instant does not parse.
    static func wallClock(_ iso: String, zone: String) -> String {
        guard let date = ScheduleFormat.date(iso) else { return "" }
        let parts = calendar(zone).dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let millis = Int((date.timeIntervalSince1970 * 1000).rounded()) % 1000
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, (millis + 1000) % 1000)
    }

    /// ISO weekday (Monday 1 … Sunday 7) of an instant in a zone.
    static func weekday(_ iso: String, zone: String) -> Int {
        let date = ScheduleFormat.date(iso) ?? .now
        let weekday = calendar(zone).component(.weekday, from: date)
        return (weekday + 5) % 7 + 1
    }

    /// `date` (`YYYY-MM-DD`) at `00:00` in a zone, for the date picker.
    static func day(_ text: String, zone: String) -> Date? {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar(zone).date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    static func dayText(_ date: Date, zone: String) -> String {
        let parts = calendar(zone).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
}
