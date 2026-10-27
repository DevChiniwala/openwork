import AppKit
import Darwin

/// How a control session's input reaches its window. Background posts events to
/// the app's process and makes the window key without raising it, so the
/// person's front app, cursor and Space stay as they are and several agents can
/// work at once. Foreground brings the window to the front first, as before.
enum InputDelivery: String {
    case background, foreground

    /// Canvas apps and games read only HID-tap input that follows a real pointer
    /// move, so routed events silently do nothing there. They keep the front.
    static let foregroundBundlePrefixes = ["org.blenderfoundation.blender", "com.unity3d."]

    /// Set by the trusted host only while the `computerUseBackground` feature is on.
    static let hostVariable = "OPENWORK_COMPUTER_USE_DELIVERY"

    static func decide(enabled: Bool, available: Bool, mode: AccessMode, bundleID: String) -> InputDelivery {
        guard enabled, available, mode == .control else { return .foreground }
        let id = bundleID.lowercased()
        return foregroundBundlePrefixes.contains(where: id.hasPrefix) ? .foreground : .background
    }
}

/// Makes a window its app's key window without raising it or activating the
/// app (the focus-without-raise pattern from yabai): WindowServer event records
/// sent to the target process only. It never calls
/// `SLPSSetFrontProcessWithOptions`, which raises and can switch Spaces, and
/// never touches the person's front app.
enum BackgroundFocus {
    private typealias PostEventRecordTo = @convention(c) (UnsafeRawPointer, UnsafeRawPointer) -> Int32
    private typealias GetProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
    private static let skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
    private static func symbol<T>(_ name: String, _ type: T.Type) -> T? {
        guard let pointer = dlsym(skyLight, name) ?? dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }
        return unsafeBitCast(pointer, to: type)
    }
    private static let postRecord = symbol("SLPSPostEventRecordTo", PostEventRecordTo.self)
    private static let processForPID = symbol("GetProcessForPID", GetProcessForPID.self)

    /// Both private calls resolved on this macOS; otherwise every session keeps the front.
    static var available: Bool { postRecord != nil && processForPID != nil }

    /// The records WindowServer reads: activate the window within its app, then
    /// make it key. Each is 0xF8 bytes with the window id at 0x3C.
    static func records(window: CGWindowID) -> [[UInt8]] {
        func record(kind: UInt8) -> [UInt8] {
            var bytes = [UInt8](repeating: 0, count: 0xF8)
            bytes[0x04] = 0xF8; bytes[0x08] = kind
            withUnsafeBytes(of: window.littleEndian) { for (index, byte) in $0.enumerated() { bytes[0x3C + index] = byte } }
            return bytes
        }
        var activate = record(kind: 0x0D)
        activate[0x8A] = 0x01
        return [activate] + ([0x01, 0x02] as [UInt8]).map { kind in
            var key = record(kind: kind)
            key[0x3A] = 0x10
            for index in 0x20..<0x30 { key[index] = 0xFF }
            return key
        }
    }

    static func makeKey(pid: pid_t, window: CGWindowID) async throws {
        var process = [UInt32](repeating: 0, count: 2)
        guard let postRecord, let processForPID,
              process.withUnsafeMutableBytes({ processForPID(pid, $0.baseAddress!) }) == 0 else {
            throw UseError("background_unavailable", "This Mac cannot work in an app in the background. Nothing was dispatched.", next: "observe")
        }
        for (index, record) in records(window: window).enumerated() {
            let status = process.withUnsafeBytes { psn in record.withUnsafeBytes { postRecord(psn.baseAddress!, $0.baseAddress!) } }
            guard status == 0 else {
                throw UseError("background_unavailable", "The window could not be made ready in the background. Nothing was dispatched.", next: "observe")
            }
            // Some apps drop an activation that arrives together with the key change.
            if index == 0 { try await Task.sleep(nanoseconds: 10_000_000) }
        }
    }
}

/// Whether an observation carries a screenshot. Requested wins. Automatic,
/// used with background delivery, reads the accessibility tree first and adds
/// the image only when the tree names too few controls to act on.
enum ImagePolicy {
    static let enoughControls = 8

    static func include(requested: Bool?, automatic: Bool, namedControls: Int) -> Bool {
        if let requested { return requested }
        return !automatic || namedControls < enoughControls
    }
}

/// What the person would notice on their desktop: which app is in front, where
/// the cursor is and which Space is shown. Receipts report changes across an
/// action, including the person's own, so background delivery can be checked.
struct DesktopState: Equatable {
    let frontPID: pid_t?
    let cursor: CGPoint
    let space: Int

    @MainActor static func now() -> DesktopState {
        DesktopState(frontPID: NSWorkspace.shared.frontmostApplication?.processIdentifier,
            cursor: CGEvent(source: nil)?.location ?? .zero, space: SpaceWatch.shared.changes)
    }

    func changes(to after: DesktopState) -> [String: Any] {
        ["front_app_changed": frontPID != after.frontPID,
         "cursor_moved": hypot(after.cursor.x - cursor.x, after.cursor.y - cursor.y) > 0.5,
         "space_changed": space != after.space]
    }
}

/// Counts Space switches since launch; NSWorkspace reports no current Space id.
@MainActor
final class SpaceWatch {
    static let shared = SpaceWatch()
    private(set) var changes = 0
    private var observer: NSObjectProtocol?

    private init() {
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.changes += 1 }
        }
    }
}
