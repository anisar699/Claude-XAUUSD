package com.example.chartkit // change to your app's package

import android.annotation.SuppressLint
import android.content.res.AssetManager
import android.graphics.Color
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Turns any WebView into the chart.
 *
 *     val web = WebView(this)            // or findViewById / AndroidView { } in Compose
 *     ChartWebView.attach(web)
 *     container.addView(web)
 *
 * The page is served from the app's own assets (assets/www) under a private
 * https origin that never touches the network. Its /api/proxy requests are
 * answered by [ApiProxy]. Forward the host's onPause / onResume to the WebView
 * so the chart stops polling in the background.
 */
object ChartWebView {

    // Reserved by Google for app-local content; it never resolves publicly.
    private const val APP_HOST = "appassets.androidplatform.net"
    private const val START_URL = "https://$APP_HOST/index.html"

    @SuppressLint("SetJavaScriptEnabled")
    fun attach(web: WebView) {
        web.setBackgroundColor(Color.parseColor("#0B0E14"))
        web.settings.apply {
            javaScriptEnabled = true // only the bundled page ever loads; see Client
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        web.webViewClient = Client(web.context.assets, web.settings.userAgentString)
        web.loadUrl(START_URL)
    }

    private class Client(
        private val assets: AssetManager,
        private val userAgent: String,
    ) : WebViewClient() {

        // Runs on a background thread, so the blocking fetch is fine here.
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
            val url = request.url
            if (url.scheme != "https" || url.host != APP_HOST) {
                return respond(403, "text/plain", "Blocked".toByteArray())
            }
            val path = url.path ?: "/"
            if (path == "/api/proxy") {
                val r = ApiProxy.fetch(url.getQueryParameter("u"), userAgent)
                return respond(r.status, r.contentType, r.body, noStore = true)
            }
            return asset(if (path == "/") "/index.html" else path)
        }

        // Nothing may navigate the WebView away from the bundled page.
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

        // The MIME type matters: a script served as text/plain will not run.
        private fun mimeOf(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html"
            "js" -> "text/javascript"
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
            val reason = if (code < 400) "OK" else "Error"
            return WebResourceResponse(mime, "utf-8", code, reason, headers, ByteArrayInputStream(body))
        }
    }
}
