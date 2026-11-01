import ApplicationServices
import CoreGraphics
import Foundation
let ax = AXIsProcessTrusted()
let sr = CGPreflightScreenCaptureAccess()
print("accessibility=\(ax) screenRecording=\(sr) guiSession=\(CGSessionCopyCurrentDictionary() != nil)")
