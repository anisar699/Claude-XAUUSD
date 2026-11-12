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
