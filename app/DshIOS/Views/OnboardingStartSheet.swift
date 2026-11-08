import SwiftUI

/// 第一次发消息、还没有任何能回答的模型时，直接问「你要用哪种」，而不是先甩一个登录页。
///
/// 为什么不再复用 `SignInSheet`：
///   登录页把「DeepSeek 账号登录 / 官方 API Key / 第三方中转站」三件事混在一屏，
///   小白看到的第一个画面是「登录」——但他手里往往只有一串别处买的 key。
///   这里把问题降成一个：「你手上有什么？」两个选项，各一句话说清区别。
struct OnboardingStartSheet: View {
    /// 往下走：登录官方账号。
    let signIn: () -> Void
    /// 添加第三方 API（中转站 / 自建）。
    let thirdParty: () -> Void
    /// 官方 API Key。
    let officialKey: () -> Void
    /// 先不配。
    let later: () -> Void

    /// 展开「不知道选哪个」的说明。
    @State private var explaining = false

    var body: some View {
        VStack(spacing: 0) {
            grabber

            VStack(spacing: 10) {
                Image(systemName: "key.horizontal.fill")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(Palette.ink)
                    .frame(width: 62, height: 62)
                    .glassSurface(
                        RoundedRectangle(cornerRadius: 20, style: Glass.corner),
                        .floating
                    )
                    .padding(.bottom, 6)

                Text("配一个 API Key")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(Palette.ink)
                Text("配一次就能一直用。你手上是哪种？")
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 26)
            .padding(.bottom, 24)

            VStack(spacing: 10) {
                choice(
                    icon: "bolt.horizontal.circle.fill",
                    title: "第三方 API",
                    detail: "中转站 / 自建接口。有「地址 + 密钥」就选这个，兼容 OpenAI 和 Anthropic。",
                    badge: "推荐",
                    tint: Palette.ink,
                    action: thirdParty
                )
                choice(
                    icon: "brain.head.profile",
                    title: "DeepSeek 官方 Key",
                    detail: "platform.deepseek.com 申请的 sk-… 密钥，直连官方。",
                    badge: nil,
                    tint: Palette.secondary,
                    action: officialKey
                )
            }
            .padding(.horizontal, 18)

            // 「不知道选哪个」：默认收起，点开才占空间——大多数人不需要读第二段话。
            Button {
                Haptics.tap()
                withAnimation(.snappy(duration: 0.25)) { explaining.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: explaining ? "chevron.up" : "questionmark.circle")
                        .font(.system(size: 11, weight: .medium))
                    Text(explaining ? "收起" : "不知道选哪个？")
                        .font(.footnote)
                }
                .foregroundStyle(Palette.secondary)
            }
            .buttonStyle(.plain)
            .padding(.top, 14)

            if explaining {
                Text("你有别人给的「接口地址 + 一串密钥」→ 选第三方 API。\n你只有 DeepSeek 官网申请的一串 sk- 开头密钥 → 选官方。\n分不清就先选第三方，配错了随时能在设置里改。")
                    .font(.caption)
                    .foregroundStyle(Palette.secondary)
                    .multilineTextAlignment(.leading)
                    .lineSpacing(3)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .glassCard(radius: 16, .panel)
                    .padding(.horizontal, 18)
                    .padding(.top, 10)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }

            Spacer(minLength: 8)

            HStack(spacing: 14) {
                Button("登录 DeepSeek 账号", action: signIn)
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
                Text("·").foregroundStyle(Palette.faint).font(.footnote)
                Button("先逛逛", action: later)
                    .font(.footnote)
                    .foregroundStyle(Palette.secondary)
            }
            .buttonStyle(.plain)
            .padding(.bottom, 26)
        }
        .presentationDetents([.height(explaining ? 590 : 500)])
        .presentationDragIndicator(.hidden)
        // 半透明底：让下面的会话隐约透出来，玻璃 sheet 才“浮”得住。
        // 不用 .presentationBackground(.clear)：它会让 sheet 完全透明，
        // 17–25 上就成了白底黑字压不住背景，统一用 material 最稳。
        .presentationBackground(.ultraThinMaterial)
    }

    private var grabber: some View {
        Capsule()
            .fill(Palette.faint.opacity(0.4))
            .frame(width: 36, height: 4)
            .padding(.top, 8)
    }

    /// 一张玻璃选项卡：图标 + 标题（可带徽章）+ 一句人话说明。
    private func choice(
        icon: String,
        title: LocalizedStringKey,
        detail: LocalizedStringKey,
        badge: LocalizedStringKey?,
        tint: Color,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            HStack(spacing: 13) {
                Image(systemName: icon)
                    .font(.system(size: 21, weight: .medium))
                    .foregroundStyle(tint)
                    .frame(width: 46, height: 46)
                    .glassSurface(
                        RoundedRectangle(cornerRadius: 14, style: Glass.corner),
                        .floating
                    )

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Palette.ink)
                        if let badge {
                            Text(badge)
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(Palette.onInk)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 2)
                                .background(Palette.ink, in: Capsule())
                        }
                    }
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(Palette.secondary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Palette.faint)
            }
            .padding(15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassCard(radius: 22, .panel)
        }
        .buttonStyle(GlassButtonStyle(radius: 22))
    }
}
