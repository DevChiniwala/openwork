import AppKit
import ApplicationServices

@MainActor
final class SessionRuntime {
    private let access = MacAccessibility()
    private let input = MacInput()
    private let controls = SessionControls()
    private let policy: RuntimePolicy
    private let clock: () -> TimeInterval
    private var session: Session?
    private var lease: ControlLease?
    private var busy = false
    private var desktopAvailable = true
    private var resumingSessionID: String?
    private var watch = WatchLease()
    private var watchTimer: Timer?
    private var watchCapture: Task<Void, Never>?
    private var lastWatchCaptureAt: TimeInterval = -.infinity
    private var handBack = SharedDesktop.HandBack()
    private var handBackTimer: Timer?

    private struct Session {
        let id: String
        let app: AppIdentity
        let target: WindowTarget
        let mode: AccessMode
        var started: TimeInterval
        var lastUsed: TimeInterval
        var generation = 0
        var paused = false
        var pauseReason: String?
        var interactionDeadline: TimeInterval?
        var needsRefresh = true
        let purpose: String
        var observation: ObservationLease?
        var records: [ElementRecord] = []
        var actionCount = 0
        var receipts: [String: [String: Any]] = [:]
        var receiptInputs: [String: Data] = [:]
        var focus: ElementRecord?
        var baseline: ActionBaseline?
        /// The person interrupted the last step; the read right after it leaves the front to them.
        var yielded = false
    }
    init(policy: RuntimePolicy = .desktop, clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.policy = policy; self.clock = clock
        controls.onPause = { [weak self] reason in self?.pause(reason) }
        controls.onAvailability = { [weak self] available in self?.desktopAvailability(available) }
        controls.onResume = { [weak self] in Task { await self?.resume() } }
        controls.onStop = { [weak self] in self?.close(stoppedByPerson: true) }
        controls.onTick = { [weak self] in self?.expire() }
        controls.onWatch = { [weak self] visible in self?.watchWindow(visible: visible) }
    }
    private var now: TimeInterval { clock() }

    func call(_ name: String, _ values: [String: Any]) async throws -> [[String: Any]] {
        let a = Arguments(values: values)
        if name == "computer_close_session" {
            try a.only(["session_id"])
            let id = try a.string("session_id")
            guard session?.id == id else { throw UseError("session_unavailable", "This connection does not own that session.", next: "open_session") }
            close()
            return text(["ok": true, "state": "closed"])
        }
        guard !busy else { throw UseError("busy", "A computer operation is still running. Calls must be sequential.", next: "wait") }
        watch.invalidate(); watchCapture?.cancel(); MCPOutput.shared.discardUnsentFrame()
        handBackTimer?.invalidate(); handBackTimer = nil
        busy = true; defer { busy = false; scheduleHandBack() }
        switch name {
        case "computer_discover":
            try a.only([])
            return text(discover())
        case "computer_open_session":
            try a.only(["app_id", "pid", "window_id", "mode", "purpose"])
            guard session == nil else { throw UseError("session_exists", "Close this connection's session before opening another.", next: "close_session") }
            defer { if session == nil { controls.close() } }
            let appID = try a.string("app_id")
            let pid = values["pid"] == nil ? nil : pid_t(try a.integer("pid", min: 1, max: Int(Int32.max)))
            guard let mode = AccessMode(rawValue: try a.string("mode")) else { throw UseError("invalid_arguments", "mode must be observe, assist, or control.") }
            let purpose = try a.string("purpose", max: 500)
            try access.requirePermissions()
            let reservation = try ControlLease()
            let identity = try await AppIdentity.open(appID, pid: pid)
            var windows = try await access.windows(identity)
            if windows.isEmpty {
                // Reopen a running app's normal window through Launch Services.
                // Resolve the opened app before reading or dispatching input.
                if let url = identity.app.bundleURL {
                    let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = true
                    _ = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
                    windows = try await access.windows(identity)
                }
            }
            guard !windows.isEmpty else { throw UseError("window_unavailable", "The app opened, but did not expose a usable window. Check for a sign-in or app dialog, then request a session again.", next: "human_takeover") }
            try Task.checkCancellation()
            let requested = values["window_id"] == nil ? nil : try a.integer("window_id", min: 1, max: Int(UInt32.max))
            let focusedID = access.focusedWindowID(identity, windows: windows)
            let targetID = try WindowSelection.resolve(ids: windows.map { Int($0.id) }, requested: requested, focused: focusedID,
                descriptions: windows.map { "\($0.id): \($0.title)" })
            guard let target = windows.first(where: { Int($0.id) == targetID }) else { throw UseError("window_unavailable", "The resolved window closed.", next: "open_session") }
            try Task.checkCancellation()
            _ = try access.validate(target, app: identity)
            let id = UUID().uuidString.lowercased()
            session = Session(id: id, app: identity, target: target, mode: mode, started: now, lastUsed: now, purpose: purpose)
            lease = reservation
            controls.show(app: identity, target: target, mode: mode, purpose: purpose)
            if mode == .control, let current = session {
                // Initial focus is technical startup, never a human pause/Continue flow.
                try await takeGap(current)
                do { try await takeFront(current) }
                catch let error as UseError where error.code == SharedDesktop.interrupted.code {
                    // Nothing stays half open: the host opens the session again later.
                    close()
                    throw error
                }
            }
            guard let opened = session, opened.id == id else { throw UseError("session_unavailable", "Access ended while starting. Stop work and wait for a new user request.", next: "human_takeover") }
            return text(["ok": true, "session_id": id, "app_id": identity.bundleID, "app_name": identity.name, "pid": Int(identity.pid),
                "window_id": Int(target.id), "window_title": target.title, "mode": mode.rawValue,
                "state": opened.paused ? "paused" : "active", "expires_in_seconds": 900,
                "next": next(opened)])
        case "computer_observe":
            let options = try ObservationOptions(values, policy: policy)
            return try await observe(try a.string("session_id"), image: options.image, elements: options.elements)
        case "computer_act":
            try a.only(policy == .embedded ? ["session_id", "observation_id", "request_id", "action", "actions", "intent"] : ["session_id", "observation_id", "request_id", "action"])
            let id = try a.string("session_id")
            let observationID = try a.string("observation_id")
            let requestID = try a.string("request_id", max: 100)
            let actions = try Action.batch(values, policy: policy)
            let raw = values["actions"] ?? values["action"] ?? NSNull()
            // Display only: shown on the person's desktop cursor, never part of the receipt identity.
            let intent = values["intent"] == nil ? nil : try a.string("intent", max: 120)
            return try await act(id: id, observationID: observationID, requestID: requestID, actions: actions, raw: raw, intent: intent)
        case "computer_zoom" where policy == .embedded:
            try a.only(["session_id", "observation_id", "x", "y", "width", "height"])
            return try await zoom(try a.string("session_id"), observationID: try a.string("observation_id"),
                region: CGRect(x: try a.number("x", min: 0, max: 100_000), y: try a.number("y", min: 0, max: 100_000),
                               width: try a.number("width", min: 8, max: 100_000), height: try a.number("height", min: 8, max: 100_000)))
        case "computer_session_status":
            try a.only(["session_id"])
            let current = try current(try a.string("session_id"), allowPaused: true)
            var status: [String: Any] = ["ok": true, "session_id": current.id, "mode": current.mode.rawValue,
                "state": current.paused ? "paused" : "active", "phase": phase(current),
                "purpose": current.purpose, "app_name": current.app.name, "window_title": current.target.title, "panel_visible": controls.isVisible,
                "actions": current.actionCount,
                "expires_in_seconds": max(0, Int(900 - (now - current.started))),
                "next": next(current)]
            if let reason = current.pauseReason { status["pause_reason"] = reason }
            return text(status)
        default: throw UseError("unknown_tool", "Unknown tool. Refresh the Computer Use tool list.", next: "discover")
        }
    }

    private func discover() -> [String: Any] {
        let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && AppIdentity.isAllowed($0) }
            .compactMap { app -> [String: Any]? in
                guard let id = app.bundleIdentifier else { return nil }
                return ["app_id": id, "name": app.localizedName ?? id, "pid": Int(app.processIdentifier)]
            }.sorted { String(describing: $0["name"]) < String(describing: $1["name"]) }
        let runningIDs = Set(running.compactMap { $0["app_id"] as? String })
        let apps = (running + AppIdentity.installedApps().filter { !runningIDs.contains($0["app_id"] as? String ?? "") })
            .sorted { String(describing: $0["name"]) < String(describing: $1["name"]) }
        var limits = ["lease_seconds": 900, "observation_seconds": Int(policy.observationSeconds), "actions_per_lease": 200]
        var result: [String: Any] = ["ok": true, "protocol": "openwork.computer-use/1", "platform": "macos",
            "permissions": Self.permissions(), "apps": apps,
            "modes": AccessMode.allCases.map { ["id": $0.rawValue, "description": $0.explanation] },
            "keys": policy.keys, "guidance": policy.guidance]
        if policy == .embedded {
            limits["batch_actions"] = Action.batchLimit
            result["modifiers"] = NativeKey.supportedModifiers
            result["shortcuts"] = NativeKey.shortcuts.sorted()
            result["blocked_shortcuts"] = NativeKey.blockedShortcuts
        }
        result["limits"] = limits
        return result
    }
    private func watchWindow(visible: Bool) {
        guard SessionControls.embedded, session != nil else { return }
        watch.update(visible: visible, now: now)
        if !visible {
            watchCapture?.cancel(); watchTimer?.invalidate(); watchTimer = nil
            MCPOutput.shared.discardUnsentFrame()
            return
        }
        if watchTimer == nil {
            let timer = Timer(timeInterval: 0.2, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.captureWatchFrame() }
            }
            watchTimer = timer; RunLoop.main.add(timer, forMode: .common)
        }
        captureWatchFrame()
    }

    private func captureWatchFrame() {
        guard watch.isVisible(now: now) else {
            watchTimer?.invalidate(); watchTimer = nil; watchCapture?.cancel()
            MCPOutput.shared.discardUnsentFrame()
            return
        }
        guard watchCapture == nil, !busy, resumingSessionID == nil,
              let current = session, !current.paused, now - current.started < 900,
              now - current.lastUsed < 120, now - lastWatchCaptureAt >= 0.2,
              MCPOutput.shared.canSendFrame else { return }
        let generation = watch.generation
        lastWatchCaptureAt = now
        watchCapture = Task { [weak self] in
            guard let self else { return }
            defer { self.watchCapture = nil }
            @MainActor func check() throws {
                try Task.checkCancellation()
                guard let latest = self.session, latest.id == current.id, latest.generation == current.generation,
                      latest.target.id == current.target.id, latest.app.pid == current.app.pid,
                      CFEqual(latest.target.element, current.target.element), !latest.paused,
                      self.watch.generation == generation, self.watch.isVisible(now: self.now),
                      !self.busy, self.resumingSessionID == nil, self.now - latest.started < 900,
                      self.now - latest.lastUsed < 120, MCPOutput.shared.canSendFrame else {
                    throw UseError("watch_inactive", "The embedded view is no longer watching.")
                }
            }
            do {
                try check()
                let bounds = try self.access.validate(current.target, app: current.app)
                let state = try await self.access.read(current.target, check: check)
                try state.requireCapture()
                try check()
                let captured = try await self.access.capture(target: current.target, app: current.app,
                    bounds: bounds, state: state, check: {
                        try check()
                        guard try self.access.validate(current.target, app: current.app) == bounds else {
                            throw UseError("stale_observation", "The watched window changed.")
                        }
                    })
                try check()
                guard try self.access.validate(current.target, app: current.app) == bounds else { return }
                try check()
                // Never install a lease, records, preview, or lastUsed from a UI frame.
                self.controls.frame(captured.0, width: captured.1, height: captured.2, capturedAt: captured.3)
            } catch {
                // Read-only races, revocation, and backpressure drop this frame.
                // A subsequent heartbeat may watch; it cannot recover control.
            }
        }
    }

    private func stopWatching() {
        watch.update(visible: false, now: now); watchCapture?.cancel()
        watchTimer?.invalidate(); watchTimer = nil
        MCPOutput.shared.discardUnsentFrame()
    }
    static func permissions() -> [String: Any] {
        let ax = AXIsProcessTrusted(); let capture = CGPreflightScreenCaptureAccess()
        return ["ok": ax && capture, "accessibility": ax, "screenRecording": capture,
            "supported": true, "protocolVersion": "openwork.computer-use/1"]
    }
    private func current(_ id: String, allowPaused: Bool = false) throws -> Session {
        expire()
        guard let current = session, current.id == id else { throw UseError("session_unavailable", "This session ended or belongs to another connection. Open a new session.", next: "open_session") }
        if current.paused && !allowPaused { throw interruption(current) }
        if !desktopAvailable && !allowPaused { throw UseError("desktop_unavailable", "The desktop is temporarily unavailable. Wait until it is available, then observe again.", next: "observe") }
        try Task.checkCancellation()
        try current.app.validate()
        return current
    }
    private func interruption(_ current: Session) -> UseError {
        if policy == .embedded {
            // Say why it paused and where Continue is, so the model can tell the person in one sentence.
            let reason = current.pauseReason.map { " (\($0))" } ?? ""
            return UseError("session_paused", "Paused for the person\(reason). They resume with Continue on your pill over the selected window or in OpenWork's Computer view. Tell them that once and stop; do not retry automatically.", next: "human_takeover")
        }
        return UseError("session_paused", "The person must choose Continue in the Computer Use controls. Do not retry automatically.", next: "human_takeover")
    }
    private func checkActive(_ expected: Session, deadline: TimeInterval? = nil) throws {
        try Task.checkCancellation()
        guard let current = session, current.id == expected.id else {
            throw UseError("session_changed", "Access ended during this operation. No remaining input is allowed.", next: "human_takeover")
        }
        if current.paused { throw interruption(current) }
        if !desktopAvailable { throw UseError("desktop_unavailable", "The desktop became unavailable. No remaining input is allowed; observe again when available.", next: "observe") }
        guard current.generation == expected.generation else {
            throw UseError("session_changed", "Control changed during this operation. A new observation is required.", next: "human_takeover")
        }
        if let deadline, now >= deadline { throw UseError("action_timeout", "The bounded action time expired. Inspect the receipt before doing anything else.", next: "observe") }
    }
    private func observe(_ id: String, image: Bool, elements: String) async throws -> [[String: Any]] {
        // A paused session never resumes from an observation: only the person's Continue does.
        // Retry only read-only capture races. Never repeat an action or cross takeover.
        let current = try current(id)
        session?.needsRefresh = true
        controls.update("Refreshing the selected window before continuing…", paused: false)
        var otherWindowFocused = false
        var returns = 0
        // Something else in front is the person or another app, not a takeover:
        // bring the selected window back for this read; it is handed back after.
        func bringBack() async throws {
            // Right after the person interrupted a step, read without taking the front.
            // The next action takes it and re-checks the window against this read.
            if self.session?.yielded == true {
                self.session?.yielded = false
                otherWindowFocused = true
                return
            }
            try await self.takeGap(current)
            guard (try? self.access.validate(current.target, app: current.app, requireFrontmost: true)) == nil else { return }
            // Another window of this app in front is usually a dialog the last action
            // opened. Raising the target would hide it, or fail behind a modal one;
            // input raises the target only when the model acts on it again.
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == current.app.pid {
                otherWindowFocused = true
                return
            }
            _ = try await SharedDesktop.returnFocus(used: &returns, inFront: { false }, focus: { try await self.takeFront(current) })
        }
        return try await ObservationPreparation.capture(mode: current.mode, check: {
            try self.checkActive(current)
        }, focus: bringBack, read: {
            for attempt in 0..<3 {
                try self.checkActive(current)
                do { return try await self.observeAttempt(id, image: image, elements: elements, otherWindowFocused: otherWindowFocused) }
                catch let error as UseError {
                    if error.code == "window_not_frontmost", current.mode == .control, attempt < 2 {
                        try await bringBack()
                        continue
                    }
                    guard error.code == "stale_observation", attempt < 2 else { throw SharedDesktop.yielding(error) }
                    try await Task.sleep(nanoseconds: 75_000_000)
                }
            }
            throw UseError("stale_observation", "The window is still changing. Observe again.", next: "observe")
        })
    }
    private func observeAttempt(_ id: String, image: Bool, elements filter: String, otherWindowFocused: Bool = false) async throws -> [[String: Any]] {
        let current = try current(id)
        session?.observation = nil; session?.records = []; session?.focus = nil
        let frontmost = current.mode == .control && !otherWindowFocused
        let bounds = try access.validate(current.target, app: current.app, requireFrontmost: frontmost)
        @MainActor func check() throws { try self.checkActive(current) }
        var state = try await access.read(current.target, check: check)
        var png: Data?
        var imageFailure: UseError?
        var width = max(1, Int(bounds.width)); var height = max(1, Int(bounds.height))
        if image {
            do {
                let captured = try await observationImage(current, bounds: bounds, state: state, requireFrontmost: frontmost, check: check)
                png = captured.0; width = captured.1; height = captured.2
            } catch {
                try check()
                let failure = (error as? UseError) ?? UseError("capture_failed", "The window screenshot is unavailable; only the accessible text was read.", next: "observe")
                if failure.code == "stale_observation", policy == .desktop { throw failure }
                imageFailure = failure
                if failure.code == "stale_observation" { state = try await access.read(current.target, check: check) }
            }
        } else if policy == .desktop {
            let after = try await access.read(current.target, check: check)
            guard try access.captureDigest(state) == access.captureDigest(after) else {
                throw UseError("stale_observation", "The window changed during the read. Observe again.", next: "observe")
            }
        }
        try check()
        guard try access.validate(current.target, app: current.app, requireFrontmost: frontmost) == bounds else {
            throw UseError("stale_observation", "The window moved during the observation.", next: "observe")
        }
        var effectiveFilter = filter
        // AX trees can retain virtualized or scrolled-out nodes. Keep those
        // internal for privacy/staleness scans, never expose their text or refs.
        let visible = state.records.filter { bounds.contains($0.frame) }
        var shown = filter == "none" ? [] : filter == "all" ? visible : visible.filter(\.interactive)
        if png == nil, shown.isEmpty, filter == "interactive" { shown = visible; effectiveFilter = "all" }
        guard png != nil || !shown.isEmpty else {
            throw imageFailure ?? UseError("observation_unavailable", "No image or useful accessible elements could be read.", next: "observe")
        }
        let elements = try shown.map { try $0.payload(bounds: bounds, width: width, height: height, compact: policy == .embedded) }
        let observation = ObservationLease(id: UUID().uuidString.lowercased(), createdAt: now, generation: current.generation,
            frame: bounds, imageWidth: width, imageHeight: height, stateDigest: try access.captureDigest(state),
            imageDigest: png.map(access.imageDigest), validFor: policy.observationSeconds)
        try check()
        let observedFocus = state.focusRecord.flatMap { focus in shown.first { CFEqual($0.element, focus.element) } }
        let afterAction = current.baseline.flatMap { baseline in
            baseline.generation == current.generation ? baseline.changes(stateDigest: observation.stateDigest, imageDigest: observation.imageDigest) : nil
        }
        session?.observation = observation; session?.records = shown; session?.focus = observedFocus
        session?.lastUsed = now; session?.needsRefresh = false; session?.baseline = nil
        controls.update("Window observed. Ready for the next action.", paused: false)
        var imageInfo: [String: Any] = ["width": width, "height": height, "included": png != nil, "coordinate_space": "image_pixels"]
        if let imageFailure { imageInfo["unavailable"] = imageFailure.payload }
        var payload: [String: Any] = ["ok": true, "session_id": id, "observation_id": observation.id, "window_id": Int(current.target.id),
            "window_title": current.target.title, "mode": current.mode.rawValue, "image": imageInfo, "elements": elements,
            "truncated": state.truncated, "protected_fields": state.protectedFrames.count,
            "content_trust": "untrusted_app_content", "next": "act_once_then_observe"]
        if let afterAction { payload["after_action"] = afterAction }
        if otherWindowFocused { payload["other_window_focused"] = true }
        if policy == .embedded {
            payload["elements_filter"] = effectiveFilter; payload["elements_total"] = visible.count
            payload["observation_seconds"] = Int(policy.observationSeconds)
            if let focus = observedFocus { payload["focused_ref"] = focus.ref }
            if let issue = state.privacyIssue { payload["privacy_issue"] = issue }
        }
        var result: [[String: Any]] = []
        if let png { result.append(["type": "image", "data": png.base64EncodedString(), "mimeType": Self.observationMimeType]) }
        return result + text(payload)
    }

    /// Observations are compact JPEGs: image tokens and upload time dominate each step.
    /// The re-capture that guards coordinate input uses the same encoding, so digests compare.
    static let observationMimeType = "image/jpeg"
    private func observationImage(_ current: Session, bounds: CGRect, state: WindowState, requireFrontmost: Bool,
                                  check: () throws -> Void) async throws -> (Data, Int, Int, Int64) {
        try await access.capture(target: current.target, app: current.app, bounds: bounds, state: state,
            maxLongSide: 1280, jpegQuality: 0.8, requireFrontmost: requireFrontmost, check: check)
    }

    /// A sharper look at part of the current observation, for reading only. It
    /// neither consumes nor replaces the observation, so coordinates stay in the
    /// original image's pixels and the next act still uses that observation_id.
    private func zoom(_ id: String, observationID: String, region pixels: CGRect) async throws -> [[String: Any]] {
        let current = try current(id)
        guard let observation = current.observation else { throw UseError("observation_required", "Observe this window before zooming.", next: "observe") }
        let bounds = try access.validate(current.target, app: current.app)
        try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
        guard observation.imageWidth > 0, observation.imageHeight > 0,
              CGRect(x: 0, y: 0, width: observation.imageWidth, height: observation.imageHeight).contains(pixels) else {
            throw UseError("invalid_arguments", "The zoom region must lie inside the observation image.", next: "observe")
        }
        let xScale = bounds.width / CGFloat(observation.imageWidth), yScale = bounds.height / CGFloat(observation.imageHeight)
        let region = CGRect(x: pixels.minX * xScale, y: pixels.minY * yScale, width: pixels.width * xScale, height: pixels.height * yScale)
        @MainActor func check() throws { try self.checkActive(current) }
        let state = try await access.read(current.target, check: check)
        let (png, width, height, capturedAt) = try await access.capture(target: current.target, app: current.app, bounds: bounds, state: state,
            region: region, maxScale: NSScreen.screens.map(\.backingScaleFactor).max() ?? 2, check: check)
        try check()
        session?.lastUsed = now
        let payload: [String: Any] = ["ok": true, "session_id": id, "observation_id": observationID, "state": "active",
            "region": ["x": pixels.minX, "y": pixels.minY, "width": pixels.width, "height": pixels.height, "coordinate_space": "image_pixels"],
            "image": ["width": width, "height": height, "captured_at": capturedAt], "protected_fields": state.protectedFrames.count,
            "content_trust": "untrusted_app_content",
            "next": "Read only. Act with the same observation_id and coordinates from the original observation image, not this zoom."]
        return [["type": "image", "data": png.base64EncodedString(), "mimeType": "image/png"]] + text(payload)
    }

    private func act(id: String, observationID: String, requestID: String, actions: [Action], raw: Any, intent: String? = nil) async throws -> [[String: Any]] {
        let cached = try current(id, allowPaused: true)
        let fingerprint = try JSONSerialization.data(withJSONObject: ["observation_id": observationID, "action": raw], options: [.sortedKeys])
        if let receipt = cached.receipts[requestID] {
            guard cached.receiptInputs[requestID] == fingerprint else { throw UseError("request_id_reused", "A request_id cannot name a different action.") }
            return text(receipt)
        }
        let current = try current(id)
        guard current.mode != .observe, !actions.contains(where: \.requiresControl) || current.mode == .control else {
            throw UseError("scope_denied", "This action is outside the selected mode. Close the session and open the needed mode.", next: "open_session")
        }
        if current.actionCount + actions.count > 200 { session?.actionCount = 0 }
        if current.receipts.count >= 200, let oldest = current.receipts.keys.first {
            session?.receipts.removeValue(forKey: oldest); session?.receiptInputs.removeValue(forKey: oldest)
        }
        guard let observation = current.observation else { throw UseError("observation_required", "Observe this window before acting. Each observation authorizes one act call.", next: "observe") }
        // The person may be using another app meanwhile; bring the selected window back
        // for this step instead of pausing when they switched away. A click or key of
        // theirs from here on stops the step and leaves the computer to them.
        try await takeGap(current)
        let moment = ProcessInfo.processInfo.systemUptime
        var returns = 0
        var disturbed = try await shareDesktop(current, returns: &returns, since: moment)
        let bounds: CGRect
        do { bounds = try access.validate(current.target, app: current.app, requireFrontmost: current.mode == .control) }
        catch { throw SharedDesktop.yielding(error) }
        try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
        if actions.contains(where: \.usesCoordinates), observation.imageDigest == nil {
            throw UseError("image_required", "Coordinates require an observation with an available verified image. Use accessible refs instead.", next: "observe")
        }
        session?.observation = nil; session?.focus = nil; session?.lastUsed = now
        if let intent { controls.narrate(intent) }
        session?.receiptInputs[requestID] = fingerprint
        session?.receipts[requestID] = ["ok": false, "code": "action_interrupted", "request_id": requestID, "next": "observe"]
        let deadline = now + 30
        @MainActor func check() throws { try self.checkActive(current, deadline: deadline) }
        @MainActor func checkWindow() throws {
            try check()
            let live: CGRect
            do { live = try self.access.validate(current.target, app: current.app, requireFrontmost: current.mode == .control) }
            catch { throw SharedDesktop.yielding(error) }
            guard live == bounds else {
                throw UseError("stale_observation", "The window moved during input.", next: "observe")
            }
        }
        @MainActor func checkInput() throws {
            try check()
            if current.mode == .control, self.personInterrupted(since: moment) { throw SharedDesktop.interrupted }
        }
        var progress = BatchProgress(actions: actions.map(\.name))
        // Watch for the app's reaction from the first event on, so the wait
        // after input ends when the app has finished changing.
        let activity = actions.contains(where: \.changesWindow) ? AXActivity(pid: current.app.pid, clock: clock) : nil
        defer { activity?.stop() }
        let windowsBefore = access.windowChanges(current.app)
        var focus = current.focus
        var needsObservation = false
        var failure: UseError?
        var uncertain = false
        for (index, action) in actions.enumerated() {
            do {
                try checkInput()
                guard !needsObservation, !action.usesCoordinates || !progress.hasInput else {
                    throw UseError("observation_required", "The preceding step may have changed the view or focus. Observe before executing the remaining steps.", next: "observe")
                }
                // Between steps, bring the window back if something else came to the front.
                // Before any input, the window must still match the observation; after it,
                // each step re-validates the field or control it uses.
                if index > 0, try await shareDesktop(current, returns: &returns, since: moment, deadline: deadline) { disturbed = true }
                try checkWindow()
                try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
                var pointerTarget: AXUIElement?
                if action.usesCoordinates || (policy == .desktop && index == 0) || (disturbed && !progress.hasInput) {
                    let live = try await access.read(current.target, check: check)
                    guard try access.captureDigest(live) == observation.stateDigest else {
                        throw UseError("stale_observation", "The observed window content or focus changed.", next: "observe")
                    }
                    if action.usesCoordinates {
                        let captured = try await observationImage(current, bounds: bounds, state: live,
                            requireFrontmost: current.mode == .control, check: check)
                        guard access.imageDigest(captured.0) == observation.imageDigest else {
                            throw UseError("stale_observation", "The window image changed. Observe before coordinate input.", next: "observe")
                        }
                        let point: CGPoint
                        switch action {
                        case .move(let p), .click(let p, _, _), .scroll(let p, _, _): point = p
                        case .drag(let points): point = points[0]
                        default: throw UseError("invalid_arguments", "This action has no coordinates.")
                        }
                        pointerTarget = try access.checkHit(observation.screenPoint(point), target: current.target, app: current.app)
                    }
                }
                if !progress.hasInput, let focus {
                    switch action {
                    case .key, .type: try access.validateRecord(focus, target: current.target)
                    default: break
                    }
                }
                try check()
                try observation.validate(id: observationID, generation: current.generation, frame: bounds, now: now)
                session?.actionCount += 1
                let path = try await input.execute(action, app: current.app, target: current.target, lease: observation,
                    access: access, records: current.records, focus: focus, pointerTarget: pointerTarget,
                    check: checkInput, checkWindow: checkWindow, feedback: { [weak self] feedback in
                        guard let self, self.session?.id == id else { return }
                        self.controls.inputFeedback(feedback)
                    })
                uncertain = path != "waited"
                try check()
                progress.dispatched(path: path); uncertain = false
                controls.showAction(action, records: current.records)
                switch action {
                case .click:
                    focus = current.records.first { record in record.textField && pointerTarget.map { CFEqual($0, record.element) } == true }
                    needsObservation = focus == nil
                case .press(let ref):
                    focus = current.records.first { $0.ref == ref && $0.textField }
                    needsObservation = focus == nil
                case .setValue(let ref, _):
                    if focus?.ref != ref { focus = nil }
                case .move, .scroll, .drag: needsObservation = true
                case .key: needsObservation = action.endsFocusSequence
                default: break
                }
                if policy == .embedded, !needsObservation, action.changesWindow, index + 1 < actions.count {
                    try await Task.sleep(nanoseconds: 50_000_000)
                    try check()
                }
            } catch let interrupted as InputFailure {
                failure = SharedDesktop.yielding(interrupted.cause); uncertain = interrupted.mayHaveActed
                break
            } catch {
                failure = (SharedDesktop.yielding(error) as? UseError) ?? UseError("action_interrupted", "Input was interrupted. Inspect the receipt; do not repeat it.", next: "human_takeover")
                break
            }
        }
        if failure?.code == SharedDesktop.interrupted.code {
            // The person chose where to be: leave the front with them, and let the read
            // that follows this step happen without taking it again.
            handBack.forget()
            session?.yielded = true
        }
        var settled: Bool?
        if progress.hasInput || uncertain {
            session?.baseline = ActionBaseline(generation: current.generation, stateDigest: observation.stateDigest, imageDigest: observation.imageDigest)
            do {
                settled = try await InputSettle.wait(since: now, lastActivity: { activity?.last ?? 0 }, now: { self.now },
                    check: check, sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) })
            } catch {
                if failure == nil { failure = (error as? UseError) ?? UseError("action_interrupted", "Control ended after dispatch.", next: "human_takeover") }
            }
        }
        if failure == nil {
            do { try check() }
            catch { failure = (error as? UseError) ?? UseError("action_interrupted", "Control ended after dispatch.", next: "human_takeover") }
        }
        var receipt = progress.receipt(requestID: requestID, failure: failure, uncertain: uncertain, detailed: policy == .embedded)
        if let settled { receipt["settled"] = settled }
        if settled != nil, let changes = windowsBefore.diff(access.windowChanges(current.app), target: current.target.id) {
            receipt["window_changes"] = changes
        }
        if session?.id == id { session?.receipts[requestID] = receipt }
        return text(receipt)
    }
    private func next(_ current: Session) -> String {
        current.paused ? "human_takeover" : "observe"
    }
    private func phase(_ current: Session) -> String {
        if let deadline = current.interactionDeadline, now < deadline { return "person_interacting" }
        if current.paused { return "ready_to_continue" }
        return current.needsRefresh ? "refreshing" : "working"
    }
    private func desktopAvailability(_ available: Bool) {
        desktopAvailable = available
        guard session != nil else { return }
        session?.generation += 1; session?.observation = nil; session?.records = []; session?.focus = nil; session?.needsRefresh = true
        stopWatching(); input.releaseAll()
        // Sleep/idle availability is technical, not the person's Take over.
        // Preserve any real pause, and require fresh validated reads on return.
        if session?.paused != true { controls.update(available ? "Refreshing the selected window…" : "Waiting for the desktop…", paused: false) }
    }
    func pause(_ reason: String, announce: Bool = true) {
        guard let current = session, !current.paused || resumingSessionID == current.id else { return }
        session?.pauseReason = reason
        session?.interactionDeadline = nil
        session?.needsRefresh = true
        session?.paused = true; session?.generation += 1; session?.observation = nil; session?.records = []; session?.focus = nil
        // A takeover leaves the front wherever the person puts it.
        handBack.forget(); handBackTimer?.invalidate(); handBackTimer = nil
        stopWatching()
        input.releaseAll()
        if announce { controls.update(reason, paused: true) }
    }
    private static let interruptions: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]
    /// When the person last produced physical input of this type, in uptime. The
    /// HID system state holds only device input, never the agent's process-targeted
    /// events. Reads only timing, with no permission beyond computer use's own.
    private func lastPersonInput(_ type: CGEventType) -> TimeInterval {
        ProcessInfo.processInfo.systemUptime - CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: type)
    }
    private func personInterrupted(since start: TimeInterval) -> Bool {
        Self.interruptions.contains { SharedDesktop.personInterrupted(inputAt: lastPersonInput($0), since: start) }
    }
    /// A physical mouse button held down right now.
    private func personHoldsButton() -> Bool {
        [CGMouseButton.left, .right, .center].contains { CGEventSource.buttonState(.hidSystemState, button: $0) }
    }
    /// In control mode, takes the next gap in the person's typing or a held button.
    private func takeGap(_ current: Session, deadline: TimeInterval? = nil) async throws {
        guard current.mode == .control else { return }
        try await SharedDesktop.takeGap(busy: {
            SharedDesktop.personBusy(keyAt: self.lastPersonInput(.keyDown), buttonDown: self.personHoldsButton(),
                now: ProcessInfo.processInfo.systemUptime)
        }, now: { self.now }, check: {
            try self.checkActive(current, deadline: deadline)
        }, sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) })
    }
    /// Brings the selected window to the front, remembering which app had it. A click
    /// or key of the person's while it comes forward stops whatever was to follow.
    private func takeFront(_ current: Session) async throws {
        handBack.record(frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier,
            target: current.app.pid, own: ProcessInfo.processInfo.processIdentifier, at: ProcessInfo.processInfo.systemUptime)
        do {
            try await SharedDesktop.acquire(now: { ProcessInfo.processInfo.systemUptime }, buttonDown: { self.personHoldsButton() },
                focus: { try await self.focusTarget(current) }, interrupted: { self.personInterrupted(since: $0) })
        } catch let error as UseError where error.code == SharedDesktop.interrupted.code {
            // Their input may have landed in the agent's window: the front stays there,
            // and the read that follows does not take it again.
            handBack.forget()
            session?.yielded = true
            throw error
        }
    }
    /// Before input: takes a gap in the person's typing, then brings the selected
    /// window back if something else came to the front. Returns whether it refocused.
    /// A click or key since the step began (`since`) leaves the front with the person.
    private func shareDesktop(_ current: Session, returns: inout Int, since step: TimeInterval, deadline: TimeInterval? = nil) async throws -> Bool {
        guard current.mode == .control else { return false }
        session?.yielded = false
        try await takeGap(current, deadline: deadline)
        do {
            return try await SharedDesktop.returnFocus(used: &returns, inFront: {
                (try? self.access.validate(current.target, app: current.app, requireFrontmost: true)) != nil
            }, personActed: { self.personInterrupted(since: step) }, focus: { try await self.takeFront(current) })
        } catch let error as UseError where error.code == SharedDesktop.interrupted.code {
            // The read that follows leaves the front where the person has it.
            session?.yielded = true
            throw error
        }
    }
    /// Gives the front back once the agent's moment is over: no call within
    /// `handBackDelay`, so an action and the read after it count as one moment.
    private func scheduleHandBack() {
        handBackTimer?.invalidate(); handBackTimer = nil
        guard handBack.pid != nil else { return }
        let timer = Timer(timeInterval: SharedDesktop.handBackDelay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.giveBack() }
        }
        RunLoop.main.add(timer, forMode: .common)
        handBackTimer = timer
    }
    private func giveBack() {
        handBackTimer?.invalidate(); handBackTimer = nil
        guard !busy, let current = session, !current.paused else { return }
        // Any click or key since the front was taken, even one that might be the
        // agent's own, means the person may be working in the agent's window.
        let latest = Self.interruptions.map { lastPersonInput($0) }.max() ?? -.infinity
        guard let pid = handBack.take(frontmost: NSWorkspace.shared.frontmostApplication?.processIdentifier,
                  target: current.app.pid, lastPersonInput: latest),
              let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return }
        _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        app.activate(options: [])
    }
    private func focusTarget(_ current: Session) async throws {
        guard desktopAvailable else { throw UseError("desktop_unavailable", "The desktop is temporarily unavailable. Observe again when available.", next: "observe") }
        if current.mode == .control {
            _ = try access.validate(current.target, app: current.app)
            guard AXUIElementPerformAction(current.target.element, kAXRaiseAction as CFString) == .success,
                  current.app.app.activate(options: []) else {
                throw UseError("window_unavailable", "The selected window could not be focused. Refresh the app state.", next: "observe")
            }
            // Request focus once; never keep stealing it if a person intervenes.
            for attempt in 0..<10 {
                guard session?.id == current.id, session?.generation == current.generation else { throw UseError("session_changed", "Control changed during focus. No input was dispatched.", next: "observe") }
                if (try? access.validate(current.target, app: current.app, requireFrontmost: true)) != nil { break }
                if attempt < 9 { try await Task.sleep(nanoseconds: 50_000_000) }
            }
        }
        guard desktopAvailable else { throw UseError("desktop_unavailable", "The desktop is temporarily unavailable. Observe again when available.", next: "observe") }
        guard session?.id == current.id, session?.generation == current.generation else { throw UseError("session_changed", "Control changed during focus.", next: "observe") }
        _ = try access.validate(current.target, app: current.app, requireFrontmost: current.mode == .control)
    }
    private func resume() async {
        guard let current = session, current.paused, resumingSessionID == nil,
              current.interactionDeadline.map({ now >= $0 }) ?? true else { return }
        resumingSessionID = current.id
        defer { if resumingSessionID == current.id { resumingSessionID = nil } }
        do {
            // Only the person's explicit Continue can resume a human pause.
            try await focusTarget(current)
            guard session?.id == current.id, session?.generation == current.generation else { return }
            _ = try access.validate(current.target, app: current.app, requireFrontmost: current.mode == .control)
            expire(); guard session != nil else { return }
            session?.pauseReason = nil
            session?.interactionDeadline = nil
            session?.needsRefresh = true
            session?.paused = false; session?.generation += 1; session?.observation = nil; session?.lastUsed = now
            controls.update("Refreshing the selected window before continuing…", paused: false)
        } catch {
            guard session?.id == current.id, session?.generation == current.generation else { return }
            session?.pauseReason = error.localizedDescription
            session?.interactionDeadline = nil
            controls.update(error.localizedDescription, paused: true)
        }
    }
    private func expire() {
        guard let current = session else { return }
        if let deadline = current.interactionDeadline, now >= deadline {
            session?.interactionDeadline = nil
            controls.update(current.pauseReason ?? "You have control. Click Continue when you are ready.", paused: true)
        }
        controls.updateExpiry(seconds: max(0, Int(900 - (now - current.started))))
        if current.app.app.isTerminated { close(); return }
        // Renew technical accounting silently. Preserve paused state, generation,
        // target validation, observation freshness and at-most-once receipts.
        if now - current.started >= 900 { session?.started = now }
    }
    func close(stoppedByPerson: Bool = false) {
        giveBack(); handBack.forget()
        stopWatching()
        resumingSessionID = nil; session = nil
        input.releaseAll(); lease = nil; controls.close(stoppedByPerson: stoppedByPerson)
    }
    func cancel() {
        // Cancellation is terminal, including an idle agent turn's pending call.
        close()
    }
    private func text(_ payload: [String: Any]) -> [[String: Any]] {
        let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        return [["type": "text", "text": String(decoding: data, as: UTF8.self)]]
    }
}
