import SwiftUI

/// One read of a market index: the query, then pages appended to `entries`.
@MainActor
@Observable
final class PluginMarketModel {
    struct Query: Equatable {
        var text = ""
        var category: String?
        var labels: [String] = []
        /// `index` / `relevance` / `published` / `key`, with `id` and `direction` where they apply.
        var sort: JSON = ["kind": "index"]
    }

    enum SourceFailure: Equatable { case invalid, duplicate, unavailable, other(String) }

    private(set) var indexes: [JSON]?
    private(set) var indexesFailed = false
    var selected: String?
    var query = Query()
    private(set) var result: JSON?
    private(set) var entries: [JSON] = []
    private(set) var loading = false
    private(set) var loadingMore = false
    private(set) var failure: String?
    private(set) var saving = false
    private(set) var sourceFailure: SourceFailure?
    private var generation = 0

    private let pageSize = 50

    var url: String? { selected ?? indexes?.first?["url"].string }

    func label(_ index: JSON) -> String {
        if let title = localized(index["title"]), !title.isEmpty { return title }
        let url = index["url"].string ?? ""
        return URLComponents(string: url)?.host ?? url
    }

    func loadIndexes(_ app: AppModel) async {
        indexesFailed = false
        do {
            indexes = try await app.client.call("pluginMarket/listIndexes").array
            if let selected, !(indexes ?? []).contains(where: { $0["url"].string == selected }) { self.selected = nil }
            await reload(app)
        } catch {
            indexesFailed = indexes == nil
        }
    }

    private func searchArgs(url: String, offset: Int, limit: Int, fetchedAt: JSON?, refresh: Bool) -> JSON {
        var request: [String: JSON] = ["sort": query.sort, "offset": .number(Double(offset)), "limit": .number(Double(limit))]
        let text = query.text.trimmingCharacters(in: .whitespaces)
        if !text.isEmpty { request["text"] = .string(query.text) }
        if let category = query.category { request["category"] = .string(category) }
        if !query.labels.isEmpty { request["labels"] = .array(query.labels.map(JSON.string)) }
        if let fetchedAt, !fetchedAt.isNull { request["fetchedAt"] = fetchedAt }
        if refresh { request["refresh"] = true }
        return ["url": .string(url), "query": .object(request)]
    }

    private func failureText(_ error: Error) -> String {
        (error as? EngineError)?.code == "plugin-market/invalid-index" ? String(localized: "此索引的格式无效") : String(localized: "无法读取此索引")
    }

    /// First page of the current query; the last list stays on screen until it answers.
    func reload(_ app: AppModel, refresh: Bool = false, limit: Int? = nil) async {
        guard let url else {
            result = nil
            entries = []
            return
        }
        generation += 1
        let current = generation
        loading = true
        failure = nil
        do {
            let value = try await app.client.call("pluginMarket/search", searchArgs(url: url, offset: 0, limit: limit ?? pageSize, fetchedAt: nil, refresh: refresh))
            guard current == generation else { return }
            result = value
            entries = value["entries"].array
            dropUndeclared(value["metadata"])
        } catch is CancellationError {
        } catch {
            guard current == generation else { return }
            failure = failureText(error)
        }
        if current == generation { loading = false }
    }

    /// 显示更多: a replaced document reloads the whole list once, then says so.
    func loadMore(_ app: AppModel, retried: Bool = false) async {
        guard let url, let result, !result["nextOffset"].isNull, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let current = generation
        do {
            let value = try await app.client.call("pluginMarket/search", searchArgs(url: url, offset: entries.count, limit: pageSize, fetchedAt: result["fetchedAt"], refresh: false))
            guard current == generation else { return }
            if value["fetchedAt"] != result["fetchedAt"] {
                if retried { failure = String(localized: "此索引在加载过程中发生了变化"); return }
                await reload(app, limit: entries.count + pageSize)
                return
            }
            entries += value["entries"].array
            self.result = value
        } catch {
            failure = failureText(error)
        }
    }

    /// Filters and the sort key the index no longer declares leave the query.
    private func dropUndeclared(_ metadata: JSON) {
        var next = query
        if let category = next.category, metadata["categories"][category].isNull { next.category = nil }
        next.labels = next.labels.filter { !metadata["labels"][$0].isNull }
        if next.sort["kind"].string == "key", metadata["sortKeys"][next.sort["id"].string ?? ""].isNull { next.sort = ["kind": "index"] }
        if next != query { query = next }
    }

    /// Typing leaves index order for best match; clearing the text returns to it.
    func setText(_ text: String) {
        let wasBlank = query.text.trimmingCharacters(in: .whitespaces).isEmpty
        let blank = text.trimmingCharacters(in: .whitespaces).isEmpty
        if wasBlank && !blank && query.sort["kind"].string == "index" { query.sort = ["kind": "relevance"] }
        else if blank && query.sort["kind"].string == "relevance" { query.sort = ["kind": "index"] }
        query.text = text
    }

    /// `setIndexes`: replace the source list. Returns whether it saved.
    func saveSources(_ urls: [String], adding: Bool, _ app: AppModel) async -> Bool {
        saving = true
        sourceFailure = nil
        defer { saving = false }
        do {
            try await app.client.call("pluginMarket/setIndexes", ["urls": .array(urls.map(JSON.string))])
            if adding { selected = urls.last }
            await loadIndexes(app)
            return true
        } catch let error as EngineError {
            switch error.code {
            case "plugin-market/invalid-index-url": sourceFailure = error.detail["details"]["reason"].string == "duplicate" ? .duplicate : .invalid
            case "plugin-market/settings-unavailable": sourceFailure = .unavailable
            default: sourceFailure = .other(error.message)
            }
            return false
        } catch {
            sourceFailure = .other(describeFailure(error))
            return false
        }
    }

    func clearSourceFailure() { sourceFailure = nil }
}

/// 发现 (MK-01…MK-09): browse an index, search and filter it, and hand an install to P-10.
struct PluginMarketPage: View {
    @Environment(AppModel.self) private var app
    @State private var model = PluginMarketModel()
    @State private var managing = false
    @State private var search = ""
    @State private var choice: MarketChoice?
    @State private var route: PluginRoute?

    var body: some View {
        Group {
            if let indexes = model.indexes {
                if indexes.isEmpty {
                    ContentUnavailableView {
                        Label("还没有插件市场", systemImage: "storefront")
                    } description: {
                        Text("添加一个插件市场索引，即可在这里浏览和安装其中的插件")
                    } actions: {
                        Button("添加索引源") { managing = true }.buttonStyle(.capsule(height: 40, fill: false))
                    }
                } else {
                    browser(indexes)
                }
            } else if model.indexesFailed {
                ContentUnavailableView {
                    Label("无法读取索引源", systemImage: "exclamationmark.triangle")
                } actions: {
                    Button("重试") { Task { await model.loadIndexes(app) } }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .sheet(isPresented: $managing) { MarketSourcesSheet(model: model) }
        .sheet(item: $choice) { MarketInstallConfirm(choice: $0) }
        .navigationDestination(item: $route) { PluginDetailView(name: $0.name) }
        .task(id: app.revision("plugin-market/changed")) { await model.loadIndexes(app) }
        .task(id: app.revision("plugin-manager/changed")) { if model.result != nil { await model.reload(app, limit: max(model.entries.count, 50)) } }
        // Keystrokes settle for 250 ms before a read.
        .task(id: search) {
            guard search != model.query.text else { return }
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            model.setText(search)
            await model.reload(app)
        }
    }

    private func browser(_ indexes: [JSON]) -> some View {
        let metadata = model.result?["metadata"] ?? .null
        return List {
            Section { toolbar(indexes, metadata) }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
            if !metadata["categories"].object.isEmpty { categories(metadata) }
            if let failure = model.failure {
                Section {
                    Text(failure).font(.footnote).foregroundStyle(Palette.removed)
                    Button("重试") { Task { await model.reload(app) } }
                }
                .groupedRow()
            }
            if model.entries.isEmpty, model.failure == nil {
                Section {
                    if model.loading || model.result == nil {
                        HStack { Spacer(); ProgressView(); Text("正在读取索引").font(.footnote).foregroundStyle(Palette.secondary); Spacer() }
                    } else {
                        Text(unfiltered ? "此索引没有插件" : "没有符合条件的插件").font(.footnote).foregroundStyle(Palette.secondary)
                    }
                }
                .groupedRow()
            }
            if !model.entries.isEmpty {
                Section {
                    ForEach(model.entries, id: \.self) { entry in
                        MarketEntryRow(entry: entry, market: model, install: { choice = $0 }, open: { route = PluginRoute(name: $0) })
                    }
                    if model.result?["nextOffset"].isNull == false {
                        Button {
                            Task { await model.loadMore(app) }
                        } label: {
                            HStack { Spacer(); Text(model.loadingMore ? "正在读取索引" : "显示更多").foregroundStyle(Palette.ink); Spacer() }
                        }
                        .disabled(model.loadingMore)
                    }
                }
                .groupedRow()
            }
        }
        .groupedList()
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索插件")
        .refreshable { await model.reload(app, refresh: true) }
    }

    private var unfiltered: Bool {
        model.query.text.trimmingCharacters(in: .whitespaces).isEmpty && model.query.category == nil && model.query.labels.isEmpty
    }

    private func toolbar(_ indexes: [JSON], _ metadata: JSON) -> some View {
        HStack(spacing: 12) {
            Menu {
                ForEach(indexes, id: \.self) { index in
                    Button {
                        model.selected = index["url"].string
                        Task { await model.reload(app) }
                    } label: {
                        if index["url"].string == model.url { Label(model.label(index), systemImage: "checkmark") } else { Text(model.label(index)) }
                    }
                }
                Divider()
                Button("管理索引源…") { managing = true }
            } label: {
                HStack(spacing: 3) {
                    Text(indexes.first { $0["url"].string == model.url }.map(model.label) ?? "").lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down").font(.caption2)
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(Palette.ink)
            }
            Spacer()
            if !metadata["labels"].object.isEmpty { labelsMenu(metadata) }
            sortMenu(metadata)
        }
    }

    private func declared(_ dictionary: JSON) -> [(id: String, title: String)] {
        dictionary.object.map { (id: $0.key, title: localized($0.value["title"]) ?? $0.key) }
            .sorted { $0.title.localizedCompare($1.title) == .orderedAscending }
    }

    private func labelsMenu(_ metadata: JSON) -> some View {
        Menu {
            ForEach(declared(metadata["labels"]), id: \.id) { label in
                Button {
                    if let index = model.query.labels.firstIndex(of: label.id) { model.query.labels.remove(at: index) } else { model.query.labels.append(label.id) }
                    Task { await model.reload(app) }
                } label: {
                    if model.query.labels.contains(label.id) { Label(label.title, systemImage: "checkmark") } else { Text(label.title) }
                }
            }
        } label: {
            Text(model.query.labels.isEmpty ? String(localized: "标签") : String(localized: "标签 · \(model.query.labels.count)"))
                .font(.footnote).foregroundStyle(Palette.secondary)
        }
    }

    private func sortName(_ sort: JSON, _ metadata: JSON) -> String {
        switch sort["kind"].string {
        case "relevance": return String(localized: "最佳匹配")
        case "published": return String(localized: "发布时间")
        case "key": return localized(metadata["sortKeys"][sort["id"].string ?? ""]["title"]) ?? (sort["id"].string ?? "")
        default: return String(localized: "默认顺序")
        }
    }

    private func sortMenu(_ metadata: JSON) -> some View {
        let hasText = !model.query.text.trimmingCharacters(in: .whitespaces).isEmpty
        let current = model.query.sort
        func choose(_ sort: JSON) {
            model.query.sort = sort
            Task { await model.reload(app) }
        }
        return Menu {
            Button(hasText ? "最佳匹配" : "默认顺序") { choose([ "kind": hasText ? "relevance" : "index"]) }
            Button("发布时间") { choose(["kind": "published", "direction": "desc"]) }
            ForEach(declared(metadata["sortKeys"]), id: \.id) { key in
                Button(key.title) {
                    choose(["kind": "key", "id": .string(key.id), "direction": metadata["sortKeys"][key.id]["order"].string.map(JSON.string) ?? "desc"])
                }
            }
            if let direction = current["direction"].string {
                Divider()
                Button(direction == "desc" ? "改为升序" : "改为降序") {
                    choose(current.setting(["direction"], .string(direction == "desc" ? "asc" : "desc")))
                }
            }
        } label: {
            Text("排序：\(sortName(current, metadata))").font(.footnote).foregroundStyle(Palette.secondary).lineLimit(1)
        }
    }

    private func categories(_ metadata: JSON) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("全部", selected: model.query.category == nil) { model.query.category = nil }
                ForEach(declared(metadata["categories"]), id: \.id) { category in
                    chip(LocalizedStringKey(category.title), selected: model.query.category == category.id) { model.query.category = category.id }
                }
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
    }

    private func chip(_ title: LocalizedStringKey, selected: Bool, _ action: @escaping () -> Void) -> some View {
        Button {
            action()
            Task { await model.reload(app) }
        } label: {
            Text(title)
                .font(.footnote.weight(.medium))
                .foregroundStyle(selected ? Palette.onInk : Palette.ink)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(selected ? Palette.ink : Palette.control, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// An entry and version chosen for installation.
struct MarketChoice: Identifiable {
    let entry: JSON
    let version: JSON
    var id: String { "\(entry["name"].string ?? "")@\(version["version"].string ?? "")" }
}

private func marketTitle(_ entry: JSON) -> String { localized(entry["title"]) ?? entry["name"].string ?? "" }

/// The version an entry presents and installs by default.
private func presentedVersion(_ entry: JSON) -> JSON? {
    entry["versions"].array.first { $0["version"].string == entry["defaultVersion"].string } ?? entry["versions"].array.first
}

private func installable(_ compatibility: JSON) -> Bool {
    compatibility["compatible"].bool == true || compatibility["exempted"].bool == true
}

private func formatDate(_ timestamp: JSON) -> String? {
    timestamp.double.map { Date(timeIntervalSince1970: $0).formatted(date: .abbreviated, time: .omitted) }
}

/// The one action an entry offers in its state.
private struct MarketEntryAction: View {
    let entry: JSON
    let install: (MarketChoice) -> Void
    let open: (String) -> Void

    var body: some View {
        let status = entry["installation"]["status"].string
        let presented = presentedVersion(entry)
        switch status {
        case "installed": statusLink(String(localized: "已安装"))
        case "update-available": statusLink(String(localized: "有新版本"))
        case "provided": statusLink(String(localized: "随 DSH 提供"))
        default:
            Button("安装") { if let presented { install(MarketChoice(entry: entry, version: presented)) } }
                .buttonStyle(.capsule(.secondary, height: 44, fill: false))
                .disabled(presented.map { !installable($0["compatibility"]) } ?? true)
        }
    }

    /// Installed entries read as a link to their page under 已安装.
    private func statusLink(_ text: String) -> some View {
        Button { open(entry["name"].string ?? "") } label: {
            Text(text).font(.footnote.weight(.medium)).foregroundStyle(Palette.secondary)
        }
        .buttonStyle(.borderless)
        .fixedSize()
    }
}

/// Opens a package's detail page from the market.
struct PluginRoute: Hashable { let name: String }

private struct MarketEntryRow: View {
    let entry: JSON
    let market: PluginMarketModel
    let install: (MarketChoice) -> Void
    let open: (String) -> Void

    var body: some View {
        let version = presentedVersion(entry)
        NavigationLink {
            MarketEntryDetail(entry: entry, market: market, install: install)
        } label: {
            HStack(spacing: 12) {
                PluginIcon(source: entry["icon"].string)
                VStack(alignment: .leading, spacing: 3) {
                    Text(marketTitle(entry)).font(.callout).foregroundStyle(Palette.ink).lineLimit(1)
                    if let description = localized(entry["description"]), !description.isEmpty {
                        Text(description).font(.footnote).foregroundStyle(Palette.secondary).lineLimit(1)
                    }
                    Text(meta(version)).font(.caption).foregroundStyle(Palette.faint).lineLimit(1)
                    if let version, !installable(version["compatibility"]) {
                        Text("没有与当前 DSH \(version["compatibility"]["runtimeVersion"].string ?? "") 兼容的版本").font(.caption).foregroundStyle(Palette.waiting)
                    }
                }
                Spacer(minLength: 0)
                MarketEntryAction(entry: entry, install: install, open: open)
            }
            .padding(.vertical, 3)
        }
    }

    private func meta(_ version: JSON?) -> String {
        [version?["version"].string, entry["author"].string, version.flatMap { formatDate($0["publishTimestamp"]) }].compactMap { $0 }.joined(separator: " · ")
    }
}

/// MK-07: the full description, facts and every version.
private struct MarketEntryDetail: View {
    let entry: JSON
    let market: PluginMarketModel
    let install: (MarketChoice) -> Void
    @State private var route: PluginRoute?

    var body: some View {
        let version = presentedVersion(entry)
        List {
            Section {
                HStack(spacing: 14) {
                    PluginIcon(source: entry["icon"].string, size: 44)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(marketTitle(entry)).font(.title3.weight(.medium)).foregroundStyle(Palette.ink)
                        Text(entry["name"].string ?? "").font(.caption.monospaced()).foregroundStyle(Palette.faint)
                    }
                    Spacer(minLength: 0)
                    MarketEntryAction(entry: entry, install: install) { route = PluginRoute(name: $0) }
                }
                if let description = localized(entry["description"]), !description.isEmpty {
                    Text(description).font(.subheadline).foregroundStyle(Palette.secondary)
                }
                if let version { compatibilityNote(version) }
            }
            .groupedRow()
            Section {
                if let author = entry["author"].string { LabeledContent("作者", value: author) }
                if let homepage = entry["homepage"].string, let url = URL(string: homepage) {
                    LabeledContent("主页") { Link(url.host ?? homepage, destination: url).font(.footnote) }
                }
                if let repository = entry["repository"]["url"].string, let url = URL(string: repository) {
                    LabeledContent("源代码") {
                        Link(entry["repository"]["directory"].string.map { "\(url.host ?? repository) · \($0)" } ?? (url.host ?? repository), destination: url).font(.footnote)
                    }
                }
                if let version {
                    if version["source"]["type"].string == "npm" {
                        LabeledContent("软件包") { Text("\(entry["name"].string ?? "")@\(version["version"].string ?? "")").font(.footnote.monospaced()).multilineTextAlignment(.trailing) }
                        if let registry = version["source"]["registry"].string { LabeledContent("注册表", value: registry) }
                    } else {
                        LabeledContent("仓库") { Text(version["source"]["url"].string ?? "").font(.footnote.monospaced()).multilineTextAlignment(.trailing) }
                        LabeledContent("提交") { Text(version["source"]["commit"].string ?? "").font(.footnote.monospaced()).multilineTextAlignment(.trailing) }
                        if let path = version["source"]["path"].string { LabeledContent("目录", value: path) }
                    }
                    if let date = formatDate(version["publishTimestamp"]) { LabeledContent("发布时间", value: date) }
                }
                if let category = entry["metadata"]["category"].string {
                    LabeledContent("分类", value: localized(market.result?["metadata"]["categories"][category]["title"] ?? .null) ?? category)
                }
                let labels = entry["metadata"]["labels"].array.compactMap(\.string)
                if !labels.isEmpty {
                    LabeledContent("标签", value: labels.map { localized(market.result?["metadata"]["labels"][$0]["title"] ?? .null) ?? $0 }.joined(separator: String(localized: "、")))
                }
                if let title = market.result?["title"], let name = localized(title) { LabeledContent("插件市场", value: name) }
            }
            .groupedRow()
            Section("版本") {
                ForEach(entry["versions"].array, id: \.self) { item in versionRow(item) }
            }
            .groupedRow()
        }
        .groupedList()
        .navigationTitle(marketTitle(entry))
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $route) { PluginDetailView(name: $0.name) }
    }

    @ViewBuilder
    private func compatibilityNote(_ version: JSON) -> some View {
        let compatibility = version["compatibility"]
        if compatibility["compatible"].bool != true {
            if compatibility["exempted"].bool == true {
                Text("此版本与当前 DSH 不兼容，但你已为它设置了兼容性豁免").font(.footnote).foregroundStyle(Palette.waiting)
            } else {
                Text("此版本与当前的 DSH \(compatibility["runtimeVersion"].string ?? "") 不兼容，它要求 DSH \(compatibility["requirements"].object.values.compactMap(\.string).joined(separator: ", "))")
                    .font(.footnote).foregroundStyle(Palette.waiting)
            }
        }
    }

    private func versionRow(_ version: JSON) -> some View {
        let number = version["version"].string ?? ""
        let installed = entry["installation"]["installedVersion"].string == number
        let isDefault = entry["defaultVersion"].string == number
        let compatibility = version["compatibility"]
        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(number).font(.callout.monospaced()).foregroundStyle(Palette.ink)
                HStack(spacing: 4) {
                    if isDefault { PluginTag(text: String(localized: "推荐"), tone: Palette.running) }
                    if number.contains("-") { PluginTag(text: String(localized: "预发布")) }
                    if installed { PluginTag(text: String(localized: "当前已安装")) }
                    if compatibility["compatible"].bool != true {
                        if compatibility["exempted"].bool == true { PluginTag(text: String(localized: "已豁免"), tone: Palette.waiting) }
                        else { PluginTag(text: String(localized: "不兼容"), tone: Palette.removed) }
                    }
                }
            }
            Spacer(minLength: 0)
            if !installed, entry["installation"]["status"].string != "provided", installable(compatibility) {
                Button("安装") { install(MarketChoice(entry: entry, version: version)) }
                    .buttonStyle(.capsule(.secondary, height: 44, fill: false))
            }
        }
    }
}

/// MK-08: 安装「{name}」？ with where it comes from, then the install sheet.
private struct MarketInstallConfirm: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let choice: MarketChoice

    var body: some View {
        let number = choice.version["version"].string ?? ""
        let source = choice.version["source"]
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                PluginIcon(source: choice.entry["icon"].string)
                VStack(alignment: .leading, spacing: 2) {
                    Text("安装「\(marketTitle(choice.entry))」？").font(.headline).foregroundStyle(Palette.ink)
                    Text(number).font(.footnote.monospaced()).foregroundStyle(Palette.secondary)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                if let author = choice.entry["author"].string { Text("作者：\(author)").font(.footnote).foregroundStyle(Palette.secondary) }
                Text(source["type"].string == "npm" ? "\(choice.entry["name"].string ?? "")@\(number)" : (source["url"].string ?? ""))
                    .font(.caption.monospaced()).foregroundStyle(Palette.faint)
                if choice.version["compatibility"]["exempted"].bool == true {
                    Text("此版本与当前 DSH 不兼容，但你已为它设置了兼容性豁免").font(.footnote).foregroundStyle(Palette.waiting)
                }
            }
            Label("插件在本机以你的权限运行。请确认你信任它的来源", systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(Palette.secondary)
            Spacer(minLength: 0)
            HStack(spacing: 12) {
                Button("取消") { dismiss() }.buttonStyle(.capsule(.outline))
                Button("安装") {
                    let install = choice.version["install"]
                    dismiss()
                    Task {
                        // Our sheet must be gone before the install sheet presents.
                        try? await Task.sleep(for: .milliseconds(400))
                        app.pluginInstall.installFrom(spec: install["spec"].string ?? "", registry: install["registry"].string, title: marketTitle(choice.entry), version: number)
                    }
                }
                .buttonStyle(.capsule())
            }
        }
        .padding(20)
        .background(Palette.background)
        .presentationDetents([.medium])
        .tint(Palette.ink)
    }
}

/// MK-03: the index list, written whole with `setIndexes`.
private struct MarketSourcesSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: PluginMarketModel
    @State private var draft = ""

    private var urls: [String] { (model.indexes ?? []).compactMap { $0["url"].string } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(model.indexes ?? [], id: \.self) { index in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(model.label(index)).foregroundStyle(Palette.ink)
                            Text(index["url"].string ?? "").font(.caption).foregroundStyle(Palette.secondary).lineLimit(1)
                            if let error = index["error"].string { Text(error).font(.caption).foregroundStyle(Palette.removed) }
                        }
                    }
                    .onDelete { offsets in
                        var next = urls
                        next.remove(atOffsets: offsets)
                        Task { _ = await model.saveSources(next, adding: false, app) }
                    }
                } footer: {
                    Text("插件市场以一个索引文件的 URL 提供，「发现」从这里列出的索引浏览插件")
                }
                .groupedRow()
                Section("索引 URL") {
                    TextField("https://example.com/index.json", text: $draft)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: draft) { _, _ in model.clearSourceFailure() }
                    if let failure = failureText { Text(failure).font(.caption).foregroundStyle(Palette.removed) }
                    Button("添加") {
                        let url = draft.trimmingCharacters(in: .whitespaces)
                        Task {
                            if await model.saveSources(urls + [url], adding: true, app) { draft = "" }
                        }
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || model.saving)
                }
                .groupedRow()
                Section {} footer: {
                    Text("索引由第三方提供。只添加你信任的来源：其中的插件安装后以你的权限运行")
                }
            }
            .groupedList()
            .navigationTitle("索引源")
            .navigationBarTitleDisplayMode(.inline)
            .closeButton(dismiss)
        }
        .tint(Palette.ink)
    }

    private var failureText: String? {
        switch model.sourceFailure {
        case .invalid?: String(localized: "请使用 http 或 https 地址，且不要包含用户名、密码或 # 片段")
        case .duplicate?: String(localized: "已添加过这个索引源")
        case .unavailable?: String(localized: "当前环境无法保存索引源")
        case .other(let reason)?: String(localized: "无法保存索引源：\(reason)")
        case nil: nil
        }
    }
}
