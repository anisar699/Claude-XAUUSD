package com.xauusd.levels

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class ApiProxyTest {

    private val ua = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36"

    @Test
    fun rejectsAnythingOutsideTheAllowList() {
        assertEquals(400, ApiProxy.fetch(null, ua).status)
        assertEquals(400, ApiProxy.fetch("not a url", ua).status)
        assertEquals(403, ApiProxy.fetch("https://example.com/", ua).status)
        assertEquals(403, ApiProxy.fetch("http://freeserv.dukascopy.com/2.0/index.php", ua).status)
        assertEquals(403, ApiProxy.fetch("https://freeserv.dukascopy.com:8443/2.0/index.php", ua).status)
        assertEquals(403, ApiProxy.fetch("https://freeserv.dukascopy.com.evil.example/x", ua).status)
        assertEquals(403, ApiProxy.fetch("file:///etc/hosts", ua).status)
    }

    @Test
    fun oversizedAnswerIsRejectedNotCut() {
        val max = 1000
        assertEquals(max, ApiProxy.readCapped(java.io.ByteArrayInputStream(ByteArray(max)), max)?.size)
        assertEquals(null, ApiProxy.readCapped(java.io.ByteArrayInputStream(ByteArray(max + 1)), max))
    }

    @Test
    fun retryAfterIsReadAsSecondsOrADate() {
        val now = 1_795_000_000_000L
        assertEquals(120L, ApiProxy.parseRetryAfter("120", now))
        assertEquals(3600L, ApiProxy.parseRetryAfter("99999", now))
        assertEquals(null, ApiProxy.parseRetryAfter(null, now))
        assertEquals(null, ApiProxy.parseRetryAfter("soon", now))
        val f = java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", java.util.Locale.US)
        f.timeZone = java.util.TimeZone.getTimeZone("GMT")
        assertEquals(90L, ApiProxy.parseRetryAfter(f.format(java.util.Date(now + 90_000)), now))
    }

    @Test
    fun rateLimitHoldsEveryRequestToThatHostOnly() {
        var now = 1_000_000L
        val gate = ApiProxy.Gate { now }
        val duka = "freeserv.dukascopy.com"
        assertEquals(null, gate.admit(duka))
        // 429 with Retry-After: 120 s for everyone, the other host unaffected.
        assertEquals(120L, gate.answered(duka, 429, "120"))
        assertEquals(120L, gate.admit(duka))
        assertEquals(null, gate.admit("forex-data-feed.swissquote.com"))
        now += 119_000
        assertEquals(1L, gate.admit(duka))
        now += 1_000
        assertEquals(null, gate.admit(duka))
        // A second 429 in a row waits longer; an answer that is not a rate
        // limit resets that. Without Retry-After the wait doubles from 30 s.
        assertEquals(null, gate.answered(duka, 200, null))
        assertEquals(30L, gate.answered(duka, 429, null))
        assertEquals(60L, gate.answered(duka, 429, null))
        now += 60_000
        assertEquals(null, gate.answered(duka, 200, null))
        assertEquals(30L, gate.answered(duka, 429, null))
        // A 503 counts only when it says how long to wait.
        now += 31_000
        assertEquals(null, gate.answered(duka, 503, null))
        assertEquals(null, gate.admit(duka))
    }

    @Test
    fun twelveDataGetsEightRequestsAMinuteAcrossPages() {
        var now = 0L
        val gate = ApiProxy.Gate { now }
        repeat(8) { assertEquals(null, gate.admit("api.twelvedata.com")) }
        assertEquals(60L, gate.admit("api.twelvedata.com"))
        now += 30_000
        assertEquals(30L, gate.admit("api.twelvedata.com"))
        now += 30_000
        assertEquals(null, gate.admit("api.twelvedata.com"))
    }

    // Talks to the real feeds, so it only runs on request: LIVE_TESTS=1 ./gradlew test
    @Test
    fun liveFeedsAnswer() {
        assumeTrue(System.getenv("LIVE_TESTS") == "1")

        val candles = ApiProxy.fetch(
            "https://freeserv.dukascopy.com/2.0/index.php?path=chart%2Fjson3&instrument=XAU%2FUSD&offer_side=B" +
                "&interval=1HOUR&splits=true&stocks=true&limit=5&time_direction=P" +
                "&timestamp=${System.currentTimeMillis()}&jsonp=cb",
            ua,
        )
        assertEquals(200, candles.status)
        assertTrue(String(candles.body).startsWith("cb([["))

        val quote = ApiProxy.fetch(
            "https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD",
            ua,
        )
        assertEquals(200, quote.status)
        assertTrue(String(quote.body).contains("\"bid\""))
    }
}
