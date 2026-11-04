import SwiftUI

/// A turn that had no working credential. The engine's error names environment variables;
/// this says what to do instead, and once it is done offers to send the message again.
struct CredentialNotice: View {
    let id: String
    let problem: TurnFailure.CredentialProblem
    let model: SessionModel
    @Environment(AppModel.self) private var app
    /// Some provider can answer now; nil until asked.
    @State private var ready: Bool?

    /// A later turn has moved on: this one is only a record, and only the last can be sent again.
    private var isLast: Bool { model.items.last?.id == id && !model.running }

    private var resendText: String? {
        guard isLast else { return nil }
        for item in model.items.reversed() {
            if case .user(_, let text, _, _) = item, !text.isEmpty { return text }
        }
        return nil
    }

    /// What a credential is added for: the conversation's model, unless that is the official route's.
    private var keyStep: AppModel.CredentialStep {
        switch model.modelCatalog?.selection(model)?.provider {
        case nil, "deepseek-official", "deepseek-account": .officialKey
        default: .settings
        }
    }

    var body: some View {
        // Not a Group: an empty one takes its modifiers with it, and the task below would never run.
        VStack(alignment: .leading, spacing: 0) {
            if !isLast {
                record
            } else {
                switch (problem, ready) {
                case (.missing, nil):
                    EmptyView()
                case (.missing, false?):
                    card("需要先登录或添加 API Key", "登录 DeepSeek 账号，或添加一个 API Key，就能开始对话。") {
                        Button("添加 API Key") { app.requestCredentials(keyStep) }
                            .buttonStyle(.capsule(.outline, height: 44))
                        Button("登录") { app.requestCredentials(.signIn) }
                            .buttonStyle(.capsule(.primary, height: 44))
                    }
                case (.missing, true?):
                    card("已经配置好了", "把刚才的消息重新发送一次。") { resendButton }
                case (.invalid, _):
                    card("API Key 无法使用", "这个 API Key 无效或已失效，换一个再试。") {
                        Button("更换 API Key") { app.requestCredentials(keyStep) }
                            .buttonStyle(.capsule(.outline, height: 44))
                        resendButton
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Signing in or saving a key anywhere answers here, without a new turn.
        .task(id: "\(app.revision("llm/adapters-updated", "settings/document-updated", "credentials/record-updated", "credentials/reference-updated"))-\(app.account.signedIn)") {
            guard problem == .missing else { return }
            ready = await app.onboardingReadiness() == .ready
        }
    }

    private var record: some View {
        Text(problem == .missing ? "这条消息发送时还没有配置模型。" : "这条消息发送时 API Key 无法使用。")
            .font(.footnote)
            .foregroundStyle(Palette.secondary)
    }

    @ViewBuilder
    private var resendButton: some View {
        if let resendText {
            Button("重新发送") {
                Haptics.tap()
                Task { await model.send(text: resendText) }
            }
            .buttonStyle(.capsule(.primary, height: 44))
        }
    }

    private func card<Actions: View>(_ title: LocalizedStringKey, _ detail: LocalizedStringKey, @ViewBuilder actions: () -> Actions) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.ink)
                Text(detail).font(.footnote).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) { actions() }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.grouped, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}
