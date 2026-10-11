import ObjectiveC
import Tauri
import UIKit
import UserNotifications
import WebKit

/*
 手机壳的远程推送（Rust 那一半在 ../../src/lib.rs）。

 **为什么要往 AppDelegate 上补方法。** APNs 把设备令牌交给 `UIApplicationDelegate` 的
 `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`，而 Tauri 的 AppDelegate 是 tao
 运行时动态生成的类，插件既不拥有也继承不了它。所以第一次要令牌时用 `class_addMethod` 把这两个
 回调补到那个类上——tao 自己没实现它们，补得上；万一哪天实现了，补不上会打一行日志，要令牌那一步
 就会超时，而不是悄悄串到别人的实现里。

 **点通知。** `UNUserNotificationCenter` 的代理在插件初始化时就接管：Apple 要求在应用启动完成前设好，
 否则冷启动（从锁屏点通知把应用拉起来）的那一下点击会丢。点到的那条记在 `pendingTap`，页面来取
 （take_tap）；不主动推给页面，因为点的那一刻页面可能还没起来。

 **前台时不弹横幅**（ADR §2.5）：人就在应用里，对话页自己会更新。只进通知中心（.list），不打断。

 所有状态只在主线程上碰：UIKit 的回调本来就在主线程，Invoke 进来的命令先切过去。
 */

private var injected = false
private var pendingRegister: [Invoke] = []
private var pendingTap: [String: String]? = nil
private var lastToken: String? = nil

private func hex(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}

/**
 APNs 的哪一头认这台设备的令牌。**看签名时写进包里的 aps-environment，不看编译开关**：本机
 `build:ios` 出的 release 包用的是开发描述文件（ExportOptions.plist 的 debugging），令牌只在 sandbox
 认；按「release 就是 production」报，Gateway 发到 production 那头，APNs 回 BadDeviceToken，
 令牌当场被摘掉，推送就此没了。

 - 模拟器：sandbox（Xcode 14 起 Apple 芯片上的模拟器拿的是 sandbox 的真令牌）。
 - 包里有 embedded.mobileprovision（开发包、Ad Hoc 包）：读它的 Entitlements。它是一段 CMS 签名
   包着的 XML plist，把 `<?xml` 到 `</plist>` 那段截出来解析即可。
 - 没有描述文件：App Store / TestFlight 的包（Apple 重签时去掉了），一律 production。
 */
private func apsEnvironment() -> String {
  #if targetEnvironment(simulator)
    return "sandbox"
  #else
    guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
      let data = try? Data(contentsOf: url)
    else { return "production" }
    guard let start = data.range(of: Data("<?xml".utf8)),
      let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
      let plist = try? PropertyListSerialization.propertyList(
        from: data.subdata(in: start.lowerBound..<end.upperBound), format: nil) as? [String: Any],
      let entitlements = plist["Entitlements"] as? [String: Any],
      let env = entitlements["aps-environment"] as? String
    else {
      NSLog("[satu-push] 读不出描述文件里的 aps-environment，按 production 报")
      return "production"
    }
    return env == "development" ? "sandbox" : "production"
  #endif
}

private func resolveAll(_ payload: JsonObject) {
  let waiting = pendingRegister
  pendingRegister = []
  for invoke in waiting { invoke.resolve(payload) }
}

/// 把两个 APNs 回调补到 tao 的 AppDelegate 类上。只在主线程、只做一次。
private func injectAppDelegate() {
  guard !injected else { return }
  guard let delegate = UIApplication.shared.delegate else {
    NSLog("[satu-push] 还没有 UIApplication.delegate，这次不补")
    return
  }
  let cls: AnyClass = type(of: delegate)

  let ok: @convention(block) (AnyObject, UIApplication, NSData) -> Void = { _, _, data in
    let token = hex(data as Data)
    lastToken = token
    resolveAll(["granted": true, "token": token, "environment": apsEnvironment()])
  }
  if !class_addMethod(
    cls, sel_registerName("application:didRegisterForRemoteNotificationsWithDeviceToken:"),
    imp_implementationWithBlock(ok as Any), "v@:@@")
  {
    NSLog("[satu-push] AppDelegate 已经有 didRegisterForRemoteNotifications，没补上——令牌会拿不到")
  }

  let fail: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { _, _, error in
    NSLog("[satu-push] 要令牌失败：%@", error.localizedDescription)
    resolveAll(["granted": true, "error": error.localizedDescription])
  }
  if !class_addMethod(
    cls, sel_registerName("application:didFailToRegisterForRemoteNotificationsWithError:"),
    imp_implementationWithBlock(fail as Any), "v@:@@")
  {
    NSLog("[satu-push] AppDelegate 已经有 didFailToRegisterForRemoteNotifications，没补上")
  }
  injected = true
}

private class CenterDelegate: NSObject, UNUserNotificationCenterDelegate {
  static let shared = CenterDelegate()

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    // .list 是 iOS 14 起才有的。应用本身最低 15，但这个包单独编译时（cargo check、CI）
    // swift-rs 按更低的部署目标编，不判断就编不过。更老的系统上前台到达的通知直接不显示。
    if #available(iOS 14.0, *) {
      completionHandler([.list])
    } else {
      completionHandler([])
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    var tap: [String: String] = [:]
    // Gateway 的 payload 顶层只有 botId / kind 两个短字符串（gateway/src/lib/push.ts 的 pushMessage）。
    for key in ["botId", "kind"] {
      if let v = info[key] as? String { tap[key] = v }
    }
    DispatchQueue.main.async { pendingTap = tap }
    completionHandler()
  }
}

@objc(SatuPushPlugin)
class SatuPushPlugin: Plugin {
  /// 要通知权限，再向 APNs 要令牌。用户拒了就回 granted: false。15 秒没回音按失败回。
  @objc public func register(_ invoke: Invoke) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) {
      granted, error in
      DispatchQueue.main.async {
        guard granted else {
          invoke.resolve(["granted": false, "error": error?.localizedDescription])
          return
        }
        injectAppDelegate()
        pendingRegister.append(invoke)
        UIApplication.shared.registerForRemoteNotifications()
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
          guard pendingRegister.contains(where: { $0 === invoke }) else { return }
          pendingRegister.removeAll(where: { $0 === invoke })
          invoke.resolve(["granted": true, "error": "等不到 APNs 的设备令牌"])
        }
      }
    }
  }

  /// 用户点开的那条通知，取一次就清掉。没有就回空对象。
  @objc public func takeTap(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let tap = pendingTap ?? [:]
      pendingTap = nil
      invoke.resolve(tap as JsonObject)
    }
  }
}

@_cdecl("init_plugin_satu_push")
func initPlugin() -> Plugin {
  // 越早越好：冷启动那一下点击要在启动完成前有代理接着。
  UNUserNotificationCenter.current().delegate = CenterDelegate.shared
  return SatuPushPlugin()
}
