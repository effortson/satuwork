import Tauri
import UIKit

/*
 手机壳的「下载」，iOS 那半（Rust 那一半在 ../../src/lib.rs）。

 Rust 已经把文件写进应用缓存目录，这里只弹系统的分享面板（UIActivityViewController）：面板里有
 「存储到文件」、AirDrop、发给别的应用，手机上「下载」该去的地方都在里面。面板弹出来就回话，
 不等人选完——页面不关心存到了哪儿。
 */

class ShareArgs: Decodable {
  let path: String
  let mime: String?
}

@objc(SatuSharePlugin)
class SatuSharePlugin: Plugin {
  @objc public func share(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ShareArgs.self)
    let url = URL(fileURLWithPath: args.path)
    DispatchQueue.main.async {
      guard let root = self.manager.viewController else {
        invoke.reject("没有可以弹面板的界面")
        return
      }
      // 已经有弹层（比如上一个面板还没收）时要从最上面那层弹，否则 present 会被系统忽略。
      var top = root
      while let next = top.presentedViewController { top = next }
      let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      // iPad 上面板是弹出框，必须有锚点，不给就崩。锚在屏幕底边正中，不画箭头。
      if let pop = sheet.popoverPresentationController {
        pop.sourceView = top.view
        pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY - 1, width: 1, height: 1)
        pop.permittedArrowDirections = []
      }
      top.present(sheet, animated: true) { invoke.resolve() }
    }
  }
}

@_cdecl("init_plugin_satu_share")
func initPlugin() -> Plugin {
  return SatuSharePlugin()
}
