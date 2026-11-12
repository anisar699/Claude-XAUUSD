package com.xauusd.levels

import android.annotation.SuppressLint
import android.app.Activity
import android.content.res.AssetManager
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * A thin shell: one WebView showing the bundled web UI (assets/www).
 *
 * The UI is served from a private https origin that never touches the
 * network; its /api/proxy route is answered by [ApiProxy].
 */
class MainActivity : Activity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#0B0E14"))
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.settings.apply {
            javaScriptEnabled = true // only the bundled UI ever loads; see AppClient
            domStorageEnabled = true // settings and the candle cache live in localStorage
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        web.webViewClient = AppClient(assets, web.settings.userAgentString)
        setContentView(web)
        web.loadUrl(START_URL)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    // Back returns to the Overview tab first; from there it leaves the app.
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("(window.__onBack ? window.__onBack() : false) === true") { handled ->
            if (handled != "true") finish()
        }
    }

    private class AppClient(
        private val assets: AssetManager,
        private val userAgent: String,
    ) : WebViewClient() {

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val url = request.url
            if (url.scheme != "https" || url.host != APP_HOST) {
                return respond(403, "text/plain", "Blocked".toByteArray())
            }
            val path = url.path ?: "/"
            if (path == "/api/proxy") {
                if (!request.method.equals("GET", ignoreCase = true)) {
                    return respond(405, "text/plain", "Method not allowed".toByteArray())
                }
                val r = ApiProxy.fetch(url.getQueryParameter("u"), userAgent)
                return respond(r.status, r.contentType, r.body, noStore = true)
            }
            return asset(if (path == "/") "/index.html" else path)
        }

        // The UI is a single page; nothing may navigate the WebView elsewhere.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            request.url.host != APP_HOST

        private fun asset(path: String): WebResourceResponse {
            if (path.contains("..")) return respond(400, "text/plain", "Bad path".toByteArray())
            return try {
                val bytes = assets.open("www$path").use { it.readBytes() }
                respond(200, mimeOf(path), bytes)
            } catch (e: IOException) {
                respond(404, "text/plain", "Not found".toByteArray())
            }
        }

        private fun mimeOf(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            else -> "text/plain"
        }

        private fun respond(
            status: Int,
            contentType: String,
            body: ByteArray,
            noStore: Boolean = false,
        ): WebResourceResponse {
            // WebResourceResponse rejects 3xx codes; the proxy never follows
            // redirects, so report one as an upstream failure.
            val code = if (status in 300..399 || status !in 100..599) 502 else status
            val mime = contentType.substringBefore(';').trim().ifEmpty { "text/plain" }
            val headers = if (noStore) mapOf("Cache-Control" to "no-store") else emptyMap()
            return WebResourceResponse(mime, "utf-8", code, reason(code), headers, ByteArrayInputStream(body))
        }

        private fun reason(code: Int): String = when (code) {
            200 -> "OK"
            400 -> "Bad Request"
            403 -> "Forbidden"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            502 -> "Bad Gateway"
            else -> if (code < 400) "OK" else "Error"
        }
    }

    private companion object {
        // Reserved by Google for app-local content; it never resolves publicly.
        const val APP_HOST = "appassets.androidplatform.net"
        const val START_URL = "https://$APP_HOST/index.html"
    }
}
