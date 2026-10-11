plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "sg.dami.satuwork.share"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    // tauri-plugin 的构建脚本把 Tauri 的 Android API 拷到 ../.tauri/tauri-api，app 的 tauri.settings.gradle
    // 把它注册成 :tauri-android。
    implementation(project(":tauri-android"))
    // FileProvider：把缓存目录里的文件以 content:// 交给别的应用。app 的 AndroidManifest 已经声明了
    // ${applicationId}.fileprovider，覆盖缓存目录（res/xml/file_paths.xml 的 cache-path）。
    implementation("androidx.core:core:1.13.1")
}
