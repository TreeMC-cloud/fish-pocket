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
            // 卡片走液态玻璃：面板是“浮在对话上”的一层，玻璃材质天然合适，
            // 也和输入条、引导页统一了语言。
            .glassCard(radius: 22, .panel)
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
            Text(text).font(.caption)
                .padding(.horizontal, 9).padding(.vertical, 4)
                .glassPill(.floating)
        case "TinyDivider", "hr":
            Divider()
        // ── 长任务反馈：AI 跑多步任务时给一条进度，用户不用盯着空白等 ──
        case "TinyProgress", "Progress", "progress":
            GenProgress(
                value: props["value"].double ?? props["percent"].double.map { $0 / 100 } ?? 0,
                label: props["label"].string ?? props["text"].string,
                indeterminate: props["indeterminate"].bool == true
            )
        // ── 迷你趋势：用量、耗时、次数这类一维序列，不占地方 ──
        case "TinySparkline", "Sparkline", "sparkline":
            GenSparkline(
                values: (props["values"].array ?? props["data"].array).compactMap { $0.double },
                label: props["label"].string,
                suffix: props["suffix"].string
            )
        // ── 滑块：让用户直接给个数值，胜过让他打一句话 ──
        case "TinySlider", "Slider", "slider":
            GenSlider(
                label: props["label"].string ?? "调整",
                lower: props["min"].double ?? 0,
                upper: props["max"].double ?? 100,
                initial: props["value"].double,
                suffix: props["suffix"].string
            )
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

// MARK: - 液态玻璃面板组件

/// 进度条。AI 跑多步任务时用它替代「正在思考…」的空洞等待。
///
/// 为什么要有 indeterminate：工具调用常常拿不到总步数，
/// 这时候画一条在动的玻璃轨道，比假装知道百分比更诚实。
private struct GenProgress: View {
    let value: Double
    let label: String?
    let indeterminate: Bool
    @State private var sweep = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                if let label {
                    Text(label).font(.footnote.weight(.medium))
                }
                Spacer()
                if !indeterminate {
                    Text("\(Int((value.clamped01) * 100))%")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Palette.secondary)
                }
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Palette.control)
                    if indeterminate {
                        Capsule()
                            .fill(Palette.ink)
                            .frame(width: geo.size.width * 0.32)
                            .offset(x: sweep ? geo.size.width * 0.68 : 0)
                            .onAppear {
                                withAnimation(.easeInOut(duration: 1.25).repeatForever(autoreverses: true)) {
                                    sweep = true
                                }
                            }
                    } else {
                        Capsule()
                            .fill(Palette.ink)
                            .frame(width: max(0, geo.size.width * value.clamped01))
                            .animation(.smooth(duration: 0.4), value: value)
                    }
                }
            }
            .frame(height: 6)
        }
        .padding(14)
        .glassCard(radius: 18, .panel)
    }
}

/// 迷你折线：一维数字序列的走势。用 Charts 会带来坐标轴、图例这些噪音，
/// 面板里的迷你图只要「形状」，所以直接手绘。
private struct GenSparkline: View {
    let values: [Double]
    let label: String?
    let suffix: String?

    private var range: (min: Double, max: Double) {
        guard let lo = values.min(), let hi = values.max(), hi > lo else { return (0, 1) }
        return (lo, hi)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                if let label {
                    Text(label).font(.footnote.weight(.medium))
                }
                Spacer()
                if let last = values.last {
                    Text(format(last))
                        .font(.caption.monospacedDigit().weight(.semibold))
                        .foregroundStyle(Palette.ink)
                }
            }
            GeometryReader { geo in
                let span = range.max - range.min
                let stepX = values.count > 1 ? geo.size.width / CGFloat(values.count - 1) : 0
                Path { path in
                    for (index, v) in values.enumerated() {
                        let y = geo.size.height - CGFloat((v - range.min) / (span == 0 ? 1 : span)) * geo.size.height
                        let point = CGPoint(x: CGFloat(index) * stepX, y: y)
                        if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
                    }
                }
                .stroke(Palette.ink, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))
            }
            .frame(height: 40)
        }
        .padding(14)
        .glassCard(radius: 18, .panel)
    }

    private func format(_ value: Double) -> String {
        let text = value == value.rounded() ? String(Int(value)) : String(format: "%.1f", value)
        return text + (suffix ?? "")
    }
}

/// 滑块：把「给我个数值」变成一次拖动。
///
/// 为什么不做成可提交的表单：这个渲染器是无状态的（交互留在网页版），
/// 所以滑块只负责让用户看清区间和当前值，真正的提交由 AI 下一轮问。
private struct GenSlider: View {
    let label: String
    let lower: Double
    let upper: Double
    let initial: Double?
    let suffix: String?
    @State private var value: Double
    @State private var ready = false

    init(label: String, lower: Double, upper: Double, initial: Double?, suffix: String?) {
        self.label = label
        self.lower = lower
        self.upper = upper
        self.initial = initial
        self.suffix = suffix
        _value = State(initialValue: initial ?? (lower + upper) / 2)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label).font(.footnote.weight(.medium))
                Spacer()
                Text("\(Int(value))\(suffix ?? "")")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(Palette.secondary)
            }
            Slider(value: $value, in: lower...max(lower + 0.0001, upper))
                .tint(Palette.ink)
                .onAppear { ready = true }
        }
        .padding(14)
        .glassCard(radius: 18, .panel)
    }
}

private extension Double {
    var clamped01: Double { min(max(self, 0), 1) }
}
