package app.tessel.viewer

import android.content.res.AssetManager
import android.webkit.WebResourceResponse
import java.io.IOException

/**
 * Serves the bundled web app (assets/www) at https://appassets.androidplatform.net/ — a secure origin,
 * so IndexedDB, module workers and WebAssembly behave as on the website. Paths without a file extension
 * are app routes and get index.html (the router takes it from there).
 */
class AppAssets(private val assets: AssetManager) {
    fun handle(path: String): WebResourceResponse? {
        val clean = path.substringBefore('?').substringBefore('#').trimStart('/')
        val last = clean.substringAfterLast('/')
        val file = if (clean.isEmpty() || !last.contains('.')) "www/index.html" else "www/$clean"
        return try {
            WebResourceResponse(mimeOf(file), if (isText(file)) "utf-8" else null, assets.open(file)).apply {
                // Assets ship with the APK: a new version means a new APK, so caching within a run is safe.
                responseHeaders = mapOf("Cache-Control" to "no-cache") + ISOLATION
            }
        } catch (e: IOException) {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        }
    }

    private fun isText(file: String) = mimeOf(file).let { it.startsWith("text/") || it.endsWith("json") || it.endsWith("javascript") || it.endsWith("manifest+json") }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"

        /**
         * Cross-origin isolation: lets the scanner's text recognition (ONNX Runtime) use several threads. Everything
         * the app loads comes from this origin, so nothing is blocked by it.
         */
        val ISOLATION = mapOf("Cross-Origin-Opener-Policy" to "same-origin", "Cross-Origin-Embedder-Policy" to "require-corp")

        fun mimeOf(file: String): String = when (file.substringAfterLast('.').lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json", "map" -> "application/json"
            "webmanifest" -> "application/manifest+json"
            "wasm" -> "application/wasm"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "svg" -> "image/svg+xml"
            "ico" -> "image/x-icon"
            "webp" -> "image/webp"
            "ttf" -> "font/ttf"
            "otf" -> "font/otf"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            "gz" -> "application/gzip"
            "pdf" -> "application/pdf"
            "epub" -> "application/epub+zip"
            "md", "txt" -> "text/plain"
            else -> "application/octet-stream"
        }
    }
}
