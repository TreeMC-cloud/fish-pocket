import SwiftUI

/// AI 生成的面板可以「钉」在这儿，不随聊天滚走。
///
/// 为什么需要它：
///   现在 ```schemaJson 面板只能作为一条消息出现在时间线里——AI 给你看了张
///   任务进度 / 数据概览，你往上滑两步它就没了，想再看只能让它重新生成。
///   面板本来就是「一直该在那儿」的东西，所以给它一个常驻位置。
///
/// 形态：
///   - 收起：输入条上方一条玻璃胶囊，显示面板标题 + 一个有内容的摘要。
///   - 展开：一张玻璃卡，从胶囊下方长出来，限高可滚。
///   之所以默认收起：面板会把输入框往上顶，第一次见到的人会以为界面坏了。
struct PanelDock: View {
    /// 最近一次可以钉住的面板。
    let node: JSON
    let title: String
    /// 收起了没有。由对话持有，换会话时能一起保留。
    @Binding var collapsed: Bool
    /// 用户把它关了：本会话不再显示。
    let dismiss: () -> Void

    /// 展开时的最大高度，超过就在卡内滚动。
    private let maxExpandedHeight: CGFloat = 300

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if !collapsed {
                Divider().padding(.horizontal, 14)
                ScrollView {
                    GenUIView(node: node)
                        .padding(14)
                }
                .frame(maxHeight: maxExpandedHeight)
                .scrollBounceBehavior(.basedOnSize)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .glassCard(radius: 24, .panel)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button {
                Haptics.tap()
                withAnimation(.snappy(duration: 0.26)) { collapsed.toggle() }
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: "rectangle.on.rectangle.angled")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Palette.ink)
                    Text(title)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Image(systemName: collapsed ? "chevron.down" : "chevron.up")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Palette.faint)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                Haptics.tap()
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Palette.faint)
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("关闭面板")
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 11)
    }
}

/// 从时间线里挑出「该钉住的面板」。
///
/// 判据：只钉最后一条带 ```schemaJson 的助手消息。
/// 为什么不钉所有历史面板：它们是对话的一部分，钉多了等于把时间线抄一遍，
/// 而且「我到底在看哪一版」会立刻变得不清楚。
enum PanelDockPicker {
        /// 从时间线里找最后一个可钉面板。
    ///
    /// 用 `items` 而不是原始事件：`Timeline` 已经把消息拆成了正文块，
    /// 这里只要顺着正文找最后一个 ```schemaJson 就够，不必重新解析事件流。
    ///
    /// 从 `items` 里扫出最后一个可钉面板。
    ///
    /// 不在这里做缓存：这个函数在 `body` 里调用，缓存必须跟着会话走，
    /// 放成 static 会让 A 会话的面板漏到 B 会话。调用方用 `@State` 持有一份，
    /// 并在 `items.last?.id` 变化时重算（见 ConversationView）。
    static func latest(in items: [Timeline.Item]) -> (node: JSON, title: String, id: String)? {
        for item in items.reversed() {
            guard case .assistant(_, let blocks, _, _) = item else { continue }
            for block in blocks.reversed() {
                guard case .text(let id, let text) = block else { continue }
                guard let parsed = firstSchemaBlock(in: text), let node = GenUIView.parse(parsed) else { continue }
                let title = node["props"]["title"].string
                    ?? node["children"].array.first?["props"]["title"].string
                    ?? String(localized: "面板")
                return (node, title, id)
            }
        }
        return nil
    }

    /// 从 Markdown 里抠出第一个 ```schemaJson 块。和 MarkdownView 的判据保持一致。
    static func firstSchemaBlock(in text: String) -> String? {
        var inBlock = false
        var buffer: [String] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inBlock {
                    return buffer.joined(separator: "\n")
                } else {
                    let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    guard language == "schemaJson" else { return nil }
                    inBlock = true
                    buffer = []
                }
                continue
            }
            if inBlock { buffer.append(String(line)) }
        }
        return nil
    }
}

/// 钉住的面板。单独定义是因为 `@State` 需要 `Equatable`（`onChange` 判等用）。
struct PinnedPanel: Equatable {
    let node: JSON
    let title: String
    let id: String

    static func == (lhs: PinnedPanel, rhs: PinnedPanel) -> Bool { lhs.id == rhs.id }
}

// MARK: - 钉住环境值

/// 把「钉住这张面板」的动作为 Markdown 渲染好的面板提供下去。
///
/// 为什么用 Environment 而不是给 MarkdownView 加参数：
///   MarkdownView 的签名被时间线、详情页、子代理页好几处用，
///   加一个只有面板关心的参数会污染所有调用点，还容易漏传。
private struct PinPanelKey: EnvironmentKey {
    static let defaultValue: ((JSON, String) -> Void)? = nil
}

extension EnvironmentValues {
    var pinPanel: ((JSON, String) -> Void)? {
        get { self[PinPanelKey.self] }
        set { self[PinPanelKey.self] = newValue }
    }
}

/// 面板右上角的小按钮：把这它钉到面板坞。
struct PinPanelButton: View {
    let node: JSON
    let title: String
    @Environment(\.pinPanel) private var pin

    var body: some View {
        if let pin {
            Button {
                Haptics.tap()
                pin(node, title)
            } label: {
                Image(systemName: "pin")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Palette.secondary)
                    .frame(width: 26, height: 26)
                    .glassSurface(
                        RoundedRectangle(cornerRadius: 8, style: Glass.corner),
                        .floating
                    )
            }
            .buttonStyle(GlassButtonStyle())
            .accessibilityLabel("钉到面板坞")
        }
    }
}
