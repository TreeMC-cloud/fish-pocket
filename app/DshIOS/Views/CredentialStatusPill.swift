import SwiftUI

/// 侧边栏顶部的一条状态药丸：现在能不能说话、用的哪个模型。
///
/// 为什么要有它：以前「配没配 Key」只有进设置才知道。小白装完 App 第一件事
/// 是找「我配好了吗」，把答案放在他每次打开侧边栏都会看到的地方。
///
/// 三种状态：
///   - 已就绪：绿点 + 模型名，点一下去换模型/换 Key
///   - 未配置：空心点 + 「配置 API Key」，点一下直接进引导（最重要的入口）
///   - 读取中：不显示，避免闪一下「未配置」让人误以为坏了
struct CredentialStatusPill: View {
    let openThirdParty: () -> Void
    let openSettings: () -> Void

    @Environment(AppModel.self) private var app
    /// nil = 还没问出来
    @State private var readiness: AppModel.OnboardingReadiness?
    /// 当前模型名，就绪时显示
    @State private var modelName: String?

    private var ready: Bool { readiness == .ready }

    var body: some View {
        Group {
            if let readiness {
                if ready {
                    pill(ready: true)
                } else if case .credentialMissing = readiness {
                    pill(ready: false)
                } else if case .unavailable = readiness {
                    // 引擎还没起来/读失败：不冒充「未配置」，给一个中性入口。
                    pill(ready: false, unknown: true)
                }
            }
        }
        .task(id: refreshKey) { await load() }
    }

    /// 任何会影响「能不能说话」的东西变了就重问。
    private var refreshKey: String {
        "\(app.revision("llm/adapters-updated", "settings/document-updated", "credentials/record-updated", "credentials/reference-updated"))-\(app.account.signedIn)"
    }

    private func load() async {
        let value = await app.onboardingReadiness()
        readiness = value
        if value == .ready {
            modelName = await app.defaultModelLabel()
        } else {
            modelName = nil
        }
    }

    private func pill(ready: Bool, unknown: Bool = false) -> some View {
        Button {
            Haptics.tap()
            if ready {
                openSettings()
            } else if unknown {
                openSettings()
            } else {
                // 未配置时直达引导页，不让人在设置里翻。
                app.requestCredentials(.start)
            }
        } label: {
            HStack(spacing: 8) {
                Circle()
                    .fill(ready ? Palette.running : Color.clear)
                    .overlay {
                        Circle().strokeBorder(
                            ready ? Color.clear : Palette.secondary.opacity(0.6),
                            lineWidth: 1.2
                        )
                    }
                    .frame(width: 7, height: 7)
                    .shadow(color: ready ? Palette.running.opacity(0.6) : .clear, radius: 4)

                Text(ready ? (modelName ?? String(localized: "已就绪")) : String(localized: "配置 API Key"))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(ready ? Palette.ink : Palette.secondary)
                    .lineLimit(1)

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Palette.faint)
            }
            .padding(.horizontal, 14)
            .frame(height: 34)
            .glassPill(.floating, tint: ready ? nil : Palette.secondary)
        }
        .buttonStyle(GlassButtonStyle())
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .accessibilityLabel(Text(ready ? "模型已就绪，点按进入设置" : "还没有配置 API Key，点按开始配置"))
    }
}

extension AppModel {
    /// 当前默认模型的名字，给药丸显示。读不到就不显示（返回 nil）。
    func defaultModelLabel() async -> String? {
        guard let catalog = try? await client.call("session/modelCatalog") else { return nil }
        // JSON.array 是 [JSON]（不是 Optional），空数组就是「没有」。
        // 写 guard let 会被编译器拒（initializer for conditional binding must have Optional type）。
        let groups = catalog["groups"].array
        for group in groups {
            let models = group["models"].array
            if models.isEmpty { continue }
            if let selected = models.first(where: { $0["selected"].bool == true }) ?? models.first {
                if let label = selected["label"].string ?? selected["name"].string ?? selected["id"].string {
                    return label
                }
            }
        }
        return nil
    }
}
