package app.tessel.viewer

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.io.File

/**
 * Tessel for Android: the web app, bundled in the APK and shown in a WebView, with native glue for
 * opening files from other apps, the file picker, share, save and print. Works fully offline.
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var appAssets: AppAssets
    private val bridge by lazy { Bridge(this) }
    private var pageReady = false

    private var chooserCallback: ValueCallback<Array<Uri>>? = null
    private val chooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val data = result.data
        val uris = when {
            result.resultCode != RESULT_OK || data == null -> null
            data.clipData != null -> Array(data.clipData!!.itemCount) { data.clipData!!.getItemAt(it).uri }
            data.data != null -> arrayOf(data.data!!)
            else -> null
        }
        chooserCallback?.onReceiveValue(uris)
        chooserCallback = null
    }

    private var pendingSave: File? = null
    private val saver = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val file = pendingSave
        pendingSave = null
        val target = result.data?.data
        if (result.resultCode == RESULT_OK && file != null && target != null) {
            runCatching { contentResolver.openOutputStream(target)?.use { out -> file.inputStream().use { it.copyTo(out) } } }
                .onFailure { Log.w(TAG, "save failed", it) }
        }
    }

    private var folderCallback: ((Uri?) -> Unit)? = null
    private val folderPicker = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { tree ->
        if (tree != null) bridge.folders.keep(tree)
        folderCallback?.invoke(tree)
        folderCallback = null
    }

    private var accessCallback: ((Boolean) -> Unit)? = null
    private val accessDone = { accessCallback?.invoke(bridge.folders.allFilesGranted()); accessCallback = null }
    private val accessSettings = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { accessDone() }
    private val accessPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { accessDone() }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        appAssets = AppAssets(assets)

        web = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                setSupportMultipleWindows(false)
                // The app sets its own type scale (and has its own text size setting).
                textZoom = 100
                userAgentString = "$userAgentString TesselShell/${BuildConfig.VERSION_NAME}"
            }
            addJavascriptInterface(bridge, "TesselShell")
            webViewClient = Client()
            webChromeClient = Chrome()
        }

        // Keep the web app clear of the status bar, navigation bar, cutouts and keyboard.
        val root = FrameLayout(this)
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })

        handleIntent(intent)
        // Always start fresh: the app itself restores the library and each document's position.
        web.loadUrl("${AppAssets.ORIGIN}/")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    /** Files from "Open with" or "Share": hand them to the web app, which adds and opens them. */
    private fun handleIntent(intent: Intent?) {
        if (intent == null) return
        val uris = when (intent.action) {
            Intent.ACTION_VIEW -> listOfNotNull(intent.data)
            Intent.ACTION_SEND -> listOfNotNull(streamExtra(intent))
            Intent.ACTION_SEND_MULTIPLE -> streamListExtra(intent)
            else -> emptyList()
        }
        if (uris.isNotEmpty() && bridge.accept(uris) > 0 && pageReady) notifyWeb()
    }

    private fun notifyWeb() = web.evaluateJavascript("window.dispatchEvent(new Event('tessel-shell-open'))", null)

    @Suppress("DEPRECATION")
    private fun streamExtra(intent: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableExtra(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun streamListExtra(intent: Intent): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM))
            ?: emptyList()

    /** "Download" in the app: the system's save dialog (any folder or cloud provider). */
    fun saveAs(file: File, mime: String) {
        pendingSave = file
        saver.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, file.name))
    }

    // ---------- ambient light (the "light sensor" theme) ----------

    private val sensors by lazy { getSystemService(SensorManager::class.java) }
    private val lightSensor by lazy { sensors?.getDefaultSensor(Sensor.TYPE_LIGHT) }
    private var lightWanted = false
    private var lastLight = 0L
    private val lightListener = object : SensorEventListener {
        override fun onSensorChanged(event: SensorEvent) {
            // A few readings a second are plenty: the web app waits for the light to settle anyway.
            val now = SystemClock.elapsedRealtime()
            if (now - lastLight < 400) return
            lastLight = now
            val lux = event.values.firstOrNull() ?: return
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('tessel-light', { detail: $lux }))", null)
        }

        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    fun hasLightSensor() = lightSensor != null

    fun watchLight(on: Boolean) {
        lightWanted = on
        if (on && lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) startLight() else stopLight()
    }

    private fun startLight() {
        val s = lightSensor ?: return
        sensors?.registerListener(lightListener, s, SensorManager.SENSOR_DELAY_NORMAL)
    }

    private fun stopLight() {
        sensors?.unregisterListener(lightListener)
    }

    override fun onResume() {
        super.onResume()
        if (lightWanted) startLight()
    }

    override fun onPause() {
        stopLight()
        super.onPause()
    }

    /** The system folder picker; access is kept across restarts. */
    fun pickFolder(done: (Uri?) -> Unit) {
        folderCallback?.invoke(null)
        folderCallback = done
        try {
            folderPicker.launch(null)
        } catch (_: ActivityNotFoundException) {
            folderCallback = null
            done(null)
        }
    }

    /** "All files access": Android's settings screen for it (11+), or the storage permission (8–10). */
    fun requestAllFiles(done: (Boolean) -> Unit) {
        if (bridge.folders.allFilesGranted()) return done(true)
        accessCallback?.invoke(false)
        accessCallback = done
        if (Build.VERSION.SDK_INT >= 30) {
            val app = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))
            try {
                accessSettings.launch(app)
            } catch (_: ActivityNotFoundException) {
                runCatching { accessSettings.launch(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }.onFailure { accessDone() }
            }
        } else {
            accessPermission.launch(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE))
        }
    }

    /** Answers a bridge request (see Bridge.request). */
    fun reply(id: String, ok: Boolean, value: Any?) {
        val detail = JSONObject().put("id", id).put("ok", ok).put(if (ok) "value" else "error", value ?: JSONObject.NULL)
        web.post { web.evaluateJavascript("window.dispatchEvent(new CustomEvent('tessel-shell-reply', { detail: $detail }))", null) }
    }

    /** System bars follow the app's palette (the web app reports it on every theme change). */
    fun applyTheme(background: String, dark: Boolean) {
        runCatching { window.decorView.setBackgroundColor(Color.parseColor(background)) }
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url
            if (url.host != AppAssets.HOST) return null
            val path = url.path ?: "/"
            return when {
                path.startsWith("/__shell/file/") -> bridge.serve(path)
                path == "/__shell/doc" -> bridge.folders.serve(url.getQueryParameter("u"))
                else -> appAssets.handle(path)
            }
        }

        /** Links to the web open in the browser (or the matching app); the app itself stays in the WebView. */
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (request.url.host == AppAssets.HOST) return false
            try {
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
            } catch (_: ActivityNotFoundException) {
            }
            return true
        }

        override fun onPageFinished(view: WebView, url: String) {
            pageReady = true
            notifyWeb()
        }
    }

    private inner class Chrome : WebChromeClient() {
        /** <input type="file">: the system document picker, for PDFs and EPUBs. */
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
            chooserCallback?.onReceiveValue(null)
            chooserCallback = callback
            val types = params.acceptTypes.flatMap { it.split(',') }.map { it.trim() }.filter { it.contains('/') }.ifEmpty { listOf("application/pdf", "application/epub+zip") }
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(if (types.size == 1) types[0] else "*/*")
                .putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
            return try {
                chooser.launch(intent)
                true
            } catch (_: ActivityNotFoundException) {
                chooserCallback = null
                false
            }
        }

        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            // Visible in logcat (and the CI smoke test) as "TesselWeb".
            Log.println(if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.ERROR else Log.INFO, "TesselWeb", "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
            return true
        }
    }

    companion object {
        private const val TAG = "Tessel"
    }
}
