import Foundation

/// What the first-run steps read from the engine, ported from
/// `dsh-client-ui-settings-models` (`onboardingReadiness`).
extension AppModel {
    enum OnboardingReadiness: Equatable {
        /// Some provider can already answer.
        case ready
        /// Nothing can answer and the official route takes a key under this reference.
        case credentialMissing(ref: String)
        /// A prompt could not help (read failed, adapter absent, read-only…).
        case unavailable
    }

    /// What a conversation can ask of the shell when it has no working credential.
    enum CredentialStep {
        /// The first-run sheet: signing in, with the API Key as the alternative.
        case start
        /// Straight to signing in.
        case signIn
        /// The official route's key.
        case officialKey
        /// Another provider's key, kept in settings.
        case settings
    }

    func requestCredentials(_ step: CredentialStep) {
        credentialRequest = (step, UUID())
    }

    /// The credential reference the official route's profile names.
    func officialKeyRef() async -> String? {
        guard let declared = try? await client.call("llm/listConfigurableProviders"),
              let settings = try? await client.call("settings/describe"),
              let entry = declared.array.first(where: { $0["provider"].string == "deepseek-official" }),
              let ns = entry["settingsNs"].string else { return nil }
        var profile = settings["namespaces"].array.first { $0["ns"].string == ns }?["value"] ?? .null
        for key in entry["settingsPath"].array.compactMap(\.string) { profile = profile[key] }
        return profile["apiKeyEnv"].string.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The official provider join, reduced to the question the step asks: any
    /// active provider with its credential stored (or owing none, or the signed-in
    /// account with models) ends it; otherwise only the official route can prompt.
    func onboardingReadiness() async -> OnboardingReadiness {
        guard let registered = try? await client.call("llm/listProviders"),
              let declared = try? await client.call("llm/listConfigurableProviders"),
              let settings = try? await client.call("settings/describe") else { return .unavailable }
        let namespaces = settings["namespaces"].array
        // The Host switch `credentialOnboarding`, when it is exposed at all (default on).
        if namespaces.first(where: { $0["ns"].string == "ui-settings-models" })?["value"]["credentialOnboarding"].bool == false { return .unavailable }

        struct Row { let provider: String; let ns: String; let path: [String]; let active: Bool; let keyRef: String? }
        let active = Set(registered.array.compactMap { $0["id"].string })
        var rows = declared.array.map { entry -> Row in
            let provider = entry["provider"].string ?? ""
            let ns = entry["settingsNs"].string ?? ""
            let path = entry["settingsPath"].array.compactMap(\.string)
            var profile = namespaces.first { $0["ns"].string == ns }?["value"] ?? .null
            for key in path { profile = profile[key] }
            let ref = provider == "deepseek-account" ? nil : profile["apiKeyEnv"].string.flatMap { $0.isEmpty ? nil : $0 }
            return Row(provider: provider, ns: ns, path: path, active: active.contains(provider), keyRef: ref)
        }
        let declaredIds = Set(rows.map(\.provider))
        for id in active where !declaredIds.contains(id) {
            rows.append(Row(provider: id, ns: "", path: [], active: true, keyRef: nil))
        }

        var accountHasModels = false
        if rows.contains(where: { $0.provider == "deepseek-account" }),
           let catalog = try? await client.call("session/modelCatalog") {
            accountHasModels = catalog["groups"].array.contains { $0["id"].string == "deepseek-account" && !$0["models"].array.isEmpty }
        }

        let refs = Array(Set(rows.compactMap(\.keyRef)))
        var credentials: [String: JSON] = [:]
        var credentialsFailed = false
        for start in stride(from: 0, to: refs.count, by: 64) {
            let batch = refs[start..<min(start + 64, refs.count)]
            guard let value = try? await client.call("credentials/describe", ["refs": .array(batch.map { .string($0) })]) else {
                credentialsFailed = true
                break
            }
            credentials.merge(value.object) { $1 }
        }

        let usable = rows.contains { row in
            guard row.active else { return false }
            if row.provider == "deepseek-account" { return accountHasModels }
            guard let ref = row.keyRef else { return true }
            return credentials[ref]?["configured"].bool == true
        }
        if usable { return .ready }
        guard let official = rows.first(where: { $0.provider == "deepseek-official" && $0.ns == "llm-deepseek" && $0.path.isEmpty }),
              official.active, !credentialsFailed, let ref = official.keyRef, let credential = credentials[ref],
              settings["writable"].bool == true, credential["writable"].bool == true else { return .unavailable }
        return .credentialMissing(ref: ref)
    }
}
