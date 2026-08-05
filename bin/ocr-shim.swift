#!/usr/bin/env swift

import Foundation
import Vision
import CoreVideo

// MARK: - Unified OCR Result

struct OCRRegion {
    let text: String
    let confidence: Float
    let bounds: CGRect
}

struct OCRShimResult {
    let text: String
    let confidence: Float
    let regions: [OCRRegion]

    func toJSON() -> [String: Any] {
        let regionDicts: [[String: Any]] = regions.map { region in
            [
                "text": region.text,
                "confidence": region.confidence,
                "bounds": [
                    "x": region.bounds.origin.x,
                    "y": region.bounds.origin.y,
                    "width": region.bounds.width,
                    "height": region.bounds.height
                ]
            ]
        }
        return [
            "text": text,
            "confidence": confidence,
            "regionCount": regions.count,
            "regions": regionDicts
        ]
    }
}

// MARK: - Core Recognition (shared by both paths)

func performOCR(handler: VNImageRequestHandler) throws -> OCRShimResult {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    try handler.perform([request])

    guard let observations = request.results, !observations.isEmpty else {
        return OCRShimResult(text: "", confidence: 0.0, regions: [])
    }

    var regions: [OCRRegion] = []
    var fullText = ""

    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else { continue }
        fullText += candidate.string + "\n"
        regions.append(OCRRegion(
            text: candidate.string,
            confidence: candidate.confidence,
            bounds: observation.boundingBox
        ))
    }

    let avgConfidence: Float = regions.isEmpty ? 0.0
        : regions.map(\.confidence).reduce(0, +) / Float(regions.count)

    return OCRShimResult(
        text: fullText.trimmingCharacters(in: .whitespacesAndNewlines),
        confidence: avgConfidence,
        regions: regions
    )
}

// MARK: - Library API (CVPixelBuffer — zero-copy path)

func recognizeText(from pixelBuffer: CVPixelBuffer) throws -> OCRShimResult {
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
    return try performOCR(handler: handler)
}

// MARK: - Library API (Data path)

func recognizeText(from data: Data) throws -> OCRShimResult {
    let handler = VNImageRequestHandler(data: data, options: [:])
    return try performOCR(handler: handler)
}

// MARK: - CLI Entry Point

guard CommandLine.arguments.count > 1 else {
    let error = ["error": "Usage: ocr-shim <png-path>"]
    FileHandle.standardError.write(try! JSONSerialization.data(withJSONObject: error))
    exit(1)
}

let pngPath = CommandLine.arguments[1]
guard let imageData = FileManager.default.contents(atPath: pngPath) else {
    let error = ["error": "Cannot read file: \(pngPath)"]
    FileHandle.standardError.write(try! JSONSerialization.data(withJSONObject: error))
    exit(1)
}

do {
    let result = try recognizeText(from: imageData)
    let jsonData = try JSONSerialization.data(withJSONObject: result.toJSON(), options: [.sortedKeys])
    FileHandle.standardOutput.write(jsonData)
} catch {
    let errObj: [String: Any] = ["error": "Recognition failed: \(error.localizedDescription)"]
    let data = try! JSONSerialization.data(withJSONObject: errObj)
    FileHandle.standardError.write(data)
    exit(1)
}
