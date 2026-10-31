import AppKit
import QuartzCore

final class CursorView: NSView {
    static let canvasSize: CGFloat = 52
    static let hotspotX: CGFloat = 10
    static let hotspotY: CGFloat = 9
    private static let padding: CGFloat = 4

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
    }

    required init?(coder: NSCoder) {
        fatalError("CursorView is created programmatically")
    }

    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current?.cgContext.translateBy(x: Self.padding, y: Self.padding)
        let arrow = NSBezierPath()
        arrow.move(to: NSPoint(x: 6, y: 39))
        arrow.line(to: NSPoint(x: 32, y: 17))
        arrow.line(to: NSPoint(x: 22, y: 16))
        arrow.line(to: NSPoint(x: 16, y: 5))
        arrow.close()
        arrow.lineJoinStyle = .round
        arrow.lineCapStyle = .round

        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowOffset = NSSize(width: 1, height: -2)
        shadow.shadowBlurRadius = 3
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
        shadow.set()
        NSColor(calibratedRed: 0.192, green: 0.373, blue: 0.816, alpha: 1).setFill()
        arrow.fill()
        NSColor(calibratedRed: 0.09, green: 0.231, blue: 0.51, alpha: 1).setStroke()
        arrow.lineWidth = 1.35
        arrow.stroke()
        NSGraphicsContext.restoreGraphicsState()

        let inset = NSBezierPath()
        inset.move(to: NSPoint(x: 10, y: 33))
        inset.line(to: NSPoint(x: 27, y: 19))
        inset.line(to: NSPoint(x: 21, y: 18))
        inset.lineCapStyle = .round
        inset.lineJoinStyle = .round
        NSColor.white.setStroke()
        inset.lineWidth = 1.3
        inset.stroke()

        let outer = NSBezierPath(ovalIn: NSRect(x: -1, y: 32, width: 14, height: 14))
        NSColor.white.withAlphaComponent(0.88).setFill()
        outer.fill()
        NSColor(calibratedRed: 0.192, green: 0.373, blue: 0.816, alpha: 1).setStroke()
        outer.lineWidth = 1.2
        outer.stroke()
        let inner = NSBezierPath(ovalIn: NSRect(x: 3.8, y: 36.8, width: 4.4, height: 4.4))
        NSColor(calibratedRed: 0.192, green: 0.373, blue: 0.816, alpha: 1).setFill()
        inner.fill()
        NSGraphicsContext.restoreGraphicsState()
    }

    func showClick() {
        guard let layer else { return }
        let radius = 15.0
        let ring = CAShapeLayer()
        ring.frame = CGRect(x: Self.hotspotX - radius, y: Self.canvasSize - Self.hotspotY - radius, width: radius * 2, height: radius * 2)
        ring.path = CGPath(ellipseIn: ring.bounds, transform: nil)
        ring.fillColor = NSColor.clear.cgColor
        ring.strokeColor = NSColor(calibratedRed: 0.192, green: 0.373, blue: 0.816, alpha: 1).cgColor
        ring.lineWidth = 1.6
        ring.opacity = 0
        layer.addSublayer(ring)

        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.55
        scale.toValue = 1.35
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.85
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [scale, fade]
        group.duration = 0.4
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        ring.add(group, forKey: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            ring.removeFromSuperlayer()
        }
    }
}
