package sg.dami.satuwork.share

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

/*
 * 手机壳的「下载」，Android 那半（iOS 那半在 ../../../../../../../ios/Sources/SatuSharePlugin.swift）。
 *
 * Rust 已经把文件写进应用缓存目录，这里用 FileProvider 换成 content:// 地址，起系统的分享选择器
 * （ACTION_SEND）。选择器起来就回话，不等人选完。
 *
 * 读权限要两处都给：FLAG_GRANT_READ_URI_PERMISSION 管接收方，ClipData 管 Android 10 起选择器自己
 * 画的那张预览——只给 flag 的话，选择器读不到文件，预览是空的。
 */
@InvokeArg
class ShareArgs {
    lateinit var path: String
    var mime: String? = null
}

@TauriPlugin
class SatuSharePlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun share(invoke: Invoke) {
        val args = invoke.parseArgs(ShareArgs::class.java)
        val file = File(args.path)
        val uri = try {
            FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
        } catch (e: IllegalArgumentException) {
            invoke.reject("文件不在 FileProvider 认的目录里：" + e.message)
            return
        }
        val send = Intent(Intent.ACTION_SEND).apply {
            type = args.mime?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
            putExtra(Intent.EXTRA_STREAM, uri)
            clipData = ClipData.newRawUri(file.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, null).apply { addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        activity.runOnUiThread {
            try {
                activity.startActivity(chooser)
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject("起不了分享选择器：" + e.message)
            }
        }
    }
}
