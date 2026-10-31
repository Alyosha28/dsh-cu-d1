import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// Reports macOS privacy state and, when asked, opens the system prompt.
//
// Modes:
//   status        preflight only, never shows a dialog
//   accessibility request Accessibility (AXIsProcessTrustedWithOptions prompt)
//   screen        request Screen Recording (CGRequestScreenCaptureAccess)
//   both          request both
//
// The output is one JSON object on stdout so the Node side can report the real
// state instead of guessing from an error message.

let arguments = Set(CommandLine.arguments.dropFirst())
let wantsAccessibility = arguments.contains("accessibility") || arguments.contains("both")
let wantsScreen = arguments.contains("screen") || arguments.contains("both")

var accessibility = AXIsProcessTrusted()
var prompted = false

if wantsAccessibility && !accessibility {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    accessibility = AXIsProcessTrustedWithOptions(options)
    prompted = true
}

var screenRecording = CGPreflightScreenCaptureAccess()
if wantsScreen && !screenRecording {
    screenRecording = CGRequestScreenCaptureAccess()
    prompted = true
}

let result: [String: Any] = [
    "accessibility": accessibility,
    "screenRecording": screenRecording,
    "prompted": prompted,
]
guard let data = try? JSONSerialization.data(withJSONObject: result) else {
    exit(1)
}
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([0x0a]))
