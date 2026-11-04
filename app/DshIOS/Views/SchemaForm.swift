import SwiftUI

/// One node of a serialized schemastery schema, with the uid it was stored under
/// (the key order of its fields is looked up by that uid).
struct SchemaNode: Hashable {
    let json: JSON
    let uid: String?

    var type: String { json["type"].string ?? "" }
    var meta: JSON { json["meta"] }
    var role: String? { meta["role"].string }
    var hidden: Bool { meta["hidden"].bool == true }
    var required: Bool { meta["required"].bool == true }
    var disabled: Bool { meta["disabled"].bool == true }
    var defaultValue: JSON? { meta["default"].nonNull }
}

/// A serialized schemastery schema (`{uid, refs}`), as `settings/describe` sends it:
/// child nodes are uid references into `refs` (they may be shared or recursive).
struct SchemaGraph {
    let refs: [String: JSON]
    let root: SchemaNode
    /// Field order per object uid; fields of an unknown uid fall back to name order.
    let order: [String: [String]]

    init(_ json: JSON, order: [String: [String]] = [:]) {
        let refs = json["refs"].object
        self.refs = refs
        self.order = order
        let uid = json["uid"].int.map(String.init) ?? json["uid"].string
        root = uid.flatMap { id in refs[id].map { SchemaNode(json: $0, uid: id) } } ?? SchemaNode(json: json, uid: nil)
    }

    /// Resolve a reference (a uid, or an inline node), then unwrap `lazy` and `transform`
    /// (their callbacks are function source a native client ignores; the inner schema renders).
    func node(_ ref: JSON) -> SchemaNode {
        var current: SchemaNode
        if let id = ref.int.map(String.init) ?? ref.string, let json = refs[id] {
            current = SchemaNode(json: json, uid: id)
        } else {
            current = SchemaNode(json: ref, uid: nil)
        }
        var hops = 0
        while ["lazy", "transform"].contains(current.type), !current.json["inner"].isNull, hops < 8 {
            let meta = current.meta
            let inner = node(current.json["inner"])
            // The outer node's meta (description, default…) applies to what it wraps.
            current = SchemaNode(json: inner.json.setting(["meta"], .object(inner.meta.object.merging(meta.object) { inner, _ in inner })), uid: inner.uid)
            hops += 1
        }
        return current
    }

    func list(_ node: SchemaNode) -> [SchemaNode] { node.json["list"].array.map(self.node) }
    func inner(_ node: SchemaNode) -> SchemaNode { self.node(node.json["inner"]) }

    /// An object's fields in schema order; an intersect contributes the fields of
    /// every object branch it joins (F-18).
    func fields(_ node: SchemaNode) -> [(key: String, node: SchemaNode)] {
        switch node.type {
        case "object":
            let dict = node.json["dict"].object
            let ordered = node.uid.flatMap { order[$0] } ?? dict.keys.sorted()
            var keys = ordered.filter { dict[$0] != nil }
            keys += dict.keys.filter { !keys.contains($0) }.sorted()
            return keys.map { ($0, self.node(dict[$0]!)) }
        case "intersect":
            var seen = Set<String>()
            var result: [(key: String, node: SchemaNode)] = []
            for branch in list(node) where branch.type == "object" || branch.type == "intersect" {
                for field in fields(branch) where !seen.contains(field.key) {
                    seen.insert(field.key)
                    result.append(field)
                }
            }
            return result
        default:
            return []
        }
    }

    /// The branches of an intersect that are not plain objects (unions of objects, mostly).
    func extraBranches(_ node: SchemaNode) -> [SchemaNode] {
        guard node.type == "intersect" else { return [] }
        return list(node).filter { $0.type != "object" && $0.type != "intersect" }
    }

    /// Union of constants → the values of a picker.
    func choices(_ node: SchemaNode) -> [JSON]? {
        guard node.type == "union" else { return nil }
        let members = list(node)
        guard !members.isEmpty, members.allSatisfy({ $0.type == "const" }) else { return nil }
        return members.map { $0.json["value"] }
    }

    /// The node at `path` below `start`: object fields, dict and array elements, and
    /// the first union / intersect branch that has the next step.
    func node(at path: [String], from start: SchemaNode? = nil) -> SchemaNode? {
        var current = start ?? root
        for key in path {
            guard let next = step(current, key) else { return nil }
            current = next
        }
        return current
    }

    private func step(_ node: SchemaNode, _ key: String) -> SchemaNode? {
        switch node.type {
        case "object", "intersect":
            if let field = fields(node).first(where: { $0.key == key }) { return field.node }
            for branch in extraBranches(node) { if let found = step(branch, key) { return found } }
            return nil
        case "dict", "array":
            return inner(node)
        case "tuple":
            return Int(key).flatMap { index in list(node).indices.contains(index) ? Optional(list(node)[index]) : nil }
        case "union":
            for branch in list(node) { if let found = step(branch, key) { return found } }
            return nil
        default:
            return nil
        }
    }

    /// The label of a constant: its (localized) description, else its value.
    func label(ofConst value: JSON, in node: SchemaNode) -> String {
        if let member = list(node).first(where: { $0.json["value"] == value }), let text = schemaText(member.meta["description"]) { return text }
        return value.compactText
    }
}

/// A schemastery i18n description (`string` or `{"": …, zh: …, en: …}`) in the
/// reader's language: the language, its primary subtag, `en`, then the untranslated text.
func schemaText(_ value: JSON) -> String? {
    if let text = value.string { return text.isEmpty ? nil : text }
    let object = value.object
    guard !object.isEmpty else { return nil }
    let preferred = (Locale.preferredLanguages.first ?? "zh").lowercased()
    let primary = String(preferred.prefix { $0 != "-" && $0 != "_" })
    let candidates = [preferred, primary, primary == "zh" ? "zh-cn" : primary, "en", ""]
    for key in candidates {
        if let match = object.first(where: { $0.key.lowercased() == key })?.value.string, !match.isEmpty { return match }
    }
    return object.values.compactMap(\.string).first
}

/// Field labels: the schema's own (localized) description when it is short, else the key, humanized.
func schemaLabel(_ key: String, _ node: SchemaNode) -> String {
    if let text = schemaText(node.meta["description"]), text.count <= 40, !text.contains("\n") { return text }
    return humanize(key)
}

/// A long description, shown under the field instead of as its label.
func schemaHelp(_ node: SchemaNode) -> String? {
    guard let text = schemaText(node.meta["description"]), text.count > 40 || text.contains("\n") else { return nil }
    return text
}

func humanize(_ key: String) -> String {
    var words = ""
    for character in key {
        if character.isUppercase, !words.isEmpty, words.last != " " { words.append(" ") }
        words.append(character == "_" || character == "-" ? " " : character)
    }
    return words.prefix(1).uppercased() + words.dropFirst()
}

// MARK: - Form context

/// Where a form's edits go and what it reads: the namespace (writes are `settings/mutate`
/// path ops) or a local value an array or tuple editor saves as a whole.
struct SchemaFormContext {
    let graph: SchemaGraph
    /// The effective value of the form's root.
    let value: JSON
    /// The user layer: a field present there can be reset. Nil for local values.
    let user: JSON?
    /// `secrets[]`: the path of each secret slot and whether it is set.
    let secrets: [[String]: Bool]
    let disabled: Bool
    /// Write `value` at `path`; nil unsets it (falling back to the inherited value).
    let save: ([String], JSON?) -> Void
    /// The namespace the form edits, for credential references; nil for local values.
    var namespace: String?

    func value(at path: [String]) -> JSON? { value.value(at: path) }
    func overridden(_ path: [String]) -> Bool { user?.has(path) ?? false }
}

/// The page of one settings namespace (the generic form, used where no native page
/// exists): every edit is written on its own as soon as it is committed.
struct NamespaceFormView: View {
    @Environment(AppModel.self) private var app
    let title: String
    let ns: String

    var body: some View {
        let mirror = app.settings
        Form {
            if let namespace = mirror.namespace(ns), let graph = mirror.graph(ns) {
                if !mirror.writable {
                    Section { Label("设置当前为只读。", systemImage: "lock").foregroundStyle(Palette.secondary) }
                }
                let context = SchemaFormContext(
                    graph: graph,
                    value: namespace["value"],
                    user: namespace["user"],
                    secrets: Self.secretSlots(namespace),
                    disabled: !mirror.writable,
                    save: save,
                    namespace: ns
                )
                SchemaObjectSections(context: context, node: graph.root, path: [], depth: 0)
            } else if mirror.loaded {
                Section { Text("该插件当前未加载，暂时无法配置。").foregroundStyle(Palette.secondary) }
            } else {
                Section { ProgressView() }
            }
        }
        .tint(Palette.ink)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .keyboardDoneButton()
        .followSettings()
    }

    static func secretSlots(_ namespace: JSON) -> [[String]: Bool] {
        Dictionary(namespace["secrets"].array.map { ($0["path"].array.compactMap(\.string), $0["set"].bool ?? false) }, uniquingKeysWith: { $1 })
    }

    private func save(_ path: [String], _ value: JSON?) {
        Task {
            do {
                try await app.settings.set(ns, path, value)
            } catch {
                Haptics.error()
                app.showToast(describeFailure(error), duration: 5)
            }
        }
    }
}

extension View {
    /// One 完成 button over the keyboard (number pads have no return key); leaving the
    /// field commits it. Attach once per form, not per field (each would add a button).
    func keyboardDoneButton() -> some View {
        toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("完成") { dismissKeyboard() }.fontWeight(.semibold)
            }
        }
    }
}

/// The one saving model of an edit page: 保存 in the toolbar, where the keyboard never covers
/// it. With unsaved edits, the back button and the sheet's swipe give way to 取消, which
/// asks before dropping them.
private struct EditPageChrome: ViewModifier {
    @Environment(\.dismiss) private var dismiss
    let dirty: Bool
    let canSave: Bool
    let saving: Bool
    let save: () -> Void
    let discard: () -> Void
    @State private var confirming = false

    func body(content: Content) -> some View {
        content
            .saveToolbar(canSave: dirty && canSave, saving: saving, cancel: dirty ? { confirming = true } : nil, save: save)
            .navigationBarBackButtonHidden(dirty)
            .interactiveDismissDisabled(dirty)
            .alert("放弃修改？", isPresented: $confirming) {
                Button("继续编辑", role: .cancel) {}
                Button("放弃", role: .destructive) {
                    discard()
                    dismiss()
                }
            }
    }
}

extension View {
    func editPage(dirty: Bool, canSave: Bool, saving: Bool = false, discard: @escaping () -> Void = {}, save: @escaping () -> Void) -> some View {
        modifier(EditPageChrome(dirty: dirty, canSave: canSave, saving: saving, save: save, discard: discard))
    }

    /// 恢复默认 on a row whose value the user set: swipe left or long-press. The modifiers stay
    /// on while it is not offered, so the row keeps its identity (and a field its focus).
    func resettable(_ offered: Bool, title: LocalizedStringKey = "恢复默认", reset: @escaping () -> Void) -> some View {
        swipeActions(edge: .trailing) {
            if offered {
                Button(title) { Haptics.tap(); reset() }.tint(Palette.secondary)
            }
        }
        .contextMenu {
            if offered {
                Button(title, systemImage: "arrow.uturn.backward") { Haptics.tap(); reset() }
            }
        }
    }
}

// MARK: - Objects

/// An object's fields as form sections: leaves in one section, then nested
/// objects as their own sections (first level) or pages (deeper, or `collapse`).
struct SchemaObjectSections: View {
    let context: SchemaFormContext
    let node: SchemaNode
    let path: [String]
    let depth: Int

    var body: some View {
        let fields = context.graph.fields(node).filter { !$0.node.hidden }
        let leaves = fields.filter { !isGroup($0.node) }
        let groups = fields.filter { isGroup($0.node) }
        let extras = context.graph.extraBranches(node)
        if !leaves.isEmpty || !extras.isEmpty {
            Section {
                ForEach(leaves, id: \.key) { field in
                    SchemaField(context: context, key: field.key, node: field.node, path: path + [field.key])
                }
                ForEach(Array(extras.enumerated()), id: \.offset) { _, branch in
                    SchemaField(context: context, key: "", node: branch, path: path, merge: true)
                }
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    if depth == 0, let help = schemaHelp(node) { Text(help) }
                    if let missing = missingRequired(leaves) { Text("需要填写：\(missing)") }
                }
            }
        }
        ForEach(groups, id: \.key) { field in
            let childPath = path + [field.key]
            if depth == 0 && field.node.meta["collapse"].bool != true {
                Section {
                    SchemaGroupLink(context: context, key: field.key, node: field.node, path: childPath, inline: true)
                    if context.overridden(childPath) {
                        Button("恢复本组默认") { Haptics.tap(); context.save(childPath, nil) }
                            .foregroundStyle(Palette.ink)
                            .disabled(context.disabled)
                    }
                } header: {
                    FieldHeader(key: field.key, node: field.node)
                }
            } else {
                Section {
                    SchemaGroupLink(context: context, key: field.key, node: field.node, path: childPath, inline: false)
                        .resettable(context.overridden(childPath)) { context.save(childPath, nil) }
                }
            }
        }
    }

    private func isGroup(_ node: SchemaNode) -> Bool { node.type == "object" || node.type == "intersect" }

    /// Required fields still empty, for the section footer.
    private func missingRequired(_ fields: [(key: String, node: SchemaNode)]) -> String? {
        let missing = fields.filter { field in
            guard field.node.required else { return false }
            let value = context.value(at: path + [field.key])
            return value == nil || value?.isNull == true || value?.string?.isEmpty == true
        }
        return missing.isEmpty ? nil : missing.map { schemaLabel($0.key, $0.node) }.joined(separator: String(localized: "、"))
    }
}

/// A nested object: its leaves inline (a first-level group) or a page of its own.
private struct SchemaGroupLink: View {
    let context: SchemaFormContext
    let key: String
    let node: SchemaNode
    let path: [String]
    let inline: Bool

    var body: some View {
        let fields = context.graph.fields(node).filter { !$0.node.hidden }
        if inline && fields.allSatisfy({ $0.node.type != "object" && $0.node.type != "intersect" }) && context.graph.extraBranches(node).isEmpty && fields.count <= 6 {
            ForEach(fields, id: \.key) { field in
                SchemaField(context: context, key: field.key, node: field.node, path: path + [field.key])
            }
        } else {
            NavigationLink {
                Form { SchemaObjectSections(context: context, node: node, path: path, depth: 1) }
                    .tint(Palette.ink)
                    .navigationTitle(schemaLabel(key, node))
                    .navigationBarTitleDisplayMode(.inline)
                    .keyboardDoneButton()
            } label: {
                Text(inline ? String(localized: "全部选项") : schemaLabel(key, node))
            }
        }
    }
}

// MARK: - Field chrome

/// Schema badges (`experimental` / `deprecated`).
struct SchemaBadges: View {
    let node: SchemaNode

    var body: some View {
        ForEach(Array(node.meta["badges"].array.enumerated()), id: \.offset) { _, badge in
            let text = badge["text"].string ?? ""
            Text(text == "experimental" ? String(localized: "实验性") : text == "deprecated" ? String(localized: "已弃用") : text)
                .font(.caption2.weight(.medium))
                .foregroundStyle(badge["type"].string == "danger" ? Palette.removed : Palette.waiting)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background((badge["type"].string == "danger" ? Palette.removed : Palette.waiting).opacity(0.12), in: Capsule())
        }
    }
}

/// A section header for a group field.
private struct FieldHeader: View {
    let key: String
    let node: SchemaNode

    var body: some View {
        HStack(spacing: 6) {
            Text(schemaLabel(key, node))
            SchemaBadges(node: node)
        }
    }
}

/// The label of a field: its name and badges. Required fields say so in the section footer.
private struct FieldLabel: View {
    let key: String
    let node: SchemaNode

    var body: some View {
        HStack(spacing: 6) {
            Text(key.isEmpty ? schemaText(node.meta["description"]) ?? String(localized: "选项") : schemaLabel(key, node))
                .foregroundStyle(Palette.ink)
                .accessibilityHint(node.required ? Text("必填") : Text(""))
            SchemaBadges(node: node)
        }
    }
}

/// Help, comment, link and validation text under a field.
private struct FieldNotes: View {
    let node: SchemaNode
    var problem: String?

    var body: some View {
        if let problem {
            Text(problem).font(.caption).foregroundStyle(Palette.removed)
        }
        if let help = schemaHelp(node) {
            Text(help).font(.caption).foregroundStyle(Palette.secondary)
        }
        if let comment = schemaText(node.meta["comment"]) {
            Text(comment).font(.caption).foregroundStyle(Palette.faint)
        }
        if let link = node.meta["link"].string, let url = URL(string: link) {
            Link("了解更多", destination: url).font(.caption)
        }
    }
}

// MARK: - Fields

/// One field, by its schema type (F-01…F-21). `merge` renders a union of objects
/// in place inside its parent object (an intersect's union branch).
struct SchemaField: View {
    let context: SchemaFormContext
    let key: String
    let node: SchemaNode
    let path: [String]
    var merge = false
    /// The caller gave the row its own swipe actions (a dict entry's 删除).
    var ownsRowActions = false

    /// Secrets clear through their own dialog; a free union resets its own row, with its choice.
    private var resettable: Bool {
        !merge && !ownsRowActions && node.role != "secret" && context.secrets[path] == nil
            && (node.type != "union" || context.graph.choices(node) != nil)
    }

    var body: some View {
        if resettable {
            field.resettable(context.overridden(path)) { context.save(path, nil) }
        } else {
            field
        }
    }

    @ViewBuilder
    private var field: some View {
        let overridden = !merge && context.overridden(path)
        let current = context.value(at: path) ?? node.defaultValue
        Group {
            if node.hidden {
                EmptyView()
            } else if node.role == "secret" || context.secrets[path] != nil {
                SecretField(context: context, key: key, node: node, path: path)
            } else if node.role == "credential-ref" {
                CredentialRefField(context: context, key: key, node: node, path: path, overridden: overridden)
            } else if let choices = context.graph.choices(node) {
                choiceField(choices, current: current)
            } else {
                switch node.type {
                case "boolean":
                    VStack(alignment: .leading, spacing: 4) {
                        Toggle(isOn: Binding(get: { current?.bool ?? false }, set: { context.save(path, .bool($0)) })) {
                            FieldLabel(key: key, node: node)
                        }
                        .toggleStyle(.mono)
                        FieldNotes(node: node)
                    }
                case "number", "natural", "percent":
                    NumberField(context: context, key: key, node: node, path: path, overridden: overridden)
                case "string":
                    StringField(context: context, key: key, node: node, path: path, overridden: overridden)
                case "const":
                    LabeledContent { Text(node.json["value"].compactText).foregroundStyle(Palette.secondary) } label: {
                        FieldLabel(key: key, node: node)
                    }
                case "union":
                    UnionField(context: context, key: key, node: node, path: path, overridden: overridden, merge: merge)
                case "object", "intersect":
                    SchemaGroupLink(context: context, key: key, node: node, path: path, inline: false)
                case "dict":
                    NavigationLink {
                        DictEditor(context: context, key: key, node: node, path: path)
                    } label: {
                        LabeledContent {
                            Text(String(localized: "\(current?.object.count ?? 0) 项")).foregroundStyle(Palette.secondary)
                        } label: { FieldLabel(key: key, node: node) }
                    }
                case "array":
                    NavigationLink {
                        ArrayEditor(context: context, title: schemaLabel(key, node), node: node, path: path)
                    } label: {
                        LabeledContent {
                            Text(String(localized: "\(current?.array.count ?? 0) 项")).foregroundStyle(Palette.secondary)
                        } label: { FieldLabel(key: key, node: node) }
                    }
                case "tuple":
                    NavigationLink {
                        TupleEditor(context: context, title: schemaLabel(key, node), node: node, path: path)
                    } label: {
                        LabeledContent {
                            Text(current?.compactText ?? "").foregroundStyle(Palette.secondary).lineLimit(1)
                        } label: { FieldLabel(key: key, node: node) }
                    }
                case "bitset":
                    BitsetField(context: context, key: key, node: node, path: path)
                default:
                    // any / is / function / never: nothing a form can edit.
                    VStack(alignment: .leading, spacing: 4) {
                        LabeledContent {
                            Text(current?.compactText ?? "—").foregroundStyle(Palette.secondary).lineLimit(1)
                        } label: { FieldLabel(key: key, node: node) }
                        Text("请在配置文件中编辑").font(.caption).foregroundStyle(Palette.faint)
                    }
                }
            }
        }
        .disabled(context.disabled || node.disabled)
    }

    /// F-12: a picker over constants; a stored value outside them stays listed (loose).
    @ViewBuilder
    private func choiceField(_ choices: [JSON], current: JSON?) -> some View {
        let shown = current.map { choices.contains($0) ? choices : choices + [$0] } ?? choices
        VStack(alignment: .leading, spacing: 4) {
            Picker(selection: Binding(get: { current ?? .null }, set: { context.save(path, $0) })) {
                if current == nil { Text("未设置").tag(JSON.null) }
                ForEach(shown, id: \.self) { choice in
                    Text(context.graph.label(ofConst: choice, in: node)).tag(choice)
                }
            } label: {
                FieldLabel(key: key, node: node)
            }
            .pickerStyle(.menu)
            FieldNotes(node: node)
        }
    }
}

/// A text field that commits when it loses focus (or on return), so number pads
/// without a return key still save (F-09), and a page left mid-edit keeps the edit.
private struct CommitTextField: View {
    let placeholder: String
    @Binding var text: String
    var keyboard: UIKeyboardType = .default
    var monospaced = false
    var alignment: TextAlignment = .trailing
    let commit: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        TextField(placeholder, text: $text)
            .keyboardType(keyboard)
            .multilineTextAlignment(alignment)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(monospaced ? .body.monospaced() : .body)
            .focused($focused)
            .submitLabel(.done)
            .onSubmit { focused = false }
            .onChange(of: focused) { _, now in if !now { commit() } }
            .onDisappear { if focused { commit() } }
    }
}

/// F-09 / F-10: a number. Blank unsets (the default applies), anything that is not a
/// finite number in range is refused in place. An integer field with bounds also
/// gets a stepper, whose taps commit after a short pause.
private struct NumberField: View {
    let context: SchemaFormContext
    let key: String
    let node: SchemaNode
    let path: [String]
    let overridden: Bool
    @State private var text = ""
    @State private var problem: String?
    @State private var stepTask: Task<Void, Never>?

    private var stored: Double? { context.value(at: path)?.double }
    private var step: Double? { node.meta["step"].double }
    private var integer: Bool { step.map { $0.rounded() == $0 } ?? false }
    private var minimum: Double? { node.meta["min"].double }
    private var maximum: Double? { node.meta["max"].double }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if node.role == "slider" {
                slider
            } else {
                LabeledContent {
                    HStack(spacing: 8) {
                        CommitTextField(placeholder: placeholder, text: $text, keyboard: integer && (minimum ?? -1) >= 0 ? .numberPad : .decimalPad, commit: commit)
                        if node.role == "ms" { Text("毫秒").font(.footnote).foregroundStyle(Palette.secondary) }
                        if integer, minimum != nil, maximum != nil {
                            Stepper("", onIncrement: { bump(1) }, onDecrement: { bump(-1) }).labelsHidden().fixedSize()
                        }
                    }
                } label: {
                    FieldLabel(key: key, node: node)
                }
            }
            FieldNotes(node: node, problem: problem)
        }
        .onAppear { text = format(stored) }
        .onChange(of: stored) { _, value in text = format(value); problem = nil }
    }

    private var placeholder: String {
        if let value = node.defaultValue?.double { return format(value) }
        return String(localized: "默认")
    }

    private var slider: some View {
        VStack(alignment: .leading) {
            FieldLabel(key: key, node: node)
            let range = (minimum ?? 0)...(maximum ?? 1)
            HStack {
                Slider(value: Binding(get: { Double(text) ?? stored ?? node.defaultValue?.double ?? range.lowerBound }, set: { text = format($0) }),
                       in: range, step: step ?? 0.01,
                       onEditingChanged: { editing in if !editing { commit() } })
                Text(text).font(.footnote.monospacedDigit()).foregroundStyle(Palette.secondary).frame(minWidth: 36)
            }
        }
    }

    private func format(_ value: Double?) -> String {
        guard let value else { return "" }
        return value.rounded() == value && abs(value) < 1e15 ? String(Int(value)) : String(value)
    }

    private func bump(_ direction: Double) {
        let base = Double(text) ?? stored ?? node.defaultValue?.double ?? minimum ?? 0
        var next = base + direction * (step ?? 1)
        if let minimum { next = max(next, minimum) }
        if let maximum { next = min(next, maximum) }
        text = format(next)
        stepTask?.cancel()
        stepTask = Task {
            try? await Task.sleep(for: .milliseconds(600))
            if !Task.isCancelled { commit() }
        }
    }

    private func commit() {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            problem = nil
            // Nothing of the user's to clear: the inherited value stays on show.
            if overridden { context.save(path, nil) } else { text = format(stored) }
            return
        }
        guard let number = Double(trimmed), number.isFinite else {
            problem = String(localized: "请填数字；留空表示使用默认值。")
            return
        }
        if let minimum, number < minimum { problem = String(localized: "不能小于 \(format(minimum))。"); return }
        if let maximum, number > maximum { problem = String(localized: "不能大于 \(format(maximum))。"); return }
        if integer, number.rounded() != number { problem = String(localized: "请填整数。"); return }
        problem = nil
        // Passing through a field must not turn the inherited value into an override.
        if number != stored { context.save(path, .number(number)) }
    }
}

/// F-02 / F-05…F-08: text. Blank unsets; `pattern` and length bounds are checked first.
private struct StringField: View {
    let context: SchemaFormContext
    let key: String
    let node: SchemaNode
    let path: [String]
    let overridden: Bool
    @State private var text = ""
    @State private var problem: String?
    @FocusState private var editorFocused: Bool

    private var stored: String? { context.value(at: path)?.string }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch node.role {
            case "textarea", "markdown":
                FieldLabel(key: key, node: node)
                TextEditor(text: $text)
                    .frame(minHeight: 90)
                    .font(node.role == "markdown" ? .body.monospaced() : .body)
                    .focused($editorFocused)
                    .onChange(of: editorFocused) { _, now in if !now { commit() } }
                    .onDisappear { if editorFocused { commit() } }
            case "datetime", "date", "time":
                DatePicker(selection: Binding(get: { Self.parseDate(stored) ?? Date() }, set: { context.save(path, .string(Self.formatDate($0, role: node.role))) }),
                           displayedComponents: node.role == "date" ? [.date] : node.role == "time" ? [.hourAndMinute] : [.date, .hourAndMinute]) {
                    FieldLabel(key: key, node: node)
                }
            default:
                LabeledContent {
                    CommitTextField(placeholder: node.defaultValue?.string ?? "",
                                    text: $text,
                                    keyboard: node.role == "link" || node.role == "url" ? .URL : .default,
                                    monospaced: node.role == "regexp",
                                    commit: commit)
                } label: {
                    FieldLabel(key: key, node: node)
                }
            }
            FieldNotes(node: node, problem: problem)
        }
        .onAppear { text = stored ?? "" }
        .onChange(of: stored) { _, value in text = value ?? ""; problem = nil }
    }

    private func commit() {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty {
            if node.required { problem = String(localized: "此项必填。"); return }
            problem = nil
            if overridden { context.save(path, nil) } else { text = stored ?? "" }
            return
        }
        if let pattern = node.meta["pattern"]["source"].string ?? node.meta["pattern"].string {
            let flags = node.meta["pattern"]["flags"].string ?? ""
            let options: NSRegularExpression.Options = flags.contains("i") ? [.caseInsensitive] : []
            if let regex = try? NSRegularExpression(pattern: pattern, options: options),
               regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) == nil {
                problem = String(localized: "格式不符合要求（\(pattern)）。")
                return
            }
        }
        if node.role == "regexp", (try? NSRegularExpression(pattern: value)) == nil {
            problem = String(localized: "不是有效的正则表达式。")
            return
        }
        if let min = node.meta["min"].int, value.count < min { problem = String(localized: "至少 \(min) 个字符。"); return }
        if let max = node.meta["max"].int, value.count > max { problem = String(localized: "最多 \(max) 个字符。"); return }
        problem = nil
        if value != stored { context.save(path, .string(value)) }
    }

    static func parseDate(_ text: String?) -> Date? {
        guard let text else { return nil }
        let full = ISO8601DateFormatter()
        full.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return full.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    static func formatDate(_ date: Date, role: String?) -> String {
        let formatter = ISO8601DateFormatter()
        if role == "date" { formatter.formatOptions = [.withFullDate] }
        return formatter.string(from: date)
    }
}

/// F-03: a secret slot. The value never comes back; only whether it is set.
private struct SecretField: View {
    let context: SchemaFormContext
    let key: String
    let node: SchemaNode
    let path: [String]
    @State private var editing = false
    @State private var draft = ""

    var body: some View {
        let set = context.secrets[path] == true
        Button {
            draft = ""
            editing = true
        } label: {
            LabeledContent {
                Text(set ? "已设置" : "未设置").foregroundStyle(Palette.secondary)
            } label: {
                FieldLabel(key: key, node: node)
            }
        }
        .alert(schemaLabel(key, node), isPresented: $editing) {
            SecureField(set ? String(localized: "已设置（留空保持）") : String(localized: "未设置"), text: $draft)
            Button("取消", role: .cancel) {}
            if set { Button("清除", role: .destructive) { context.save(path, nil) } }
            Button("保存") { context.save(path, .string(draft.trimmingCharacters(in: .whitespacesAndNewlines))) }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("只保存在本机引擎里，任何读取接口都不会返回它。")
        }
    }
}

/// F-04: a credential reference. The field holds a reference name (`DEEPSEEK_API_KEY`),
/// not a key; the key itself goes to `credentials/set` under that name.
private struct CredentialRefField: View {
    @Environment(AppModel.self) private var app
    let context: SchemaFormContext
    let key: String
    let node: SchemaNode
    let path: [String]
    let overridden: Bool
    @State private var info: JSON?
    @State private var editingKey = false
    @State private var draft = ""
    @State private var refText = ""

    private var ref: String { context.value(at: path)?.string ?? node.defaultValue?.string ?? "" }

    var body: some View {
        Button {
            draft = ""
            editingKey = true
        } label: {
            LabeledContent {
                Text(status).foregroundStyle(Palette.secondary)
            } label: {
                FieldLabel(key: key, node: node)
            }
        }
        .disabled(ref.isEmpty || info?["writable"].bool == false)
        .onAppear { refText = context.value(at: path)?.string ?? "" }
        .task(id: "\(ref)#\(app.settingsRevision)") { await load() }
        .alert(schemaLabel(key, node), isPresented: $editingKey) {
            SecureField(info?["configured"].bool == true ? String(localized: "留空保持已存储的密钥") : String(localized: "输入密钥"), text: $draft)
            Button("取消", role: .cancel) {}
            if info?["configured"].bool == true && info?["source"].string == "file" {
                Button("清除", role: .destructive) { Task { await write(nil) } }
            }
            Button("保存") { Task { await write(draft.trimmingCharacters(in: .whitespacesAndNewlines)) } }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("密钥只保存在本机。")
        }
        NavigationLink {
            Form {
                Section {
                    CommitTextField(placeholder: node.defaultValue?.string ?? "", text: $refText, monospaced: true, alignment: .leading) {
                        let value = refText.trimmingCharacters(in: .whitespaces)
                        if value.isEmpty { if overridden { context.save(path, nil) } } else if value != ref { context.save(path, .string(value)) }
                    }
                } footer: {
                    Text("密钥在本机存储中的名字，一般不用改。")
                }
            }
            .tint(Palette.ink)
            .navigationTitle("凭据名")
            .navigationBarTitleDisplayMode(.inline)
            .keyboardDoneButton()
        } label: {
            LabeledContent("凭据名", value: ref)
        }
    }

    private var status: String {
        guard let info else { return "…" }
        guard info["configured"].bool == true else { return String(localized: "未配置") }
        return info["source"].string == "file" ? String(localized: "已保存") : String(localized: "已配置")
    }

    private func load() async {
        guard !ref.isEmpty else { info = nil; return }
        info = (try? await app.settings.describeCredentials([ref]))?[ref]
    }

    private func write(_ value: String?) async {
        do {
            if let value { try await app.settings.setCredential(ref, value) } else { try await app.settings.unsetCredential(ref) }
            app.showToast(value == nil ? String(localized: "已清除密钥") : String(localized: "密钥已保存"))
            await load()
        } catch {
            app.showToast(describeFailure(error), duration: 5)
        }
    }
}

/// F-13: a union that mixes constants with other shapes. Constants are picker
/// options; each other branch is one more option with its own editor below. A union
/// of objects picks its branch by the constant field the branches differ in.
private struct UnionField: View {
    let context: SchemaFormContext
    let key: String
    let node: SchemaNode
    let path: [String]
    let overridden: Bool
    let merge: Bool
    @State private var chosen: Int?

    private struct Option: Hashable {
        let index: Int
        let label: String
        let constant: JSON?
        let branch: SchemaNode?
        /// The discriminating field and value of an object branch.
        let discriminator: (key: String, value: JSON)?

        static func == (lhs: Option, rhs: Option) -> Bool { lhs.index == rhs.index }
        func hash(into hasher: inout Hasher) { hasher.combine(index) }
    }

    var body: some View {
        let options = self.options
        let current = context.value(at: path)
        let active = chosen.flatMap { index in options.first { $0.index == index } } ?? match(current, options)
        VStack(alignment: .leading, spacing: 6) {
            Picker(selection: Binding(get: { active?.index ?? -1 }, set: { select($0, options) })) {
                if active == nil { Text("未设置").tag(-1) }
                ForEach(options, id: \.index) { option in Text(option.label).tag(option.index) }
            } label: {
                FieldLabel(key: key, node: node)
            }
            .pickerStyle(.menu)
            FieldNotes(node: node)
        }
        .resettable(overridden) { chosen = nil; context.save(path, nil) }
        if let branch = active?.branch {
            branchEditor(branch, discriminator: active?.discriminator?.key)
        }
    }

    @ViewBuilder
    private func branchEditor(_ branch: SchemaNode, discriminator: String?) -> some View {
        switch branch.type {
        case "object", "intersect":
            ForEach(context.graph.fields(branch).filter { $0.key != discriminator && !$0.node.hidden }, id: \.key) { field in
                SchemaField(context: context, key: field.key, node: field.node, path: path + [field.key])
            }
        default:
            SchemaField(context: context, key: "", node: SchemaNode(json: branch.json.setting(["meta", "description"], .string(String(localized: "值"))), uid: branch.uid), path: path)
        }
    }

    private var options: [Option] {
        var result: [Option] = []
        for (index, member) in context.graph.list(node).enumerated() {
            switch member.type {
            case "const":
                let value = member.json["value"]
                let label = value.isNull ? String(localized: "无") : context.graph.label(ofConst: value, in: node)
                result.append(Option(index: index, label: label, constant: value, branch: nil, discriminator: nil))
            case "is", "function", "never", "any":
                continue
            case "object", "intersect":
                let disc = context.graph.fields(member).first { $0.node.type == "const" }
                let label = disc.map { schemaText($0.node.meta["description"]) ?? $0.node.json["value"].compactText } ?? schemaText(member.meta["description"]) ?? String(localized: "选项 \(index + 1)")
                result.append(Option(index: index, label: label, constant: nil, branch: member, discriminator: disc.map { ($0.key, $0.node.json["value"]) }))
            default:
                result.append(Option(index: index, label: schemaText(member.meta["description"]) ?? typeName(member), constant: nil, branch: member, discriminator: nil))
            }
        }
        return result
    }

    private func typeName(_ node: SchemaNode) -> String {
        switch node.type {
        case "string": String(localized: "自定义文本")
        case "number", "natural", "percent": String(localized: "数字")
        case "boolean": String(localized: "开关")
        case "array": String(localized: "列表")
        case "dict": String(localized: "键值表")
        default: node.type
        }
    }

    private func match(_ value: JSON?, _ options: [Option]) -> Option? {
        guard let value else { return nil }
        if let constant = options.first(where: { $0.constant == value }) { return constant }
        for option in options {
            guard let branch = option.branch else { continue }
            if let disc = option.discriminator {
                if value[disc.key] == disc.value { return option }
                continue
            }
            switch (branch.type, value) {
            case ("string", .string), ("number", .number), ("natural", .number), ("percent", .number),
                 ("boolean", .bool), ("array", .array), ("tuple", .array), ("dict", .object), ("object", .object), ("intersect", .object):
                return option
            default:
                continue
            }
        }
        return nil
    }

    private func select(_ index: Int, _ options: [Option]) {
        guard let option = options.first(where: { $0.index == index }) else { return }
        if let constant = option.constant {
            chosen = nil
            context.save(path, constant)
        } else if let disc = option.discriminator {
            chosen = nil
            // Only the discriminating field: the other fields stay as they are.
            context.save(path + [disc.key], disc.value)
        } else {
            chosen = index
            if let branch = option.branch, let fallback = branch.defaultValue { context.save(path, fallback) }
        }
    }
}

/// F-19: a bit set as one switch per named bit.
private struct BitsetField: View {
    let context: SchemaFormContext
    let key: String
    let node: SchemaNode
    let path: [String]

    var body: some View {
        let mask = context.value(at: path)?.int ?? node.defaultValue?.int ?? 0
        let bits = node.json["bits"].object.compactMap { name, bit in bit.int.map { (name, $0) } }.sorted { $0.1 < $1.1 }
        DisclosureGroup {
            ForEach(bits, id: \.0) { name, bit in
                Toggle(humanize(name), isOn: Binding(get: { mask & bit != 0 }, set: { on in
                    context.save(path, .number(Double(on ? mask | bit : mask & ~bit)))
                }))
                .toggleStyle(.mono)
            }
        } label: {
            FieldLabel(key: key, node: node)
        }
    }
}

// MARK: - Collections

/// F-15: a dictionary. Each key is written on its own (`set [..., key]`, `unset [..., key]`).
private struct DictEditor: View {
    let context: SchemaFormContext
    let key: String
    let node: SchemaNode
    let path: [String]
    @State private var newKey = ""

    var body: some View {
        let inner = context.graph.inner(node)
        let keyChoices = node.json["sKey"].isNull ? nil : context.graph.choices(context.graph.node(node.json["sKey"]))
        let entries = (context.value(at: path)?.object ?? [:]).keys.sorted()
        Form {
            Section {
                if entries.isEmpty { Text("暂无条目").foregroundStyle(Palette.secondary) }
                ForEach(entries, id: \.self) { entry in
                    SchemaField(context: context, key: entry, node: inner.with(label: entry), path: path + [entry], ownsRowActions: true)
                        .swipeActions { Button("删除", role: .destructive) { context.save(path + [entry], nil) } }
                }
            } footer: {
                FieldNotes(node: node)
            }
            Section("添加") {
                if let keyChoices {
                    let free = keyChoices.filter { !entries.contains($0.compactText) }
                    Menu {
                        ForEach(free, id: \.self) { choice in
                            Button(context.graph.label(ofConst: choice, in: context.graph.node(node.json["sKey"]))) { add(choice.compactText, inner) }
                        }
                    } label: { Label("添加条目", systemImage: "plus") }
                    .disabled(free.isEmpty)
                } else {
                    HStack {
                        TextField("键", text: $newKey).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button { add(newKey.trimmingCharacters(in: .whitespaces), inner); newKey = "" } label: { Text("添加").hitTarget() }
                            .buttonStyle(.borderless)
                            .disabled(newKey.trimmingCharacters(in: .whitespaces).isEmpty || entries.contains(newKey))
                    }
                }
            }
        }
        .tint(Palette.ink)
        .disabled(context.disabled)
        .navigationTitle(schemaLabel(key, node))
        .navigationBarTitleDisplayMode(.inline)
        .keyboardDoneButton()
    }

    private func add(_ entry: String, _ inner: SchemaNode) {
        guard !entry.isEmpty else { return }
        context.save(path + [entry], inner.defaultValue ?? emptyValue(for: inner, graph: context.graph))
    }
}

/// F-16: a list, written as a whole (`set [path] [...]`, as the web model page does).
/// Items of an object schema open their own form, edited locally and saved with the list.
private struct ArrayEditor: View {
    let context: SchemaFormContext
    let title: String
    let node: SchemaNode
    let path: [String]
    @State private var draft = ""

    var body: some View {
        let inner = context.graph.inner(node)
        let items = context.value(at: path)?.array ?? node.defaultValue?.array ?? []
        Form {
            if let choices = context.graph.choices(inner) {
                Section {
                    ForEach(choices, id: \.self) { choice in
                        Toggle(context.graph.label(ofConst: choice, in: inner), isOn: Binding(get: { items.contains(choice) }, set: { on in
                            var next = items
                            if on { next.append(choice) } else { next.removeAll { $0 == choice } }
                            context.save(path, .array(next))
                        }))
                        .toggleStyle(.mono)
                    }
                } footer: { FieldNotes(node: node) }
            } else if ["string", "number", "natural"].contains(inner.type) {
                Section {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, item in Text(item.compactText).font(.callout.monospaced()) }
                        .onDelete { offsets in var next = items; next.remove(atOffsets: offsets); context.save(path, .array(next)) }
                        .onMove { from, to in var next = items; next.move(fromOffsets: from, toOffset: to); context.save(path, .array(next)) }
                    HStack {
                        TextField("添加", text: $draft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(inner.type == "string" ? .default : .decimalPad)
                        Button {
                            let value = draft.trimmingCharacters(in: .whitespaces)
                            if inner.type == "string" { context.save(path, .array(items + [.string(value)])) }
                            else if let number = Double(value) { context.save(path, .array(items + [.number(number)])) }
                            draft = ""
                        } label: {
                            Text("添加").hitTarget()
                        }
                        .buttonStyle(.borderless)
                        .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || (inner.type != "string" && Double(draft) == nil))
                    }
                } footer: { FieldNotes(node: node) }
            } else {
                Section {
                    ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                        NavigationLink {
                            LocalValueEditor(base: context, title: summary(item, index), node: inner, value: item) { next in
                                var list = items
                                if list.indices.contains(index) { list[index] = next }
                                context.save(path, .array(list))
                            }
                        } label: {
                            Text(summary(item, index)).font(.callout)
                        }
                    }
                    .onDelete { offsets in var next = items; next.remove(atOffsets: offsets); context.save(path, .array(next)) }
                    .onMove { from, to in var next = items; next.move(fromOffsets: from, toOffset: to); context.save(path, .array(next)) }
                    Button { context.save(path, .array(items + [inner.defaultValue ?? emptyValue(for: inner, graph: context.graph)])) } label: {
                        Label("添加一项", systemImage: "plus")
                    }
                } footer: { FieldNotes(node: node) }
            }
        }
        .tint(Palette.ink)
        .disabled(context.disabled)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { if !items.isEmpty && context.graph.choices(inner) == nil { EditButton() } }
        .keyboardDoneButton()
    }

    private func summary(_ item: JSON, _ index: Int) -> String {
        if let name = item["name"].string ?? item["id"].string, !name.isEmpty { return name }
        let text = item.compactText
        return text.isEmpty || text == "{}" ? String(localized: "第 \(index + 1) 项") : text
    }
}

/// F-17: a tuple: fixed positions, edited locally and written as a whole.
private struct TupleEditor: View {
    let context: SchemaFormContext
    let title: String
    let node: SchemaNode
    let path: [String]

    var body: some View {
        let positions = context.graph.list(node)
        let current = context.value(at: path)?.array ?? node.defaultValue?.array ?? []
        let local = SchemaFormContext(
            graph: context.graph,
            value: .array(positions.indices.map { current.indices.contains($0) ? current[$0] : .null }),
            user: nil,
            secrets: [:],
            disabled: context.disabled,
            save: { relative, value in
                var list = positions.indices.map { current.indices.contains($0) ? current[$0] : JSON.null }
                if let index = relative.first.flatMap(Int.init), list.indices.contains(index) {
                    let rest = Array(relative.dropFirst())
                    list[index] = rest.isEmpty ? (value ?? .null) : list[index].setting(rest, value)
                }
                context.save(path, .array(list))
            }
        )
        Form {
            Section {
                ForEach(Array(positions.enumerated()), id: \.offset) { index, position in
                    SchemaField(context: local, key: schemaText(position.meta["description"]) ?? String(localized: "第 \(index + 1) 项"), node: position, path: [String(index)])
                }
            } footer: { FieldNotes(node: node) }
        }
        .tint(Palette.ink)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .keyboardDoneButton()
    }
}

/// A local value (one list item) edited with the same fields, handed back whole on every change.
private struct LocalValueEditor: View {
    let base: SchemaFormContext
    let title: String
    let node: SchemaNode
    @State var value: JSON
    let commit: (JSON) -> Void

    var body: some View {
        let local = SchemaFormContext(graph: base.graph, value: value, user: nil, secrets: [:], disabled: base.disabled, save: { path, next in
            value = value.setting(path, next)
            commit(value)
        })
        Form {
            if node.type == "object" || node.type == "intersect" {
                SchemaObjectSections(context: local, node: node, path: [], depth: 1)
            } else {
                Section { SchemaField(context: local, key: "", node: node, path: []) }
            }
        }
        .tint(Palette.ink)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .keyboardDoneButton()
    }
}

/// A fresh value for a new entry of `node`'s shape.
func emptyValue(for node: SchemaNode, graph: SchemaGraph) -> JSON {
    switch node.type {
    case "object", "intersect", "dict": return [:]
    case "array", "tuple": return []
    case "boolean": return false
    case "number", "natural", "percent": return .number(node.meta["min"].double ?? 0)
    case "union": return graph.choices(node)?.first ?? graph.list(node).first.map { emptyValue(for: $0, graph: graph) } ?? .null
    case "const": return node.json["value"]
    default: return ""
    }
}

private extension SchemaNode {
    /// The same node labelled `label` (dict entries are named by their key).
    func with(label: String) -> SchemaNode {
        SchemaNode(json: json.setting(["meta", "description"], .string(label)), uid: uid)
    }
}
