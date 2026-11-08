import SwiftUI

/// 输入条上方的模型药丸：**任何会话**都能看到「下一句会用哪个模型」，点一下就换。
///
/// 为什么需要它：
///   原来 `ModelPicker` 只挂在空会话的导航标题上（`ConversationView` 里
///   `else if blank || ...` 那个分支）。一旦开口说话，标题位置换成了
///   `SessionTitleMenu`，模型名就从界面上消失了——想换模型得先开新会话，
///   或者去设置里改全局默认（那是改「以后所有会话」，不是改这一个）。
///   这是「当前会话换模型」缺失的根因。
///
/// 为什么放输入条上方而不是标题栏：
///   1. 标题栏在已开始的会话里被标题占用，挤不下
///   2. 模型是「发送动作」的属性，跟输入框放一起语义更近
///   3. 换模型后立刻看得到结果（发送键旁边的名字变了），反馈闭环短
///
/// 为什么不做成常驻一整条：
///   只在有模型信息时才显示。没配 Key / 目录还没加载完的会话里，显示一个
///   「暂无模型」的空药丸只会制造焦虑，不如不显示。
struct SessionModelPill: View {
    let model: SessionModel
    let context: ComposerContext
    @Environment(AppModel.self) private var app

    /// 搜索页的开关。模型多的时候菜单太长，需要独立一页。
    @State private var searching = false

    var body: some View {
        // 空会话不显示：那里标题栏已经有完整的 `ModelPicker`，再来一个就是重复。
        if let selection = context.selection(model), let name = displayName(selection) {
            Menu {
                if context.catalog.flatMap(\.models).count > 4 {
                    Button { searching = true } label: { Label("搜索模型…", systemImage: "magnifyingglass") }
                }
                ForEach(context.catalog) { group in
                    Section(group.name) {
                        ForEach(group.models) { choice in item(choice) }
                    }
                }
                if !context.catalogFailures.isEmpty {
                    Section {
                        ForEach(context.catalogFailures, id: \.id) { failure in
                            Label("\(failure.name) 加载失败", systemImage: "exclamationmark.triangle")
                        }
                        Button { Task { await context.loadCatalog(model) } } label: {
                            Label("重新加载", systemImage: "arrow.clockwise")
                        }
                    }
                }
                // 换模型是「这一句话用谁答」的决定，用户随时可能反悔：
                // 给一条明确的回退路径，比让他去设置里翻全局默认好。
                // 注意 catalogDefault 是元组不是 ModelChoice，要先用目录里的真身，
                // 否则 selectModel 拿不到 reasoningEfforts。
                if model.modelSelection != nil, let fallback = defaultChoice {
                    Section {
                        Button {
                            Haptics.tap()
                            Task { await model.selectModel(fallback, effort: fallback.defaultEffort) }
                        } label: {
                            Label("恢复默认（\(fallback.name)）", systemImage: "arrow.uturn.backward")
                        }
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "cpu")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Palette.secondary)
                    Text(name)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let effort = context.effortName(model) {
                        Text(effort)
                            .font(.caption2)
                            .foregroundStyle(Palette.secondary)
                            .lineLimit(1)
                    }
                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(Palette.faint)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .glassPill(.floating)
            .accessibilityLabel(Text("模型：\(name)"))
            .accessibilityHint(Text("切换当前会话使用的模型"))
            .sheet(isPresented: $searching) { ModelSearchSheet(model: model, context: context) }
            // 供应商的 key / 适配器变了，菜单里的列表要跟着变。
            .onChange(of: app.revision(
                "llm/adapters-updated",
                "settings/document-updated",
                "credentials/record-updated",
                "credentials/reference-updated"
            )) {
                Task { await context.loadCatalog(model) }
            }
        }
    }

    /// 目录里的默认模型真身。`catalogDefault` 只是元组，`selectModel` 要 `ModelChoice`。
    private var defaultChoice: ModelChoice? {
        guard let fallback = context.catalogDefault else { return nil }
        return context.catalog.flatMap(\.models).first {
            $0.provider == fallback.provider && $0.model == fallback.model
        }
    }

    /// 目录里查得到就用全名（`DeepSeek-V4.1-Flash`），查不到就退回收到的 id。
    ///
    /// 为什么需要兜底：会话记录的模型可能已被移除（换供应商、模型下线），
    /// 这时 `catalog` 里找不到它，但用户仍该看到「这个会话现在挂在一个不存在的
    /// 模型上」——这比什么都不显示有用得多，否则他只会遇到发消息失败。
    private func displayName(_ selection: (provider: String, model: String, effort: String?)) -> String? {
        if let found = context.catalog.flatMap(\.models).first(where: {
            $0.provider == selection.provider && $0.model == selection.model
        }) {
            return found.name
        }
        return selection.model.isEmpty ? nil : selection.model
    }

    @ViewBuilder
    private func item(_ choice: ModelChoice) -> some View {
        let current = isCurrent(choice)
        let title = ModelPicker.title(choice)
        if choice.reasoningEfforts.isEmpty {
            Button {
                Haptics.select()
                Task { await model.selectModel(choice, effort: nil) }
            } label: {
                if current { Label(title, systemImage: "checkmark") } else { Text(title) }
            }
        } else {
            Menu {
                ForEach(choice.reasoningEfforts, id: \.id) { effort in
                    Button {
                        Haptics.select()
                        Task { await model.selectModel(choice, effort: effort.id) }
                    } label: {
                        if current && (context.selection(model)?.effort ?? choice.defaultEffort) == effort.id {
                            Label(effort.name, systemImage: "checkmark")
                        } else {
                            Text(effort.name)
                        }
                    }
                }
            } label: {
                if current { Label(title, systemImage: "checkmark") } else { Text(title) }
            }
        }
    }

    private func isCurrent(_ choice: ModelChoice) -> Bool {
        guard let selection = context.selection(model) else { return false }
        return selection.provider == choice.provider && selection.model == choice.model
    }
}
