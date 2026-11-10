// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SubKitAnalytics",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [.library(name: "SubKitAnalytics", targets: ["SubKitAnalytics"])],
    targets: [
        .target(name: "SubKitAnalytics", path: "sdks/ios/Sources/SubKitAnalytics"),
        .testTarget(name: "SubKitAnalyticsTests", dependencies: ["SubKitAnalytics"], path: "sdks/ios/Tests/SubKitAnalyticsTests")
    ]
)
