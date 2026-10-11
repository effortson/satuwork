package sg.dami.satuwork.push

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.webkit.WebView
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/*
 * 手机壳的远程推送，Android 那半（iOS 那半在 ../../../../../../../ios/Sources/SatuPushPlugin.swift）。
 *
 * 和 iOS 同两条命令：register（要通知权限、要 FCM 令牌）、takeTap（用户点开的那条，取一次就清）。
 *
 * - **Firebase 没配就不推**：google-services.json 不进版本库（仓库是公开的），没有那个文件时 app 不
 *   套 google-services 插件，FirebaseApp 没初始化，这里回 granted: false 和原因，页面不登记。
 * - **通知权限**：Android 13 起要运行时权限，没给就回 granted: false。
 * - **点通知**：FCM 的通知消息在后台到达时由系统直接显示，点开会带着 data（botId、kind）拉起
 *   MainActivity——冷启动在 activity.intent 里，热启动走 onNewIntent。两处都只认带 google.message_id
 *   的 intent，认完就把那几个字段摘掉，免得转屏、重建时又跳一次。
 * - **前台不弹**：前台到达的通知消息交给 FirebaseMessagingService，我们没注册它，系统就不显示——
 *   和 iOS 那边「前台不弹横幅」一致，对话页自己会更新。
 */
@TauriPlugin(
    permissions = [
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
    ],
)
class SatuPushPlugin(private val activity: Activity) : Plugin(activity) {
    private var pendingTap: JSObject? = null

    override fun load(webView: WebView) {
        takeIntent(activity.intent)
    }

    override fun onNewIntent(intent: Intent) {
        takeIntent(intent)
    }

    private fun takeIntent(intent: Intent?) {
        val extras = intent?.extras ?: return
        if (extras.getString("google.message_id") == null) return
        val tap = JSObject()
        extras.getString("botId")?.let { tap.put("botId", it) }
        extras.getString("kind")?.let { tap.put("kind", it) }
        pendingTap = tap
        for (key in listOf("google.message_id", "botId", "kind")) intent.removeExtra(key)
    }

    @Command
    fun register(invoke: Invoke) {
        if (FirebaseApp.getApps(activity).isEmpty()) {
            val out = JSObject()
            out.put("granted", false)
            out.put("error", "这个包没配 Firebase（构建时没有 google-services.json）")
            invoke.resolve(out)
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", invoke, "afterPermission")
            return
        }
        fetchToken(invoke)
    }

    @PermissionCallback
    private fun afterPermission(invoke: Invoke) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            val out = JSObject()
            out.put("granted", false)
            invoke.resolve(out)
            return
        }
        fetchToken(invoke)
    }

    private fun fetchToken(invoke: Invoke) {
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            val out = JSObject()
            out.put("granted", true)
            if (task.isSuccessful && task.result != null) {
                out.put("token", task.result)
            } else {
                out.put("error", task.exception?.message ?: "拿不到 FCM 令牌")
            }
            invoke.resolve(out)
        }
    }

    @Command
    fun takeTap(invoke: Invoke) {
        val tap = pendingTap ?: JSObject()
        pendingTap = null
        invoke.resolve(tap)
    }
}
