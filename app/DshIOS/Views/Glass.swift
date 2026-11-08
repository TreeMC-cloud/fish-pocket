import SwiftUI

/// iOS 26 液态玻璃（Liquid Glass）的落点。
///
/// 为什么不直接全局换成 `.glassEffect()`：
///   部署目标是 iOS 17——降级到 17 才能让老设备装上，而 `.glassEffect` 是 26 才有的 API。
///   所以这里统一走 `glassSurface(...)`：26 及以上用系统原生玻璃（有折射、动态高光、
///   自动适配底色），17–25 退回「毛玻璃 + 内侧高光描边」的等价视觉。
///   调用方不关心版本差异，也不会在旧系统上编译失败。
enum Glass {
    /// 圆角连续（squircle），和 iOS 26 的玻璃形状一致；`.circular` 会让胶囊和卡片看起来两头尖。
    static let corner: RoundedCornerStyle = .continuous

    /// 一行内的三种密度。对话气泡要更透（背后是内容），设置卡片要更实（背后是底色）。
    enum Density {
        /// 悬浮控件、药丸、输入条：最透，靠高光廓形。
        case floating
        /// 对话气泡、面板：中等，文字要压得住背景。
        case panel
        /// 设置分组：最实，长列表要读得清。
        case card

        var material: Material {
            switch self {
            case .floating: .ultraThinMaterial
            case .panel: .thinMaterial
            case .card: .regularMaterial
            }
        }

        /// 内侧高光（玻璃的“厚度”）。液态玻璃靠这一条把平面和实体分开，
        /// 所以旧系统上必须自己画，新系统由系统 API 负责。
        var specular: Double {
            switch self {
            case .floating: 0.30
            case .panel: 0.22
            case .card: 0.16
            }
        }

        var stroke: Double {
            switch self {
            case .floating: 0.14
            case .panel: 0.10
            case .card: 0.08
            }
        }
    }
}

extension View {
    /// 一块液态玻璃。`shape` 用 `RoundedRectangle(style: Glass.corner)` 或 `Capsule()`。
    ///
    /// 22 / 25 走的是同一条视觉路线：半透明材质打底 → 0.5pt 外描边定形 →
    /// 顶部 0.5pt 内高光做“玻璃边缘”。26 上交给系统玻璃，参数只做语义映射。
    @ViewBuilder
    func glassSurface<S: InsettableShape>(
        _ shape: S,
        _ density: Glass.Density = .panel,
        tint: Color? = nil
    ) -> some View {
        if #available(iOS 26.0, *) {
            GlassEffectBridge.surface(self, shape: shape, density: density, tint: tint)
        } else {
            self
                .background {
                    shape
                        .fill(density.material)
                        .overlay {
                            // 染色层：警示/成功这类语义色压在材质上，不能直接改材质。
                            if let tint {
                                shape.fill(tint.opacity(0.14))
                            }
                        }
                }
                .overlay {
                    shape
                        .strokeBorder(
                            LinearGradient(
                                colors: [
                                    .white.opacity(density.specular),
                                    .white.opacity(density.stroke * 0.5),
                                    .black.opacity(0.06),
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 0.5
                        )
                }
                .clipShape(shape)
                .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
        }
    }

    /// 圆角矩形玻璃，最常用的那一种。
    func glassCard(
        radius: CGFloat = 24,
        _ density: Glass.Density = .card,
        tint: Color? = nil
    ) -> some View {
        glassSurface(
            RoundedRectangle(cornerRadius: radius, style: Glass.corner),
            density,
            tint: tint
        )
    }

    /// 胶囊玻璃：药丸、输入条、状态条。
    func glassPill(
        _ density: Glass.Density = .floating,
        tint: Color? = nil
    ) -> some View {
        glassSurface(Capsule(style: .continuous), density, tint: tint)
    }
}

/// 液态玻璃按钮：按下时玻璃轻微缩小 + 提亮，和系统控件的反馈一致。
///
/// 为什么阴影不放在这里：玻璃本身带投影，`scaleEffect` 时阴影会跟着抖。
/// 调用方把 `glassCard` / `glassPill` 的阴影留在外层，这里只负责按压反馈。
struct GlassButtonStyle: ButtonStyle {
    var radius: CGFloat? = nil

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.72 : 1)
            .scaleEffect(configuration.isPressed ? 0.975 : 1)
            .animation(.spring(duration: 0.22, bounce: 0.2), value: configuration.isPressed)
    }
}

/// 把 iOS 26 的 `.glassEffect` 隔在一个带 `@available` 的类型里。
///
/// 为什么不能直接在 `if #available` 里写：`View.glassEffect` 的**返回类型**
/// （`GlassEffectContainer` 相关类型）在旧 SDK 里不存在，编译器在解析函数体时
/// 就要解析它，`if #available` 保护不了类型解析。用一个 `@available` 标注的
/// 静态方法包起来，旧 SDK 只会看到「这个类型不可用」，不会去解析方法体。
@available(iOS 26.0, *)
private enum GlassEffectBridge {
    static func surface<S: View, Sh: InsettableShape>(
        _ view: S,
        shape: Sh,
        density: Glass.Density,
        tint: Color?
    ) -> some View {
        view.glassEffect(
            .regular
                .tint(tint ?? .clear)
                .interactive(false),
            in: shape
        )
    }
}
