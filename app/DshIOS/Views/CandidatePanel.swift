import SwiftUI

/// What picking a candidate does: run the `/` row's decision, or put text in place
/// of the token (`keepOpen`: a directory drill, the menu continues one level down).
enum Candidate {
    case command(CommandRow)
    case insert(String, keepOpen: Bool)
    /// A session: the field shows `@title`, the message carries `mention`.
    case reference(title: String, mention: String)
}

/// The candidate panel docked above the composer (C-98): `/` commands from the
/// session's catalog, `@` files, folders and sessions from the engine (C-102).
/// The keyboard leaves little room, so it holds a few two-line results and hands
/// the rest to 「全部」; deleting the trigger character leaves it.
struct CandidatePanel: View {
    let model: SessionModel
    let context: ComposerContext
    let hit: TriggerHit
    let pick: (Candidate) -> Void
    let showAll: () -> Void
    @Environment(AppModel.self) private var app
    @State private var references: [Row] = []
    @State private var searched = false

    /// Rows that fit without covering the timeline; 「全部」 takes the last place when there are more.
    private static let limit = 4

    struct Row: Identifiable {
        let id: String
        var icon: String
        var title: String
        var detail: String?
        var section: String?
        var candidate: Candidate
        /// A folder's chevron: descend instead of inserting it.
        var drill: Candidate?
        /// `detail` is a path: its end says more than its start.
        var pathDetail = false
    }

    var body: some View {
        let rows = hit.trigger == "/" ? commandRows : references
        VStack(alignment: .leading, spacing: 0) {
            if rows.isEmpty {
                if hit.trigger == "/" || searched {
                    Text(hit.trigger == "/" ? "没有匹配的指令" : "没有匹配的文件或对话")
                        .font(.subheadline).foregroundStyle(Palette.secondary)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                } else {
                    ForEach(0..<2, id: \.self) { _ in
                        RoundedRectangle(cornerRadius: 4).fill(Palette.control).frame(height: 16).padding(.vertical, 10).padding(.horizontal, 16)
                    }
                }
            } else if rows.count > Self.limit {
                ForEach(rows.prefix(Self.limit - 1)) { row in rowView(row) }
                Button(action: showAll) {
                    HStack {
                        Text("全部").font(.subheadline.weight(.medium)).foregroundStyle(Palette.ink)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Palette.secondary)
                    }
                    .padding(.horizontal, 16)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                ForEach(rows) { row in rowView(row) }
            }
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.grouped, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .task(id: hit.trigger == "@" ? "\(model.loaded)\(hit.quoted)\(hit.query)" : nil) {
            guard hit.trigger == "@", model.loaded else { return }
            guard let rows = await Self.loadReferences(app: app, model: model, query: hit.query, quoted: hit.quoted) else { return }
            references = rows
            searched = true
        }
    }

    private func rowView(_ row: Row) -> some View {
        CandidateRowView(row: row, pick: pick, descend: pick)
    }

    // MARK: `/` (C-99)

    private var commandRows: [Row] { Self.commandRows(context, query: hit.query, leading: hit.leading) }

    static func commandRows(_ context: ComposerContext, query: String, leading: Bool) -> [Row] {
        context.commandRows(query: query, leading: leading).map { row in
            Row(id: "cmd-\(row.name)", icon: row.icon, title: row.label ?? row.name,
                detail: row.description.isEmpty ? nil : row.description, section: row.section, candidate: .command(row))
        }
    }

    // MARK: `@` (C-102, C-103)

    /// Files and sessions in parallel, after a short pause in typing. Nil when a new key
    /// cancelled this load (the caller keeps what it shows).
    static func loadReferences(app: AppModel, model: SessionModel, query: String, quoted: Bool) async -> [Row]? {
        try? await Task.sleep(for: .milliseconds(120))
        if Task.isCancelled { return nil }
        let client = app.client, sessionId = model.sessionId
        async let files = try? client.call("fileReferences/list", ["agentId": .string(sessionId), "query": .string(query)])
        async let sessions = quoted ? nil : (try? client.call("sessionReferenceResolver/candidates", ["agentId": .string(sessionId), "query": .string(query)]))
        let (fileList, sessionList) = await (files, sessions)
        if Task.isCancelled { return nil }
        var rows: [Row] = []
        for item in fileList?.array ?? [] {
            guard let path = item["path"].string else { continue }
            let directory = item["kind"].string == "directory"
            guard let mention = formatFileMention(path: path, directory: directory, preserveQuote: quoted) else { continue }
            let slash = path.lastIndex(of: "/")
            let name = slash.map { String(path[path.index(after: $0)...]) } ?? path
            let parent = slash.map { String(path[..<$0]) }
            rows.append(Row(
                id: "file-\(path)", icon: directory ? "folder" : "doc", title: directory ? name + "/" : name,
                detail: parent, section: String(localized: "文件与文件夹"), candidate: .insert(mention, keepOpen: false),
                drill: directory ? .insert(mention, keepOpen: true) : nil, pathDetail: true
            ))
        }
        let sessionRows: [(child: Bool, row: Row)] = (sessionList?.array ?? []).compactMap { item in
            guard let mention = item["mention"].string, let id = item["sessionId"].string else { return nil }
            let child = app.sessions[id]?.isSubagent == true
            let label = item["displayTitle"].string ?? item["label"].string ?? id
            let updated = app.sessions[id]?.updatedAt ?? Date(timeIntervalSince1970: (item["createdAt"].double ?? 0) / 1000)
            let location: String? = item["sameWorkspace"].bool == true ? nil : (item["cwd"].string ?? String(localized: "（无工作目录）"))
            let age = Self.age(updated)
            return (child, Row(id: "session-\(id)", icon: "bubble.left", title: label, detail: location.map { "\($0) · \(age)" } ?? age,
                               section: child ? String(localized: "子智能体") : String(localized: "对话"), candidate: .reference(title: label, mention: mention)))
        }
        rows += sessionRows.filter(\.child).map(\.row) + sessionRows.filter { !$0.child }.map(\.row)
        return rows
    }

    /// 刚刚 / 5分钟 / 3小时 / 2天 / 4个月 / 1年, the reference menu's ages.
    static func age(_ date: Date, now: Date = .now) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        let day = 86_400.0
        switch seconds {
        case ..<60: return String(localized: "刚刚")
        case ..<3600: return String(localized: "\(Int(seconds / 60))分钟")
        case ..<day: return String(localized: "\(Int(seconds / 3600))小时")
        case ..<(30 * day): return String(localized: "\(Int(seconds / day))天")
        case ..<(365 * day): return String(localized: "\(Int(seconds / (30 * day)))个月")
        default: return String(localized: "\(Int(seconds / (365 * day)))年")
        }
    }
}

/// One candidate: title over detail, with a chevron for a folder.
struct CandidateRowView: View {
    let row: CandidatePanel.Row
    let pick: (Candidate) -> Void
    let descend: (Candidate) -> Void

    var body: some View {
        HStack(spacing: 0) {
            Button { pick(row.candidate) } label: {
                HStack(spacing: 10) {
                    Image(systemName: row.icon).font(.footnote).foregroundStyle(Palette.secondary).frame(width: 18)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.title).font(.subheadline).foregroundStyle(Palette.ink).lineLimit(1)
                        if let detail = row.detail {
                            Text(detail).font(.caption).foregroundStyle(Palette.secondary).lineLimit(1)
                                .truncationMode(row.pathDetail ? .head : .tail)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, 16)
                .padding(.trailing, row.drill == nil ? 16 : 0)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let drill = row.drill {
                Button { descend(drill) } label: {
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Palette.secondary)
                        .hitTarget()
                }
                .buttonStyle(.plain)
                .accessibilityLabel("进入目录")
            }
        }
    }
}

/// Every candidate with a search field: the panel's 「全部」 and the ＋ tray's
/// 指令 and 引用 pages. A folder's chevron searches inside it.
struct CandidateList: View {
    let model: SessionModel
    let context: ComposerContext
    let trigger: Character
    /// The commands that only open a draft are listed when nothing precedes them.
    var leading = true
    let pick: (Candidate) -> Void
    @State private var query: String
    @State private var quoted: Bool
    @State private var references: [CandidatePanel.Row] = []
    @State private var searched = false
    @Environment(AppModel.self) private var app

    init(model: SessionModel, context: ComposerContext, trigger: Character, query: String = "", quoted: Bool = false, leading: Bool = true, pick: @escaping (Candidate) -> Void) {
        self.model = model
        self.context = context
        self.trigger = trigger
        self.leading = leading
        self.pick = pick
        _query = State(initialValue: query)
        _quoted = State(initialValue: quoted)
    }

    private var rows: [CandidatePanel.Row] {
        trigger == "/" ? CandidatePanel.commandRows(context, query: query, leading: leading) : references
    }

    /// Neighbouring rows of one section.
    private var sections: [(title: String?, rows: [CandidatePanel.Row])] {
        var sections: [(title: String?, rows: [CandidatePanel.Row])] = []
        for row in rows {
            if let last = sections.indices.last, sections[last].title == row.section { sections[last].rows.append(row) }
            else { sections.append((row.section, [row])) }
        }
        return sections
    }

    var body: some View {
        List {
            if rows.isEmpty {
                if trigger == "/" || searched {
                    Text(trigger == "/" ? "没有匹配的指令" : "没有匹配的文件或对话").foregroundStyle(Palette.secondary).groupedRow()
                } else {
                    ProgressView().frame(maxWidth: .infinity).groupedRow()
                }
            }
            ForEach(sections, id: \.rows.first?.id) { section in
                Section {
                    ForEach(section.rows) { row in
                        CandidateRowView(row: row, pick: pick, descend: descend)
                            .listRowInsets(EdgeInsets())
                    }
                } header: {
                    if let title = section.title { Text(title) }
                }
                .groupedRow()
            }
        }
        .groupedList()
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: trigger == "/" ? "搜索指令" : "搜索文件或对话")
        .navigationTitle(trigger == "/" ? "指令" : "引用文件或对话")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: trigger == "@" ? "\(quoted)\(query)" : nil) {
            guard trigger == "@" else { return }
            guard let rows = await CandidatePanel.loadReferences(app: app, model: model, query: query, quoted: quoted) else { return }
            references = rows
            searched = true
        }
    }

    /// The folder's mention is a live token: its query lists the folder.
    private func descend(_ candidate: Candidate) {
        guard case .insert(let mention, _) = candidate, let next = TriggerHit.detect(in: mention) else { return }
        Haptics.select()
        quoted = next.quoted
        query = next.query
    }
}

extension TriggerHit: Identifiable {
    var id: Int { start }
}

/// The panel's 「全部」 as a sheet.
struct CandidateSheet: View {
    let model: SessionModel
    let context: ComposerContext
    let hit: TriggerHit
    let pick: (Candidate) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            CandidateList(model: model, context: context, trigger: hit.trigger, query: hit.query, quoted: hit.quoted, leading: hit.leading, pick: pick)
                .closeButton(dismiss)
        }
        .presentationDetents([.medium, .large])
    }
}

/// Attachments waiting in the composer (C-106): image thumbnails and file cards
/// with their upload state; a failed card retries on tap, ✕ removes.
struct AttachmentRail: View {
    let composer: ComposerModel

    var body: some View {
        if !composer.attachments.isEmpty {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(composer.attachments) { attachment in
                            item(attachment)
                                .overlay(alignment: .topTrailing) {
                                    Button { composer.removeAttachment(attachment.id) } label: {
                                        Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
                                    }
                                    .offset(x: 4, y: -4)
                                    .accessibilityLabel(Text("移除 \(attachment.name)"))
                                }
                                .id(attachment.id)
                        }
                    }
                    .padding(.top, 4)
                    .padding(.trailing, 4)
                }
                .onChange(of: composer.attachments.count) { old, new in
                    if new > old, let last = composer.attachments.last { withAnimation { proxy.scrollTo(last.id, anchor: .trailing) } }
                }
            }
        }
    }

    @ViewBuilder
    private func item(_ attachment: DraftAttachment) -> some View {
        switch attachment.kind {
        case .image(_, _, let preview):
            Image(uiImage: preview).resizable().scaledToFill()
                .frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 12))
                .accessibilityLabel(Text("图片 \(attachment.name)"))
        case .file:
            fileCard(attachment)
        }
    }

    private func fileCard(_ attachment: DraftAttachment) -> some View {
        let failed: Bool = if case .failed = attachment.upload { true } else { false }
        return Button { composer.retryUpload(attachment.id) } label: {
            HStack(spacing: 10) {
                Group {
                    if case .uploading = attachment.upload { ProgressView().controlSize(.small) }
                    else { Image(systemName: "doc").font(.title3).foregroundStyle(Palette.secondary) }
                }
                .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.name).font(.footnote.weight(.medium)).foregroundStyle(Palette.ink).lineLimit(1).truncationMode(.middle)
                    Text(meta(attachment)).font(.caption2).foregroundStyle(failed ? Palette.removed : Palette.secondary).lineLimit(1)
                }
                Spacer(minLength: 12)
            }
            .padding(.horizontal, 10)
            .frame(width: 200)
            .frame(minHeight: 56)
            .overlay(alignment: .bottom) {
                if case .uploading(let loaded, let total) = attachment.upload {
                    Group {
                        if let total, total > 0 { ProgressView(value: Double(loaded), total: Double(total)) } else { ProgressView(value: 0.35) }
                    }
                    .progressViewStyle(.linear)
                    .tint(Palette.ink)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 4)
                }
            }
            .background(Palette.background, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(failed ? Palette.removed : Palette.stroke, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
        .disabled(!failed)
        .accessibilityHint(failed ? Text("轻点重试上传") : Text(""))
    }

    private func meta(_ attachment: DraftAttachment) -> String {
        switch attachment.upload {
        case .uploading: return String(localized: "上传中…")
        case .failed: return String(localized: "上传失败，轻点重试")
        default:
            let ext = (attachment.name as NSString).pathExtension.uppercased().prefix(8)
            let size = ByteCountFormatter.string(fromByteCount: Int64(attachment.bytes), countStyle: .file)
            return [String(ext), size].filter { !$0.isEmpty }.joined(separator: " ")
        }
    }
}
