import SwiftUI

/// 「导出日志」: the engine zips this session, its sub-sessions and attachments
/// (`api/session.export`); here the ZIP lands in a temporary file to share.
struct SessionLogExportSheet: View {
    let sessionId: String
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var file: URL?
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Text(file != nil ? "导出已就绪" : failure != nil ? "导出失败" : "正在导出会话")
                    .font(.title3.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                if file == nil && failure == nil { ProgressView().controlSize(.small) }
            }
            Group {
                if let failure {
                    Text(failure)
                } else if file != nil {
                    Text("ZIP 含当前会话、子会话和附件，分享前请确认接收方。")
                } else {
                    Text("正在打包当前会话、子会话和附件。")
                }
            }
            .font(.subheadline)
            .foregroundStyle(Palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button("关闭") { dismiss() }.buttonStyle(.capsule(.secondary))
                if let file {
                    ShareLink(item: file) { Text("分享") }.buttonStyle(.capsule())
                }
            }
        }
        .padding(EdgeInsets(top: 28, leading: 22, bottom: 22, trailing: 22))
        .fittedSheet()
        .task { await export() }
        .onDisappear { if let file { try? FileManager.default.removeItem(at: file) } }
    }

    private func export() async {
        var components = URLComponents(url: app.client.origin.appendingPathComponent("api/session.export"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "sessionId", value: sessionId), URLQueryItem(name: "includeDescendants", value: "true")]
        do {
            let (temporary, response) = try await app.client.session.download(for: app.client.request(components.url!))
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                let body = (try? Data(contentsOf: temporary)).flatMap { try? JSONDecoder().decode(JSON.self, from: $0) }
                try? FileManager.default.removeItem(at: temporary)
                failure = body?["error"]["message"].string ?? String(localized: "无法开始导出")
                Haptics.error()
                return
            }
            let name = "dsh-session-\(sessionId.map { $0.isLetter || $0.isNumber || $0 == "-" ? $0 : "_" }.reduce(into: "") { $0.append($1) }).zip"
            let target = FileManager.default.temporaryDirectory.appendingPathComponent(name)
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: temporary, to: target)
            file = target
            Haptics.success()
        } catch is CancellationError {
        } catch {
            failure = error.localizedDescription
            Haptics.error()
        }
    }
}
