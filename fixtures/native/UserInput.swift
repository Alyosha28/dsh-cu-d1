import CoreGraphics
import Foundation

let count = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 30 : 30
let source = CGEventSource(stateID: .hidSystemState)
for _ in 0..<count {
    var character: UniChar = 117
    let down = CGEvent(keyboardEventSource: source, virtualKey: 32, keyDown: true)
    down?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: source, virtualKey: 32, keyDown: false)
    up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
    up?.post(tap: .cghidEventTap)
    usleep(20000)
}
