import SwiftTerm
import SwiftUI

/// Keys the on-screen keyboard lacks or buries, shown under the workbench terminal.
enum TerminalKey: CaseIterable {
    case escape, tab, control, up, down, left, right, pipe, slash, dash, tilde

    var label: String {
        switch self {
        case .escape: "esc"
        case .tab: "tab"
        case .control: "ctrl"
        case .up: "↑"
        case .down: "↓"
        case .left: "←"
        case .right: "→"
        case .pipe: "|"
        case .slash: "/"
        case .dash: "-"
        case .tilde: "~"
        }
    }

    var accessibilityLabel: Text {
        switch self {
        case .escape: Text("Esc")
        case .tab: Text("Tab")
        case .control: Text("Control")
        case .up: Text("上")
        case .down: Text("下")
        case .left: Text("左")
        case .right: Text("右")
        case .pipe: Text("竖线")
        case .slash: Text("斜杠")
        case .dash: Text("减号")
        case .tilde: Text("波浪号")
        }
    }

    var sequence: String? {
        switch self {
        case .escape: "\u{1b}"
        case .tab: "\t"
        case .control: nil
        case .up: "\u{1b}[A"
        case .down: "\u{1b}[B"
        case .right: "\u{1b}[C"
        case .left: "\u{1b}[D"
        case .pipe: "|"
        case .slash: "/"
        case .dash: "-"
        case .tilde: "~"
        }
    }

    /// Goes through the emulator's text input, so a held ctrl applies to it.
    var printable: Bool {
        switch self {
        case .pipe, .slash, .dash, .tilde: true
        default: false
        }
    }
}

/// One terminal the workbench shows (the web's `TerminalView` model). It holds a
/// `terminal/retain` stream, then attaches; output frames feed the emulator one at
/// a time, and input is sent in order inside the Host's byte windows. A failed
/// attachment stays on screen with its status until `connect()` runs again.
@MainActor
@Observable
final class TerminalConnection {
    enum Phase: Equatable {
        case connecting, connected, disconnected
        case failed(String)
        /// `terminal/unavailable`: the Host has no such terminal any more.
        case missing
    }

    let id = UUID()
    let terminalId: String
    private(set) var phase = Phase.connecting
    /// `WebTerminalInfo` of the last snapshot or state frame.
    private(set) var info: JSON = .null
    private(set) var writable = false
    /// ctrl is held for the next key; the emulator lets go after that key.
    private(set) var controlActive = false

    var exited: Bool { info["state"].string == "exited" }

    @ObservationIgnored private let mux: StreamMux
    @ObservationIgnored private let client: EngineClient
    @ObservationIgnored private let sessionId: String
    @ObservationIgnored private weak var view: SwiftTerm.TerminalView?
    /// Frames that arrived before the view did, oldest first (a snapshot replaces them).
    @ObservationIgnored private var unrendered: [JSON] = []
    @ObservationIgnored private var attachTask: Task<Void, Never>?
    @ObservationIgnored private var retainTask: Task<Void, Never>?
    @ObservationIgnored private var senderTask: Task<Void, Never>?
    @ObservationIgnored private var attachment: Attachment?
    @ObservationIgnored private var maxInputBytes = 65536
    @ObservationIgnored private var maxBufferedBytes = 2_097_152
    @ObservationIgnored private var maxCols = 500
    @ObservationIgnored private var maxRows = 200
    @ObservationIgnored private var size: (cols: Int, rows: Int)?
    @ObservationIgnored private var controlReset: NSObjectProtocol?

    /// Largest single `write`: long pastes go up in pieces, each waiting for window room.
    private static let chunkBytes = 8192

    /// Input state of one attachment; sequences restart at 1 on every attach, and input is never replayed.
    private final class Attachment {
        struct Command { let value: JSON; let inputBytes: Int; let frameBytes: Int }

        let outbox: AsyncStream<JSON>.Continuation
        var sequence = 0
        var acknowledged = 0
        var pending: [Int: Command] = [:]
        var queued: [Command] = []
        /// `inputWindow` of the snapshot: bytes allowed in flight, and the carrier's per-frame overhead.
        var windowBytes: Int?
        var frameOverhead = 0
        var inFlightInput = 0
        var inFlightFrames = 0
        var bufferedBytes = 0
        var outputSequence: Int?

        init(outbox: AsyncStream<JSON>.Continuation) { self.outbox = outbox }
    }

    init(mux: StreamMux, client: EngineClient, sessionId: String, terminalId: String) {
        self.mux = mux
        self.client = client
        self.sessionId = sessionId
        self.terminalId = terminalId
        connect()
    }

    /// (Re)attach with a fresh screen, taking input control back from any other view.
    func connect() {
        detach()
        phase = .connecting
        writable = false
        attachTask = Task { [weak self] in await self?.run() }
    }

    func close() {
        detach()
        retainTask?.cancel()
        retainTask = nil
        if let controlReset { NotificationCenter.default.removeObserver(controlReset) }
        controlReset = nil
    }

    private func detach() {
        attachTask?.cancel()
        attachTask = nil
        senderTask?.cancel()
        senderTask = nil
        attachment?.outbox.finish()
        attachment = nil
        unrendered = []
    }

    private func run() async {
        if let environment = try? await client.call("terminal/environment", ["agentId": .string(sessionId)]) {
            maxInputBytes = environment["maxInputBytes"].int ?? maxInputBytes
            maxBufferedBytes = environment["maxBufferedBytes"].int ?? maxBufferedBytes
            maxCols = environment["maxCols"].int ?? maxCols
            maxRows = environment["maxRows"].int ?? maxRows
        }
        do {
            try await retain()
            if Task.isCancelled { return }
            let duplex = mux.openDuplex("terminal/attach", ["agentId": .string(sessionId), "id": .string(terminalId)])
            // One sender keeps the sequence numbers in order on the wire.
            let (outbox, continuation) = AsyncStream.makeStream(of: JSON.self)
            let attachment = Attachment(outbox: continuation)
            self.attachment = attachment
            let send = duplex.send
            senderTask = Task.detached { for await item in outbox { try? await send(item) } }
            for try await frame in duplex.items {
                if Task.isCancelled { return }
                guard handle(frame, attachment) else {
                    fail("终端画面传输异常，请重新连接。")
                    return
                }
                // Let the screen draw and touches run between frames of a large output.
                await Task.yield()
            }
            if Task.isCancelled { return }
            writable = false
            if !exited { fail("终端连接已结束，请重新连接。") }
        } catch {
            if Task.isCancelled { return }
            writable = false
            if let error = error as? EngineError, error.code != "WS_CLOSED" {
                if error.code == "terminal/unavailable" { phase = .missing; detach() } else if !exited { fail(error.message) }
            } else if !exited {
                // A transport failure: never shown as an error, the process keeps running.
                phase = .disconnected
                detach()
            }
        }
    }

    /// Wait for the first `retained` frame, then keep the stream open: it is what keeps the Host from reaping the terminal.
    private func retain() async throws {
        retainTask?.cancel()
        let frames = mux.open("terminal/retain", ["sessionId": .string(sessionId), "id": .string(terminalId)])
        let gate = RetainGate()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            gate.continuation = continuation
            retainTask = Task {
                do {
                    for try await _ in frames { gate.open(nil) }
                    gate.open(EngineError(code: "WS_CLOSED", message: "连接已断开", detail: .null))
                } catch {
                    gate.open(error)
                }
            }
        }
    }

    private final class RetainGate {
        var continuation: CheckedContinuation<Void, Error>?
        func open(_ error: Error?) {
            guard let continuation else { return }
            self.continuation = nil
            if let error { continuation.resume(throwing: error) } else { continuation.resume() }
        }
    }

    private func fail(_ message: String) {
        phase = .failed(message)
        writable = false
        detach()
    }

    /// One downlink frame; false when the stream broke the protocol (a sequence gap, a missing snapshot).
    private func handle(_ frame: JSON, _ attachment: Attachment) -> Bool {
        switch frame["type"].string {
        case "snapshot":
            guard attachment.outputSequence == nil else { return false }
            attachment.outputSequence = frame["sequence"].int ?? 0
            attachment.windowBytes = frame["inputWindow"]["maxBytes"].int
            attachment.frameOverhead = frame["inputWindow"]["frameOverheadBytes"].int ?? 0
            apply(info: frame["info"], writable: frame["writable"].bool ?? false)
            render(frame)
            sendSize()
        case "output":
            guard let sequence = attachment.outputSequence, frame["sequence"].int == sequence + 1 else { return false }
            attachment.outputSequence = sequence + 1
            render(frame)
        case "state":
            guard attachment.outputSequence != nil else { return false }
            apply(info: frame["info"], writable: frame["writable"].bool ?? false)
        case "ack":
            guard let sequence = frame["sequence"].int, sequence == attachment.acknowledged + 1, let command = attachment.pending.removeValue(forKey: sequence) else { return false }
            attachment.acknowledged = sequence
            attachment.inFlightInput -= command.inputBytes
            attachment.inFlightFrames -= command.frameBytes
            attachment.bufferedBytes -= command.frameBytes
            if frame["refusal"].string != nil { writable = false }
            flush(attachment)
        default:
            break
        }
        return true
    }

    private func apply(info: JSON, writable: Bool) {
        self.info = info
        phase = .connected
        self.writable = info["state"].string == "running" && writable
    }

    private func render(_ frame: JSON) {
        guard let view else {
            if frame["type"].string == "snapshot" { unrendered = [] }
            unrendered.append(frame)
            return
        }
        if frame["type"].string == "snapshot" {
            // A reconnect's snapshot redraws the whole screen.
            view.getTerminal().resetToInitialState()
            view.feed(text: frame["screen"].string ?? "")
        } else {
            view.feed(text: frame["data"].string ?? "")
        }
    }

    func attach(_ view: SwiftTerm.TerminalView) {
        self.view = view
        if let controlReset { NotificationCenter.default.removeObserver(controlReset) }
        controlReset = NotificationCenter.default.addObserver(forName: .terminalViewControlModifierReset, object: view, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.controlActive = false }
        }
        let frames = unrendered
        unrendered = []
        frames.forEach(render)
    }

    /// Bring up the keyboard for this terminal.
    func focus() { _ = view?.becomeFirstResponder() }

    /// Queue terminal input; a long paste splits into pieces that wait for acks (S-93).
    func write(_ data: String) {
        guard writable, let attachment, !data.isEmpty else { return }
        var bytes = data.utf8.count
        if attachment.bufferedBytes + bytes > maxBufferedBytes {
            fail("输入缓冲区已满，请重新连接后重试。")
            return
        }
        var rest = Substring(data)
        while !rest.isEmpty {
            let chunk = bytes <= Self.chunkBytes ? rest : Self.prefix(of: rest, bytes: Self.chunkBytes)
            let size = chunk.utf8.count
            rest = rest.dropFirst(chunk.count)
            bytes -= size
            enqueue(["type": "write", "data": .string(String(chunk))], inputBytes: size, attachment)
        }
    }

    /// Whole characters up to `limit` UTF-8 bytes, so a piece never ends inside one.
    private static func prefix(of text: Substring, bytes limit: Int) -> Substring {
        var used = 0
        var end = text.startIndex
        for character in text {
            let size = character.utf8.count
            if used + size > limit, used > 0 { break }
            used += size
            end = text.index(after: end)
        }
        return text[..<end]
    }

    /// A key-bar key: its sequence, or (ctrl) a modifier for the next typed key, which
    /// needs the keyboard up to be typed at all.
    func press(_ key: TerminalKey) {
        guard let view else { return }
        guard let sequence = key.sequence else {
            view.controlModifier.toggle()
            controlActive = view.controlModifier
            if controlActive { focus() }
            return
        }
        if controlActive, key.printable {
            view.insertText(sequence)
        } else {
            view.controlModifier = false
            write(sequence)
        }
    }

    /// Clipboard text as the running program expects a paste, in pieces like any long input.
    func paste(_ text: String) {
        let bracketed = view?.getTerminal().bracketedPasteMode == true
        write(bracketed ? "\u{1b}[200~\(text)\u{1b}[201~" : text)
    }

    /// Resize only from the writable view; a read-only one keeps the Host's size.
    func resize(cols: Int, rows: Int) {
        size = (cols, rows)
        sendSize()
    }

    private func sendSize() {
        guard writable, let attachment else { return }
        // Before the first layout report, the grid the view already has.
        let grid = size ?? view.map { ($0.getTerminal().cols, $0.getTerminal().rows) }
        guard let grid, grid.0 >= 20, grid.1 >= 4 else { return }
        let cols = min(grid.0, maxCols), rows = min(grid.1, maxRows)
        if info["cols"].int == cols, info["rows"].int == rows { return }
        enqueue(["type": "resize", "cols": .number(Double(cols)), "rows": .number(Double(rows))], inputBytes: 0, attachment)
    }

    /// Input commands carry a gap-free sequence the Host acks in order.
    private func enqueue(_ command: [String: JSON], inputBytes: Int, _ attachment: Attachment) {
        attachment.sequence += 1
        var frame = command
        frame["sequence"] = .number(Double(attachment.sequence))
        let value = JSON.object(frame)
        let frameBytes = ((try? JSONEncoder().encode(value))?.count ?? 0) + attachment.frameOverhead
        attachment.queued.append(Attachment.Command(value: value, inputBytes: inputBytes, frameBytes: frameBytes))
        attachment.bufferedBytes += frameBytes
        flush(attachment)
    }

    /// Send what fits in the Host's windows; the rest waits for acks.
    private func flush(_ attachment: Attachment) {
        while writable, let next = attachment.queued.first {
            if let window = attachment.windowBytes, attachment.inFlightFrames > 0, attachment.inFlightFrames + next.frameBytes > window { return }
            if attachment.inFlightInput > 0, attachment.inFlightInput + next.inputBytes > maxInputBytes { return }
            attachment.queued.removeFirst()
            attachment.outbox.yield(next.value)
            attachment.pending[next.value["sequence"].int ?? 0] = next
            attachment.inFlightInput += next.inputBytes
            attachment.inFlightFrames += next.frameBytes
        }
    }
}

struct TerminalHost: UIViewRepresentable {
    let connection: TerminalConnection
    /// The room it was given: the width of a column or a sheet, not of the screen.
    let width: CGFloat
    var fontSize: CGFloat = 13

    func makeCoordinator() -> Coordinator { Coordinator(connection: connection) }

    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        // Not `.zero`: the emulator sizes its grid from the first frame, and the snapshot fed
        // before layout would wrap at two columns (the prompt then reads one letter per line).
        let view = SwiftTerm.TerminalView(frame: CGRect(x: 0, y: 0, width: max(width, 320), height: 360))
        view.terminalDelegate = context.coordinator
        view.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        // Resizing (the keyboard) would otherwise stretch the old contents until the next output.
        view.contentMode = .redraw
        view.nativeBackgroundColor = UIColor(named: "Grouped") ?? .secondarySystemBackground
        view.nativeForegroundColor = UIColor(named: "Ink") ?? .label
        view.caretColor = UIColor(named: "Ink") ?? .label
        // The workbench draws its own key bar under the terminal.
        view.inputAccessoryView = nil
        // No first responder here: the keyboard waits for a tap on the terminal.
        connection.attach(view)
        return view
    }

    /// The font setting can change while a terminal is open; a new font re-fits the grid.
    func updateUIView(_ view: SwiftTerm.TerminalView, context: Context) {
        if view.font.pointSize != fontSize { view.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular) }
    }

    final class Coordinator: NSObject, TerminalViewDelegate {
        let connection: TerminalConnection
        init(connection: TerminalConnection) { self.connection = connection }

        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
            MainActor.assumeIsolated { connection.write(String(decoding: data, as: UTF8.self)) }
        }
        /// Layout passes through tiny sizes on the way in; a shell told it has two columns
        /// prints its prompt that narrow, and printed lines never reflow.
        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
            guard newCols >= 20, newRows >= 4 else { return }
            MainActor.assumeIsolated { connection.resize(cols: newCols, rows: newRows) }
        }
        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
        func scrolled(source: SwiftTerm.TerminalView, position: Double) {}
        func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link) { UIApplication.shared.open(url) }
        }
        func bell(source: SwiftTerm.TerminalView) {}
        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {
            UIPasteboard.general.string = String(decoding: content, as: UTF8.self)
        }
        func iTermContent(source: SwiftTerm.TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}
    }
}
