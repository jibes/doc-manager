package expo.modules.pdfengine

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.LoadParams
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.min
import kotlin.math.roundToInt

class OpenFailedException(reason: String) : CodedException(reason)

/** PdfRenderer-backed implementation of the DocHandle contract in src/engine/types.ts. */
class PdfEngineModule : Module() {
  private class Doc(val pfd: ParcelFileDescriptor, val renderer: PdfRenderer) {
    val sizes: List<Pair<Int, Int>> = (0 until renderer.pageCount).map { i ->
      renderer.openPage(i).use { it.width to it.height }
    }
  }

  private val docs = ConcurrentHashMap<String, Doc>()
  private val maxWidth = 4096

  private val cacheDir: File
    get() = File(appContext.reactContext?.cacheDir ?: throw Exceptions.AppContextLost(), "pdf-render").apply { mkdirs() }

  private fun doc(handle: String) = docs[handle] ?: throw OpenFailedException("Document closed.")

  override fun definition() = ModuleDefinition {
    Name("PdfEngine")

    AsyncFunction("open") { uri: String, password: String? ->
      val path = Uri.parse(uri).path ?: throw OpenFailedException("Invalid file URI.")
      val pfd = ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY)
      // Messages carry the tokens src/engine/types.ts#asPasswordError looks for.
      val renderer = try {
        if (!password.isNullOrEmpty() && Build.VERSION.SDK_INT >= 35) {
          PdfRenderer(pfd, LoadParams.Builder().setPassword(password).build())
        } else {
          PdfRenderer(pfd)
        }
      } catch (e: SecurityException) {
        pfd.close()
        // Before API 35 PdfRenderer can't take a password at all.
        throw OpenFailedException(if (password.isNullOrEmpty() || Build.VERSION.SDK_INT < 35) "password-required" else "password-wrong")
      } catch (e: Exception) {
        pfd.close()
        throw OpenFailedException("Could not open PDF.")
      }
      val d = Doc(pfd, renderer)
      val handle = UUID.randomUUID().toString()
      docs[handle] = d
      mapOf(
        "handle" to handle,
        "pageCount" to renderer.pageCount,
        "pageSizes" to d.sizes.map { (w, h) -> mapOf("width" to w.toDouble(), "height" to h.toDouble()) },
      )
    }

    AsyncFunction("render") { handle: String, index: Int, width: Double ->
      val d = doc(handle)
      val (pw, ph) = d.sizes[index]
      val w = min(width.roundToInt(), maxWidth)
      val h = (w.toDouble() * ph / pw).roundToInt()
      val file = File(cacheDir, "$handle-$index-$w.jpg")
      if (!file.exists()) {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        bmp.eraseColor(Color.WHITE)
        // PdfRenderer allows one open page per renderer.
        synchronized(d) {
          d.renderer.openPage(index).use { it.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY) }
        }
        val tmp = File(cacheDir, "${file.name}.tmp")
        FileOutputStream(tmp).use { bmp.compress(Bitmap.CompressFormat.JPEG, 92, it) }
        bmp.recycle()
        tmp.renameTo(file)
      }
      mapOf("uri" to Uri.fromFile(file).toString(), "width" to w.toDouble(), "height" to h.toDouble())
    }

    // PdfRenderer exposes no outline API.
    AsyncFunction("outline") { _: String -> emptyList<Map<String, Any>>() }

    AsyncFunction("search") { handle: String, query: String ->
      if (Build.VERSION.SDK_INT < 35) return@AsyncFunction emptyList<Map<String, Any>>()
      val d = doc(handle)
      val hits = mutableListOf<Map<String, Any>>()
      for (i in 0 until d.renderer.pageCount) {
        val (pw, ph) = d.sizes[i]
        synchronized(d) {
          d.renderer.openPage(i).use { page ->
            val text = page.textContents.joinToString(" ") { it.text }
            for (m in page.searchText(query)) {
              val start = m.textStartIndex
              val from = maxOf(0, start - 40)
              val to = min(text.length, start + query.length + 60)
              hits += mapOf(
                "page" to i,
                "rects" to m.bounds.map { r ->
                  mapOf("x" to r.left / pw, "y" to r.top / ph, "w" to r.width() / pw, "h" to r.height() / ph)
                },
                "snippet" to if (from < to) text.substring(from, to) else query,
                "matchStart" to start - from,
                "matchLength" to query.length,
              )
            }
          }
        }
      }
      hits
    }

    Function("close") { handle: String ->
      docs.remove(handle)?.let {
        synchronized(it) { it.renderer.close() }
        it.pfd.close()
      }
    }
  }
}
