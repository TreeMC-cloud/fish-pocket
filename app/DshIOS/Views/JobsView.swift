import SwiftUI

/// One background job as `job/list` reports it (`JobView`).
struct JobRow: Identifiable, Hashable {
    let id: String
    let kind: String
    let label: String
    let status: String
    let detail: String?
    let startedAt: Date
    let finishedAt: Date?
    let outputTotal: Double

    init(_ json: JSON) {
        id = json["id"].string ?? ""
        kind = json["kind"].string ?? ""
        label = json["label"].string ?? id
        status = json["status"].string ?? "running"
        // Live progress while running, the terminal reason once settled.
        let raw = json["progress"].string ?? json["detail"].string
        // Stopped from this app; `signal: SIGTERM; cancelled by the user` says nothing more.
        detail = raw?.contains("cancelled by the user") == true ? String(localized: "已停止") : raw
        startedAt = Date(timeIntervalSince1970: (json["startedAt"].double ?? 0) / 1000)
        finishedAt = json["finishedAt"].double.map { Date(timeIntervalSince1970: $0 / 1000) }
        outputTotal = json["output"]["total"].double ?? 0
    }

    var live: Bool { status == "running" || status == "stopping" }
    /// A live job (its output may still arrive) or a settled one that left output behind.
    var observable: Bool { live || outputTotal > 0 }

    var statusLabel: String {
        switch status {
        case "running": String(localized: "运行中")
        case "stopping": String(localized: "正在停止")
        case "completed": String(localized: "已完成")
        case "killed": String(localized: "已取消")
        default: String(localized: "已失败")
        }
    }

    /// The line under a job's command: what it is doing, and for how long.
    func summary(now: Date) -> String { [detail ?? statusLabel, duration(now: now)].joined(separator: " · ") }

    /// Elapsed time in at most two adjacent units.
    func duration(now: Date) -> String {
        let total = Int(max(0, (live ? now : finishedAt ?? startedAt).timeIntervalSince(startedAt)))
        let seconds = total % 60, minutes = (total / 60) % 60, hours = total / 3600
        if hours > 0 { return String(localized: "\(hours)小时\(minutes)分") }
        if minutes > 0 { return String(localized: "\(minutes)分\(seconds)秒") }
        return String(localized: "\(seconds)秒")
    }
}

/// The session's job roster: `job/list` frames carry the whole set; the stream stays
/// open while the conversation is up, so the top bar knows when there is anything to show.
@MainActor
@Observable
final class JobsModel {
    private(set) var rows: [JobRow] = []
    /// Settled rows cleared here; 清空 is client-side, as on the web.
    private(set) var cleared: Set<String> = []

    /// Live rows first in start order, then settled rows newest-first.
    var live: [JobRow] { rows.filter(\.live).sorted { $0.startedAt < $1.startedAt } }
    var settled: [JobRow] {
        rows.filter { !$0.live && !cleared.contains($0.id) }
            .sorted { ($0.finishedAt ?? $0.startedAt, $1.startedAt) > ($1.finishedAt ?? $1.startedAt, $0.startedAt) }
    }
    var visibleCount: Int { live.count + settled.count }

    func clearSettled() { cleared.formUnion(settled.map(\.id)) }

    /// `already-finished` is success: the job ended before the request landed.
    func stop(_ job: JobRow, sessionId: String, app: AppModel) async {
        do {
            try await app.client.call("job/kill", ["request": ["sessionId": .string(sessionId), "jobId": .string(job.id)]])
            Haptics.firm()
        } catch {
            Haptics.error()
            app.showToast(String(localized: "停止失败"), tone: .warning)
        }
    }

    /// Follow the roster until the task is cancelled, reopening after any failure.
    func follow(sessionId: String, app: AppModel) async {
        while !Task.isCancelled {
            do {
                for try await frame in app.mux.open("job/list", ["request": ["sessionId": .string(sessionId)]]) {
                    if frame["type"].string == "rows" { rows = frame["jobs"].array.map(JobRow.init) }
                }
            } catch {
                if Task.isCancelled { return }
            }
            try? await Task.sleep(for: .seconds(5))
        }
    }
}

/// 后台任务: 进行中, then 已结束 with 清空. A row opens its live output; a running
/// one can be stopped after a confirmation.
struct JobsSheet: View {
    let sessionId: String
    let jobs: JobsModel
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var stopping: JobRow?
    @State private var settledOpen: Bool?

    var body: some View {
        NavigationStack {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                List {
                    if !jobs.live.isEmpty {
                        Section("进行中") {
                            ForEach(jobs.live) { row($0, now: context.date) }
                        }
                        .groupedRow()
                    }
                    if !jobs.settled.isEmpty {
                        let open = settledOpen ?? jobs.live.isEmpty
                        Section {
                            if open { ForEach(jobs.settled) { row($0, now: context.date) } }
                        } header: {
                            HStack {
                                Button {
                                    withAnimation(.snappy(duration: 0.2)) { settledOpen = !open }
                                } label: {
                                    HStack(spacing: 4) {
                                        Image(systemName: "chevron.right").font(.caption2.weight(.bold)).rotationEffect(.degrees(open ? 90 : 0))
                                        Text("已结束 \(jobs.settled.count)")
                                    }
                                    .hitTarget()
                                }
                                Spacer()
                                Button { jobs.clearSettled() } label: { Text("清空").hitTarget() }
                            }
                            .buttonStyle(.plain)
                        }
                        .groupedRow()
                    }
                }
                .groupedList()
            }
            .overlay { if jobs.visibleCount == 0 { Text("暂无后台任务").font(.subheadline).foregroundStyle(Palette.secondary) } }
            .navigationTitle("后台任务")
            .navigationBarTitleDisplayMode(.inline)
            .closeButton(dismiss)
            .navigationDestination(for: JobRow.self) { job in JobOutputView(sessionId: sessionId, jobs: jobs, job: job) }
            .stopJobDialog($stopping) { job in Task { await jobs.stop(job, sessionId: sessionId, app: app) } }
        }
        // A job or two does not need the whole screen.
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private func row(_ job: JobRow, now: Date) -> some View {
        Group {
            if job.observable {
                NavigationLink(value: job) { JobRowLabel(job: job, now: now) }
            } else {
                JobRowLabel(job: job, now: now)
            }
        }
        .swipeActions {
            if job.status == "running" {
                Button { stopping = job } label: { Label("停止", systemImage: "stop.fill") }
                    .tint(Palette.removed)
            }
        }
        .contextMenu {
            Button { copyToPasteboard(job.label) } label: { Label("复制", systemImage: "doc.on.doc") }
            if job.status == "running" {
                Button(role: .destructive) { stopping = job } label: { Label("停止", systemImage: "stop.fill") }
            }
        }
    }
}

private extension View {
    /// The one confirmation before a job stops, from the list or its output page.
    func stopJobDialog(_ job: Binding<JobRow?>, stop: @escaping (JobRow) -> Void) -> some View {
        confirmationDialog("停止这个任务？", isPresented: Binding(get: { job.wrappedValue != nil }, set: { if !$0 { job.wrappedValue = nil } }), titleVisibility: .visible, presenting: job.wrappedValue) { row in
            Button("停止", role: .destructive) { stop(row) }
        } message: { row in
            Text(row.label)
        }
    }
}

private struct JobRowLabel: View {
    let job: JobRow
    let now: Date

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            mark.frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                Text(job.label).font(.subheadline).foregroundStyle(Palette.ink).lineLimit(2)
                Text(job.summary(now: now))
                    .font(.caption).foregroundStyle(Palette.secondary).lineLimit(1)
            }
        }
    }

    @ViewBuilder
    private var mark: some View {
        switch job.status {
        case "running": StatusDot(state: .running)
        case "stopping", "killed": StatusDot(state: .waiting)
        case "failed": Circle().fill(Palette.removed).frame(width: 7, height: 7)
        default: Circle().fill(Palette.faint).frame(width: 7, height: 7)
        }
    }
}

/// A job's output (`job/follow`): retained bytes, then live; the stream closes with
/// this page. Output reads from the top; once it outgrows the page, the page follows
/// its end until the user scrolls away.
struct JobOutputView: View {
    let sessionId: String
    let jobs: JobsModel
    let job: JobRow
    @Environment(AppModel.self) private var app
    @State private var text = ""
    @State private var gap = false
    @State private var failure: String?
    @State private var finished = false
    @State private var stopping: JobRow?
    @State private var end = OutputEnd()

    private var current: JobRow { jobs.rows.first { $0.id == job.id } ?? job }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    if gap { Text("……较早的输出已丢弃……").font(.caption).foregroundStyle(Palette.secondary) }
                    if let failure { Text("实时输出流中断：\(failure)").font(.caption).foregroundStyle(Palette.removed) }
                    if text.isEmpty {
                        // Some jobs only report when they end: the page says it is waiting.
                        Text(finished ? "（无输出）" : "等待输出…").font(.footnote).foregroundStyle(Palette.secondary)
                    } else {
                        Text(text)
                            .font(.footnote.monospaced())
                            .foregroundStyle(Palette.ink)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                        // iOS 17 has no scroll geometry; this marker's place in the scroll view says the same.
                        .onGeometryChange(for: OutputEnd.self) { geometry in
                            OutputEnd(contentHeight: geometry.frame(in: .named("output")).maxY, distance: -(geometry.bounds(of: .scrollView)?.maxY ?? 0))
                        } action: { new in
                            if new.contentHeight > end.contentHeight, end.distance <= OutputEnd.threshold { proxy.scrollTo("bottom", anchor: .bottom) }
                            end = new
                        }
                }
                .padding(16)
                .coordinateSpace(name: "output")
            }
        }
        .background(Palette.background)
        .navigationTitle("任务输出")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { copyToPasteboard(current.label) } label: { Label("复制命令", systemImage: "terminal") }
                    Button { copyToPasteboard(text) } label: { Label("复制输出", systemImage: "doc.on.doc") }.disabled(text.isEmpty)
                } label: { Image(systemName: "doc.on.doc") }
                .accessibilityLabel("复制")
            }
            if current.status == "running" {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("停止", role: .destructive) { stopping = current }.tint(Palette.removed)
                }
            }
        }
        .stopJobDialog($stopping) { job in Task { await jobs.stop(job, sessionId: sessionId, app: app) } }
        .task { await follow() }
    }

    /// The command, where the title used to be cut off, and how the job is doing.
    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(current.label)
                .font(.footnote.monospaced())
                .foregroundStyle(Palette.ink)
                .lineLimit(4)
                .textSelection(.enabled)
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(current.summary(now: context.date)).font(.caption).foregroundStyle(Palette.secondary).lineLimit(2)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.field, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    /// Where the end of the output sits, relative to the bottom of the page.
    private struct OutputEnd: Equatable {
        static let threshold: CGFloat = 40
        var contentHeight: CGFloat = 0
        var distance: CGFloat = 0
    }

    /// Resume from the last offset after a dropped stream; a settled job ends with `status`.
    private func follow() async {
        var offset: Double?
        while !Task.isCancelled {
            var request: [String: JSON] = ["jobId": .string(job.id), "sessionId": .string(sessionId)]
            if let offset { request["from"] = .number(offset) }
            do {
                for try await frame in app.mux.open("job/follow", ["request": .object(request)]) {
                    failure = nil
                    switch frame["type"].string {
                    case "output":
                        if frame["lossy"].bool == true { gap = true }
                        for chunk in frame["chunks"].array {
                            if chunk["gapBefore"].bool == true && !text.isEmpty { text += "\n……\n" }
                            text += chunk["text"].string ?? ""
                        }
                        // Keep the page responsive however long the job has been talking.
                        if text.utf8.count > 512_000 {
                            text = String(text.suffix(256_000))
                            gap = true
                        }
                        offset = frame["next"].double
                    case "status":
                        finished = !JobRow(frame["job"]).live
                    default:
                        break
                    }
                }
                finished = true
                return
            } catch {
                if Task.isCancelled { return }
                failure = error.localizedDescription
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }
}
