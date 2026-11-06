import SwiftUI

/// Shell notices, filling the screen they sit on (the gap between them takes no
/// touches). On top, what describes the app's state: the connection banner (S-10)
/// and the account notices. At the bottom, in the thumb's reach just above the
/// composer, the shell toast (S-128, one at a time, a newer one replaces it).
struct ShellNotices: View {
    @Environment(AppModel.self) private var app
    @Environment(\.noticesHosted) private var hosted
    /// The banner waits a moment so a quick reconnect never flashes it.
    @State private var showOffline = false

    /// Over a sheet there is no composer, but there may be a bottom bar.
    private var bottomInset: CGFloat { hosted ? 56 : app.composerHeight + 8 }

    var body: some View {
        VStack(spacing: 8) {
            if showOffline {
                Label("引擎已断开，正在重连…", systemImage: "wifi.exclamationmark")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Palette.ink)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(Palette.grouped, in: Capsule())
                    .overlay(Capsule().strokeBorder(Palette.stroke))
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
            AccountNotices()
            Spacer(minLength: 0)
            if let toast = app.toast {
                ToastView(toast: toast) { withAnimation { app.dismissToast(toast.id) } }
                    .id(toast.id)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, bottomInset)
        .animation(.snappy, value: app.toast)
        .animation(.snappy, value: showOffline)
        .task(id: app.connected) {
            guard !app.connected, app.generation > 0 else { showOffline = false; return }
            try? await Task.sleep(for: .seconds(1.5))
            if !Task.isCancelled { showOffline = true }
        }
    }
}

/// The toast bar: an icon for its tone, the short text, and its button on the
/// right edge. A tap elsewhere dismisses it.
private struct ToastView: View {
    let toast: Toast
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            switch toast.tone {
            case .success: Image(systemName: "checkmark.circle.fill")
            case .warning: Image(systemName: "exclamationmark.triangle.fill")
            case .plain: EmptyView()
            }
            Text(toast.text)
                .fixedSize(horizontal: false, vertical: true)
            if !toast.actions.isEmpty {
                Spacer(minLength: 8)
                ForEach(Array(toast.actions.enumerated()), id: \.offset) { _, action in
                    Button {
                        Haptics.tap()
                        action.perform()
                        dismiss()
                    } label: {
                        Text(action.label).font(.subheadline.weight(.semibold)).padding(.horizontal, 8).hitTarget()
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(Palette.onInk)
        .padding(.leading, 16)
        .padding(.trailing, toast.actions.isEmpty ? 16 : 8)
        .frame(minHeight: 44)
        .padding(.vertical, toast.actions.isEmpty ? 2 : 0)
        .frame(maxWidth: toast.actions.isEmpty ? nil : 480)
        .background(Palette.ink, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .onTapGesture(perform: dismiss)
        .accessibilityElement(children: .contain)
        .task {
            try? await Task.sleep(for: .seconds(toast.duration))
            // Cancelled means this host went away, and the sleep returns at once: the toast
            // itself is still due, on whichever host remains. Installing an enable failure
            // raises it just as the install sheet closes.
            if !Task.isCancelled { dismiss() }
        }
    }
}
