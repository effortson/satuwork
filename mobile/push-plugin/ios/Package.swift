// swift-tools-version:5.5

import PackageDescription

let package = Package(
  name: "tauri-plugin-satu-push",
  platforms: [
    .iOS(.v15),
  ],
  products: [
    .library(
      name: "tauri-plugin-satu-push",
      type: .static,
      targets: ["tauri-plugin-satu-push"])
  ],
  dependencies: [
    // tauri-plugin 的构建脚本把 Tauri 的 Swift API 拷到这儿（不进版本库，见 mobile/push-plugin/.gitignore）。
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-satu-push",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
