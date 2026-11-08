import SwiftUI

/// Design tokens (docs/design/README.md §3). Each is a Color Set in
/// Assets.xcassets with a light and a dark value; views use only these names.
enum Palette {
    static let background = Color("Background")
    static let ink = Color("Ink")
    static let onInk = Color("OnInk")
    static let secondary = Color("TextSecondary")
    static let faint = Color("TextFaint")
    /// Composer and command blocks.
    static let field = Color("Field")
    /// Grouped lists and the terminal.
    static let grouped = Color("Grouped")
    /// User bubbles, the search field, the selected row.
    static let bubble = Color("Bubble")
    /// Secondary buttons (reject, restart).
    static let control = Color("Control")
    static let stroke = Color("Stroke")
    static let running = Color("StatusRunning")
    static let waiting = Color("StatusWaiting")
    static let addedBackground = Color("DiffAddBackground")
    static let added = Color("DiffAddText")
    static let removedBackground = Color("DiffDeleteBackground")
    static let removed = Color("DiffDeleteText")
    static let scrim = Color("Scrim")
}

/// The appearance choice lives in the engine (`ui-theme.preference`, shared with the web and
/// desktop clients). The app keeps the last value it read, because the screens shown while
/// the engine starts need it before the engine can answer.
enum ThemePreference {
    static let key = "dsh.theme.preference"
    static let system = "system"

    static func style(_ preference: String) -> UIUserInterfaceStyle {
        switch preference {
        case "light": .light
        case "dark": .dark
        default: .unspecified
        }
    }
}

/// Sets the appearance on the window itself. `preferredColorScheme(nil)` does not bring a
/// sheet that is already up back to the system's: going from 深色 to 跟随系统 left 设置 dark.
struct WindowAppearance: UIViewRepresentable {
    let style: UIUserInterfaceStyle

    func makeUIView(context: Context) -> Probe { Probe(style: style) }

    func updateUIView(_ view: Probe, context: Context) {
        view.style = style
        view.window?.overrideUserInterfaceStyle = style
    }

    final class Probe: UIView {
        var style: UIUserInterfaceStyle

        init(style: UIUserInterfaceStyle) {
            self.style = style
            super.init(frame: .zero)
            isUserInteractionEnabled = false
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("not used from a nib") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            window?.overrideUserInterfaceStyle = style
        }
    }
}

/// Pill buttons: `.primary` is ink on the page, `.secondary` the grey control fill.
struct CapsuleButtonStyle: ButtonStyle {
    enum Kind { case primary, secondary, outline }
    var kind: Kind = .primary
    var height: CGFloat = 52
    var fill = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(height >= 44 ? .callout.weight(.semibold) : .subheadline.weight(.semibold))
            .foregroundStyle(kind == .primary ? Palette.onInk : Palette.ink)
            .padding(.horizontal, 16)
            .frame(maxWidth: fill ? .infinity : nil, minHeight: height)
            .background {
                switch kind {
                case .primary: Capsule().fill(Palette.ink)
                case .secondary: Capsule().fill(Palette.control)
                case .outline: Capsule().strokeBorder(Palette.stroke)
                }
            }
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

extension ButtonStyle where Self == CapsuleButtonStyle {
    static func capsule(_ kind: CapsuleButtonStyle.Kind = .primary, height: CGFloat = 52, fill: Bool = true) -> CapsuleButtonStyle {
        CapsuleButtonStyle(kind: kind, height: height, fill: fill)
    }
}

/// The monochrome switch: ink track with a page-coloured knob when on, so it
/// reads in both appearances (the system knob is always white).
struct MonoToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 16) {
            configuration.label
            Spacer(minLength: 0)
            MonoSwitch(isOn: configuration.$isOn)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(configuration.isOn ? Text("开") : Text("关"))
        .accessibilityAction { configuration.isOn.toggle() }
    }
}

/// The switch alone, for rows that lay out their own label (plugins).
struct MonoSwitch: View {
    @Binding var isOn: Bool
    var label: Text?

    var body: some View {
        Capsule()
            .fill(isOn ? Palette.ink : Palette.control)
            .frame(width: 48, height: 28)
            .overlay(alignment: isOn ? .trailing : .leading) {
                Circle()
                    .fill(isOn ? Palette.background : Palette.faint)
                    .frame(width: 22, height: 22)
                    .padding(3)
            }
            .animation(.snappy(duration: 0.2), value: isOn)
            .contentShape(Capsule())
            .onTapGesture { isOn.toggle(); Haptics.select() }
            .accessibilityElement()
            .accessibilityLabel(label ?? Text(""))
            .accessibilityAddTraits(.isToggle)
            .accessibilityValue(isOn ? Text("开") : Text("关"))
            .accessibilityAction { isOn.toggle() }
    }
}

extension ToggleStyle where Self == MonoToggleStyle {
    static var mono: MonoToggleStyle { MonoToggleStyle() }
}

/// Running / waiting indicator: the only colour besides diffs.
struct StatusDot: View {
    enum State { case running, waiting }
    let state: State
    var size: CGFloat = 7
    var halo = false

    var body: some View {
        let color = state == .running ? Palette.running : Palette.waiting
        Circle()
            .fill(color)
            .frame(width: size, height: size)
            .background { if halo { Circle().fill(color.opacity(0.15)).frame(width: size + 8, height: size + 8) } }
            .accessibilityLabel(state == .running ? Text("运行中") : Text("等待允许"))
    }
}

/// Grouped rows on the page background (settings, plugins, workbench lists).
struct GroupedListStyle: ViewModifier {
    /// 分组卡片走液态玻璃：设置页的分区是「一叠浮着的卡」，
    /// 和 iOS 26 设置 App 的观感一致。
    /// 为什么只改 listRowBackground 而不是重写整个 List：
    ///   List 的滑动删除、行内编辑、键盘避让都是系统给的，自己搭 VStack
    ///   会一样样丢掉——这里只换皮的材质，行为一点不动。
    func body(content: Content) -> some View {
        content
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Palette.background)
            // 分组之间要拉开距离：一叠玻璃卡挨太近会糊成一片，
            // 看不出「这是三个不同的分区」。14pt 让每叠卡自成一块。
            .listSectionSpacing(18)
            // 行高兜底：insetGrouped 的行默认 44pt，而这套卡片圆角 22pt、
            // 上下还有 14pt insets，44pt 的行里字被挤到贴边。
            // 52pt 是「圆角 22 + 上下各 8pt 呼吸」的下限。
            // 放在这里而不是每行：139 处调用只有 7 处显式设过 insets，
            // 逐行补漏一定漏；样式统一在 List 层才能一次覆盖。
            .environment(\.defaultMinListRowHeight, 52)
    }
}

extension View {
    func groupedList() -> some View { modifier(GroupedListStyle()) }

    /// A small control keeps its look; the tappable area grows to the 44 pt a thumb needs.
    func hitTarget(_ size: CGFloat = 44) -> some View {
        frame(minWidth: size, minHeight: size)
            .contentShape(Rectangle())
            // A pointer (iPad): the area lights up as it passes.
            .contentShape(.hoverEffect, RoundedRectangle(cornerRadius: 12, style: .continuous))
            .hoverEffect(.highlight)
    }

    /// The reading column of a wide window, centred. A phone is narrower: nothing changes there.
    func readableWidth() -> some View {
        frame(maxWidth: readableColumnWidth, alignment: .leading).frame(maxWidth: .infinity)
    }

    /// One saving model for edit pages: 取消 and 保存 in the toolbar, where the keyboard never covers them.
    func saveToolbar(canSave: Bool, saving: Bool = false, cancel: (() -> Void)? = nil, save: @escaping () -> Void) -> some View {
        toolbar {
            if let cancel { ToolbarItem(placement: .cancellationAction) { Button("取消", action: cancel) } }
            ToolbarItem(placement: .confirmationAction) {
                if saving { ProgressView() } else { Button("保存", action: save).disabled(!canSave) }
            }
        }
    }

    /// Row fill (and no separators: rows group by space) for lists styled with
    /// `groupedList()`; applies to every row of a `Section`.
    /// 设置/详情页的一行。底色是液态玻璃卡而不是实色块。
    ///
    /// 用 `.fill(.regularMaterial)` 而不是 `.glassEffect`：
    /// List 的行背景必须是「填满矩形」的视图，`glassEffect` 会把内容再包一层形状，
    /// 和 List 的行裁剪打架（圆角会错位）。材质 + 内高光描边在这里等价且稳。
    ///
    /// 行内边距必须显式给：`.insetGrouped` 的默认上下边距只有 11pt，而这里的
    /// 卡片圆角是 22pt——内容正好压在圆弧起势的位置上，一叠卡看着又挤又紧。
    /// 给到 14pt 的上下留白后，文字离卡边有一段呼吸，圆角也不再切到字。
    /// 左右也用 16pt，和 iOS 设置页的分组内容对齐。
    func groupedRow() -> some View {
        listRowBackground(
            // 卡片本身不再铺满整行高度：上下各留 5pt，行与行之间才有缝。
            // 之前圆角 22 的卡片直接首尾相接，视觉上成了一整块被横线切开的色块，
            // 这正是「每一行和下一行好挤」的来源——不是内边距不够，是卡片之间没有间隔。
            RoundedRectangle(cornerRadius: 22, style: Glass.corner)
                .fill(.regularMaterial)
                .overlay {
                    RoundedRectangle(cornerRadius: 22, style: Glass.corner)
                        .strokeBorder(
                            LinearGradient(
                                colors: [.white.opacity(0.16), .white.opacity(0.04), .black.opacity(0.06)],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 0.5
                        )
                }
                .padding(.vertical, 5)
        )
        .listRowSeparator(.hidden)
        // 内容内边距保持 14：卡片自己有了 5pt 外缩，内容再压 14 就有双层留白。
        .listRowInsets(EdgeInsets(top: 9, leading: 16, bottom: 9, trailing: 16))
    }

    /// A close button for a view presented as a sheet (it may also be pushed, where it has none).
    func closeButton(_ dismiss: DismissAction) -> some View {
        toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { dismiss() } label: { Image(systemName: "xmark") }
                    .accessibilityLabel("关闭")
            }
        }
    }
}

/// Lines past this are hard to follow, and a window can be far wider.
let readableColumnWidth: CGFloat = 760

/// Haptics, one vocabulary for the whole app (they follow the system's vibration setting):
/// a light tap for sending and small actions, a firmer one for stopping, a selection tick
/// for switches and pickers, and notifications for approvals, success and errors.
@MainActor
enum Haptics {
    static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func firm() { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
    /// Keys and repeated small presses.
    static func soft() { UIImpactFeedbackGenerator(style: .soft).impactOccurred(intensity: 0.6) }
    static func select() { UISelectionFeedbackGenerator().selectionChanged() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
}

/// Copy with a success tick.
@MainActor
func copyToPasteboard(_ text: String) {
    UIPasteboard.general.string = text
    Haptics.success()
}

/// Hide the keyboard, whichever field (or the terminal) holds it.
@MainActor
func dismissKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}

/// Empty the focused text view in place. Clearing a SwiftUI binding while a Chinese
/// input method is composing leaves the old text on screen (the binding is empty, the
/// view is not); ending the composition and emptying the view directly keeps the two
/// in step without rebuilding the field, so focus and the keyboard stay.
@MainActor
func clearFocusedTextInput() {
    switch UIResponder.focused {
    case let view as UITextView:
        view.unmarkText()
        view.text = ""
    case let field as UITextField:
        field.unmarkText()
        field.text = ""
    default:
        break
    }
}

private extension UIResponder {
    static weak var found: UIResponder?

    /// The first responder: an action sent to nil reaches it.
    static var focused: UIResponder? {
        found = nil
        UIApplication.shared.sendAction(#selector(captureFirstResponder), to: nil, from: nil, for: nil)
        return found
    }

    @objc func captureFirstResponder() { UIResponder.found = self }
}

/// The drawer button: two lines, the lower one shorter.
struct DrawerGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let unit = rect.width / 24
        path.move(to: CGPoint(x: 4 * unit, y: rect.minY + 8 * unit))
        path.addLine(to: CGPoint(x: 20 * unit, y: rect.minY + 8 * unit))
        path.move(to: CGPoint(x: 4 * unit, y: rect.minY + 16 * unit))
        path.addLine(to: CGPoint(x: 14 * unit, y: rect.minY + 16 * unit))
        return path
    }
}

struct DrawerButton: View {
    let action: () -> Void

    // 原来是纯抽屉图标——一眼看不出这是哪个 App，也看不出背后是谁。
    // 现在做成「Σ + 抽屉线」的组合：Σ 是身份（Sigma），线条保留"这里有侧边栏"的既有语义。
    // 尺寸维持 22×22，不改变导航栏高度，也不影响右侧按钮的排布。
    var body: some View {
        Button(action: action) {
            HStack(spacing: 3) {
                Text("Σ")
                    .font(.system(size: 17, weight: .semibold, design: .default))
                    .foregroundStyle(Palette.ink)
                DrawerGlyph()
                    .stroke(Palette.secondary, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                    .frame(width: 15, height: 15)
            }
            .frame(height: 22)
        }
        .accessibilityLabel("打开侧边栏")
    }
}
