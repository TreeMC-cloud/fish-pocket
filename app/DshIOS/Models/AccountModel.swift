import Foundation
import Observation
import SwiftUI

/// A bonus the Platform has credited but the user has not been shown yet.
struct BonusNotice: Identifiable, Hashable {
    let accountId: String
    let orderId: String
    let title: String
    let message: String
    let expiresAt: Date?
    var id: String { orderId }

    var expired: Bool { expiresAt.map { $0 <= Date() } ?? false }
}

/// The DeepSeek account the way the official web client tracks it
/// (`dsh-client-ui-settings-account`): `account/watch` pushes the login state
/// and the browser attempt; profile, wallet balances and bonus notices are
/// read whenever a signed-in frame arrives and whenever settings open.
///
/// The engine holds the account grant. This client never sees the user's
/// Platform password or web cookies: sign-in happens on Platform's own page
/// in a browser this app cannot read.
@MainActor
@Observable
final class AccountModel {
    /// The engine build this client speaks for; account methods require it in `client`.
    static let clientVersion = "0.2.2-rc.1"

    @ObservationIgnored private let client: EngineClient
    @ObservationIgnored private let mux: StreamMux

    /// The latest `AccountView`: `status`, `links`, `attempt`.
    private(set) var view: JSON?
    private(set) var streamFailed = false
    /// `nil` while loading; then `{status:"ready", value}` or `{status:"failed"}`.
    private(set) var profile: JSON?
    private(set) var balance: JSON?
    private(set) var bonuses: [BonusNotice] = []
    /// One-shot shell notices: a toast line, or the no-balance prompt.
    var toast: String?
    var quotaPrompt = false

    @ObservationIgnored private var watchTask: Task<Void, Never>?
    @ObservationIgnored private var detailsGeneration = 0
    @ObservationIgnored private var initializedAttempt: String?
    @ObservationIgnored private var acked: Set<String> = []

    init(client: EngineClient, mux: StreamMux) {
        self.client = client
        self.mux = mux
    }

    // MARK: State

    var signedIn: Bool { view?["status"].string == "credential-stored" }

    var attempt: JSON? {
        guard let attempt = view?["attempt"], !attempt.isNull else { return nil }
        return attempt
    }

    var phase: String? { attempt?["phase"].string }

    /// A browser sign-in is under way (the official `active`).
    var attemptActive: Bool { ["initializing", "waiting-browser", "exchanging", "committing"].contains(phase ?? "") }

    var usageURL: URL? { view?["links"]["usageUrl"].string.flatMap(URL.init(string:)) }
    var topUpURL: URL? { view?["links"]["topUpUrl"].string.flatMap(URL.init(string:)) }
    /// Platform's home page, the official "更多账号信息".
    var accountInfoURL: URL? { usageURL.flatMap { URL(string: "/", relativeTo: $0)?.absoluteURL } }

    var profileValue: JSON? { profile?["status"].string == "ready" ? profile?["value"] : nil }
    var displayName: String? { profileValue?["name"].string }

    /// Recharge wallets once read; nil while loading or after a failed read.
    var wallets: [JSON]? { balance?["status"].string == "ready" ? balance?["value"].array : nil }
    /// Bonus wallets with money in them.
    var bonusWallets: [JSON] {
        guard balance?["status"].string == "ready" else { return [] }
        return balance?["bonusWallets"].array.filter { (Decimal(string: $0["balance"].string ?? "") ?? 0) > 0 } ?? []
    }
    /// The bonus row hides only once a read shows every bonus wallet empty.
    var showsBonusRow: Bool { balance?["status"].string != "ready" || !bonusWallets.isEmpty }

    /// The sign-in authorize page in the app's colour scheme.
    func authorizeURL(_ scheme: ColorScheme) -> URL? {
        guard let raw = attempt?["authorizeUrl"].string, var components = URLComponents(string: raw) else { return nil }
        var items = components.queryItems ?? []
        items.removeAll { $0.name == "theme" }
        items.append(URLQueryItem(name: "theme", value: scheme == .dark ? "dark" : "light"))
        components.queryItems = items
        return components.url
    }

    /// The request identity every account method carries.
    private var clientInfo: JSON {
        [
            "version": .string(Self.clientVersion),
            "locale": .string(Bundle.main.preferredLocalizations.first ?? "zh-Hans"),
            "timezoneOffsetSeconds": .number(Double(TimeZone.current.secondsFromGMT())),
        ]
    }

    // MARK: Following

    func follow() {
        watchTask?.cancel()
        watchTask = Task {
            while !Task.isCancelled {
                do {
                    for try await frame in mux.open("account/watch", [:]) {
                        streamFailed = false
                        apply(frame)
                    }
                } catch {
                    if Task.isCancelled { return }
                    streamFailed = true
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func apply(_ next: JSON) {
        let wasSignedIn = signedIn
        view = next
        guard signedIn else {
            detailsGeneration += 1
            profile = nil
            balance = nil
            bonuses = []
            quotaPrompt = false
            return
        }
        if !wasSignedIn {
            Task { await loadBonuses() }
        }
        // First frame of a finished sign-in: pick the account's default model, as the web client does.
        if phase == "succeeded", let id = attempt?["id"].string, initializedAttempt != id {
            initializedAttempt = id
            Task { _ = try? await client.call("session/initializeDefaultModel") }
        }
        Task { await refreshDetails() }
    }

    /// Profile and balances, each on its own; a newer read drops an older one's result.
    func refreshDetails() async {
        guard signedIn else { return }
        detailsGeneration += 1
        let generation = detailsGeneration
        let client = self.client, info = clientInfo
        async let profileRead = Self.read(client, "account/getProfile", info)
        async let balanceRead = Self.read(client, "account/getBalance", info)
        let (nextProfile, nextBalance) = await (profileRead, balanceRead)
        guard generation == detailsGeneration, signedIn else { return }
        profile = nextProfile
        balance = nextBalance
    }

    /// Opening settings re-reads everything shown there, bonus notices included.
    func refresh() async {
        guard signedIn else { return }
        async let details: Void = refreshDetails()
        async let notices: Void = loadBonuses()
        _ = await (details, notices)
    }

    nonisolated private static func read(_ client: EngineClient, _ method: String, _ info: JSON) async -> JSON {
        let value = try? await client.call(method, ["client": info])
        guard let value, !value.isNull else { return ["status": "failed"] }
        return value
    }

    // MARK: Bonus notices

    private func loadBonuses() async {
        guard let batch = try? await client.call("account/getUnnotifiedBonuses", ["client": clientInfo]), !batch.isNull else { return }
        let accountId = batch["accountId"].string ?? ""
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        bonuses = batch["bonuses"].array.compactMap { bonus in
            guard let orderId = bonus["orderId"].string, !acked.contains(orderId) else { return nil }
            let expires = bonus["expiresAt"].string.flatMap { $0.isEmpty ? nil : (iso.date(from: $0) ?? plain.date(from: $0)) }
            let notice = BonusNotice(
                accountId: accountId,
                orderId: orderId,
                title: bonus["title"].string ?? String(localized: "赠金已到账"),
                message: bonus["message"].string ?? "",
                expiresAt: expires
            )
            return notice.expired ? nil : notice
        }
    }

    /// A notice counts as shown once on screen: acknowledge it once, retrying failures with backoff.
    func markShown(_ notice: BonusNotice) {
        guard !acked.contains(notice.orderId) else { return }
        acked.insert(notice.orderId)
        let client = self.client, info = clientInfo
        Task {
            var delay = 1.0
            while !Task.isCancelled {
                do {
                    _ = try await client.call("account/ackBonusNotified", ["accountId": .string(notice.accountId), "orderId": .string(notice.orderId), "client": info])
                    return // false means Platform will not take it: do not retry either.
                } catch {
                    try? await Task.sleep(for: .seconds(delay))
                    delay = min(delay * 2, 60)
                }
            }
        }
    }

    func dismiss(_ notice: BonusNotice) {
        markShown(notice)
        bonuses.removeAll { $0.id == notice.id }
    }

    // MARK: Actions

    func startSignIn() async throws {
        let next = try await client.call("account/startSignIn", [
            "client": clientInfo,
            "callbackOrigin": .string(client.origin.absoluteString),
            "loginSource": "web",
        ])
        apply(next)
    }

    func cancelSignIn() async {
        guard let id = attempt?["id"].string, attemptActive, phase != "committing" else { return }
        if let next = try? await client.call("account/cancelSignIn", ["attemptId": .string(id)]) { apply(next) }
    }

    /// Whether tasks are running on the account: `nil` when it could not be checked.
    func hasRunningTasks() async -> Bool? {
        (try? await client.call("account/hasRunningAccountTasks"))?.bool
    }

    func signOut() async throws {
        let next = try await client.call("account/signOut", ["client": clientInfo])
        apply(next)
    }

    // MARK: Shell notices

    /// Host events from `$events` (`deepseek-account/*`).
    func handle(event: String) {
        switch event {
        case "deepseek-account/session-expired": toast = String(localized: "登录信息已失效，请重新登录")
        case "deepseek-account/model-sign-in-required": toast = String(localized: "当前模型暂不可用，请登录后再试")
        default: break
        }
    }

    /// A live turn ended on `QUOTA`/`ACCOUNT_QUOTA`: an account route asks to top up, anything else is a toast.
    func reportQuota(code: String) {
        if code == "ACCOUNT_QUOTA", signedIn, topUpURL != nil {
            quotaPrompt = true
        } else {
            toast = String(localized: "当前请求的额度已用尽")
        }
    }
}

/// Platform Web's balance text: two decimals rounded down, grouped digits, and
/// sub-cent amounts shown as `<¥0.01` (`-¥0.01` when negative).
func formatBalance(_ amount: String, currency: String?) -> String {
    let symbol = currency == "USD" ? "$" : "¥"
    guard let value = Decimal(string: amount, locale: Locale(identifier: "en_US_POSIX")) else { return amount }
    if value == 0 { return "\(symbol)0.00" }
    if value < 0 {
        return value > Decimal(string: "-0.01")! ? "-\(symbol)0.01" : "-\(symbol)\(grouped(-value, .plain))"
    }
    if value < Decimal(string: "0.01")! { return "<\(symbol)0.01" }
    return "\(symbol)\(grouped(value, .down))"
}

private func grouped(_ value: Decimal, _ rounding: NSDecimalNumber.RoundingMode) -> String {
    var input = value, rounded = Decimal()
    NSDecimalRound(&rounded, &input, 2, rounding)
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.minimumFractionDigits = 2
    formatter.maximumFractionDigits = 2
    return formatter.string(from: rounded as NSDecimalNumber) ?? "\(rounded)"
}

/// What a `turn/end` failed with, as the official chat client words it.
struct TurnFailure {
    let code: String?
    let message: String

    /// `reason` of a `turn/end`: a recorded error, a sign-out abort, or a turn closed by an engine restart.
    init?(reason: JSON) {
        let code: String?, raw: String
        switch reason["kind"].string {
        case "error":
            code = reason["error"]["code"].string
            raw = reason["error"]["message"].string ?? ""
        case "aborted" where reason["reason"]["kind"].string == "hook" && reason["reason"]["reason"].string == "deepseek-account/signed-out":
            code = "ACCOUNT_SIGNED_OUT"
            raw = ""
        case "interrupted":
            code = "INTERRUPTED"
            raw = ""
        default:
            return nil
        }
        self.code = code
        switch code {
        case "ACCOUNT_SIGNED_OUT": message = String(localized: "任务已因退出 DeepSeek 登录而停止。")
        case "INTERRUPTED": message = String(localized: "DSH 进程在本轮完成前退出（例如被强制结束、崩溃或关闭超时），重新启动后本轮已中止。未完成的工具调用结果未知。")
        case "ACCOUNT_SIGN_IN_REQUIRED": message = String(localized: "请先登录 DeepSeek，并确认请求地址支持账号认证。")
        case "QUOTA", "ACCOUNT_QUOTA": message = String(localized: "当前请求的额度已用尽")
        case "AUTH": message = String(localized: "API 密钥无效")
        default: message = raw.isEmpty ? String(localized: "本轮运行失败") : raw
        }
    }

    var isQuota: Bool { code == "QUOTA" || code == "ACCOUNT_QUOTA" }

    /// The turn never reached a model for want of a working credential.
    enum CredentialProblem: Hashable { case missing, invalid }

    var credentialProblem: CredentialProblem? {
        switch code {
        case "MISSING_CREDENTIAL", "ACCOUNT_SIGN_IN_REQUIRED": .missing
        case "AUTH", "INVALID_CREDENTIAL": .invalid
        default: nil
        }
    }
}
