import AppKit
import ApplicationServices
import ScreenCaptureKit

/// A dialog an action opened over the session's window: a sheet on it, a dialog
/// window the app moved its focus to, or the system Open/Save panel shown over
/// it for a sandboxed app. The session works in it until it closes, then
/// returns to its window.
struct DialogTarget {
    enum Kind: String { case sheet, dialog, filePanel = "file_panel" }
    let target: WindowTarget
    let app: AppIdentity
    let kind: Kind
}

extension AppIdentity {
    /// macOS draws Open and Save panels for sandboxed apps in this process.
    static let filePanelService = "com.apple.appkit.xpc.openAndSavePanelService"

    /// The panel process is not a regular app, so `resolve` never returns it.
    /// It is reachable only as a dialog over a window a session already controls.
    static func filePanel(pid: pid_t) -> AppIdentity? {
        guard let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == filePanelService,
              let executable = app.executableURL, let launched = ProcessStart(pid: pid) else { return nil }
        return AppIdentity(app: app, bundleID: filePanelService, executable: executable, launched: launched)
    }
}

enum DialogRules {
    static let dialogSubroles: Set<String> = ["AXDialog", "AXSystemDialog"]
    /// Default buttons that hand the chosen files to the app.
    static let fileConfirmTitles: Set<String> = ["open", "choose", "upload", "select", "attach", "insert", "add", "import", "send"]

    /// A panel for choosing files: the system panel process, or a dialog with a
    /// file browser whose default button hands files over.
    static func isFilePanel(bundleID: String, roles: Set<String>, defaultButton: String?) -> Bool {
        if bundleID == AppIdentity.filePanelService { return true }
        if roles.contains("AXBrowser") { return true }
        guard let title = defaultButton?.lowercased() else { return false }
        return roles.contains("AXOutline") && fileConfirmTitles.contains(title)
    }

    /// Whether this step would hand the panel's selection to the app.
    static func confirmsFilePanel(_ action: Action, pressed: AXUIElement?, defaultButton: AXUIElement?) -> Bool {
        if case .key(let key, _) = action, ["enter", "return"].contains(key) { return true }
        guard let pressed, let defaultButton else { return false }
        return CFEqual(pressed, defaultButton)
    }
}

extension MacAccessibility {
    /// A dialog over `target`, if an action opened one.
    func dialog(over target: WindowTarget, app: AppIdentity) async -> DialogTarget? {
        let root = AXUIElementCreateApplication(app.pid)
        // A sheet is a child of its window.
        if let children = attribute(target.element, kAXChildrenAttribute) as? [AXUIElement],
           let sheet = children.first(where: { (attribute($0, kAXRoleAttribute) as? String) == "AXSheet" }),
           let found = await windowTarget(for: sheet, pid: app.pid) {
            let kind: DialogTarget.Kind = isFilePanel(found, app: app) ? .filePanel : .sheet
            return DialogTarget(target: found, app: app, kind: kind)
        }
        // A dialog window the app moved its focus to.
        if let focused = elementAttribute(root, kAXFocusedWindowAttribute), !CFEqual(focused, target.element),
           let subrole = attribute(focused, kAXSubroleAttribute) as? String, DialogRules.dialogSubroles.contains(subrole),
           let found = await windowTarget(for: focused, pid: app.pid) {
            return DialogTarget(target: found, app: app, kind: isFilePanel(found, app: app) ? .filePanel : .dialog)
        }
        // The system Open/Save panel of a sandboxed app, drawn over the window.
        for service in NSRunningApplication.runningApplications(withBundleIdentifier: AppIdentity.filePanelService) {
            guard let identity = AppIdentity.filePanel(pid: service.processIdentifier) else { continue }
            let windows = attribute(AXUIElementCreateApplication(service.processIdentifier), kAXWindowsAttribute) as? [AXUIElement] ?? []
            for window in windows {
                guard let bounds = frame(window), bounds.intersects(target.frame),
                      target.frame.contains(CGPoint(x: bounds.midX, y: bounds.minY + 1)),
                      let found = await windowTarget(for: window, pid: service.processIdentifier) else { continue }
                return DialogTarget(target: found, app: identity, kind: .filePanel)
            }
        }
        return nil
    }

    /// Whether a followed dialog is still on screen.
    func dialogOpen(_ dialog: WindowTarget, app: AppIdentity) -> Bool {
        guard (try? app.validate()) != nil, frame(dialog.element) != nil,
              let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, dialog.id) as? [[String: Any]] else { return false }
        return info.contains { ($0[kCGWindowOwnerPID as String] as? Int32) == app.pid && ($0[kCGWindowIsOnscreen as String] as? Bool) == true }
    }

    func defaultButton(_ dialog: WindowTarget) -> AXUIElement? {
        elementAttribute(dialog.element, kAXDefaultButtonAttribute)
    }

    /// The names a file panel would hand over: its selected rows, or the name field of a save panel.
    func selectedFileNames(_ dialog: WindowTarget) -> [String] {
        var names: [String] = []
        var pending: [(AXUIElement, Int)] = [(dialog.element, 0)]
        var visited = 0
        while let (element, depth) = pending.popLast(), visited < 400 {
            visited += 1
            let role = attribute(element, kAXRoleAttribute) as? String
            if ["AXOutline", "AXTable", "AXList", "AXBrowser"].contains(role ?? ""),
               let rows = attribute(element, kAXSelectedRowsAttribute) as? [AXUIElement] {
                names += rows.prefix(20).compactMap(rowName)
            }
            if role == "AXTextField", (attribute(element, kAXIdentifierAttribute) as? String)?.lowercased().contains("save") == true,
               let value = attribute(element, kAXValueAttribute) as? String, !value.isEmpty {
                names.append(value)
            }
            guard depth < 12, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            pending += children.map { ($0, depth + 1) }
        }
        return Array(NSOrderedSet(array: names).compactMap { $0 as? String }.prefix(20))
    }

    private func rowName(_ row: AXUIElement) -> String? {
        var pending = [row]
        var visited = 0
        while let element = pending.popLast(), visited < 40 {
            visited += 1
            for name in [kAXValueAttribute, kAXTitleAttribute] {
                if let text = attribute(element, name) as? String, !text.isEmpty { return String(text.prefix(255)) }
            }
            pending += attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
        }
        return nil
    }

    private func isFilePanel(_ dialog: WindowTarget, app: AppIdentity) -> Bool {
        var roles: Set<String> = []
        var pending: [(AXUIElement, Int)] = [(dialog.element, 0)]
        var visited = 0
        while let (element, depth) = pending.popLast(), visited < 300 {
            visited += 1
            if let role = attribute(element, kAXRoleAttribute) as? String { roles.insert(role) }
            guard depth < 8, let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            pending += children.map { ($0, depth + 1) }
        }
        let title = defaultButton(dialog).flatMap { attribute($0, kAXTitleAttribute) as? String }
        return DialogRules.isFilePanel(bundleID: app.bundleID, roles: roles, defaultButton: title)
    }

    /// The on-screen window of `element`, matched by frame as `windows` does.
    private func windowTarget(for element: AXUIElement, pid: pid_t) async -> WindowTarget? {
        guard let bounds = frame(element), Geometry.valid(bounds),
              let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) else { return nil }
        let matches = content.windows.filter { window in
            window.owningApplication?.processID == pid && window.frame.width > 20 && window.frame.height > 20
                && abs(bounds.minX - window.frame.minX) < 2 && abs(bounds.minY - window.frame.minY) < 2
                && abs(bounds.width - window.frame.width) < 2 && abs(bounds.height - window.frame.height) < 2
        }
        guard matches.count == 1, let window = matches.first else { return nil }
        AXUIElementSetMessagingTimeout(element, 0.2)
        let title = attribute(element, kAXTitleAttribute) as? String
        return WindowTarget(id: window.windowID, title: title?.isEmpty == false ? title! : "Dialog", element: element, frame: window.frame)
    }
}
