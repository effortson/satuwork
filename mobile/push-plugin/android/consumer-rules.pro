# Tauri 按类名反射找插件（register_android_plugin 传的就是这个名字），release 构建开了混淆也不能改名。
-keep class sg.dami.satuwork.push.SatuPushPlugin { *; }
