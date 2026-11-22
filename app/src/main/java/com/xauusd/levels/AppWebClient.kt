package com.xauusd.levels

import android.content.res.AssetManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Serves the bundled web UI (assets/www) from a private https origin that
 * never touches the network, and answers its /api/proxy route with
 * [ApiProxy]. Used by both the visible screen and the background monitor.
 */
class AppWebClient(
    private val assets: AssetManager,
    private val userAgent: String,
    /** Called when the WebView's renderer died; the owner must drop that WebView. */
    private val onRendererGone: (WebView) -> Unit = {},
) : WebViewClient() {

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
        val url = request.url
        if (url.scheme != "https" || url.host != APP_HOST) {
            return respond(403, "text/plain", "Blocked".toByteArray())
        }
        val path = url.path ?: "/"
        if (path == "/api/proxy") {
            if (!request.method.equals("GET", ignoreCase = true) || request.isForMainFrame) {
                return respond(405, "text/plain", "Method not allowed".toByteArray())
            }
            val r = ApiProxy.fetch(url.getQueryParameter("u"), userAgent)
            // Always plain text: feed data is only ever read as text by the
            // page, so a feed answer can never become a document or script
            // running in the app's origin.
            return respond(r.status, "text/plain", r.body, noStore = true, extra = r.headers)
        }
        // Only the two pages of the app may be shown as documents.
        if (request.isForMainFrame && path !in PAGES) {
            return respond(404, "text/plain", "Not found".toByteArray())
        }
        return asset(if (path == "/") "/index.html" else path)
    }

    // The UI is a single page; nothing may navigate the WebView elsewhere.
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        !(request.url.host == APP_HOST && (request.url.path ?: "/") in PAGES)

    // Without this, a crashed or killed WebView renderer takes the whole app
    // down with it.
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        onRendererGone(view)
        return true
    }

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
        extra: Map<String, String> = emptyMap(),
    ): WebResourceResponse {
        // WebResourceResponse rejects 3xx codes; the proxy never follows
        // redirects, so report one as an upstream failure.
        val code = if (status in 300..399 || status !in 100..599) 502 else status
        val mime = contentType.substringBefore(';').trim().ifEmpty { "text/plain" }
        val headers = HashMap<String, String>()
        headers["X-Content-Type-Options"] = "nosniff"
        if (noStore) headers["Cache-Control"] = "no-store"
        // Only the two headers the page reads are passed on from the proxy.
        extra["Retry-After"]?.let { headers["Retry-After"] = it }
        extra["X-Upstream-Date"]?.let { headers["X-Upstream-Date"] = it }
        return WebResourceResponse(mime, "utf-8", code, reason(code), headers, ByteArrayInputStream(body))
    }

    private fun reason(code: Int): String = when (code) {
        200 -> "OK"
        400 -> "Bad Request"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        429 -> "Too Many Requests"
        502 -> "Bad Gateway"
        503 -> "Service Unavailable"
        else -> if (code < 400) "OK" else "Error"
    }

    companion object {
        // Reserved by Google for app-local content; it never resolves publicly.
        const val APP_HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$APP_HOST"
        private val PAGES = setOf("/", "/index.html", "/monitor.html")
    }
}
