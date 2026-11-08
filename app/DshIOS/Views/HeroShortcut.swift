import SwiftUI

/// 空会话首屏的四个入口。
///
/// 为什么是这四个：新用户面对一个空输入框，最常卡在「我能让它干什么」。
/// 这四个覆盖了他 80% 的真实需求（写东西 / 查资料 / 管文件 / 闲聊），
/// 每个只给一句具体的话，点一下就填进输入框——不是直接发送。
///
/// 为什么不直接发：填进去能改，用户才知道自己「能控制它」；
/// 直接发出去会让人以为这是个只有四个按钮的玩具。
///
/// `scene` 是和引擎 `skills/scene/panel.mjs` 的模板名对齐的：
/// 提示词里带上它，AI 就会照那个场景的面板配置来组织回答，
/// 于是点「写东西」看到的不是同一张通用面板，而是「待办 / 文档 / 字数」。
struct HeroShortcut: Identifiable {
    let id: String
    let icon: String
    let title: LocalizedStringKey
    let detail: LocalizedStringKey
    /// 填进输入框的话。留一个空位让用户接着写具体内容。
    let prompt: String
    /// 对应 panel.mjs 里的模板键；nil 表示不指定场景。
    let scene: String?

    static let all: [HeroShortcut] = [
        HeroShortcut(
            id: "write",
            icon: "square.and.pencil",
            title: "写点东西",
            detail: "文章 / 周报 / 清单",
            prompt: String(localized: "帮我写："),
            scene: "writing"
        ),
        HeroShortcut(
            id: "search",
            icon: "magnifyingglass",
            title: "帮我查",
            detail: "搜资料 / 读网页",
            prompt: String(localized: "帮我查一下："),
            scene: nil
        ),
        HeroShortcut(
            id: "files",
            icon: "folder",
            title: "管文件",
            detail: "整理 / 找 / 改名",
            prompt: String(localized: "帮我整理文件："),
            scene: "dev"
        ),
        HeroShortcut(
            id: "chat",
            icon: "bubble.left.and.bubble.right",
            title: "随便聊",
            detail: "问答 / 出主意",
            prompt: "",
            scene: nil
        ),
    ]
}
