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
import android.os.storage.StorageManager
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.MediaStore
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream

/**
 * Documents in the user's folders, for the app's file browser.
 * - Folders the user picked (Storage Access Framework trees): no permission beyond that folder.
 * - Optional "All files access": every PDF and EPUB on the device (MediaStore) and the whole of internal storage.
 * Entries carry a URI (content:// or file://), served to the web app at /__shell/doc?u=…, and the browser's
 * file operations (new folder, rename, delete, copy, move) work on those URIs.
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
        val granted = grantedTree(tree) ?: return
        for (p in resolver.persistedUriPermissions) {
            if (p.uri != granted) continue
            val flags = (if (p.isReadPermission) Intent.FLAG_GRANT_READ_URI_PERMISSION else 0) or (if (p.isWritePermission) Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
            runCatching { resolver.releasePersistableUriPermission(granted, flags) }
        }
    }

    /**
     * The granted tree a URI belongs to (a tree URI, or a document inside one), compared by provider and
     * folder ID rather than by spelling: the same tree can come back with its ID encoded differently.
     */
    private fun grantedTree(uri: Uri): Uri? {
        val id = runCatching { DocumentsContract.getTreeDocumentId(uri) }.getOrNull() ?: return null
        return resolver.persistedUriPermissions.firstOrNull {
            it.isReadPermission && DocumentsContract.isTreeUri(it.uri) && it.uri.authority == uri.authority &&
                runCatching { DocumentsContract.getTreeDocumentId(it.uri) }.getOrNull() == id
        }?.uri
    }

    // ---------- all files ----------

    fun allFilesGranted(): Boolean =
        if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager()
        else context.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    private val storageRoot: File get() = Environment.getExternalStorageDirectory()

    /**
     * Tessel's own folder, Documents/Tessel: where scans and documents opened from other apps are kept, so they
     * are real files (other apps see them; uninstalling keeps them). Android 11+ lets an app keep its own files
     * there without any permission; Android 8–10 need the storage permission.
     */
    private val appDir: File get() = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "Tessel")

    fun appFolderUsable(): Boolean = Build.VERSION.SDK_INT >= 30 || allFilesGranted()

    private fun inAppFolder(path: String): File {
        if (!appFolderUsable()) throw SecurityException("No storage permission")
        val base = appDir.apply { mkdirs() }.canonicalFile
        val f = File(path).canonicalFile
        if (f != base && !f.path.startsWith(base.path + File.separator)) throw SecurityException("Outside the Tessel folder")
        return f
    }

    private fun isInAppFolder(f: File): Boolean = appDir.canonicalPath.let { f.canonicalPath == it || f.canonicalPath.startsWith(it + File.separator) }

    private fun onDevice(path: String): File {
        if (!allFilesGranted()) throw SecurityException("All files access is off")
        val f = File(path).canonicalFile
        if (!f.path.startsWith(storageRoot.canonicalPath)) throw SecurityException("Outside storage")
        return f
    }

    // ---------- listing ----------

    /**
     * root: a granted tree URI, "device" (internal storage) or "all" (every document, newest first).
     * dir: a document ID within the tree, or an absolute path on the device; null for the root itself.
     */
    fun list(root: String, dir: String?): JSONArray = when (root) {
        "all" -> allDocuments()
        "device" -> listPath(onDevice(dir ?: storageRoot.absolutePath))
        "app" -> listPath(inAppFolder(dir ?: appDir.absolutePath))
        else -> listTree(Uri.parse(root), dir)
    }

    private fun tree(root: String): Uri = grantedTree(Uri.parse(root)) ?: throw SecurityException("No access to $root")

    /** The document URI of a folder: a tree root or a folder inside it. */
    private fun treeDir(root: String, dir: String?): Uri {
        val tree = tree(root)
        return DocumentsContract.buildDocumentUriUsingTree(tree, dir ?: DocumentsContract.getTreeDocumentId(tree))
    }

    private fun listTree(root: Uri, dir: String?): JSONArray {
        val tree = tree(root.toString())
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

    private fun listPath(dir: File): JSONArray {
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
        val where = "${MediaStore.MediaColumns.MIME_TYPE} = ? OR ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?"
        val args = arrayOf(PDF, "%.pdf")
        val out = JSONArray()
        val root = storageRoot.absolutePath
        resolver.query(files, cols, where, args, "${MediaStore.MediaColumns.DATE_MODIFIED} DESC")?.use { c ->
            while (c.moveToNext()) {
                val name = c.getString(1) ?: continue
                val kind = kindOf(name, c.getString(2)) ?: continue
                val path = c.getString(5)
                val file = path?.let { File(it) }
                // Skip app-private and hidden places (trash, caches), and files deleted since the last scan.
                if (file != null && (file.path.contains("/.") || file.path.contains("/Android/data/") || !file.exists())) continue
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
        else -> null
    }

    private fun mimeOf(name: String) = when {
        name.endsWith(".pdf", true) -> PDF
        name.endsWith(".epub", true) -> EPUB
        else -> "application/octet-stream"
    }

    // ---------- reading and writing ----------

    /** Every storage volume's root (internal storage, SD cards, USB drives): all files access reaches them all. */
    private fun volumes(): List<File> {
        val roots = if (Build.VERSION.SDK_INT >= 30) context.getSystemService(StorageManager::class.java)?.storageVolumes?.mapNotNull { it.directory }
        else context.getExternalFilesDirs(null).filterNotNull().mapNotNull { f -> f.path.substringBefore("/Android/data/", "").ifEmpty { null }?.let(::File) }
        return roots.orEmpty().ifEmpty { listOf(storageRoot) }
    }

    /** A file the user can reach through a granted folder, or anywhere with all files access. */
    private fun allowed(uri: Uri): Boolean = when (uri.scheme) {
        "content" -> allFilesGranted() || grantedTree(uri) != null
        "file" -> File(uri.path ?: "").let { f ->
            val path = f.canonicalPath
            (allFilesGranted() && volumes().any { v -> v.canonicalPath.let { path == it || path.startsWith(it + File.separator) } }) || (appFolderUsable() && isInAppFolder(f))
        }
        else -> false
    }

    private fun check(uri: Uri): Uri {
        if (!allowed(uri)) throw SecurityException("No access to $uri")
        return uri
    }

    private fun open(uri: Uri): InputStream =
        if (uri.scheme == "file") FileInputStream(File(uri.path!!)) else resolver.openInputStream(uri) ?: throw IllegalStateException("Can't read $uri")

    fun serve(u: String?): WebResourceResponse {
        val uri = u?.let(Uri::parse)
        val stream = runCatching { if (uri == null || !allowed(uri)) null else open(uri) }.getOrNull()
            ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        val mime = if (uri!!.toString().endsWith(".epub", true)) EPUB else resolver.getType(uri) ?: AppAssets.mimeOf(uri.lastPathSegment ?: "")
        return WebResourceResponse(mime, null, stream).apply { responseHeaders = AppAssets.ISOLATION }
    }

    /** Replaces a document's bytes with `source` (the reader saved form fields or annotations). */
    fun write(uri: Uri, source: File) {
        check(uri)
        if (uri.scheme == "file") return replace(File(uri.path!!)) { out -> source.inputStream().use { it.copyTo(out) } }
        // Written beside it first: a provider that can't take it all (storage full) fails there, the document still whole.
        val trial = besides(uri)
        try {
            if (trial != null) resolver.openOutputStream(trial, "w")!!.use { out -> source.inputStream().use { it.copyTo(out) } }
            resolver.openOutputStream(uri, "wt")!!.use { out -> source.inputStream().use { it.copyTo(out) } }
        } finally {
            if (trial != null) runCatching { DocumentsContract.deleteDocument(resolver, trial) }
        }
    }

    /** A new hidden document in the same folder as `uri`, where its provider can say which folder that is. */
    private fun besides(uri: Uri): Uri? = runCatching {
        val tree = grantedTree(uri) ?: return null
        val ids = DocumentsContract.findDocumentPath(resolver, uri)?.path ?: return null
        if (ids.size < 2) return null
        val name = resolver.query(uri, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } ?: "document"
        DocumentsContract.createDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, ids[ids.size - 2]), "application/octet-stream", ".$name.tessel-tmp")
    }.getOrNull()

    /**
     * Writes a file whole or not at all: into a hidden temporary file beside it, then renamed over it, so a sync
     * tool (Syncthing) never picks up a half-written file. (Picked folders reached through the system's document
     * providers can't rename over a file; there the bytes are staged first and copied in one go.)
     */
    private fun replace(target: File, write: (java.io.OutputStream) -> Unit) {
        val temp = File(target.parentFile, ".${target.name}.tessel-tmp")
        try {
            FileOutputStream(temp).use { out ->
                write(out)
                out.fd.sync()
            }
            if (!temp.renameTo(target)) throw IllegalStateException("Can't replace ${target.name}")
        } finally {
            temp.delete()
        }
    }

    /** The names of the files (not folders) in the folder at `path` below a place; none when it doesn't exist. */
    fun names(root: String, path: List<String>): JSONArray {
        val out = JSONArray()
        val id = dirAt(root, path, false) ?: return out
        if (root == "device" || root == "app") {
            File(id).listFiles()?.filter { it.isFile }?.forEach { out.put(it.name) }
            return out
        }
        val tree = tree(root)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, id)
        resolver.query(children, arrayOf(Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE), null, null, null)?.use { c ->
            while (c.moveToNext()) if (c.getString(1) != Document.MIME_TYPE_DIR) out.put(c.getString(0))
        }
        return out
    }

    /**
     * The folder at `path` below a place, made where missing when `create`: its ID as list() and create() take it
     * (a document ID in a picked folder, a path on the device), or null.
     */
    fun dirAt(root: String, path: List<String>, create: Boolean): String? {
        require(path.none { it.isEmpty() || it == ".." || it.contains('/') }) { "Bad path" }
        if (root == "device" || root == "app") {
            val rel = path.joinToString(File.separator)
            val base = if (root == "app") inAppFolder(appDir.absolutePath) else onDevice(storageRoot.absolutePath)
            val f = File(base, rel)
            if (!f.isDirectory && !(create && f.mkdirs())) return null
            return (if (root == "app") inAppFolder(f.path) else onDevice(f.path)).absolutePath
        }
        if (root == "all") throw IllegalArgumentException("Not a folder")
        val tree = tree(root)
        var id = DocumentsContract.getTreeDocumentId(tree)
        for (name in path) {
            id = childNamed(tree, id, name) ?: run {
                if (!create) return null
                val made = DocumentsContract.createDocument(resolver, DocumentsContract.buildDocumentUriUsingTree(tree, id), Document.MIME_TYPE_DIR, name)
                    ?: throw IllegalStateException("Can't create $name")
                DocumentsContract.getDocumentId(made)
            }
        }
        return id
    }

    /** Content URI another app can open (share): document URIs as they are, files through the FileProvider. */
    fun shareable(uri: Uri): Uri {
        check(uri)
        return if (uri.scheme == "file") androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.files", File(uri.path!!)) else uri
    }

    // ---------- file operations ----------

    /** A folder to create things in: a granted tree (or a folder inside it), or a path on the device. */
    private sealed interface Place
    private data class TreePlace(val dir: Uri) : Place
    private data class PathPlace(val dir: File) : Place

    private fun place(root: String, dir: String?): Place = when (root) {
        "all" -> throw IllegalArgumentException("Not a folder")
        "device" -> PathPlace(onDevice(dir ?: storageRoot.absolutePath))
        "app" -> PathPlace(inAppFolder(dir ?: appDir.absolutePath))
        else -> TreePlace(treeDir(root, dir))
    }

    /** "name", or "name (2)", "name (3)"… if taken. */
    private fun freeName(dir: File, name: String): File {
        var f = File(dir, name)
        val stem = name.substringBeforeLast('.', name)
        val ext = if (name.contains('.') && !File(dir, name).isDirectory) "." + name.substringAfterLast('.') else ""
        var n = 2
        while (f.exists()) f = File(dir, "$stem ($n)$ext").also { n++ }
        return f
    }

    /** A name for one item in a folder: never a path (or the folder itself, or its parent). */
    private fun checkName(name: String) {
        require(name.isNotEmpty() && name != "." && name != ".." && name.none { it == '/' || it == '\\' || it == '\u0000' }) { "Bad name" }
    }

    fun mkdir(root: String, dir: String?, name: String): String {
        checkName(name)
        return when (val at = place(root, dir)) {
            is TreePlace -> DocumentsContract.createDocument(resolver, at.dir, Document.MIME_TYPE_DIR, name)?.toString() ?: throw IllegalStateException("Can't create $name")
            is PathPlace -> freeName(at.dir, name).also { if (!it.mkdir()) throw IllegalStateException("Can't create $name") }.let { Uri.fromFile(it).toString() }
        }
    }

    /** A new file with these contents; a taken name gets " (2)" or the provider's own suffix. Returns its URI and name. */
    fun create(root: String, dir: String?, name: String, mime: String, source: File): JSONObject {
        checkName(name)
        val uri = when (val at = place(root, dir)) {
            is TreePlace -> DocumentsContract.createDocument(resolver, at.dir, mime, name) ?: throw IllegalStateException("Can't create $name")
            is PathPlace -> Uri.fromFile(freeName(at.dir, name).also { if (!it.createNewFile()) throw IllegalStateException("Can't create $name") })
        }
        // Not left behind empty or half written (a sync tool would spread it).
        runCatching { write(uri, source) }.onFailure { e ->
            runCatching { delete(uri) }
            throw e
        }
        val created = if (uri.scheme == "file") File(uri.path!!).name
        else resolver.query(uri, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null } ?: name
        return JSONObject().put("uri", uri.toString()).put("name", created)
    }

    // ---------- small text files (the archive's .tessel/ settings) ----------

    /** A text file at `path` below a place (picked folder, internal storage or the app folder); null if there is none. */
    fun readText(root: String, path: List<String>): String? {
        val uri = fileAt(root, path, create = false) ?: return null
        return if (uri.scheme == "file") File(uri.path!!).readText() else resolver.openInputStream(uri)?.use { it.reader().readText() }
    }

    /** Writes a text file at `path` below a place, making the folders on the way and replacing what was there. */
    fun writeText(root: String, path: List<String>, text: String) {
        val uri = fileAt(root, path, create = true) ?: throw IllegalStateException("Can't write ${path.joinToString("/")}")
        if (uri.scheme == "file") replace(File(uri.path!!)) { it.write(text.toByteArray()) }
        else resolver.openOutputStream(uri, "wt")!!.use { it.write(text.toByteArray()) }
    }

    /** Removes a text file at `path` below a place (a sync tool's conflict copy of one); nothing if there is none. */
    fun removeText(root: String, path: List<String>) {
        delete(fileAt(root, path, create = false) ?: return)
    }

    private fun fileAt(root: String, path: List<String>, create: Boolean): Uri? {
        require(path.isNotEmpty() && path.none { it.isEmpty() || it == ".." || it.contains('/') }) { "Bad path" }
        if (root == "device" || root == "app") {
            val rel = path.joinToString(File.separator)
            val f = if (root == "app") inAppFolder(File(appDir, rel).path) else onDevice(File(storageRoot, rel).path)
            if (!f.exists()) {
                if (!create) return null
                f.parentFile?.mkdirs()
                if (!f.createNewFile()) throw IllegalStateException("Can't create ${f.name}")
            }
            return Uri.fromFile(f)
        }
        if (root == "all") throw IllegalArgumentException("Not a folder")
        val tree = tree(root)
        var parent = DocumentsContract.getTreeDocumentId(tree)
        for ((i, name) in path.withIndex()) {
            val last = i == path.size - 1
            val id = childNamed(tree, parent, name) ?: run {
                if (!create) return null
                val made = DocumentsContract.createDocument(
                    resolver,
                    DocumentsContract.buildDocumentUriUsingTree(tree, parent),
                    if (last) "application/json" else Document.MIME_TYPE_DIR,
                    name,
                ) ?: throw IllegalStateException("Can't create $name")
                DocumentsContract.getDocumentId(made)
            }
            if (last) return DocumentsContract.buildDocumentUriUsingTree(tree, id)
            parent = id
        }
        return null
    }

    private fun childNamed(tree: Uri, parent: String, name: String): String? {
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
        resolver.query(children, arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
            while (c.moveToNext()) if (c.getString(1) == name) return c.getString(0)
        }
        return null
    }

    /** Returns the renamed item's URI (providers may give it a new one). */
    fun rename(uri: Uri, name: String): String {
        checkName(name)
        check(uri)
        if (uri.scheme == "file") {
            val f = File(uri.path!!)
            val to = File(f.parentFile, name)
            if (to.exists()) throw IllegalStateException("exists:$name")
            if (!f.renameTo(to)) throw IllegalStateException("Can't rename ${f.name}")
            return Uri.fromFile(to).toString()
        }
        return (DocumentsContract.renameDocument(resolver, uri, name) ?: uri).toString()
    }

    fun delete(uri: Uri) {
        check(uri)
        if (uri.scheme == "file") {
            if (!File(uri.path!!).deleteRecursively()) throw IllegalStateException("Can't delete ${uri.lastPathSegment}")
        } else if (!DocumentsContract.deleteDocument(resolver, uri)) throw IllegalStateException("Can't delete $uri")
    }

    /**
     * Copies (or moves) items into a folder; returns where each one went, or why it didn't. Within one provider a
     * move is a move; across places it is a copy followed by deleting the original.
     */
    fun transfer(items: List<Triple<Uri, String, Boolean>>, srcParent: Uri?, root: String, dir: String?, move: Boolean): JSONArray {
        val at = place(root, dir)
        val out = JSONArray()
        for ((uri, name, isDir) in items) {
            runCatching {
                check(uri)
                checkName(name)
                // Into itself, a copy would copy its own copy again and again (until the storage is full).
                if (isDir && within(at, uri)) throw IllegalArgumentException("inside-itself")
                when {
                    move && uri.scheme == "file" && at is PathPlace -> {
                        val target = freeName(at.dir, name)
                        if (!File(uri.path!!).renameTo(target)) throw IllegalStateException("Can't move $name")
                        Uri.fromFile(target)
                    }
                    move && uri.scheme == "content" && at is TreePlace && srcParent != null && uri.authority == at.dir.authority ->
                        runCatching { DocumentsContract.moveDocument(resolver, uri, srcParent, at.dir) }.getOrNull() ?: copyThenDelete(uri, name, isDir, at)
                    move -> copyThenDelete(uri, name, isDir, at)
                    else -> copyInto(uri, name, isDir, at)
                }
            }.onSuccess { to -> out.put(JSONObject().put("from", uri.toString()).put("to", to.toString())) }
                .onFailure { out.put(JSONObject().put("from", uri.toString()).put("error", it.message ?: it.javaClass.simpleName)) }
        }
        return out
    }

    /** Where a folder is on the device: file URIs, and internal storage's documents (their IDs are paths there). */
    private fun pathOf(uri: Uri): File? = when (uri.scheme) {
        "file" -> uri.path?.let(::File)
        "content" -> if (uri.authority != "com.android.externalstorage.documents") null
        else runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()?.takeIf { it.startsWith("primary:") }?.let { File(storageRoot, it.removePrefix("primary:")) }
        else -> null
    }

    /** Whether the place `at` is the folder `dir` or inside it. */
    private fun within(at: Place, dir: Uri): Boolean {
        val target = when (at) {
            is PathPlace -> Uri.fromFile(at.dir)
            is TreePlace -> at.dir
        }
        val a = pathOf(target)?.canonicalPath
        val d = pathOf(dir)?.canonicalPath
        if (a != null && d != null) return a == d || a.startsWith(d + File.separator)
        if (target.scheme != "content" || dir.scheme != "content" || target.authority != dir.authority) return false
        return runCatching {
            val ta = DocumentsContract.getDocumentId(target)
            val td = DocumentsContract.getDocumentId(dir)
            ta == td || ta.startsWith("$td/") || DocumentsContract.isChildDocument(resolver, dir, target)
        }.getOrDefault(false)
    }

    private fun copyThenDelete(uri: Uri, name: String, isDir: Boolean, at: Place): Uri = copyInto(uri, name, isDir, at).also { delete(uri) }

    private fun copyInto(uri: Uri, name: String, isDir: Boolean, at: Place): Uri {
        if (!isDir) {
            return when (at) {
                is PathPlace -> freeName(at.dir, name).also { f -> open(uri).use { input -> FileOutputStream(f).use { input.copyTo(it) } } }.let(Uri::fromFile)
                is TreePlace -> (DocumentsContract.createDocument(resolver, at.dir, mimeOf(name), name) ?: throw IllegalStateException("Can't create $name")).also { target ->
                    open(uri).use { input -> resolver.openOutputStream(target, "w")!!.use { input.copyTo(it) } }
                }
            }
        }
        // What the folder holds before its copy is made (were the copy inside it, it would be among them).
        val kids = children(uri)
        val made = Uri.parse(
            when (at) {
                is PathPlace -> Uri.fromFile(freeName(at.dir, name).also { it.mkdir() }).toString()
                is TreePlace -> DocumentsContract.createDocument(resolver, at.dir, Document.MIME_TYPE_DIR, name)?.toString() ?: throw IllegalStateException("Can't create $name")
            },
        )
        val inner: Place = if (made.scheme == "file") PathPlace(File(made.path!!)) else TreePlace(made)
        for ((child, childName, childDir) in kids) copyInto(child, childName, childDir, inner)
        return made
    }

    /** Everything in a folder (not only documents): copying a folder copies all of it. */
    private fun children(dir: Uri): List<Triple<Uri, String, Boolean>> {
        if (dir.scheme == "file") return File(dir.path!!).listFiles().orEmpty().map { Triple(Uri.fromFile(it), it.name, it.isDirectory) }
        val tree = grantedTree(dir) ?: throw SecurityException("No access to $dir")
        val kids = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(dir))
        val out = ArrayList<Triple<Uri, String, Boolean>>()
        resolver.query(kids, arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE), null, null, null)?.use { c ->
            while (c.moveToNext()) out += Triple(DocumentsContract.buildDocumentUriUsingTree(tree, c.getString(0)), c.getString(1), c.getString(2) == Document.MIME_TYPE_DIR)
        }
        return out
    }

    /** The folder an item is in, for moves within a provider. */
    fun parentOf(root: String, dir: String?): Uri? = if (root == "all" || root == "device" || root == "app") null else treeDir(root, dir)

    companion object {
        const val PDF = "application/pdf"
        const val EPUB = "application/epub+zip"
    }
}
