#if DEBUG
import Foundation

/// Synthetic session events in the engine's shapes, for `-dshOpen timeline`:
/// every kind of row and tool card without an API key.
enum TimelineFixture {
    private static var seq = 0
    private static var clock = Date().timeIntervalSince1970 * 1000 - 3_600_000

    private static func event(_ type: String, _ data: JSON) -> JSON {
        seq += 1
        clock += 1500
        return ["type": .string(type), "seq": .number(Double(seq)), "time": .number(clock), "data": data]
    }

    private static func user(_ text: String, source: JSON = ["kind": "user"], id: String? = nil) -> JSON {
        var data: [String: JSON] = ["content": [["type": "text", "text": .string(text)]], "source": source]
        if let id { data["id"] = .string(id) }
        return event("user/message", .object(data))
    }

    private static func call(_ id: String, _ name: String, _ arguments: JSON) -> JSON {
        let raw = (try? JSONEncoder().encode(arguments)).map { String(decoding: $0, as: UTF8.self) } ?? ""
        return ["type": "tool-call", "id": .string(id), "name": .string(name), "arguments": .string(raw)]
    }

    private static func assistant(_ turn: Int, id: String, _ content: [JSON], usage: JSON = ["inputTokens": 120, "outputTokens": 340, "cacheReadTokens": 2300, "cacheWriteTokens": 0, "reasoningTokens": 80, "totalTokens": 2760]) -> JSON {
        event("assistant/message", ["turn": .number(Double(turn)), "step": 1, "message": ["id": .string(id), "role": "assistant", "content": .array(content), "source": ["provider": "deepseek", "model": "deepseek-v4-pro"]], "usage": usage])
    }

    private static func result(_ id: String, _ text: String, meta: JSON = .null, isError: Bool = false, error: JSON = .null) -> JSON {
        var data: [String: JSON] = ["turn": 1, "step": 1, "message": ["toolCallId": .string(id), "source": ["kind": "tool", "callId": .string(id)], "content": [["type": "text", "text": .string(text)]], "isError": .bool(isError)]]
        if !meta.isNull { data["meta"] = meta }
        if !error.isNull { data["error"] = error }
        return event("tool/result", .object(data))
    }

    static let events: [JSON] = {
        let turn1: [JSON] = [
            user("帮我看看这个工作区，顺便用这个 key 试试 " + "sk-" + "abcdefghij0123456789klmn"),
            event("turn/start", ["turn": 1]),
            assistant(1, id: "m1", [
                ["type": "reasoning", "text": "**先看看目录结构**\n然后再决定读哪些文件。\n\n接着检查构建脚本。\n"],
                call("c1", "bash", ["command": "swift build", "description": "构建项目"]),
                call("c2", "bash", ["command": "ls -la", "description": "列出文件", "workdir": "app"]),
                call("c3", "read", ["file_path": "/tmp/work/README.md", "offset": 3]),
                call("c4", "edit", ["file_path": "/tmp/work/app/main.swift", "old_string": "print(1)", "new_string": "print(2)"]),
                call("c5", "write", ["file_path": "/tmp/work/notes.md", "content": "# 笔记\n第一行\n第二行\n"]),
                call("c6", "grep", ["pattern": "needle", "path": "."]),
                call("c7", "glob", ["pattern": "**/*.swift"]),
                call("c8", "web_search", ["queries": ["SwiftUI 滚动位置", "iOS 18 onScrollGeometryChange"]]),
                call("c9", "web_fetch", ["url": "https://example.com/doc"]),
                call("c10", "todo_write", ["todos": [["content": "读代码", "status": "completed"], ["content": "改代码", "status": "in_progress"], ["content": "跑测试", "status": "pending"]]]),
                call("c11", "ask_user_question", ["questions": [["id": "q1", "question": "用哪个方案？"], ["id": "q2", "question": "要写测试吗？"]]]),
                call("c12", "bash", ["command": "rm -rf /", "description": "清理"]),
                call("c13", "exit_plan_mode", ["plan": "# 重构计划\n\n先拆模块，再补测试。"]),
                call("c14", "present", ["files": [["path": "/tmp/work/report.pdf", "description": "分析报告（PDF）"]]]),
                call("c15", "skill", ["name": "code-review"]),
                call("c16", "mcp__github__list_issues", ["repo": "demo"]),
            ]),
            result("c1", "Compiling\nerror: oops\n[exit code: 2]"),
            result("c2", "a.txt\nb.txt", meta: ["cwd": "/tmp/work/app"]),
            result("c3", "<path>/tmp/work/README.md</path>", meta: ["path": "/tmp/work/README.md", "offset": 3, "totalLines": 40, "lang": "markdown", "lines": .array((3...14).map { ["number": .number(Double($0)), "text": .string("第 \($0) 行内容")] })]),
            result("c4", "ok", meta: ["path": "/tmp/work/app/main.swift", "diffs": [["path": "/tmp/work/app/main.swift", "oldText": "import Foundation\nprint(1)\n", "newText": "import Foundation\nprint(2)\n"]]]),
            result("c5", "ok", meta: ["operation": "create", "path": "/tmp/work/notes.md", "diffs": []]),
            result("c6", "Found 3 matches", meta: ["shape": "matches", "truncated": false, "total": 3, "files": [["path": "/tmp/work/a.swift", "matches": [["lineNumber": 3, "line": "// needle: x"], ["lineNumber": 9, "line": "// needle: y"]]], ["path": "/tmp/work/b.swift", "matches": [["lineNumber": 1, "line": "// needle: z"]]]]]),
            result("c7", "a.swift", meta: ["shape": "paths", "truncated": true, "total": 120, "paths": ["/tmp/work/a.swift", "/tmp/work/b.swift"]]),
            result("c8", "...", meta: ["truncated": true, "answer": "可以用 **onScrollGeometryChange**。", "sources": [["url": "https://example.com/a", "title": "滚动几何", "snippet": "摘要文字", "publishedAt": "2026-01-02"], ["url": "https://example.com/b"]]]),
            result("c9", "...", meta: ["url": "https://example.com/doc", "statusCode": 200, "truncated": true]),
            event("todo/write", ["todos": [["content": "读代码", "status": "completed"], ["content": "改代码", "status": "in_progress"], ["content": "跑测试", "status": "pending"]]]),
            result("c10", "ok"),
            result("c11", "{\"answers\":[{\"id\":\"q1\",\"selected\":[\"方案一\"]},{\"id\":\"q2\",\"selected\":[]}]}"),
            result("c12", "Auto review rejected tool", isError: true, error: ["name": "AutoReviewDeniedError", "code": "AUTO_REVIEW_DENIED", "reason": "删除根目录风险太高"]),
            result("c13", "{\"approved\":true}"),
            event("deliverables/presented", ["turn": 1, "callId": "c14", "files": [["path": "/tmp/work/report.pdf", "description": "分析报告（PDF）"]]]),
            result("c14", "ok"),
            result("c15", "# Code review skill\n说明文字"),
            result("c16", "[]"),
            assistant(1, id: "m2", [["type": "text", "text": "改好了，主要在 `main.swift`，另写了 `notes.md`。\n\n- 第一点\n- 第二点"]]),
            event("turn/end", ["turn": 1, "reason": ["kind": "completed"]]),
        ]
        let rest: [JSON] = [
            user("继续"),
            event("turn/start", ["turn": 2]),
            event("llm/retry", ["retryId": "r1", "turn": 2, "step": 1, "mode": "normal", "retry": 2, "maxRetries": 5, "delayMs": 4000, "failure": ["code": "RATE", "message": "429 Too Many Requests"]]),
            event("llm/retry-started", ["retryId": "r1", "turn": 2, "step": 1, "retry": 2]),
            assistant(2, id: "m3", [["type": "text", "text": "这是一段被截断的回答"]]),
            event("turn/end", ["turn": 2, "reason": ["kind": "max-tokens"]]),
            event("command/run", ["commandId": "cmd1", "name": "compact"]),
            event("compaction/start", ["compactionId": "z1", "sourceCommandId": "cmd1", "turn": .null]),
            event("compaction/summary", ["compactionId": "z1", "sourceCommandId": "cmd1", "summary": [["type": "text", "text": "## 摘要\n之前讨论了重构。"]], "shadowedSeqs": [1, 2, 3], "shadowedTokenCount": 8200]),
            event("compaction/end", ["compactionId": "z1", "sourceCommandId": "cmd1", "turn": .null]),
            event("command/done", ["commandId": "cmd1", "kind": "success", "text": "已压缩"]),
            event("command/run", ["commandId": "cmd2", "name": "status"]),
            event("command/done", ["commandId": "cmd2", "kind": "success", "text": "第一行\n第二行"]),
            event("command/run", ["commandId": "cmd3", "name": "boom"]),
            event("command/done", ["commandId": "cmd3", "kind": "error"]),
            event("agent/inbox/spliced", ["target": "next-turn", "start": 0, "removedCount": 0, "inserted": [["id": "w1", "source": ["kind": "schedule"]]]]),
            event("agent/inbox/spliced", ["target": "next-turn", "start": 0, "removedCount": 1, "inserted": []]),
            event("turn/start", ["turn": 3]),
            user("定时任务：整理今天的待办", source: ["kind": "schedule"], id: "w1"),
            assistant(3, id: "m4", [["type": "text", "text": "待办已整理。"]]),
            event("turn/end", ["turn": 3, "reason": ["kind": "error", "error": ["code": "RATE", "message": "模型服务暂时不可用"]]]),
            user("{\"kind\":\"answer_to_pending_question\",\"tool\":\"ask_user_question\",\"callId\":\"c9\",\"questions\":[{\"id\":\"q\",\"header\":\"方案\",\"question\":\"用哪个？\",\"options\":[{\"label\":\"甲\",\"description\":\"快\"},{\"label\":\"乙\"}]}],\"answers\":[{\"id\":\"q\",\"selected\":[\"甲\"]}]}", source: ["kind": "user-question-reply", "callId": "c9", "outcome": "answered"]),
        ]
        return turn1 + rest
    }()
}
#endif
