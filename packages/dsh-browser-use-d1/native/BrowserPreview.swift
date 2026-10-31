import AppKit
import Foundation

struct PanelStrings: Codable {
    let panel: [String: String]
    let phases: [String: String]
    let operations: [String: String]
}

struct PreviewCommand: Codable {
    let type: String
    let runId: String?
    let title: String?
    let phase: String?
    let operation: String?
    let data: String?
    let status: String?
    let reason: String?
    let route: String?
    let persistent: Bool?
    let labels: PanelStrings?
    let step: Int?
    let maxSteps: Int?
}

final class PreviewController: NSObject, NSWindowDelegate {
    private let panel: NSPanel
    private let imageView = NSImageView()
    private let statusLabel = NSTextField(labelWithString: "")
    private let targetLabel = NSTextField(labelWithString: "")
    private let pauseButton = NSButton(title: "", target: nil, action: nil)
    private let resumeButton = NSButton(title: "", target: nil, action: nil)
    private let stopButton = NSButton(title: "", target: nil, action: nil)
    private let takeoverButton = NSButton(title: "", target: nil, action: nil)
    private let closeButton = NSButton(title: "", target: nil, action: nil)
    private var strings: PanelStrings?
    private var runId: String?
    private var lastHeartbeat = Date()
    private var paused = false
    private var statusItem: NSStatusItem?
    private var statusMenuStop: NSMenuItem?

    override init() {
        panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 764),
            styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        super.init()
        configurePanel()
        Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self, let runId = self.runId, Date().timeIntervalSince(self.lastHeartbeat) > 3 else { return }
            self.emit(["type": "expired", "runId": runId])
            self.finish()
        }
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

    private func configurePanel() {
        panel.title = "DSH-CU Browser Use"
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.level = .floating
        panel.sharingType = .none
        panel.delegate = self
        panel.animationBehavior = .none

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 960, height: 764))
        let toolbar = NSVisualEffectView(frame: NSRect(x: 0, y: 674, width: 960, height: 90))
        toolbar.material = .hudWindow
        toolbar.blendingMode = .withinWindow
        toolbar.state = .active
        let heading = NSTextField(labelWithString: "●  DSH-CU")
        heading.frame = NSRect(x: 16, y: 60, width: 600, height: 22)
        heading.font = .systemFont(ofSize: 14, weight: .semibold)
        heading.textColor = .systemGreen
        targetLabel.frame = NSRect(x: 16, y: 38, width: 600, height: 20)
        targetLabel.lineBreakMode = .byTruncatingMiddle
        statusLabel.frame = NSRect(x: 16, y: 14, width: 600, height: 22)
        statusLabel.lineBreakMode = .byTruncatingTail
        toolbar.addSubview(heading)
        toolbar.addSubview(targetLabel)
        toolbar.addSubview(statusLabel)

        let buttons: [(NSButton, String, String, Selector)] = [
            (pauseButton, "pause", "暂停", #selector(control(_:))),
            (resumeButton, "resume", "继续", #selector(control(_:))),
            (stopButton, "stop", "停止", #selector(control(_:))),
            (takeoverButton, "takeover", "接管", #selector(control(_:))),
            (closeButton, "dismiss", "关闭", #selector(control(_:))),
        ]
        for (index, item) in buttons.enumerated() {
            let button = item.0
            button.title = item.2
            button.target = self
            button.action = item.3
            button.identifier = NSUserInterfaceItemIdentifier(item.1)
            button.frame = NSRect(x: 596 + index * 72, y: 32, width: 68, height: 30)
            button.bezelStyle = .rounded
            toolbar.addSubview(button)
        }
        resumeButton.isHidden = true
        closeButton.isHidden = true
        content.addSubview(toolbar)

        imageView.frame = NSRect(x: 0, y: 0, width: 960, height: 674)
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        content.addSubview(imageView)
        panel.contentView = content
        if let screen = NSScreen.main?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: screen.minX + 36, y: screen.minY + 36))
        }
    }

    @objc private func control(_ sender: NSButton) {
        guard let action = sender.identifier?.rawValue else { return }
        if action == "dismiss" {
            finish()
            return
        }
        guard let runId else { return }
        emit(["type": "control", "runId": runId, "action": action])
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if let runId { emit(["type": "control", "runId": runId, "action": "stop"]) }
        finish()
        return false
    }

    /// A menu-bar item mirrors the controlled tab outside the preview panel.
    @discardableResult
    private func showStatusItem(_ title: String) -> Bool {
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
        let detail = title.isEmpty ? label("controllingBrowser", "DSH-CU 正在控制此标签页") : title
        statusItem?.button?.toolTip = detail
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

    func handle(_ command: PreviewCommand) {
        if let labels = command.labels { strings = labels }
        switch command.type {
        case "start":
            guard let runId = command.runId else { return }
            self.runId = runId
            lastHeartbeat = Date()
            paused = false
            targetLabel.stringValue = command.title ?? ""
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
            panel.orderFrontRegardless()
            let menuShown = showStatusItem(command.title ?? "")
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
        case "frame":
            guard command.runId == runId, let data = command.data,
                  let imageData = Data(base64Encoded: data), let image = NSImage(data: imageData) else { return }
            if let title = command.title, !title.isEmpty {
                targetLabel.stringValue = title
                statusItem?.button?.toolTip = title
            }
            imageView.image = image
            emit(["type": "frame", "runId": command.runId!, "bytes": imageData.count])
        case "heartbeat":
            if command.runId == runId { lastHeartbeat = Date() }
        case "finish":
            guard command.runId == runId else { return }
            if command.persistent == true {
                let status = command.status ?? "completed"
                let reason = command.reason ?? ""
                let route = command.route.map { $0 == "skill" ? label("routeSkill", "已验证技能") : label("routeD1", "本地决策") } ?? ""
                statusLabel.stringValue = [phaseLabel(status), route, reason].filter { !$0.isEmpty }.joined(separator: " · ")
                pauseButton.isHidden = true
                resumeButton.isHidden = true
                stopButton.isHidden = true
                takeoverButton.isHidden = true
                closeButton.isHidden = false
                runId = nil
                emit(["type": "menu", "visible": hideStatusItem()])
                lastHeartbeat = Date()
            } else {
                finish()
            }
        case "dismiss":
            finish()
        case "stop":
            NSApplication.shared.terminate(nil)
        default:
            break
        }
    }

    private func finish() {
        let finishedRun = runId
        runId = nil
        panel.orderOut(nil)
        let menuVisible = hideStatusItem()
        if finishedRun != nil { emit(["type": "menu", "visible": menuVisible]) }
    }

    private func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
}

final class PreviewApplicationDelegate: NSObject, NSApplicationDelegate {
    let controller = PreviewController()

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
                guard let command = try? JSONDecoder().decode(PreviewCommand.self, from: line) else { continue }
                DispatchQueue.main.async { self.controller.handle(command) }
            }
        }
        let ready = try! JSONSerialization.data(withJSONObject: ["type": "ready"])
        FileHandle.standardOutput.write(ready)
        FileHandle.standardOutput.write(Data([0x0a]))
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let delegate = PreviewApplicationDelegate()
application.delegate = delegate
application.run()
