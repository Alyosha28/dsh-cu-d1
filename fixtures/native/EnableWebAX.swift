import AppKit
import ApplicationServices
import Foundation

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]) else {
    fatalError("Usage: EnableWebAX <pid>")
}
let application = AXUIElementCreateApplication(pid)
var names: CFArray?
AXUIElementCopyAttributeNames(application, &names)
print(names as? [String] ?? [])
var windowsValue: CFTypeRef?
guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &windowsValue) == .success,
      let windows = windowsValue as? [AXUIElement], let window = windows.first else {
    fatalError("No Chrome window is available")
}
let result = AXUIElementSetAttributeValue(window, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
if result != .success {
    fatalError("Could not enable web accessibility: \(result.rawValue)")
}
print("Web accessibility enabled for \(pid)")
