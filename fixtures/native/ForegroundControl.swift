import AppKit
import Foundation

func frontmostProcessIdentifier() -> pid_t {
    NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
}

guard CommandLine.arguments.count >= 2 else {
    fatalError("Usage: ForegroundControl frontmost | activate <pid> | monitor")
}
switch CommandLine.arguments[1] {
case "frontmost":
    print(frontmostProcessIdentifier())
case "pointer":
    guard let point = CGEvent(source: nil)?.location else { fatalError("Pointer location is unavailable") }
    print("\(point.x),\(point.y)")
case "activate":
    guard CommandLine.arguments.count == 3, let pid = Int32(CommandLine.arguments[2]),
          let application = NSRunningApplication(processIdentifier: pid) else {
        fatalError("A running application PID is required")
    }
    guard application.activate(options: [.activateAllWindows]) else {
        fatalError("Could not activate the controlled application")
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
case "monitor":
    var previous = pid_t(-1)
    let timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
        let current = frontmostProcessIdentifier()
        if current != previous {
            print(current)
            fflush(stdout)
            previous = current
        }
    }
    timer.fire()
    RunLoop.current.run()
default:
    fatalError("Unknown foreground control operation")
}
