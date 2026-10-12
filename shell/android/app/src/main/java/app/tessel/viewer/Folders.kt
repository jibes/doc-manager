package app.tessel.viewer

import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.MediaStore
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream

/**
 * Documents in the user's folders, for the app's file browser.
 * - Folders the user picked (Storage Access Framework trees): no permission beyond that folder.
 * - Optional "All files access": every PDF and EPUB on the device (MediaStore) and the whole of internal storage.
 * Entries carry a readable URI (content:// or file://), served to the web app at /__shell/doc?u=…
 */
class Folders(private val context: Context) {
    private val resolver: ContentResolver get() = context.contentResolver

    /** Folders the user granted, with their display names. */
    fun folders(): JSONArray {
        val list = JSONArray()
        for (p in resolver.persistedUriPermissions) {
            if (!p.isReadPermission || !DocumentsContract.isTreeUri(p.uri)) continue
            list.put(JSONObject().put("uri", p.uri.toString()).put("name", treeName(p.uri)))
        }
        return list
    }

    fun treeName(tree: Uri): String {
        val doc = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        return runCatching {
            resolver.query(doc, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
        }.getOrNull() ?: DocumentsContract.getTreeDocumentId(tree).substringAfterLast(':').substringAfterLast('/').ifBlank { "Folder" }
    }

    /** Keeps access to a picked folder across restarts (with write access where the provider allows it). */
    fun keep(tree: Uri) {
        val rw = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        runCatching { resolver.takePersistableUriPermission(tree, rw) }
            .recoverCatching { resolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    fun forget(tree: Uri) {
        for (p in resolver.persistedUriPermissions) {
            if (p.uri != tree) continue
            val flags = (if (p.isReadPermission) Intent.FLAG_GRANT_READ_URI_PERMISSION else 0) or (if (p.isWritePermission) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
            runCatching { resolver.releasePersistableUriPermission(tree, flags) }
        }
    }

    // ---------- all files ----------

    fun allFilesGranted(): Boolean =
        if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager()
        else context.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    private val storageRoot: File get() = Environment.getExternalStorageDirectory()

    // ---------- listing ----------

    /**
     * root: a granted tree URI, "device" (internal storage) or "all" (every document, newest first).
     * dir: a document ID within the tree, or an absolute path on the device; null for the root itself.
     */
    fun list(root: String, dir: String?): JSONArray = when (root) {
        "all" -> allDocuments()
        "device" -> listPath(dir ?: storageRoot.absolutePath)
        else -> listTree(Uri.parse(root), dir)
    }

    private fun listTree(tree: Uri, dir: String?): JSONArray {
        if (resolver.persistedUriPermissions.none { it.uri == tree && it.isReadPermission }) throw SecurityException("No access to $tree")
        val parent = dir ?: DocumentsContract.getTreeDocumentId(tree)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
        val out = JSONArray()
        val cols = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED)
        resolver.query(children, cols, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0) ?: continue
                val name = c.getString(1) ?: continue
                if (name.startsWith('.')) continue
                val mime = c.getString(2) ?: ""
                val isDir = mime == Document.MIME_TYPE_DIR
                val kind = if (isDir) "dir" else kindOf(name, mime) ?: continue
                out.put(
                    entry(id, name, kind, if (c.isNull(3)) 0 else c.getLong(3), if (c.isNull(4)) 0 else c.getLong(4))
                        .put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString()),
                )
            }
        }
        return out
    }

    private fun listPath(path: String): JSONArray {
        if (!allFilesGranted()) throw SecurityException("All files access is off")
        val dir = File(path).canonicalFile
        if (!dir.path.startsWith(storageRoot.canonicalPath)) throw SecurityException("Outside storage")
        val out = JSONArray()
        for (f in dir.listFiles().orEmpty()) {
            if (f.name.startsWith('.')) continue
            val kind = if (f.isDirectory) "dir" else kindOf(f.name, null) ?: continue
            out.put(entry(f.absolutePath, f.name, kind, if (f.isDirectory) 0 else f.length(), f.lastModified()).put("uri", Uri.fromFile(f).toString()))
        }
        return out
    }

    private fun allDocuments(): JSONArray {
        if (!allFilesGranted()) throw SecurityException("All files access is off")
        val files = MediaStore.Files.getContentUri("external")
        @Suppress("DEPRECATION") val data = MediaStore.MediaColumns.DATA
        val cols = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_MODIFIED, data)
        val where = "${MediaStore.MediaColumns.MIME_TYPE} IN (?, ?) OR ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ? OR ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?"
        val args = arrayOf(PDF, EPUB, "%.pdf", "%.epub")
        val out = JSONArray()
        val root = storageRoot.absolutePath
        resolver.query(files, cols, where, args, "${MediaStore.MediaColumns.DATE_MODIFIED} DESC")?.use { c ->
            while (c.moveToNext()) {
                val name = c.getString(1) ?: continue
                val kind = kindOf(name, c.getString(2)) ?: continue
                val path = c.getString(5)
                val file = path?.let { File(it) }
                // Skip app-private and hidden places (trash, caches).
                if (file != null && (file.path.contains("/.") || file.path.contains("/Android/data/"))) continue
                val uri = file?.let { Uri.fromFile(it) } ?: ContentUris.withAppendedId(files, c.getLong(0))
                val e = entry(path ?: uri.toString(), name, kind, c.getLong(3), c.getLong(4) * 1000).put("uri", uri.toString())
                file?.parentFile?.let { e.put("where", it.path.removePrefix(root).trimStart('/').ifEmpty { "/" }) }
                out.put(e)
            }
        }
        return out
    }

    private fun entry(id: String, name: String, kind: String, size: Long, modified: Long) =
        JSONObject().put("id", id).put("name", name).put("kind", kind).put("size", size).put("modified", modified)

    private fun kindOf(name: String, mime: String?): String? = when {
        mime == PDF || name.endsWith(".pdf", true) -> "pdf"
        mime == EPUB || name.endsWith(".epub", true) -> "epub"
        else -> null
    }

    // ---------- reading and writing ----------

    /** A file the user can reach through a granted folder, or anywhere with all files access. */
    private fun allowed(uri: Uri): Boolean = when (uri.scheme) {
        "content" -> allFilesGranted() || runCatching {
            val tree = DocumentsContract.buildTreeDocumentUri(uri.authority, DocumentsContract.getTreeDocumentId(uri))
            resolver.persistedUriPermissions.any { it.isReadPermission && it.uri == tree }
        }.getOrDefault(false)
        "file" -> allFilesGranted() && File(uri.path ?: "").canonicalPath.startsWith(storageRoot.canonicalPath)
        else -> false
    }

    fun serve(u: String?): WebResourceResponse {
        val uri = u?.let(Uri::parse)
        val stream = runCatching {
            if (uri == null || !allowed(uri)) null
            else if (uri.scheme == "file") FileInputStream(File(uri.path!!)) else resolver.openInputStream(uri)
        }.getOrNull() ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        val mime = if (uri!!.toString().endsWith(".epub", true)) EPUB else resolver.getType(uri) ?: AppAssets.mimeOf(uri.lastPathSegment ?: "")
        return WebResourceResponse(mime, null, stream)
    }

    /** Replaces a document's bytes with `source` (the reader saved form fields or annotations). */
    fun write(uri: Uri, source: File) {
        if (!allowed(uri)) throw SecurityException("No access to $uri")
        if (uri.scheme == "file") source.copyTo(File(uri.path!!), overwrite = true)
        else resolver.openOutputStream(uri, "wt")!!.use { out -> source.inputStream().use { it.copyTo(out) } }
    }

    companion object {
        const val PDF = "application/pdf"
        const val EPUB = "application/epub+zip"
    }
}
