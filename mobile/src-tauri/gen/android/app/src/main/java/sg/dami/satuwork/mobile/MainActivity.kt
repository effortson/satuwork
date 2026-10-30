package sg.dami.satuwork.mobile

import android.os.Bundle
import android.content.Intent
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onNewIntent(intent: Intent) {
    // 后台进程被回收后，系统可能先按旧任务重建 Activity，再投递通知 intent。
    // 此时推送插件还没加载，必须保存新 intent，供插件 load() 读取 botId / kind。
    setIntent(intent)
    super.onNewIntent(intent)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    /*
     * 给系统栏、刘海和软键盘让位。
     *
     * Android 15（targetSdk 35+）起应用一律全屏铺到系统栏底下，`adjustResize` 也不再让窗口随键盘
     * 缩短：键盘弹起时 WebView 高度不变，登录按钮、对话输入框都压在键盘底下（实测）。iOS 那边
     * WebKit 会自己滚过去，Android 的 WebView 不会。
     *
     * 所以在内容视图上按这几样 inset 加内边距：WebView 被夹在中间，键盘一弹就跟着变矮，页面里
     * 那套 100dvh 的布局（gateway/ui 的 appView）自然让出位置；页面里的 env(safe-area-inset-*)
     * 在这里是 0，不会重复让。让出来的那一圈是窗口背景色（res/values 与 values-night 的 themes.xml，和页面底色一致）。
     */
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val pad = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime(),
      )
      v.setPadding(pad.left, pad.top, pad.right, pad.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
