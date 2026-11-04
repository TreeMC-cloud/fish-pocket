import SwiftUI
import UniformTypeIdentifiers

/// Things dragged onto a conversation join the draft (C-104): files and images from
/// another app or window as attachments, plain text and links as text. A drag ending
/// on the input itself is the text field's own.
struct ComposerDrop: ViewModifier {
    let composer: ComposerModel
    /// False where this conversation takes no messages.
    let enabled: Bool
    @Environment(AppModel.self) private var app
    @State private var targeted = false

    func body(content: Content) -> some View {
        content
            .onDrop(of: [.item], isTargeted: $targeted) { providers in
                guard enabled else { return false }
                Task { await add(providers) }
                return true
            }
            .overlay {
                if targeted && enabled {
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .strokeBorder(Palette.secondary, style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
                        .background(Palette.background.opacity(0.7), in: RoundedRectangle(cornerRadius: 28, style: .continuous))
                        .overlay { Text("松手添加到消息").font(.headline).foregroundStyle(Palette.ink) }
                        .padding(12)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
    }

    private func add(_ providers: [NSItemProvider]) async {
        var files: [URL] = []
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.folder.identifier) {
                app.showToast(String(localized: "只有桌面端支持添加文件夹，请添加单个文件"))
            } else if !Self.isFile(provider), let text = await Self.text(of: provider) {
                composer.text = composer.text.isEmpty || composer.text.last?.isWhitespace == true ? composer.text + text : composer.text + " " + text
            } else if let file = await Self.file(of: provider) {
                files.append(file)
            } else {
                app.showToast(String(localized: "无法读取拖入的内容"))
            }
        }
        guard !files.isEmpty else { return }
        composer.addFiles(files)
        for file in files { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
    }

    /// A text file also reads as a string, so this has to be asked before reading one.
    private static func isFile(_ provider: NSItemProvider) -> Bool {
        provider.suggestedName != nil || provider.hasRepresentationConforming(toTypeIdentifier: UTType.item.identifier, fileOptions: .openInPlace)
    }

    private static func text(of provider: NSItemProvider) async -> String? {
        guard provider.canLoadObject(ofClass: String.self) else { return nil }
        return await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: String.self) { value, _ in continuation.resume(returning: value) }
        }
    }

    /// A copy of ours: the provider's file only lasts as long as its callback.
    private static func file(of provider: NSItemProvider) async -> URL? {
        guard let type = provider.registeredContentTypes.first(where: { $0.conforms(to: .data) }) ?? provider.registeredContentTypes.first else { return nil }
        return await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else { return continuation.resume(returning: nil) }
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent("drops/\(UUID().uuidString)", isDirectory: true)
                let copy = folder.appendingPathComponent(url.lastPathComponent)
                do {
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    try FileManager.default.copyItem(at: url, to: copy)
                    continuation.resume(returning: copy)
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
    }
}
