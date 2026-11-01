import AppKit
import CoreGraphics
import Foundation

struct PanelStrings: Codable {
    let panel: [String: String]
    let phases: [String: String]
    let operations: [String: String]
}

struct WindowBounds: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct ActivityPoint: Codable {
    let x: Double
    let y: Double
}

struct Command: Codable {
    let type: String
    let runId: String?
    let title: String?
    let appName: String?
    let pid: Int32?
    let windowId: UInt32?
    let bounds: WindowBounds?
    let phase: String?
    let operation: String?
    let point: ActivityPoint?
    let status: String?
    let reason: String?
    let route: String?
    let persistent: Bool?
    let labels: PanelStrings?
    let step: Int?
    let maxSteps: Int?
}

final class ControlController: NSObject {
    private let cursorPanel: NSPanel
    private let cursorView = CursorView(frame: NSRect(x: 0, y: 0, width: CursorView.canvasSize, height: CursorView.canvasSize))
    private let statusPanel: NSPanel
    private let statusLabel = NSTextField(labelWithString: "")
    private let targetLabel = NSTextField(labelWithString: "")
    private let headingLabel = NSTextField(labelWithString: "●  DSH-CU")
    private let pauseButton = NSButton(title: "", target: nil, action: nil)
    private let resumeButton = NSButton(title: "", target: nil, action: nil)
    private let stopButton = NSButton(title: "", target: nil, action: nil)
    private let takeoverButton = NSButton(title: "", target: nil, action: nil)
    private let closeButton = NSButton(title: "", target: nil, action: nil)
    private var strings: PanelStrings?
    private var runId: String?
    private var targetPid: pid_t?
    private var targetWindowId: CGWindowID?
    private var targetBounds: WindowBounds?
    private var lastPoint: ActivityPoint?
    private var targetOnscreen = false
    private var lastHeartbeat = Date()
    private var syntheticUntil = Date()
    private var lastKeyboardEvent: Double?
    private var lastPointerEvent: Double?
    private var paused = false
    /// True once this run has been reported as no longer visible to the host.
    private var unavailableReported = false
    private var statusItem: NSStatusItem?
    private var statusMenuStop: NSMenuItem?

    override init() {
        cursorPanel = ControlController.makePanel(width: CursorView.canvasSize, height: CursorView.canvasSize, ignoresMouse: true)
        cursorPanel.contentView = cursorView
        statusPanel = ControlController.makePanel(width: 360, height: 116, ignoresMouse: false)
        super.init()
        configureStatusPanel()
        Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
            self?.refreshWindow()
            self?.detectTakeover()
        }
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self, let runId = self.runId, Date().timeIntervalSince(self.lastHeartbeat) > 3 else { return }
            self.emit(["type": "expired", "runId": runId])
            self.finish()
        }
    }

    private static func makePanel(width: CGFloat, height: CGFloat, ignoresMouse: Bool) -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = ignoresMouse
        panel.becomesKeyOnlyIfNeeded = true
        panel.animationBehavior = .none
        panel.sharingType = .none
        return panel
    }

    private func label(_ key: String, _ fallback: String) -> String {
        strings?.panel[key] ?? fallback
    }

    private func phaseLabel(_ phase: String) -> String {
        strings?.phases[phase] ?? fallbackPhase(phase)
    }

    private func operationLabel(_ operation: String) -> String {
        strings?.operations[operation] ?? operation
    }

    private func fallbackPhase(_ phase: String) -> String {
        [
            "running": "准备执行", "observing": "正在读取界面", "deciding": "正在决策下一步",
            "awaiting_approval": "等待批准", "skill": "正在回放技能", "acting": "正在执行动作",
            "waiting": "正在等待界面更新", "verifying": "正在独立验证结果", "paused": "已暂停",
            "stopped": "已停止", "takeover": "已由你接管", "blocked": "任务被阻止",
            "completed": "任务完成", "failed": "任务失败",
        ][phase] ?? "准备执行"
    }

    /// A menu-bar item keeps "DSH-CU is controlling" visible system-wide, even
    /// when the target window is covered or on another Space. Created lazily so
    /// the process does not touch NSStatusBar before the app finishes launching.
    @discardableResult
    private func showStatusItem() -> Bool {
        if statusItem == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item.button?.title = "◉ DSH-CU"
            item.button?.font = .systemFont(ofSize: 12, weight: .semibold)
            let menu = NSMenu()
            let stop = NSMenuItem(title: "停止", action: #selector(stopFromMenu), keyEquivalent: "")
            stop.target = self
            menu.addItem(stop)
            item.menu = menu
            statusItem = item
            statusMenuStop = stop
        }
        statusMenuStop?.title = label("stop", "停止")
        statusItem?.button?.toolTip = targetLabel.stringValue.isEmpty
            ? label("controllingNative", "DSH-CU 正在控制")
            : targetLabel.stringValue
        statusItem?.isVisible = true
        return statusItem?.isVisible ?? false
    }

    @discardableResult
    private func hideStatusItem() -> Bool {
        statusItem?.isVisible = false
        return statusItem?.isVisible ?? false
    }

    @objc private func stopFromMenu() {
        guard let runId else { return }
        emit(["type": "control", "runId": runId, "action": "stop"])
    }

    private func configureStatusPanel() {
        let effect = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 360, height: 116))
        effect.material = .hudWindow
        effect.blendingMode = .withinWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 12
        effect.layer?.borderWidth = 1
        effect.layer?.borderColor = NSColor.separatorColor.cgColor

        headingLabel.frame = NSRect(x: 14, y: 88, width: 330, height: 20)
        headingLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        headingLabel.textColor = .systemGreen
        targetLabel.frame = NSRect(x: 14, y: 67, width: 330, height: 18)
        targetLabel.lineBreakMode = .byTruncatingMiddle
        targetLabel.font = .systemFont(ofSize: 11)
        statusLabel.frame = NSRect(x: 14, y: 45, width: 330, height: 20)
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.font = .systemFont(ofSize: 12)

        let buttons: [(NSButton, String, String)] = [
            (pauseButton, "pause", "暂停"),
            (resumeButton, "resume", "继续"),
            (stopButton, "stop", "停止"),
            (takeoverButton, "takeover", "接管"),
            (closeButton, "dismiss", "关闭"),
        ]
        var views: [NSView] = [headingLabel, targetLabel, statusLabel]
        for (index, item) in buttons.enumerated() {
            let button = item.0
            button.title = item.2
            button.identifier = NSUserInterfaceItemIdentifier(item.1)
            button.target = self
            button.action = #selector(control(_:))
            button.frame = NSRect(x: 14 + index * 68, y: 10, width: 64, height: 27)
            button.bezelStyle = .rounded
            button.setButtonType(.momentaryPushIn)
            views.append(button)
        }
        resumeButton.isHidden = true
        closeButton.isHidden = true
        for view in views { effect.addSubview(view) }
        statusPanel.contentView = effect
    }

    @objc private func control(_ sender: NSButton) {
        guard let action = sender.identifier?.rawValue else { return }
        if action == "dismiss" {
            reportUnavailable("panel_dismissed")
            finish()
            return
        }
        guard let runId else { return }
        emit(["type": "control", "runId": runId, "action": action])
    }

    func handle(_ command: Command) {
        if let labels = command.labels { strings = labels }
        switch command.type {
        case "start":
            guard let runId = command.runId, let pid = command.pid, let windowId = command.windowId else { return }
            finish()
            self.runId = runId
            unavailableReported = false
            targetPid = pid
            targetWindowId = windowId
            targetBounds = command.bounds
            paused = false
            let app = command.appName ?? ""
            targetLabel.stringValue = app.isEmpty ? (command.title ?? "") : "\(app) — \(command.title ?? "")"
            headingLabel.stringValue = "●  " + label("controllingNative", "DSH-CU 正在控制")
            statusLabel.stringValue = label("preparing", "准备执行")
            pauseButton.title = label("pause", "暂停")
            pauseButton.identifier = NSUserInterfaceItemIdentifier("pause")
            resumeButton.title = label("resume", "继续")
            stopButton.title = label("stop", "停止")
            takeoverButton.title = label("takeoverAction", "接管")
            closeButton.title = label("close", "关闭")
            pauseButton.isHidden = false
            resumeButton.isHidden = true
            stopButton.isHidden = false
            takeoverButton.isHidden = false
            closeButton.isHidden = true
            lastHeartbeat = Date()
            syntheticUntil = Date()
            lastKeyboardEvent = secondsSinceLastEvent(.keyDown)
            lastPointerEvent = secondsSinceLastEvent(.leftMouseDown)
            refreshWindow()
            statusPanel.orderFrontRegardless()
            let menuShown = showStatusItem()
            emit(["type": "started", "runId": runId])
            emit(["type": "menu", "runId": runId, "visible": menuShown])
        case "activity":
            guard command.runId == runId else { return }
            lastHeartbeat = Date()
            let phase = command.phase ?? "running"
            paused = phase == "paused"
            pauseButton.isHidden = paused
            resumeButton.isHidden = !paused
            var text = phaseLabel(phase)
            if phase == "acting", let operation = command.operation {
                text += " · " + operationLabel(operation)
            }
            if let step = command.step, let maxSteps = command.maxSteps {
                text += " · " + label("step", "步骤") + " \(step)/\(maxSteps)"
            }
            statusLabel.stringValue = text
            if phase == "acting" {
                syntheticUntil = Date().addingTimeInterval(0.5)
                if command.operation == "CLICK" { cursorView.showClick() }
            } else if phase == "verifying" {
                syntheticUntil = Date().addingTimeInterval(0.3)
            }
            if let point = command.point {
                lastPoint = point
                showCursor(at: point)
            }
        case "heartbeat":
            if command.runId == runId { lastHeartbeat = Date() }
        case "finish":
            guard command.runId == runId else { return }
            if command.persistent == true {
                let status = command.status ?? "completed"
                let route = command.route.map { $0 == "skill" ? label("routeSkill", "已验证技能") : label("routeD1", "本地决策") } ?? ""
                statusLabel.stringValue = [phaseLabel(status), route, command.reason ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
                pauseButton.isHidden = true
                resumeButton.isHidden = true
                stopButton.isHidden = true
                takeoverButton.isHidden = true
                closeButton.isHidden = false
                runId = nil
                targetOnscreen = false
                cursorPanel.orderOut(nil)
                emit(["type": "menu", "visible": hideStatusItem()])
            } else {
                finish()
            }
        case "dismiss":
            reportUnavailable("panel_dismissed")
            finish()
        case "stop":
            NSApplication.shared.terminate(nil)
        default:
            break
        }
    }

    private func primaryHeight() -> CGFloat {
        CGDisplayBounds(CGMainDisplayID()).height
    }

    private func setTopLeft(_ panel: NSPanel, x: Double, y: Double) {
        panel.setFrameOrigin(NSPoint(x: x, y: Double(primaryHeight()) - y - Double(panel.frame.height)))
    }

    private func showCursor(at point: ActivityPoint) {
        guard targetOnscreen else {
            cursorPanel.orderOut(nil)
            return
        }
        setTopLeft(cursorPanel, x: point.x - CursorView.hotspotX, y: point.y - CursorView.hotspotY)
        cursorPanel.orderFrontRegardless()
    }

    private func positionStatusPanel() {
        guard let bounds = targetBounds else { return }
        let width = Double(statusPanel.frame.width)
        let height = Double(statusPanel.frame.height)
        let x = max(bounds.x + 8, min(bounds.x + bounds.width - width - 10, bounds.x + bounds.width - width - 12))
        let y = max(bounds.y + 40, min(bounds.y + bounds.height - height - 8, bounds.y + bounds.height - height - 12))
        setTopLeft(statusPanel, x: x, y: y)
    }

    private func refreshWindow() {
        guard runId != nil, let windowId = targetWindowId else { return }
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowId) as? [[String: Any]],
              let info = list.first,
              let boundsDictionary = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
              let owner = info[kCGWindowOwnerPID as String] as? Int32,
              owner == targetPid else {
            reportUnavailable("window_gone")
            return
        }
        targetBounds = WindowBounds(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: rect.height)
        if info[kCGWindowIsOnscreen as String] as? Bool == true {
            targetOnscreen = true
            positionStatusPanel()
            statusPanel.orderFrontRegardless()
            if let lastPoint { showCursor(at: lastPoint) }
        } else {
            reportUnavailable("window_offscreen")
        }
    }

    private func secondsSinceLastEvent(_ type: CGEventType) -> Double {
        CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: type)
    }

    private func detectTakeover() {
        let keyboard = secondsSinceLastEvent(.keyDown)
        let pointer = secondsSinceLastEvent(.leftMouseDown)
        defer {
            lastKeyboardEvent = keyboard
            lastPointerEvent = pointer
        }
        guard runId != nil, !paused, Date() >= syntheticUntil, let bounds = targetBounds else { return }
        let targetIsFrontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPid
        if keyboard < (lastKeyboardEvent ?? Double.infinity), targetIsFrontmost {
            requestTakeover()
            return
        }
        if pointer < (lastPointerEvent ?? Double.infinity), targetIsFrontmost, let location = CGEvent(source: nil)?.location,
           location.x >= bounds.x, location.x <= bounds.x + bounds.width,
           location.y >= bounds.y, location.y <= bounds.y + bounds.height {
            let panelFrame = statusPanel.frame
            let panelTopLeftY = Double(primaryHeight()) - Double(panelFrame.origin.y) - Double(panelFrame.height)
            let insidePanel = location.x >= panelFrame.origin.x && location.x <= panelFrame.maxX
                && location.y >= panelTopLeftY && location.y <= panelTopLeftY + Double(panelFrame.height)
            if !insidePanel { requestTakeover() }
        }
    }

    /// Tells the host that this run can no longer be shown (window gone, window
    /// offscreen, panel dismissed). Input authority must be revoked by the host;
    /// locally every reference is dropped so no stale geometry survives.
    private func reportUnavailable(_ reason: String) {
        guard let runId, !unavailableReported else { return }
        unavailableReported = true
        emit(["type": "unavailable", "runId": runId, "reason": reason])
        finish()
    }

    private func requestTakeover() {
        guard let runId else { return }
        emit(["type": "control", "runId": runId, "action": "takeover", "reason": "takeover_detected"])
        finish()
    }

    private func finish() {
        let finishedRun = runId
        runId = nil
        targetPid = nil
        targetWindowId = nil
        targetBounds = nil
        lastPoint = nil
        targetOnscreen = false
        paused = false
        cursorPanel.orderOut(nil)
        statusPanel.orderOut(nil)
        let menuVisible = hideStatusItem()
        if finishedRun != nil { emit(["type": "menu", "visible": menuVisible]) }
    }

    private func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
}

final class ApplicationDelegate: NSObject, NSApplicationDelegate {
    let controller = ControlController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        var input = Data()
        FileHandle.standardInput.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty {
                DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
                return
            }
            input.append(data)
            while let newline = input.firstIndex(of: 0x0a) {
                let line = input.subdata(in: 0..<newline)
                input.removeSubrange(0...newline)
                guard let command = try? JSONDecoder().decode(Command.self, from: line) else { continue }
                DispatchQueue.main.async { self.controller.handle(command) }
            }
        }
        let ready = try! JSONSerialization.data(withJSONObject: ["type": "ready"])
        FileHandle.standardOutput.write(ready)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
}

@main
final class ControlIndicatorApplication {
    static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let delegate = ApplicationDelegate()
        application.delegate = delegate
        application.run()
    }
}
