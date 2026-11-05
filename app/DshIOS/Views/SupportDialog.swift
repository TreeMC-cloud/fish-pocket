import SwiftUI

/// The ask for a Star or a share (`SupportPrompt`): a small card in the middle of the
/// screen, the shape of the system's prompts. Only its buttons close it, so a tap meant
/// for the conversation can't spend the ask unseen.
struct SupportDialog: View {
    let star: () -> Void
    let share: () -> Void
    let later: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    /// Dimmed black is the page's own color; a step up lets the card lift off it.
    private var card: Color { colorScheme == .dark ? Palette.field : Palette.background }

    var body: some View {
        ZStack {
            Palette.scrim.ignoresSafeArea()
            VStack(spacing: 0) {
                icon
                Text("喜欢 Fish Pocket 吗？")
                    .font(.headline)
                    .foregroundStyle(Palette.ink)
                    .padding(.top, 16)
                    .accessibilityAddTraits(.isHeader)
                Text("它是一个开源项目。点个 Star 或分享给朋友，能让更多人发现它。")
                    .font(.subheadline)
                    .foregroundStyle(Palette.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 6)
                VStack(spacing: 8) {
                    Button(action: star) { Label("在 GitHub 点 Star", systemImage: "star.fill") }
                        .buttonStyle(.capsule(height: 48))
                    Button(action: share) { Label("分享给朋友", systemImage: "square.and.arrow.up") }
                        .buttonStyle(.capsule(.secondary, height: 48))
                    Button("以后再说", action: later)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Palette.secondary)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                        .buttonStyle(.plain)
                }
                .padding(.top, 20)
            }
            .padding(EdgeInsets(top: 24, leading: 20, bottom: 12, trailing: 20))
            .frame(maxWidth: 320)
            .background(card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay { RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(Palette.stroke) }
            .padding(.horizontal, 32)
            .accessibilityElement(children: .contain)
            .accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape, later)
        }
    }

    private var icon: some View {
        Group {
            if let image = UIImage(named: "AppIcon") {
                Image(uiImage: image).resizable()
            } else {
                Image("LaunchMark").resizable().scaledToFit()
            }
        }
        .frame(width: 68, height: 68)
        .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
        .accessibilityHidden(true)
    }
}
