import AppKit
import Darwin

/// Disposable native CSV importer used only by the P0 cross-application benchmark.
final class WorkflowFixture: NSObject, NSApplicationDelegate {
    let statePath: String
    var window: NSWindow!
    var pathField: NSTextField!
    var importButton: NSButton!
    var statusLabel: NSTextField!
    var resultLabel: NSTextField!
    var hiddenAX = false
    var savedChildren: [Any]?
    var rows = 0
    var total = 0
    var status = "idle"
    var controls: [DispatchSourceSignal] = []
    var stateObserver: Timer?
    var secondaryWindow: NSWindow?

    init(statePath: String) { self.statePath = statePath }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 140, y: 140, width: 520, height: 300),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "DSH Workflow Fixture"
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.collectionBehavior = [.canJoinAllApplications, .stationary]

        let title = NSTextField(labelWithString: "Import a synthetic CSV report")
        title.frame = NSRect(x: 30, y: 235, width: 450, height: 28)
        title.font = NSFont.systemFont(ofSize: 18, weight: .semibold)
        window.contentView!.addSubview(title)

        pathField = NSTextField(frame: NSRect(x: 30, y: 165, width: 460, height: 36))
        pathField.placeholderString = "Report path"
        pathField.setAccessibilityIdentifier("dsh-workflow-path")
        pathField.setAccessibilityLabel("Report path")
        if CommandLine.arguments.count > 2 { pathField.stringValue = CommandLine.arguments[2] }
        window.contentView!.addSubview(pathField)

        importButton = NSButton(title: "Import report", target: self, action: #selector(importReport))
        importButton.frame = NSRect(x: 30, y: 95, width: 180, height: 40)
        importButton.setAccessibilityIdentifier("dsh-workflow-import")
        window.contentView!.addSubview(importButton)

        statusLabel = NSTextField(labelWithString: "Status: idle")
        statusLabel.frame = NSRect(x: 30, y: 55, width: 450, height: 24)
        window.contentView!.addSubview(statusLabel)
        resultLabel = NSTextField(labelWithString: "Rows: 0 · Total: 0")
        resultLabel.frame = NSRect(x: 30, y: 20, width: 450, height: 24)
        window.contentView!.addSubview(resultLabel)

        window.makeKeyAndOrderFront(nil)
        if CommandLine.arguments.contains("--editing") { window.makeFirstResponder(pathField) }
        if CommandLine.arguments.contains("--secondary") {
            secondaryWindow = NSWindow(contentRect: NSRect(x: 700, y: 180, width: 420, height: 260),
                                       styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            secondaryWindow?.title = "DSH Workflow Secondary"
            secondaryWindow?.isReleasedWhenClosed = false
            let label = NSTextField(labelWithString: "Secondary fixture window")
            label.frame = NSRect(x: 30, y: 100, width: 360, height: 30)
            secondaryWindow?.contentView?.addSubview(label)
            secondaryWindow?.makeKeyAndOrderFront(nil)
        }
        NSApplication.shared.activate(ignoringOtherApps: true)
        savedChildren = NSApplication.shared.accessibilityChildren()

        for number in [SIGUSR1, SIGWINCH, SIGUSR2, SIGHUP] {
            signal(number, SIG_IGN)
            let control = DispatchSource.makeSignalSource(signal: number, queue: .main)
            control.setEventHandler { [weak self] in
                guard let self else { return }
                if number == SIGUSR1 { self.setAXHidden(true) }
                if number == SIGUSR2 {
                    self.window.makeKeyAndOrderFront(nil)
                    NSApplication.shared.activate(ignoringOtherApps: true)
                }
                if number == SIGHUP { self.reset() }
                if number == SIGWINCH {
                    self.window.setContentSize(NSSize(width: 600, height: 340))
                    self.persist()
                }
            }
            control.resume()
            controls.append(control)
        }
        persist()
        stateObserver = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.persist() }
        print("READY")
        fflush(stdout)
    }

    @objc func importReport() {
        do {
            let contents = try String(contentsOfFile: pathField.stringValue, encoding: .utf8)
            let lines = contents.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            guard lines.first == "city,amount", lines.count > 1 else { throw NSError(domain: "InvalidCSV", code: 1) }
            var parsedRows = 0
            var parsedTotal = 0
            for line in lines.dropFirst() {
                let columns = line.split(separator: ",", omittingEmptySubsequences: false)
                guard columns.count == 2, let amount = Int(columns[1]) else { throw NSError(domain: "InvalidCSV", code: 2) }
                parsedRows += 1
                parsedTotal += amount
            }
            rows = parsedRows
            total = parsedTotal
            status = "Import complete"
        } catch {
            rows = 0
            total = 0
            status = "Import failed"
        }
        statusLabel.stringValue = "Status: \(status)"
        resultLabel.stringValue = "Rows: \(rows) · Total: \(total)"
        persist()
    }

    func reset() {
        pathField.stringValue = ""
        rows = 0
        total = 0
        status = "idle"
        statusLabel.stringValue = "Status: idle"
        resultLabel.stringValue = "Rows: 0 · Total: 0"
        persist()
    }

    func setAXHidden(_ hidden: Bool) {
        let app = NSApplication.shared
        app.setAccessibilityChildren(hidden ? [] : savedChildren)
        app.setAccessibilityWindows(hidden ? [] : [window!])
        app.setAccessibilityFocusedWindow(hidden ? nil : window)
        hiddenAX = hidden
        NSAccessibility.post(element: app, notification: .layoutChanged)
        persist()
    }

    func persist() {
        guard window != nil, importButton != nil, pathField != nil else { return }
        let buttonRect = importButton.convert(importButton.bounds, to: nil)
        let fieldRect = pathField.convert(pathField.bounds, to: nil)
        let data = try! JSONSerialization.data(withJSONObject: [
            "pid": ProcessInfo.processInfo.processIdentifier,
            "windowId": window.windowNumber,
            "hiddenAX": hiddenAX,
            "rows": rows,
            "total": total,
            "status": status,
            "path": pathField.stringValue,
            "buttonPoint": [buttonRect.midX, window.frame.height - buttonRect.midY],
            "fieldPoint": [fieldRect.midX, window.frame.height - fieldRect.midY],
        ])
        try! data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
guard let statePath = CommandLine.arguments.dropFirst().first else { fatalError("Fixture requires a state path") }
let fixture = WorkflowFixture(statePath: statePath)
app.delegate = fixture
app.run()
