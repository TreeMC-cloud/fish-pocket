import SwiftUI

/// 「添加一个 API Key 开始使用」: the official credential-only editor. Only the
/// key is written (`credentials/set`), never the settings.
struct OnboardingKeySheet: View {
    /// The credential reference the official route's profile names.
    let ref: String
    let finish: () -> Void
    @Environment(AppModel.self) private var app
    @State private var key = ""
    @State private var reveal = false
    @State private var busy = false
    @State private var failure: String?
    @FocusState private var focused: Bool

    private var trimmed: String { key.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// `apiKeyFailure`: a pasted `NAME=value`, quotes or anything outside printable ASCII.
    private var invalid: Bool {
        guard !trimmed.isEmpty else { return false }
        if trimmed.wholeMatch(of: /[A-Z][A-Z0-9_]*=[^=].*/) != nil { return true }
        if let first = trimmed.first, let last = trimmed.last, trimmed.count >= 2, first == last, "\"'`".contains(first) { return true }
        return !trimmed.unicodeScalars.allSatisfy { (0x21...0x7E).contains($0.value) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("添加一个 API Key 开始使用").font(.title3.weight(.semibold)).accessibilityAddTraits(.isHeader)
                Text("配置 DeepSeek 官方模型，即可开始使用。").font(.subheadline).foregroundStyle(Palette.secondary)
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Group {
                        if reveal { TextField("API Key", text: $key) } else { SecureField("API Key", text: $key) }
                    }
                    .font(.callout)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    Button { reveal.toggle() } label: {
                        Image(systemName: reveal ? "eye.slash" : "eye").foregroundStyle(Palette.secondary).frame(width: 32, height: 32)
                    }
                    .accessibilityLabel(reveal ? "隐藏密钥" : "显示密钥")
                }
                .padding(.leading, 18)
                .padding(.trailing, 10)
                .frame(height: 52)
                .background(Palette.field, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                if invalid {
                    Text("该 API 密钥格式错误，请检查。").font(.footnote).foregroundStyle(Palette.removed)
                } else if !key.isEmpty && trimmed.isEmpty {
                    Text("请输入 API 密钥后继续。").font(.footnote).foregroundStyle(Palette.removed)
                }
                if let failure {
                    Text(failure).font(.footnote).foregroundStyle(Palette.removed).fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: 10) {
                Button("稍后配置", action: finish).buttonStyle(.capsule(.secondary)).disabled(busy)
                Button(busy ? "保存中…" : "保存并继续") { Task { await save() } }
                    .buttonStyle(.capsule())
                    .disabled(busy || trimmed.isEmpty || invalid)
                    .opacity(trimmed.isEmpty || invalid ? 0.4 : 1)
            }
        }
        .padding(EdgeInsets(top: 28, leading: 22, bottom: 22, trailing: 22))
        .fittedSheet()
        .interactiveDismissDisabled()
        .onAppear { focused = true }
    }

    private func save() async {
        busy = true
        failure = nil
        defer { busy = false }
        do {
            try await app.client.call("credentials/set", ["ref": .string(ref), "value": .string(trimmed)])
            Haptics.success()
            finish()
        } catch {
            Haptics.error()
            failure = error.localizedDescription
        }
    }
}
