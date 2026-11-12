package com.xauusd.levels

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Fetches market data on behalf of the web UI.
 *
 * The page cannot call the data feeds itself: they send no CORS headers, and
 * one of them needs a Referer header a page is not allowed to set. Only HTTPS
 * GETs to the hosts listed here are forwarded. Keep the list in sync with
 * tools/dev-server.mjs.
 */
object ApiProxy {

    class Result(val status: Int, val contentType: String, val body: ByteArray)

    /** Allowed host -> Referer to send (null for none). */
    private val HOSTS: Map<String, String?> = mapOf(
        "freeserv.dukascopy.com" to "https://freeserv.dukascopy.com/2.0/?path=chart/index",
        "forex-data-feed.swissquote.com" to null,
        "api.twelvedata.com" to null,
    )

    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 15_000
    private const val MAX_BYTES = 4 * 1024 * 1024

    fun fetch(target: String?, userAgent: String): Result {
        val url = try {
            URL(target)
        } catch (e: Exception) {
            return error(400, "Bad URL")
        }
        val portOk = url.port == -1 || url.port == 443
        if (url.protocol != "https" || !portOk || !HOSTS.containsKey(url.host)) {
            return error(403, "Host not allowed")
        }

        var conn: HttpURLConnection? = null
        return try {
            conn = url.openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.instanceFollowRedirects = false
            conn.useCaches = false
            conn.setRequestProperty("User-Agent", userAgent)
            conn.setRequestProperty("Accept", "*/*")
            HOSTS[url.host]?.let { conn.setRequestProperty("Referer", it) }

            val status = conn.responseCode
            val stream: InputStream? = if (status in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.use { readCapped(it) } ?: ByteArray(0)
            Result(status, conn.contentType ?: "text/plain", body)
        } catch (e: Exception) {
            error(502, e.message ?: e.javaClass.simpleName)
        } finally {
            conn?.disconnect()
        }
    }

    private fun readCapped(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (out.size() < MAX_BYTES) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    private fun error(status: Int, message: String) =
        Result(status, "text/plain", message.toByteArray(Charsets.UTF_8))
}
