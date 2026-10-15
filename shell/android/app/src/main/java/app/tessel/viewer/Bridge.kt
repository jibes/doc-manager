package app.tessel.viewer

import android.content.Intent
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Environment
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebResourceResponse
import androidx.core.content.FileProvider
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.dnsoverhttps.DnsOverHttps
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * window.TesselShell: what the web app can't do inside a WebView on its own.
 * - Files opened or shared from other apps are served at /__shell/file/<id> and listed by pending().
 * - Outgoing files (share, save, print) arrive in base64 chunks: begin → append… → finish.
 * - theme() matches the system bars to the app's palette.
 * - request(id, method, args) runs slower or interactive work (folders, permissions, writing back) and
 *   answers with a "tessel-shell-reply" event carrying {id, ok, value | error}.
 * JavaScript calls arrive on a background thread; anything touching UI hops to the main thread.
 */
class Bridge(private val activity: MainActivity) {
    private data class Incoming(val uri: Uri, val name: String, val size: Long, val type: String)

    private val incoming = LinkedHashMap<String, Incoming>()
    private val unclaimed = ArrayList<String>()
    private val outgoing = HashMap<String, Pair<File, String>>()
    val folders = Folders(activity)
    private val worker = Executors.newSingleThreadExecutor()
    /** Network requests (AI reading) take long; they don't hold up folder work. */
    private val network = Executors.newCachedThreadPool()
    /** Copies for printing: never on the main thread (a big PDF would freeze the app). */
    private val io = Executors.newSingleThreadExecutor()
    /** Requests running (by the web app's id), to stop on cancel; ids cancelled before they started. */
    private val calls = HashMap<String, okhttp3.Call>()
    private val cancelled = HashSet<String>()

    /** Registers files from a VIEW/SEND intent (off the main thread); `done` gets how many were usable, on the main thread. */
    fun accept(uris: List<Uri>, done: (Int) -> Unit) {
        worker.execute {
            val n = runCatching { accept(uris) }.getOrDefault(0)
            activity.runOnUiThread { done(n) }
        }
    }

    /**
     * A file:// another app sends is read with Tessel's own rights: only from shared storage (never Tessel's private
     * files, which a hostile app could ask it to copy out).
     */
    private fun shared(uri: Uri): Boolean {
        if (uri.scheme != "file") return uri.scheme == "content"
        val path = runCatching { File(uri.path ?: return false).canonicalPath }.getOrNull() ?: return false
        val storage = Environment.getExternalStorageDirectory().canonicalPath
        return path.startsWith(storage + File.separator) && !path.startsWith("$storage/Android/data/")
    }

    private fun accept(uris: List<Uri>): Int {
        var n = 0
        for (uri in uris) {
            if (!shared(uri)) continue
            var name = uri.lastPathSegment?.substringAfterLast('/') ?: "document"
            var size = -1L
            runCatching {
                activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        c.getString(0)?.let { name = it }
                        if (!c.isNull(1)) size = c.getLong(1)
                    }
                }
            }
            val type = activity.contentResolver.getType(uri) ?: AppAssets.mimeOf(name)
            // Name the file by its type when a provider gives none, so the web app recognises it.
            if (!name.contains('.')) name += if (type == "application/epub+zip") ".epub" else ".pdf"
            val id = UUID.randomUUID().toString()
            synchronized(this) {
                incoming[id] = Incoming(uri, name, size, type)
                unclaimed += id
                // The app keeps what it opened: older files aren't fetched again, so only the latest few are known.
                while (incoming.size > KEEP_INCOMING) {
                    val eldest = incoming.keys.first()
                    if (eldest in unclaimed) break
                    incoming.remove(eldest)
                }
            }
            n++
        }
        return n
    }

    /** Streams an incoming file to the web app (fetch from /__shell/file/<id>). */
    fun serve(path: String): WebResourceResponse? {
        val id = path.removePrefix("/__shell/file/")
        val file = synchronized(this) { incoming[id] } ?: return null
        val stream = runCatching { activity.contentResolver.openInputStream(file.uri) }.getOrNull()
            ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        return WebResourceResponse(file.type, null, stream).apply { responseHeaders = AppAssets.ISOLATION }
    }

    @JavascriptInterface
    fun pending(): String = synchronized(this) {
        val list = JSONArray()
        for (id in unclaimed) {
            val f = incoming[id] ?: continue
            list.put(JSONObject().put("url", "${AppAssets.ORIGIN}/__shell/file/$id").put("name", f.name).put("size", f.size).put("type", f.type))
        }
        unclaimed.clear()
        list.toString()
    }

    @JavascriptInterface
    fun begin(name: String, mime: String): String {
        val dir = File(activity.cacheDir, "outgoing").apply { mkdirs() }
        val safe = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "document" }
        val token = UUID.randomUUID().toString()
        val file = File(File(dir, token).apply { mkdirs() }, safe)
        file.delete()
        synchronized(this) { outgoing[token] = file to mime }
        return token
    }

    @JavascriptInterface
    fun append(token: String, base64: String) {
        val (file, _) = synchronized(this) { outgoing[token] } ?: return
        FileOutputStream(file, true).use { it.write(Base64.decode(base64, Base64.DEFAULT)) }
    }

    /** action: "share" | "save" | "print". */
    @JavascriptInterface
    fun finish(token: String, action: String) {
        val (file, mime) = synchronized(this) { outgoing.remove(token) } ?: return
        activity.runOnUiThread {
            when (action) {
                "share" -> share(file, mime)
                "save" -> activity.saveAs(file, mime)
                "print" -> print(file)
            }
        }
    }

    @JavascriptInterface
    fun request(id: String, method: String, args: String) {
        val a = runCatching { JSONObject(args) }.getOrElse { JSONObject() }
        val done = { value: Any? -> activity.reply(id, true, value) }
        val fail = { e: Throwable -> activity.reply(id, false, e.message ?: e.javaClass.simpleName) }
        when (method) {
            // Interactive: answered when the user comes back from the system screen.
            "pickFolder" -> activity.runOnUiThread { activity.pickFolder { tree -> done(tree?.let { JSONObject().put("uri", it.toString()).put("name", folders.treeName(it)) }) } }
            "requestAllFiles" -> activity.runOnUiThread { activity.requestAllFiles { done(it) } }
            "http" -> network.execute { runCatching { http(id, a) }.onSuccess(done).onFailure(fail) }
            // Types are asked for here (one call per file), the share sheet opened on the main thread.
            "share" -> worker.execute {
                runCatching {
                    val list = a.getJSONArray("uris")
                    if (list.length() > MAX_SHARE) throw IllegalArgumentException("too-many:$MAX_SHARE")
                    val uris = ArrayList((0 until list.length()).map { folders.shareable(Uri.parse(list.getString(it))) })
                    uris to shareType(uris)
                }.onSuccess { (uris, type) ->
                    activity.runOnUiThread { runCatching { shareUris(uris, type) }.onSuccess { done(null) }.onFailure(fail) }
                }.onFailure(fail)
            }
            else -> worker.execute {
                runCatching<Any?> {
                    when (method) {
                        "folders" -> folders.folders()
                        "forgetFolder" -> folders.forget(Uri.parse(a.getString("uri"))).let { null }
                        "list" -> folders.list(a.getString("root"), a.optString("dir").ifEmpty { null })
                        "access" -> JSONObject().put("allFiles", folders.allFilesGranted()).put("app", folders.appFolderUsable())
                        "names" -> a.getJSONArray("path").let { p -> folders.names(a.getString("root"), (0 until p.length()).map { p.getString(it) }) }
                        "dirAt" -> a.getJSONArray("path").let { p -> folders.dirAt(a.getString("root"), (0 until p.length()).map { p.getString(it) }, a.optBoolean("create")) ?: JSONObject.NULL }
                        "readText" -> a.getJSONArray("path").let { p -> folders.readText(a.getString("root"), (0 until p.length()).map { p.getString(it) }) }
                        "writeText" -> a.getJSONArray("path").let { p -> folders.writeText(a.getString("root"), (0 until p.length()).map { p.getString(it) }, a.getString("text")) }.let { null }
                        "mkdir" -> folders.mkdir(a.getString("root"), a.optString("dir").ifEmpty { null }, a.getString("name"))
                        "rename" -> folders.rename(Uri.parse(a.getString("uri")), a.getString("name"))
                        // Each one on its own: the web app learns which didn't go.
                        "delete" -> a.getJSONArray("uris").let { list ->
                            JSONArray().apply {
                                for (i in 0 until list.length()) {
                                    val uri = list.getString(i)
                                    runCatching { folders.delete(Uri.parse(uri)) }.onFailure { put(JSONObject().put("uri", uri).put("error", it.message ?: it.javaClass.simpleName)) }
                                }
                            }
                        }
                        "transfer" -> {
                            val list = a.getJSONArray("items")
                            val items = (0 until list.length()).map { i -> list.getJSONObject(i).let { Triple(Uri.parse(it.getString("uri")), it.getString("name"), it.optBoolean("dir")) } }
                            val from = folders.parentOf(a.getString("srcRoot"), a.optString("srcDir").ifEmpty { null })
                            folders.transfer(items, from, a.getString("root"), a.optString("dir").ifEmpty { null }, a.optBoolean("move"))
                        }
                        "create" -> {
                            val (file, _) = synchronized(this) { outgoing.remove(a.getString("token")) } ?: throw IllegalStateException("Nothing to write")
                            try {
                                folders.create(a.getString("root"), a.optString("dir").ifEmpty { null }, a.getString("name"), a.getString("mime"), file)
                            } finally {
                                file.parentFile?.deleteRecursively()
                            }
                        }
                        "write" -> {
                            val (file, _) = synchronized(this) { outgoing.remove(a.getString("token")) } ?: throw IllegalStateException("Nothing to write")
                            try {
                                folders.write(Uri.parse(a.getString("uri")), file)
                            } finally {
                                file.parentFile?.deleteRecursively()
                            }
                            null
                        }
                        else -> throw IllegalArgumentException("Unknown request: $method")
                    }
                }.onSuccess(done).onFailure(fail)
            }
        }
    }

    /** Outgoing copies older than a day (shares other apps have long read, saves cut short) go. */
    fun sweep() {
        io.execute {
            val cutoff = System.currentTimeMillis() - 86_400_000L
            File(activity.cacheDir, "outgoing").listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.deleteRecursively() }
        }
    }

    /** The activity is gone: its threads stop, and requests still running are cancelled. */
    fun close() {
        synchronized(calls) { calls.values.forEach { it.cancel() } }
        worker.shutdown()
        network.shutdown()
        io.shutdown()
    }

    /** Stops a request the web app no longer waits for (AI reading cancelled): its connection closes. */
    @JavascriptInterface
    fun cancel(id: String) {
        val call = synchronized(calls) { calls[id].also { if (it == null) cancelled += id } }
        call?.cancel()
    }

    /**
     * An HTTPS request made by the app rather than the WebView: AI reading goes to an address the user chose,
     * and the WebView's page origin (this app's own host) is one that address's CORS rules don't know.
     * {url, method, headers, body} → {status, body}.
     */
    private fun http(id: String, a: JSONObject): JSONObject {
        val url = a.getString("url").toHttpUrlOrNull() ?: throw IllegalArgumentException("ai:bad-url")
        // Unencrypted only to this device or the local network: elsewhere the key would travel in the clear.
        if (!url.isHttps && !local(url.host)) throw IllegalArgumentException("ai:insecure")
        val headers = a.optJSONObject("headers")
        val method = a.optString("method", "POST").uppercase()
        val type = headers?.optString("content-type")?.ifEmpty { null }?.toMediaTypeOrNull()
        val body = when {
            a.has("body") -> a.getString("body").toRequestBody(type)
            // OkHttp wants a body for these, if an empty one.
            method in setOf("POST", "PUT", "PATCH") -> ByteArray(0).toRequestBody(type)
            else -> null
        }
        val request = Request.Builder().url(url).method(method, body).apply {
            headers?.keys()?.forEach { k -> header(k, headers.getString(k)) }
        }.build()
        val call = client.newCall(request)
        synchronized(calls) {
            if (cancelled.remove(id)) throw IOException("Canceled")
            calls[id] = call
        }
        try {
            call.execute().use { r -> return JSONObject().put("status", r.code).put("body", r.body?.string() ?: "") }
        } catch (e: IOException) {
            // Codes the web app words in the user's language.
            throw when {
                call.isCanceled() -> e
                !online() -> IOException("ai:offline")
                e is UnknownHostException -> IOException("ai:unknown-host:${url.host}")
                e is InterruptedIOException -> IOException("ai:timeout")
                else -> IOException("ai:unreachable:${url.host}")
            }
        } finally {
            synchronized(calls) { calls.remove(id) }
        }
    }

    private fun online(): Boolean = activity.getSystemService(ConnectivityManager::class.java)?.activeNetwork != null

    /** This device, the local network (private or link-local addresses) or a .local name. */
    private fun local(host: String): Boolean {
        if (host == "localhost" || host.endsWith(".local") || host.endsWith(".localhost")) return true
        // Only an address written as numbers is judged by them (a name is never looked up here).
        val literal = host.contains(':') || host.all { it.isDigit() || it == '.' }
        if (!literal) return false
        val ip = runCatching { InetAddress.getByName(host) }.getOrNull() ?: return false
        val b = ip.address
        return ip.isLoopbackAddress || ip.isLinkLocalAddress || ip.isSiteLocalAddress ||
            (ip is Inet6Address && (b[0].toInt() and 0xfe) == 0xfc) ||
            (ip is Inet4Address && (b[0].toInt() and 0xff) == 100 && (b[1].toInt() and 0xc0) == 64)
    }

    /**
     * Names are looked up by the system first, and by Cloudflare's DNS over HTTPS when it doesn't know them:
     * a browser has its own secure DNS, so an address it reaches (a just-made workers.dev name, one a Private
     * DNS filter drops) can be unknown to the system resolver the app uses.
     */
    private val client: OkHttpClient by lazy {
        val doh = DnsOverHttps.Builder()
            .client(OkHttpClient())
            .url("https://cloudflare-dns.com/dns-query".toHttpUrl())
            .bootstrapDnsHosts(InetAddress.getByName("1.1.1.1"), InetAddress.getByName("1.0.0.1"))
            .build()
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(300, TimeUnit.SECONDS)
            .dns(object : Dns {
                override fun lookup(hostname: String): List<InetAddress> =
                    try {
                        Dns.SYSTEM.lookup(hostname)
                    } catch (e: UnknownHostException) {
                        try {
                            doh.lookup(hostname)
                        } catch (d: IOException) {
                            // Cloudflare out of reach too (blocked, offline): as unknown as the system said.
                            throw UnknownHostException(hostname).apply { initCause(d) }
                        }
                    }
            })
            .build()
    }

    /** Whether the device has an ambient light sensor (for the "light sensor" theme). */
    @JavascriptInterface
    fun hasLightSensor(): Boolean = activity.hasLightSensor()

    /** Starts or stops "tessel-light" events with the ambient light in lux. */
    @JavascriptInterface
    fun light(on: Boolean) {
        activity.runOnUiThread { activity.watchLight(on) }
    }

    @JavascriptInterface
    fun theme(background: String, dark: Boolean) {
        activity.runOnUiThread { activity.applyTheme(background, dark) }
    }

    private fun shareType(uris: List<Uri>): String {
        val types = uris.map { activity.contentResolver.getType(it) }
        return when {
            types.all { it == Folders.EPUB } -> Folders.EPUB
            types.size == 1 -> types[0] ?: "*/*"
            types.all { it == Folders.PDF } -> Folders.PDF
            else -> "*/*"
        }
    }

    /** Documents from the file browser, to any app (mail, chat, cloud storage). */
    private fun shareUris(uris: ArrayList<Uri>, type: String) {
        val send = if (uris.size == 1) Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
        else Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
        send.setType(type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = android.content.ClipData.newRawUri(null, uris[0]).apply { uris.drop(1).forEach { addItem(android.content.ClipData.Item(it)) } }
        activity.startActivity(Intent.createChooser(send, activity.getString(R.string.share_title)))
    }

    private fun share(file: File, mime: String) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", file)
        val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        activity.startActivity(Intent.createChooser(send, activity.getString(R.string.share_title)))
    }

    private fun print(file: File) {
        val manager = activity.getSystemService(PrintManager::class.java) ?: return
        manager.print(file.name, object : PrintDocumentAdapter() {
            override fun onLayout(old: PrintAttributes?, new: PrintAttributes?, cancel: CancellationSignal?, cb: LayoutResultCallback, extras: android.os.Bundle?) {
                if (cancel?.isCanceled == true) return cb.onLayoutCancelled()
                cb.onLayoutFinished(PrintDocumentInfo.Builder(file.name).setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT).build(), true)
            }

            // Called on the main thread; the copy runs elsewhere (callbacks may be answered from any thread).
            override fun onWrite(pages: Array<out PageRange>?, dest: ParcelFileDescriptor, cancel: CancellationSignal?, cb: WriteResultCallback) {
                io.execute {
                    runCatching {
                        file.inputStream().use { input -> FileOutputStream(dest.fileDescriptor).use { input.copyTo(it) } }
                    }.onSuccess {
                        if (cancel?.isCanceled == true) cb.onWriteCancelled() else cb.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
                    }.onFailure { cb.onWriteFailed(it.message) }
                }
            }

            override fun onFinish() {
                io.execute { file.delete() }
            }
        }, PrintAttributes.Builder().build())
    }

    private companion object {
        /** Files from other apps known at a time (see accept). */
        const val KEEP_INCOMING = 16
        /** Documents handed to another app at once: more make the hand-over too big for Android. */
        const val MAX_SHARE = 300
    }
}
