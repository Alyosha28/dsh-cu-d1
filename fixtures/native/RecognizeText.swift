import Foundation
import ImageIO
import Vision

guard CommandLine.arguments.count == 2 else {
    fatalError("Usage: RecognizeText <image-path>")
}
let imageURL = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
guard let source = CGImageSourceCreateWithURL(imageURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fatalError("Could not decode screenshot")
}
let request = VNRecognizeTextRequest()
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: image).perform([request])
let text = (request.results ?? []).compactMap { observation in
    observation.topCandidates(1).first?.string
}.joined(separator: "\n")
guard let data = text.data(using: .utf8) else {
    fatalError("Could not encode recognized text")
}
try FileHandle.standardOutput.write(contentsOf: data)
