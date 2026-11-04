import Foundation
import Observation

/// The Host half of the official Cordis panel (`dsh-client-ui-cordis`): plugins an agent
/// defines at runtime, listed by `dynamicCordisRunner/inventory`.
///
/// A plugin's Client half is browser code this native client cannot load, so a request to
/// activate one (`cordis/request-run`) is answered here at once as a Client failure, before
/// any of it runs: unanswered, the agent's turn would wait for a page that does not exist.
/// Host-only versions need no such request and run normally.
@MainActor
@Observable
final class CordisModel {
    private(set) var rows: [JSON] = []
    private(set) var loaded = false
    private(set) var failure: String?
    /// Plugins with an action in flight.
    private(set) var pending: Set<String> = []
    /// The last failed action of each plugin.
    private(set) var actionErrors: [String: String] = [:]

    @ObservationIgnored private var client: EngineClient?
    @ObservationIgnored private var answered: Set<String> = []

    /// Told to the model (not shown to the user): why the activation did not happen.
    private static let unsupported = "This iOS client cannot load a plugin's browser Client half, and nothing was activated. Define a version without Client code (Host only), or run this one from the web UI."

    var runningCount: Int { rows.filter { !$0["activeRun"].isNull }.count }

    func attach(_ app: AppModel) {
        client = app.client
        _ = app.addListener { [weak self, weak app] event, args in
            guard let self, let app else { return }
            switch event {
            case "cordis/request-run":
                if let request = args.first { Task { await self.refuse(request, app: app) } }
            case "cordis/dynamic-package", "cordis/dynamic-retract", "cordis/request-run-resolved":
                Task { await self.refresh(app: app) }
            default:
                break
            }
        }
    }

    /// Re-read the inventory; a request raised while nobody was connected is answered now.
    func refresh(app: AppModel) async {
        guard let client else { return }
        do {
            rows = try await client.call("dynamicCordisRunner/inventory").array
            failure = nil
            loaded = true
            for row in rows {
                let run = row["latestRun"]
                guard let requestId = run["approvalRequestId"].string,
                      ["awaiting-approval", "starting-host", "client-pending"].contains(run["status"].string ?? "") else { continue }
                let name = row["packages"].array.first { $0["packageId"] == run["packageId"] }?["name"].string
                await refuse(["requestId": .string(requestId), "name": .string(name ?? row["pluginId"].string ?? "")], app: app)
            }
        } catch {
            failure = error.localizedDescription
            loaded = true
        }
    }

    private func refuse(_ request: JSON, app: AppModel) async {
        guard let requestId = request["requestId"].string, answered.insert(requestId).inserted else { return }
        let resolution: JSON = ["ok": false, "reason": "client-half-failed", "message": .string(Self.unsupported)]
        guard (try? await client?.call("dynamicCordisRunner/resolveRequestRun", ["requestId": .string(requestId), "resolution": resolution])) != nil else {
            answered.remove(requestId)
            return
        }
        app.showToast(String(localized: "「\(request["name"].string ?? "")」带网页界面部分，iOS 无法运行，已告知 Agent"), tone: .warning, duration: 6)
        await refresh(app: app)
    }

    /// Run one Host-only version on the user's gesture, which authorizes it.
    func run(_ row: JSON, packageId: String, mode: String, app: AppModel) async {
        await act(row, app: app) { client, agent, plugin in
            let value = try await client.call("dynamicCordisRunner/runHostHalf", [
                "agent": agent, "pluginId": plugin, "packageId": .string(packageId), "mode": .string(mode), "requestId": .null, "approveFutureVersions": false,
            ])
            return value["ok"].bool == false ? value["message"].string ?? "" : nil
        }
    }

    func stop(_ row: JSON, app: AppModel) async {
        await act(row, app: app) { client, agent, plugin in
            let value = try await client.call("dynamicCordisRunner/stopFromPanel", ["agent": agent, "pluginId": plugin])
            return value["ok"].bool == true || value["reason"].string == "not-running" ? nil : value["message"].string ?? ""
        }
    }

    func remove(_ row: JSON, app: AppModel) async {
        await act(row, app: app) { client, agent, plugin in
            let value = try await client.call("dynamicCordisRunner/undefineFromPanel", ["agent": agent, "pluginId": plugin])
            return value["ok"].bool == true ? nil : value["message"].string ?? ""
        }
    }

    /// `action` answers a refusal message, nil on success.
    private func act(_ row: JSON, app: AppModel, _ action: (EngineClient, JSON, JSON) async throws -> String?) async {
        guard let client, let id = row["pluginId"].string, pending.insert(id).inserted else { return }
        actionErrors[id] = nil
        defer { pending.remove(id) }
        do {
            if let message = try await action(client, row["agentId"], row["pluginId"]) { actionErrors[id] = message }
        } catch {
            actionErrors[id] = error.localizedDescription
        }
        await refresh(app: app)
    }
}
