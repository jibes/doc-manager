package app.tessel.viewer

import android.content.Intent
import android.net.Uri
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

    /** Registers files from a VIEW/SEND intent; returns how many were usable. */
    fun accept(uris: List<Uri>): Int {
        var n = 0
        for (uri in uris) {
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
        when (method) {
            // Interactive: answered when the user comes back from the system screen.
            "pickFolder" -> activity.runOnUiThread { activity.pickFolder { tree -> done(tree?.let { JSONObject().put("uri", it.toString()).put("name", folders.treeName(it)) }) } }
            "requestAllFiles" -> activity.runOnUiThread { activity.requestAllFiles { done(it) } }
            "http" -> network.execute { runCatching { http(a) }.onSuccess(done).onFailure { activity.reply(id, false, it.message ?: it.javaClass.simpleName) } }
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
                        "delete" -> a.getJSONArray("uris").let { list -> for (i in 0 until list.length()) folders.delete(Uri.parse(list.getString(i))) }.let { null }
                        "transfer" -> {
                            val list = a.getJSONArray("items")
                            val items = (0 until list.length()).map { i -> list.getJSONObject(i).let { Triple(Uri.parse(it.getString("uri")), it.getString("name"), it.optBoolean("dir")) } }
                            val from = folders.parentOf(a.getString("srcRoot"), a.optString("srcDir").ifEmpty { null })
                            folders.transfer(items, from, a.getString("root"), a.optString("dir").ifEmpty { null }, a.optBoolean("move"))
                        }
                        "share" -> {
                            val list = a.getJSONArray("uris")
                            val uris = ArrayList((0 until list.length()).map { folders.shareable(Uri.parse(list.getString(it))) })
                            activity.runOnUiThread { shareUris(uris) }
                            null
                        }
                        "create" -> {
                            val (file, _) = synchronized(this) { outgoing.remove(a.getString("token")) } ?: throw IllegalStateException("Nothing to write")
                            folders.create(a.getString("root"), a.optString("dir").ifEmpty { null }, a.getString("name"), a.getString("mime"), file).also { file.delete() }
                        }
                        "write" -> {
                            val (file, _) = synchronized(this) { outgoing.remove(a.getString("token")) } ?: throw IllegalStateException("Nothing to write")
                            folders.write(Uri.parse(a.getString("uri")), file)
                            file.delete()
                            null
                        }
                        else -> throw IllegalArgumentException("Unknown request: $method")
                    }
                }.onSuccess(done).onFailure { activity.reply(id, false, it.message ?: it.javaClass.simpleName) }
            }
        }
    }

    /**
     * An HTTPS request made by the app rather than the WebView: AI reading goes to an address the user chose,
     * and the WebView's page origin (this app's own host) is one that address's CORS rules don't know.
     * {url, method, headers, body} → {status, body}.
     */
    private fun http(a: JSONObject): JSONObject {
        val url = a.getString("url").toHttpUrlOrNull() ?: throw IllegalArgumentException("Not a web address")
        val headers = a.optJSONObject("headers")
        val body = if (a.has("body")) a.getString("body").toRequestBody(headers?.optString("content-type")?.ifEmpty { null }?.toMediaTypeOrNull()) else null
        val request = Request.Builder().url(url).method(a.optString("method", "POST"), body).apply {
            headers?.keys()?.forEach { k -> header(k, headers.getString(k)) }
        }.build()
        try {
            client.newCall(request).execute().use { r -> return JSONObject().put("status", r.code).put("body", r.body?.string() ?: "") }
        } catch (e: UnknownHostException) {
            throw UnknownHostException("Can't find ${url.host}: neither this device's DNS nor Cloudflare's knows it. If a browser on this device reaches it, check that Tessel may use the network (app info, firewall or VPN apps).")
        }
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
            .dns { host -> try { Dns.SYSTEM.lookup(host) } catch (e: UnknownHostException) { doh.lookup(host) } }
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

    /** Documents from the file browser, to any app (mail, chat, cloud storage). */
    private fun shareUris(uris: ArrayList<Uri>) {
        val send = if (uris.size == 1) Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
        else Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
        send.setType(if (uris.all { activity.contentResolver.getType(it) == Folders.EPUB }) Folders.EPUB else if (uris.size == 1) activity.contentResolver.getType(uris[0]) ?: "*/*" else "*/*")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
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

            override fun onWrite(pages: Array<out PageRange>?, dest: ParcelFileDescriptor, cancel: CancellationSignal?, cb: WriteResultCallback) {
                runCatching {
                    file.inputStream().use { input -> FileOutputStream(dest.fileDescriptor).use { input.copyTo(it) } }
                }.onSuccess { cb.onWriteFinished(arrayOf(PageRange.ALL_PAGES)) }.onFailure { cb.onWriteFailed(it.message) }
            }
        }, PrintAttributes.Builder().build())
    }
}
