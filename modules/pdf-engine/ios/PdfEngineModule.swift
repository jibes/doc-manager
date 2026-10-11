import ExpoModulesCore
import PDFKit
import UIKit

final class OpenFailedException: Exception {
  override var reason: String { "Could not open PDF." }
}

// Reasons carry the tokens src/engine/types.ts#asPasswordError looks for.
final class PasswordRequiredException: Exception {
  override var reason: String { "password-required" }
}

final class PasswordWrongException: Exception {
  override var reason: String { "password-wrong" }
}

final class UnknownHandleException: Exception {
  override var reason: String { "Document closed." }
}

/// PDFKit-backed implementation of the DocHandle contract in src/engine/types.ts.
public class PdfEngineModule: Module {
  private var docs: [String: PDFDocument] = [:]
  private let lock = NSLock()
  private let maxWidth = 4096.0

  private lazy var cacheDir: URL = {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pdf-render", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }()

  private func doc(_ handle: String) throws -> PDFDocument {
    lock.lock()
    defer { lock.unlock() }
    guard let d = docs[handle] else { throw UnknownHandleException() }
    return d
  }

  /// Page size in points with /Rotate applied.
  private static func size(of page: PDFPage) -> CGSize {
    let b = page.bounds(for: .cropBox)
    return page.rotation % 180 == 0 ? b.size : CGSize(width: b.height, height: b.width)
  }

  public func definition() -> ModuleDefinition {
    Name("PdfEngine")

    AsyncFunction("open") { (uri: String, password: String?) -> [String: Any] in
      guard let url = URL(string: uri), let pdf = PDFDocument(url: url) else { throw OpenFailedException() }
      if pdf.isLocked {
        guard let password, !password.isEmpty else { throw PasswordRequiredException() }
        if !pdf.unlock(withPassword: password) { throw PasswordWrongException() }
      }
      let handle = UUID().uuidString
      lock.lock()
      docs[handle] = pdf
      lock.unlock()
      let sizes: [[String: Double]] = (0..<pdf.pageCount).map { i in
        guard let p = pdf.page(at: i) else { return ["width": 612, "height": 792] }
        let s = Self.size(of: p)
        return ["width": Double(s.width), "height": Double(s.height)]
      }
      let attrs = pdf.documentAttributes ?? [:]
      var result: [String: Any] = ["handle": handle, "pageCount": pdf.pageCount, "pageSizes": sizes]
      if let t = attrs[PDFDocumentAttribute.titleAttribute] as? String, !t.isEmpty { result["title"] = t }
      if let a = attrs[PDFDocumentAttribute.authorAttribute] as? String, !a.isEmpty { result["author"] = a }
      return result
    }

    AsyncFunction("render") { (handle: String, index: Int, width: Double) -> [String: Any] in
      let pdf = try doc(handle)
      guard let page = pdf.page(at: index) else { throw OpenFailedException() }
      let s = Self.size(of: page)
      let w = min(width.rounded(), maxWidth)
      let h = (w * Double(s.height) / Double(s.width)).rounded()
      let file = cacheDir.appendingPathComponent("\(handle)-\(index)-\(Int(w)).jpg")
      if !FileManager.default.fileExists(atPath: file.path) {
        // thumbnail(of:for:) honours rotation and is thread-safe for distinct pages.
        let image = page.thumbnail(of: CGSize(width: w, height: h), for: .cropBox)
        guard let data = image.jpegData(compressionQuality: 0.92) else { throw OpenFailedException() }
        try data.write(to: file, options: .atomic)
      }
      return ["uri": file.absoluteString, "width": w, "height": h]
    }

    AsyncFunction("outline") { (handle: String) -> [[String: Any]] in
      let pdf = try doc(handle)
      var budget = 5000
      func walk(_ node: PDFOutline, depth: Int) -> [[String: Any]] {
        (0..<node.numberOfChildren).compactMap { i -> [String: Any]? in
          guard budget > 0, let child = node.child(at: i) else { return nil }
          budget -= 1
          let page = child.destination?.page.map { pdf.index(for: $0) } ?? -1
          return [
            "title": child.label ?? "",
            "page": page,
            "children": depth < 8 ? walk(child, depth: depth + 1) : [],
          ]
        }
      }
      return pdf.outlineRoot.map { walk($0, depth: 0) } ?? []
    }

    AsyncFunction("search") { (handle: String, query: String) -> [[String: Any]] in
      let pdf = try doc(handle)
      var hits: [[String: Any]] = []
      for sel in pdf.findString(query, withOptions: [.caseInsensitive, .diacriticInsensitive]).prefix(2000) {
        guard let page = sel.pages.first else { continue }
        let crop = page.bounds(for: .cropBox)
        // Line-level rects in page space (origin bottom-left) → normalized, origin top-left.
        let rects: [[String: Double]] = sel.selectionsByLine().map { line in
          let r = line.bounds(for: page)
          return [
            "x": Double((r.minX - crop.minX) / crop.width),
            "y": Double((crop.maxY - r.maxY) / crop.height),
            "w": Double(r.width / crop.width),
            "h": Double(r.height / crop.height),
          ]
        }
        let ctx = sel.copy() as! PDFSelection
        ctx.extend(atStart: 40)
        ctx.extend(atEnd: 60)
        let snippet = (ctx.string ?? sel.string ?? "").replacingOccurrences(of: "\n", with: " ")
        let match = snippet.range(of: query, options: [.caseInsensitive, .diacriticInsensitive])
        hits.append([
          "page": pdf.index(for: page),
          "rects": rects,
          "snippet": snippet,
          "matchStart": match.map { snippet.distance(from: snippet.startIndex, to: $0.lowerBound) } ?? 0,
          "matchLength": match.map { snippet.distance(from: $0.lowerBound, to: $0.upperBound) } ?? query.count,
        ])
      }
      return hits
    }

    Function("close") { (handle: String) in
      lock.lock()
      docs.removeValue(forKey: handle)
      lock.unlock()
    }
  }
}
