// swift-tools-version:6.0
import PackageDescription

// Pure, platform-agnostic logic for the ADHD Reader iOS app: the cloud-sync
// merge/tombstone contract and the SM-2 flashcard scheduler, ported 1:1 from
// the Chrome extension's `src/shared/*.ts`. No Firebase/SwiftUI here — this
// package builds from the command line (`swift build`) so the shared behavior
// can be verified without Xcode. The app target links the library.
//
// Verification runs as an executable (`swift run CoreVerify`) rather than
// XCTest, because the Command Line Tools toolchain ships neither XCTest nor
// swift-testing. In full Xcode these checks can be promoted to an XCTest target.
let package = Package(
    name: "ADHDReaderCore",
    products: [
        .library(name: "ADHDReaderCore", targets: ["ADHDReaderCore"]),
        .executable(name: "CoreVerify", targets: ["CoreVerify"]),
    ],
    targets: [
        .target(name: "ADHDReaderCore"),
        .executableTarget(
            name: "CoreVerify",
            dependencies: ["ADHDReaderCore"],
            // Script-like harness: opt out of Swift 6 strict-concurrency checks
            // for its top-level mutable counters.
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
