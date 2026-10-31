import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2, let ownerPid = Int32(CommandLine.arguments[1]) else {
    fatalError("Usage: WindowInventory <owner-pid>")
}

let windows = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
let records = windows.filter { $0[kCGWindowOwnerPID as String] as? Int32 == ownerPid }.compactMap { info -> [String: Any]? in
    guard let number = info[kCGWindowNumber as String] as? Int,
          let bounds = info[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
    return [
        "windowId": number,
        "bounds": ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height],
        "isOnscreen": info[kCGWindowIsOnscreen as String] as? Bool ?? false,
        "layer": info[kCGWindowLayer as String] as? Int ?? 0,
        "sharingState": info[kCGWindowSharingState as String] as? Int ?? -1,
    ]
}
let data = try JSONSerialization.data(withJSONObject: records, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([0x0a]))
