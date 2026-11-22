package com.xauusd.levels

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * Fetches market data on behalf of the web UI.
 *
 * The page cannot call the data feeds itself: they send no CORS headers, and
 * one of them needs a Referer header a page is not allowed to set. Only HTTPS
 * GETs to the hosts listed here are forwarded. Keep the list in sync with
 * tools/dev-server.mjs.
 *
 * This object is shared by every page of the app (the screen and the
 * background monitor), so it is also where request limits are enforced for
 * all of them together:
 *  - when a host answers 429 (or 503 with Retry-After), no request goes to it
 *    until the wait it asked for is over; without Retry-After the wait starts
 *    at 30 s and doubles up to 10 minutes;
 *  - Twelve Data gets at most [TWELVE_PER_MINUTE] requests a minute.
 * A request held back gets a 429 with Retry-After without touching the
 * network. The upstream Date header is passed on as X-Upstream-Date so the
 * page can judge data age by the server's clock.
 */
object ApiProxy {

    class Result(
        val status: Int,
        val contentType: String,
        val body: ByteArray,
        val headers: Map<String, String> = emptyMap(),
    )

    /** Allowed host -> Referer to send (null for none). */
    private val HOSTS: Map<String, String?> = mapOf(
        "freeserv.dukascopy.com" to "https://freeserv.dukascopy.com/2.0/?path=chart/index",
        "forex-data-feed.swissquote.com" to null,
        "api.twelvedata.com" to null,
    )

    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 15_000
    private const val MAX_BYTES = 4 * 1024 * 1024
    private const val TWELVE_HOST = "api.twelvedata.com"
    private const val TWELVE_PER_MINUTE = 8

    /** Shared limits, with an injectable clock for tests. */
    internal val gate = Gate { System.currentTimeMillis() }

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

        gate.admit(url.host)?.let { waitSec ->
            return Result(
                429, "text/plain",
                "Waiting $waitSec s before asking ${url.host} again".toByteArray(Charsets.UTF_8),
                mapOf("Retry-After" to waitSec.toString()),
            )
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
            val date = conn.getHeaderField("Date")
            val retryAfter = conn.getHeaderField("Retry-After")
            val waitSec = gate.answered(url.host, status, retryAfter)
            val stream: InputStream? = if (status in 200..299) conn.inputStream else conn.errorStream
            val body = (if (stream == null) ByteArray(0) else stream.use { readCapped(it) })
                ?: return error(502, "Response too large")
            val headers = HashMap<String, String>()
            if (date != null) headers["X-Upstream-Date"] = date
            if (waitSec != null) headers["Retry-After"] = waitSec.toString()
            Result(status, conn.contentType ?: "text/plain", body, headers)
        } catch (e: Exception) {
            error(502, e.message ?: e.javaClass.simpleName)
        } finally {
            conn?.disconnect()
        }
    }

    /** The whole stream, or null if it is longer than [max] bytes. */
    internal fun readCapped(input: InputStream, max: Int = MAX_BYTES): ByteArray? {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) return out.toByteArray()
            out.write(buf, 0, n)
            if (out.size() > max) return null
        }
    }

    /**
     * Seconds to wait from a Retry-After value: a number of seconds or an HTTP
     * date. Null if missing or unreadable. Capped at an hour.
     */
    internal fun parseRetryAfter(value: String?, nowMs: Long): Long? {
        val v = value?.trim().orEmpty()
        if (v.isEmpty()) return null
        v.toLongOrNull()?.let { return it.coerceIn(0, 3600) }
        return try {
            val f = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US)
            f.timeZone = TimeZone.getTimeZone("GMT")
            val at = f.parse(v)?.time ?: return null
            ((at - nowMs + 999) / 1000).coerceIn(0, 3600)
        } catch (e: Exception) {
            null
        }
    }

    /** Per-host cooldowns and the Twelve Data per-minute budget. Thread-safe. */
    internal class Gate(private val clock: () -> Long) {
        private val until = HashMap<String, Long>()
        private val strikes = HashMap<String, Int>()
        private val twelve = ArrayDeque<Long>()

        /** Null to let the request go, else the seconds to wait first. */
        @Synchronized
        fun admit(host: String): Long? {
            val now = clock()
            val end = until[host] ?: 0L
            if (now < end) return (end - now + 999) / 1000
            if (host == TWELVE_HOST) {
                while (twelve.isNotEmpty() && now - twelve.first() >= 60_000) twelve.removeFirst()
                if (twelve.size >= TWELVE_PER_MINUTE) return (twelve.first() + 60_000 - now + 999) / 1000
                twelve.addLast(now)
            }
            return null
        }

        /**
         * Record an answer. Returns the seconds every page must now wait before
         * asking this host again, or null when there is no wait.
         */
        @Synchronized
        fun answered(host: String, status: Int, retryAfter: String?): Long? {
            val now = clock()
            val asked = parseRetryAfter(retryAfter, now)
            val limited = status == 429 || (status == 503 && asked != null)
            if (!limited) {
                strikes.remove(host)
                return null
            }
            val n = (strikes[host] ?: 0) + 1
            strikes[host] = n
            val wait = asked?.coerceAtLeast(1) ?: (30L shl (n - 1).coerceAtMost(5)).coerceAtMost(600)
            until[host] = maxOf(until[host] ?: 0L, now + wait * 1000)
            return wait
        }
    }

    private fun error(status: Int, message: String) =
        Result(status, "text/plain", message.toByteArray(Charsets.UTF_8))
}
