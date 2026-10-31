import AppKit
import ApplicationServices
import Foundation

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func press(_ element: AXUIElement, title: String) -> Bool {
    if attribute(element, kAXRoleAttribute as String) as? String == kAXButtonRole as String,
       attribute(element, kAXTitleAttribute as String) as? String == title {
        return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
    }
    for child in attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] ?? [] {
        if press(child, title: title) { return true }
    }
    return false
}

guard CommandLine.arguments.count == 3, let pid = Int32(CommandLine.arguments[1]) else {
    fatalError("Usage: PressControl <owner-pid> <button-title>")
}
let application = AXUIElementCreateApplication(pid)
for window in attribute(application, kAXWindowsAttribute as String) as? [AXUIElement] ?? [] {
    if press(window, title: CommandLine.arguments[2]) {
        print("pressed")
        exit(0)
    }
}
fatalError("Control button was not found or could not be pressed")
