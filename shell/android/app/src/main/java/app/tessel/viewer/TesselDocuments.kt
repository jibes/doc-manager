package app.tessel.viewer

import android.content.Context
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Point
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.CancellationSignal
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileNotFoundException

/**
 * The Tessel folder in the system's file picker (and in file managers that show document providers): a "Tessel"
 * entry beside Downloads and the drives, listing the folder's PDFs and its Inbox with their first page as the
 * picture, which Android's own storage doesn't draw for PDFs. Read-only: picking a file hands out the file itself,
 * nothing is copied; changes are made in Tessel.
 *
 * Which folder: the one Tessel uses (Settings → Tessel folder), told by the app (`tesselRoot`), else Documents/Tessel.
 * Document IDs: "a/<path below Documents/Tessel>" for that folder, "t/<document ID in the picked tree>" for a picked one.
 */
class TesselDocuments : DocumentsProvider() {
    private val ctx: Context get() = context!!

    override fun onCreate(): Boolean = true

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val c = MatrixCursor(projection ?: ROOT_COLUMNS)
        val home = home() ?: return c
        c.newRow().apply {
            add(Root.COLUMN_ROOT_ID, ROOT)
            add(Root.COLUMN_DOCUMENT_ID, home)
            add(Root.COLUMN_TITLE, ctx.getString(R.string.app_name))
            add(Root.COLUMN_SUMMARY, summary())
            add(Root.COLUMN_FLAGS, Root.FLAG_LOCAL_ONLY or Root.FLAG_SUPPORTS_IS_CHILD)
            add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
            add(Root.COLUMN_MIME_TYPES, "${Document.MIME_TYPE_DIR}\n${Folders.PDF}")
        }
        // With All files access and the setting on: the whole of internal storage, every file, with previews.
        if (deviceShown()) c.newRow().apply {
            add(Root.COLUMN_ROOT_ID, DEVICE_ROOT)
            add(Root.COLUMN_DOCUMENT_ID, "d/")
            add(Root.COLUMN_TITLE, ctx.getString(R.string.picker_device))
            add(Root.COLUMN_SUMMARY, ctx.getString(R.string.picker_device_summary))
            add(Root.COLUMN_FLAGS, Root.FLAG_LOCAL_ONLY or Root.FLAG_SUPPORTS_IS_CHILD)
            add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
        }
        return c
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
        val c = MatrixCursor(projection ?: DOC_COLUMNS)
        if (documentId == "d/") {
            row(c, documentId, ctx.getString(R.string.picker_device), true, 0, 0)
            return c
        }
        if (documentId == home()) {
            row(c, documentId, ctx.getString(R.string.app_name), true, 0, 0)
            return c
        }
        when {
            documentId.startsWith("a/") -> appFile(documentId).let { f ->
                if (!f.exists()) throw FileNotFoundException(documentId)
                row(c, documentId, f.name, f.isDirectory, if (f.isDirectory) 0 else f.length(), f.lastModified())
            }
            documentId.startsWith("d/") -> deviceFile(documentId).let { f ->
                if (!f.exists()) throw FileNotFoundException(documentId)
                anyRow(c, documentId, f)
            }
            documentId.startsWith("t/") -> {
                val tree = tree() ?: throw FileNotFoundException(documentId)
                val uri = DocumentsContract.buildDocumentUriUsingTree(tree, documentId.removePrefix("t/"))
                ctx.contentResolver.query(uri, SOURCE_COLUMNS, null, null, null)?.use { s ->
                    if (s.moveToFirst()) fromSource(c, s) else throw FileNotFoundException(documentId)
                } ?: throw FileNotFoundException(documentId)
            }
            else -> throw FileNotFoundException(documentId)
        }
        return c
    }

    override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor {
        val c = MatrixCursor(projection ?: DOC_COLUMNS)
        when {
            parentDocumentId.startsWith("a/") -> {
                val dir = appFile(parentDocumentId)
                for (f in dir.listFiles().orEmpty().sortedBy { it.name.lowercase() }) {
                    if (f.name.startsWith('.') || (!f.isDirectory && !isPdf(f.name, null))) continue
                    row(c, "a/" + f.relativeTo(appDir()).path, f.name, f.isDirectory, if (f.isDirectory) 0 else f.length(), f.lastModified())
                }
            }
            parentDocumentId.startsWith("d/") -> {
                val dir = deviceFile(parentDocumentId)
                val base = storage().canonicalFile
                // Folders first, then files, each by name; hidden ones and app-private data left out.
                val list = dir.listFiles().orEmpty().filter { !it.name.startsWith('.') && !(dir.canonicalFile == base && it.name == "Android") }
                for (f in list.sortedWith(compareBy({ !it.isDirectory }, { it.name.lowercase() }))) anyRow(c, "d/" + f.relativeTo(base).path, f)
            }
            parentDocumentId.startsWith("t/") -> {
                val tree = tree() ?: return c
                val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentDocumentId.removePrefix("t/"))
                ctx.contentResolver.query(children, SOURCE_COLUMNS, null, null, null)?.use { s ->
                    while (s.moveToNext()) fromSource(c, s)
                }
            }
        }
        // The picker shows changes as soon as the folder is read again.
        c.setNotificationUri(ctx.contentResolver, DocumentsContract.buildChildDocumentsUri(authority(ctx), parentDocumentId))
        return c
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean = when {
        parentDocumentId.startsWith("a/") && documentId.startsWith("a/") -> {
            val parent = appFile(parentDocumentId).canonicalPath
            appFile(documentId).canonicalPath.startsWith(parent + File.separator)
        }
        parentDocumentId.startsWith("d/") && documentId.startsWith("d/") -> {
            val parent = deviceFile(parentDocumentId).canonicalPath
            deviceFile(documentId).canonicalPath.startsWith(parent + File.separator)
        }
        parentDocumentId.startsWith("t/") && documentId.startsWith("t/") -> {
            val tree = tree()
            tree != null && runCatching {
                DocumentsContract.isChildDocument(
                    ctx.contentResolver,
                    DocumentsContract.buildDocumentUriUsingTree(tree, parentDocumentId.removePrefix("t/")),
                    DocumentsContract.buildDocumentUriUsingTree(tree, documentId.removePrefix("t/")),
                )
            }.getOrDefault(documentId.removePrefix("t/").startsWith(parentDocumentId.removePrefix("t/") + "/"))
        }
        else -> false
    }

    override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
        // Read-only: a file is changed in Tessel (which keeps its text and details right), not through the picker.
        if (mode != "r") throw SecurityException("Tessel's folder is read-only here")
        return when {
            documentId.startsWith("a/") -> ParcelFileDescriptor.open(appFile(documentId), ParcelFileDescriptor.MODE_READ_ONLY)
            documentId.startsWith("d/") -> ParcelFileDescriptor.open(deviceFile(documentId), ParcelFileDescriptor.MODE_READ_ONLY)
            documentId.startsWith("t/") -> {
                val tree = tree() ?: throw FileNotFoundException(documentId)
                ctx.contentResolver.openFileDescriptor(DocumentsContract.buildDocumentUriUsingTree(tree, documentId.removePrefix("t/")), "r", signal)
                    ?: throw FileNotFoundException(documentId)
            }
            else -> throw FileNotFoundException(documentId)
        }
    }

    /** The first page, drawn once per file version and kept in the cache (Android may clear it). */
    override fun openDocumentThumbnail(documentId: String, sizeHint: Point, signal: CancellationSignal?): AssetFileDescriptor {
        val (stamp, open) = when {
            documentId.startsWith("a/") || documentId.startsWith("d/") -> (if (documentId.startsWith("a/")) appFile(documentId) else deviceFile(documentId)).let { f ->
                "${f.length()}-${f.lastModified()}" to { ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY) }
            }
            else -> {
                val tree = tree() ?: throw FileNotFoundException(documentId)
                val uri = DocumentsContract.buildDocumentUriUsingTree(tree, documentId.removePrefix("t/"))
                val stamp = ctx.contentResolver.query(uri, arrayOf(Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED), null, null, null)?.use { s ->
                    if (s.moveToFirst()) "${s.getLong(0)}-${s.getLong(1)}" else null
                } ?: throw FileNotFoundException(documentId)
                stamp to { ctx.contentResolver.openFileDescriptor(uri, "r", signal) ?: throw FileNotFoundException(documentId) }
            }
        }
        val edge = maxOf(sizeHint.x, sizeHint.y, 96).coerceAtMost(MAX_EDGE)
        val dir = File(ctx.cacheDir, "thumbs").apply { mkdirs() }
        val file = File(dir, "${documentId.hashCode().toUInt()}-$stamp-$edge.jpg")
        if (!file.exists()) {
            val tmp = File(dir, "${file.name}.tmp")
            if (isImage(documentId)) image(open, edge, tmp) else open().use { pfd ->
                PdfRenderer(pfd).use { pdf ->
                    if (pdf.pageCount == 0) throw FileNotFoundException(documentId)
                    pdf.openPage(0).use { page ->
                        val scale = edge.toFloat() / maxOf(page.width, page.height)
                        val bitmap = Bitmap.createBitmap(maxOf(1, (page.width * scale).toInt()), maxOf(1, (page.height * scale).toInt()), Bitmap.Config.ARGB_8888)
                        // Pages without a background of their own are white on paper.
                        bitmap.eraseColor(Color.WHITE)
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        tmp.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }
                        bitmap.recycle()
                    }
                }
            }
            tmp.renameTo(file)
            // Older pictures of the same file go.
            val prefix = "${documentId.hashCode().toUInt()}-"
            dir.listFiles()?.filter { it.name.startsWith(prefix) && it != file }?.forEach { it.delete() }
        }
        return AssetFileDescriptor(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY), 0, AssetFileDescriptor.UNKNOWN_LENGTH)
    }

    /** A photo or picture, scaled down while it is read (a 50-megapixel photo never sits whole in memory). */
    private fun image(open: () -> ParcelFileDescriptor, edge: Int, out: File) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        open().use { BitmapFactory.decodeFileDescriptor(it.fileDescriptor, null, bounds) }
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= edge) sample *= 2
        val bitmap = open().use { BitmapFactory.decodeFileDescriptor(it.fileDescriptor, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
            ?: throw FileNotFoundException("Not an image")
        out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }
        bitmap.recycle()
    }

    // ---------- internal storage (All files access) ----------

    private fun storage(): File = Environment.getExternalStorageDirectory()

    private fun deviceShown(): Boolean = showDevice(ctx) && Folders(ctx).allFilesGranted()

    /** A path on internal storage, never outside it, and only while All files access is granted. */
    private fun deviceFile(id: String): File {
        if (!deviceShown()) throw FileNotFoundException(id)
        val base = storage().canonicalFile
        val f = File(base, id.removePrefix("d/")).canonicalFile
        if (f != base && !f.path.startsWith(base.path + File.separator)) throw FileNotFoundException(id)
        return f
    }

    private fun anyRow(c: MatrixCursor, id: String, f: File) {
        val mime = if (f.isDirectory) Document.MIME_TYPE_DIR else mimeOf(f.name)
        c.newRow().apply {
            add(Document.COLUMN_DOCUMENT_ID, id)
            add(Document.COLUMN_DISPLAY_NAME, f.name)
            add(Document.COLUMN_MIME_TYPE, mime)
            add(Document.COLUMN_SIZE, if (f.isDirectory) 0 else f.length())
            add(Document.COLUMN_LAST_MODIFIED, f.lastModified())
            add(Document.COLUMN_FLAGS, if (f.isDirectory) Document.FLAG_DIR_PREFERS_GRID else if (mime == Folders.PDF || mime.startsWith("image/")) Document.FLAG_SUPPORTS_THUMBNAIL else 0)
        }
    }

    private fun mimeOf(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    private fun isImage(id: String) = mimeOf(id).startsWith("image/")

    // ---------- the folder ----------

    private fun appDir(): File = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "Tessel")

    /** A path below Documents/Tessel, never outside it. */
    private fun appFile(id: String): File {
        val base = appDir().canonicalFile
        val f = File(base, id.removePrefix("a/")).canonicalFile
        if (f != base && !f.path.startsWith(base.path + File.separator)) throw FileNotFoundException(id)
        return f
    }

    /** The picked folder Tessel uses, while access to it is still granted. */
    private fun tree(): Uri? {
        val root = chosen(ctx) ?: return null
        val uri = Uri.parse(root)
        return ctx.contentResolver.persistedUriPermissions.firstOrNull {
            it.isReadPermission && it.uri.authority == uri.authority &&
                runCatching { DocumentsContract.getTreeDocumentId(it.uri) == DocumentsContract.getTreeDocumentId(uri) }.getOrDefault(false)
        }?.uri
    }

    /** The folder's own document ID; null when it can't be shown (a picked folder whose access is gone). */
    private fun home(): String? = when {
        chosen(ctx) == null -> "a/"
        else -> tree()?.let { "t/" + DocumentsContract.getTreeDocumentId(it) }
    }

    private fun summary(): String = when (val t = tree()) {
        null -> "Documents/Tessel"
        else -> runCatching { Folders(ctx).treeName(t) }.getOrDefault("")
    }

    private fun fromSource(c: MatrixCursor, s: Cursor) {
        val id = s.getString(0) ?: return
        val name = s.getString(1) ?: return
        if (name.startsWith('.')) return
        val mime = s.getString(2)
        val isDir = mime == Document.MIME_TYPE_DIR
        if (!isDir && !isPdf(name, mime)) return
        row(c, "t/$id", name, isDir, if (s.isNull(3)) 0 else s.getLong(3), if (s.isNull(4)) 0 else s.getLong(4))
    }

    private fun row(c: MatrixCursor, id: String, name: String, isDir: Boolean, size: Long, modified: Long) {
        c.newRow().apply {
            add(Document.COLUMN_DOCUMENT_ID, id)
            add(Document.COLUMN_DISPLAY_NAME, name)
            add(Document.COLUMN_MIME_TYPE, if (isDir) Document.MIME_TYPE_DIR else Folders.PDF)
            add(Document.COLUMN_SIZE, size)
            add(Document.COLUMN_LAST_MODIFIED, modified)
            add(Document.COLUMN_FLAGS, if (isDir) Document.FLAG_DIR_PREFERS_GRID else Document.FLAG_SUPPORTS_THUMBNAIL)
        }
    }

    private fun isPdf(name: String, mime: String?) = mime == Folders.PDF || name.endsWith(".pdf", true)

    companion object {
        private const val ROOT = "tessel"
        private const val DEVICE_ROOT = "device"
        private const val DEVICE_KEY = "device"
        private const val MAX_EDGE = 768
        private const val PREFS = "documents"
        private const val KEY = "root"
        private val ROOT_COLUMNS = arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_SUMMARY, Root.COLUMN_FLAGS, Root.COLUMN_ICON, Root.COLUMN_MIME_TYPES)
        private val DOC_COLUMNS = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS)
        private val SOURCE_COLUMNS = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED)

        fun authority(ctx: Context) = "${ctx.packageName}.documents"

        /** The picked folder Tessel uses (a tree URI), or null for Documents/Tessel. */
        private fun chosen(ctx: Context): String? = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)?.takeIf { it != "app" }

        private fun showDevice(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(DEVICE_KEY, false)

        /** Settings → Show all files in the file picker (with All files access): the second entry, on or off. */
        fun device(ctx: Context, on: Boolean) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(DEVICE_KEY, on).apply()
            ctx.contentResolver.notifyChange(DocumentsContract.buildRootsUri(authority(ctx)), null)
        }

        /** Tessel told which folder it uses: the picker shows that one from now on. */
        fun choose(ctx: Context, root: String) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, root).apply()
            ctx.contentResolver.notifyChange(DocumentsContract.buildRootsUri(authority(ctx)), null)
        }

    }
}
