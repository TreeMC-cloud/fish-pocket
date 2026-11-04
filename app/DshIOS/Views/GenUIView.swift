import Charts
import SwiftUI

/// Native rendering of the ```schemaJson blocks dsh-genui teaches the model
/// to write: an OpenTiny low-code tree (Page → TinyCard → Text / TinyGrid /
/// TinyHuicharts*). Interactive parts (state, methods, events) stay in the web
/// version; components this renderer does not know show their children.
struct GenUIView: View {
    let node: JSON

    static func parse(_ code: String) -> JSON? {
        guard let json = try? JSONDecoder().decode(JSON.self, from: Data(code.utf8)), json["componentName"].string != nil else { return nil }
        return json
    }

    var body: some View {
        GenUINode(node: node)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct GenUINode: View {
    let node: JSON

    var body: some View {
        let name = node["componentName"].string ?? ""
        let props = node["props"]
        switch name {
        case "Page", "div", "TinyLayout", "TinyRow", "TinyCol", "section", "Block":
            children(spacing: 10)
        case "TinyCard", "Card":
            VStack(alignment: .leading, spacing: 10) {
                if let title = props["title"].string { Text(title).font(.headline) }
                children(spacing: 10)
            }
            .padding(14)
            .background(Palette.grouped, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        case "h1", "h2", "h3", "h4", "h5", "h6":
            Text(text).font(name == "h1" ? .title2.bold() : name == "h2" ? .title3.bold() : .headline)
        case "Text", "span", "p", "TinyText", "label":
            Text(text)
                .font(fontSize(props["style"].string).map { .system(size: $0) } ?? .body)
                .foregroundStyle(props["style"].string?.contains("opacity") == true ? .secondary : .primary)
                .textSelection(.enabled)
        case "TinyGrid", "TinyTable", "Table":
            GridTable(columns: props["columns"].array, rows: props["data"].array)
        case _ where name.hasPrefix("TinyHuicharts") || name.hasPrefix("TinyChart"):
            ChartView(kind: name, options: props["options"].isNull ? props : props["options"])
        case "TinyTag", "Tag":
            Text(text).font(.caption).padding(.horizontal, 8).padding(.vertical, 3).background(Palette.bubble, in: Capsule())
        case "TinyDivider", "hr":
            Divider()
        case "img", "Image", "TinyImage":
            if let src = props["src"].string, let url = URL(string: src) {
                AsyncImage(url: url) { $0.resizable().scaledToFit() } placeholder: { ProgressView() }
                    .frame(maxHeight: 240)
            }
        case "TinyButton", "button", "TinyInput", "TinyForm", "TinySelect":
            Label("可交互内容 · 在网页版中操作", systemImage: "hand.tap").font(.caption).foregroundStyle(.secondary)
        default:
            if node["children"].array.isEmpty && !text.isEmpty { Text(text) } else { children(spacing: 8) }
        }
    }

    private var text: String {
        node["props"]["text"].string ?? node["children"].string ?? node["props"]["content"].string ?? ""
    }

    @ViewBuilder
    private func children(spacing: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: spacing) {
            if let text = node["children"].string {
                Text(text)
            } else {
                ForEach(Array(node["children"].array.enumerated()), id: \.offset) { _, child in GenUINode(node: child) }
            }
        }
    }

    private func fontSize(_ style: String?) -> CGFloat? {
        guard let style, let range = style.range(of: #"font-size:\s*(\d+)px"#, options: .regularExpression) else { return nil }
        return Double(style[range].filter(\.isNumber)).map { CGFloat($0) + 1 }
    }
}

private struct GridTable: View {
    let columns: [JSON]
    let rows: [JSON]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 8) {
                GridRow {
                    ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                        Text(column["title"].string ?? column["field"].string ?? "").font(.subheadline.bold())
                    }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(columns.enumerated()), id: \.offset) { _, column in
                            Text(cell(row[column["field"].string ?? ""])).font(.subheadline)
                        }
                    }
                }
            }
            .padding(10)
        }
        .background(Color(.systemBackground).opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
    }

    private func cell(_ value: JSON) -> String {
        if let string = value.string { return string }
        if let number = value.double { return number.rounded() == number ? String(Int(number)) : String(number) }
        if let bool = value.bool { return bool ? "✓" : "✗" }
        return ""
    }
}

/// HuiCharts options (`data` rows, `xAxis.data` naming the category field) as Swift Charts.
private struct ChartView: View {
    let kind: String
    let options: JSON

    private struct Point: Identifiable {
        let id = UUID()
        let category: String
        let series: String
        let value: Double
    }

    var body: some View {
        let rows = options["data"].array
        let categoryKey = options["xAxis"]["data"].string ?? rows.first?.object.first { $0.value.string != nil }?.key ?? ""
        let points: [Point] = rows.flatMap { row in
            row.object.compactMap { key, value -> Point? in
                guard key != categoryKey, let number = value.double else { return nil }
                return Point(category: row[categoryKey].string ?? row[categoryKey].double.map { "\($0)" } ?? "", series: key, value: number)
            }
        }
        let lower = options["yAxis"]["min"].double
        let upper = options["yAxis"]["max"].double
        VStack(alignment: .leading, spacing: 6) {
            if let title = options["title"]["text"].string { Text(title).font(.subheadline.bold()) }
            Chart(points) { point in
                if kind.contains("Pie") || kind.contains("Ring") {
                    SectorMark(angle: .value(point.series, point.value), innerRadius: .ratio(kind.contains("Ring") ? 0.5 : 0))
                        .foregroundStyle(by: .value("类别", point.category))
                } else if kind.contains("Line") || kind.contains("Area") {
                    LineMark(x: .value("类别", point.category), y: .value(point.series, point.value))
                        .foregroundStyle(by: .value("系列", point.series))
                        .symbol(by: .value("系列", point.series))
                } else {
                    // Bars start at the axis minimum (often not 0, e.g. years).
                    BarMark(x: .value("类别", point.category), yStart: .value("起点", lower ?? 0), yEnd: .value(point.series, point.value))
                        .foregroundStyle(by: .value("系列", point.series))
                        .position(by: .value("系列", point.series))
                }
            }
            .chartYScale(domain: (lower ?? 0)...(upper ?? (points.map(\.value).max() ?? 1) * 1.1))
            .chartPlotStyle { $0.clipped() }
            .frame(height: 220)
        }
    }
}
