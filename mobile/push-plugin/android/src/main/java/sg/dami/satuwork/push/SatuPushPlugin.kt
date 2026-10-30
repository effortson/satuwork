package sg.dami.satuwork.push

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.webkit.WebView
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

@InvokeArg
class ClearNotificationArgs { var ids: Array<String> = emptyArray() }

/*
 * 手机壳的远程推送，Android 那半（iOS 那半在 ../../../../../../../ios/Sources/SatuPushPlugin.swift）。
 *
 * register（通知权限和 FCM 令牌）、takeTap（通知点击，取一次就清），以及 Android 的
 * backgroundStatus / openBackgroundSettings（后台限制检测与设置入口）。
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
    private var page: WebView? = null

    override fun load(webView: WebView) {
        page = webView
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(
                activity.getString(R.string.satu_notification_channel_id),
                activity.getString(R.string.satu_notification_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            )
            activity.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        takeIntent(activity.intent)
    }

    /**
     * 应用在后台时点通知走这里。记下之后叫页面一声来取（和 iOS 那半一样，见 SatuPushPlugin.swift
     * 的文件头）：页面本来就会在回前台时取，这一声让它不必赌谁先到。冷启动走 load，那时页面还没起来，
     * 由页面启动完自己取。
     */
    override fun onNewIntent(intent: Intent) {
        if (takeIntent(intent)) {
            page?.post {
                page?.evaluateJavascript("window.__SATUWORK_PUSH_TAPPED__ && window.__SATUWORK_PUSH_TAPPED__()", null)
            }
        }
    }

    /** 是不是一次点通知；是的话记进 pendingTap。 */
    private fun takeIntent(intent: Intent?): Boolean {
        val extras = intent?.extras ?: return false
        if (extras.getString("google.message_id") == null) return false
        val tap = JSObject()
        extras.getString("botId")?.let { tap.put("botId", it) }
        extras.getString("kind")?.let { tap.put("kind", it) }
        pendingTap = tap
        for (key in listOf("google.message_id", "botId", "kind")) intent.removeExtra(key)
        return true
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
    fun backgroundStatus(invoke: Invoke) {
        val power = activity.getSystemService(PowerManager::class.java)
        val manager = activity.getSystemService(ActivityManager::class.java)
        val out = JSObject()
        out.put("supported", true)
        out.put("backgroundRestricted", Build.VERSION.SDK_INT >= 28 && manager.isBackgroundRestricted)
        out.put("batteryOptimizationIgnored", power.isIgnoringBatteryOptimizations(activity.packageName))
        invoke.resolve(out)
    }

    /** 通用的应用详情入口；电池页名称与路径由各手机厂商决定。 */
    @Command
    fun openBackgroundSettings(invoke: Invoke) {
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:${activity.packageName}")))
                invoke.resolve()
            } catch (error: Exception) {
                invoke.reject("Unable to open application settings: ${error.message}")
            }
        }
    }

    @Command
    fun takeTap(invoke: Invoke) {
        val tap = pendingTap ?: JSObject()
        pendingTap = null
        invoke.resolve(tap)
    }

    @Command
    fun clearNotifications(invoke: Invoke) {
        val ids = invoke.parseArgs(ClearNotificationArgs::class.java).ids.toSet()
        val manager = activity.getSystemService(NotificationManager::class.java)
        for (notice in manager.activeNotifications) {
            val tag = notice.tag ?: continue
            if (tag.startsWith("satu:") && ids.contains(tag.removePrefix("satu:"))) manager.cancel(tag, notice.id)
        }
        invoke.resolve()
    }
}
