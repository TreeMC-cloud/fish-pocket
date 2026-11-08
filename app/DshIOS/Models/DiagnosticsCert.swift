import Foundation

/// 诊断服务器的自签证书（DER，base64）。
///
/// 为什么要内置：那台服务器没有外网出口，签不了 Let's Encrypt，
/// 所以用自签证书 + 这里做**指纹固定**（certificate pinning）。
/// 只信任这一张证书，比 `NSAllowsArbitraryLoads` 或关掉证书校验安全得多——
/// 换一张证书（中间人）会直接失败。
///
/// 证书换了（重新生成）就要更新这里，否则上报会停在「服务器证书不被信任」。
/// 有效期到 2036-11-05，指纹 SHA-256：
/// DF:8A:AC:94:2F:F0:0D:00:DB:ED:35:D1:CA:A8:4D:DF:23:65:EA:26:FC:27:19:0B:BF:C8:01:ED:21:6E:86:D8
enum DiagnosticsCert {
    static let serverDERBase64 = "MIIBlTCCATygAwIBAgIUY1vzIYvfH8OTeRHalSsJBYDXvyYwCgYIKoZIzj0EAwIwGDEWMBQGA1UEAwwNMjAyLjE4OS41MS40NDAeFw0yNjExMDgyMTE1MTdaFw0zNjExMDUyMTE1MTdaMBgxFjAUBgNVBAMMDTIwMi4xODkuNTEuNDQwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQ0aPoHn5Bo2Fwo4cUqoqStQTb2C8wC2zhscLdyvPoxQjDCvitFELHMxVfMqFjmvvib8KDo4GyL7KGsgAST3Q7lo2QwYjAdBgNVHQ4EFgQUUXiNOBbxATIswnH7vx3DspGRjs8wHwYDVR0jBBgwFoAUUXiNOBbxATIswnH7vx3DspGRjs8wDwYDVR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwTKvTMsMAoGCCqGSM49BAMCA0cAMEQCIAOnTrzGzeCDFMpBqUwhHwcuPg9PFyZYsUoYRAZgbj3wAiAwsTZCLRm1bQXTMjH63UJTIf5ZEw23naLCfM7ow6xIvA=="
}
