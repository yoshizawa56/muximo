import AppKit
import Foundation

guard CommandLine.arguments.count >= 4,
      let canvasSide = Int(CommandLine.arguments[2]),
      canvasSide > 0 else {
    fputs("Usage: generate-ios-splash.swift <source.svg> <size> <output.png> [output.png ...]\n", stderr)
    exit(EXIT_FAILURE)
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURLs = CommandLine.arguments.dropFirst(3).map(URL.init(fileURLWithPath:))
let canvasSize = NSSize(width: canvasSide, height: canvasSide)

guard let sourceImage = NSImage(contentsOf: sourceURL) else {
    fputs("Unable to load splash source: \(sourceURL.path)\n", stderr)
    exit(EXIT_FAILURE)
}

for outputURL in outputURLs {
    let canvas = NSImage(size: canvasSize)
    canvas.lockFocus()
    NSColor.black.setFill()
    NSRect(origin: .zero, size: canvasSize).fill()
    sourceImage.draw(
        in: NSRect(origin: .zero, size: canvasSize),
        from: .zero,
        operation: .sourceOver,
        fraction: 1,
    )
    canvas.unlockFocus()

    guard let tiffRepresentation = canvas.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiffRepresentation),
          let pngData = bitmap.representation(using: .png, properties: [:]) else {
        fputs("Unable to encode splash PNG: \(outputURL.path)\n", stderr)
        exit(EXIT_FAILURE)
    }

    do {
        try FileManager.default.createDirectory(
            at: outputURL.deletingLastPathComponent(),
            withIntermediateDirectories: true,
        )
        try pngData.write(to: outputURL)
    } catch {
        fputs("Unable to write splash PNG: \(outputURL.path): \(error)\n", stderr)
        exit(EXIT_FAILURE)
    }
}
