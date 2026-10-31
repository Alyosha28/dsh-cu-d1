import AppKit

@main
struct CursorSnapshot {
    static func main() throws {
        guard CommandLine.arguments.count >= 2 else { fatalError("Usage: CursorSnapshot <output.png> [dark]") }
        let view = CursorView(frame: NSRect(x: 0, y: 0, width: CursorView.canvasSize, height: CursorView.canvasSize))
        let scale: CGFloat = 4
        let size = Int(CursorView.canvasSize * scale)
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: size,
            pixelsHigh: size,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
            fatalError("Could not create cursor snapshot")
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        let dark = CommandLine.arguments.contains("dark")
        NSColor(calibratedRed: dark ? 0.06 : 0.97, green: dark ? 0.09 : 0.98, blue: dark ? 0.15 : 1, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: size, height: size).fill()
        context.cgContext.scaleBy(x: scale, y: scale)
        view.draw(view.bounds)
        NSGraphicsContext.restoreGraphicsState()
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            fatalError("Could not encode cursor snapshot")
        }
        try data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
    }
}
