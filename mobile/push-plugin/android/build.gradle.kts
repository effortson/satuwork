plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "sg.dami.satuwork.push"
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
    implementation("com.google.firebase:firebase-messaging:24.1.2")
}
