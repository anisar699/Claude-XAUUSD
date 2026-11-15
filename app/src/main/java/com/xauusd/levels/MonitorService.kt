package com.xauusd.levels

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.webkit.JavascriptInterface
import android.webkit.WebView

/**
 * Background level alerts.
 *
 * A foreground service that owns a WebView with no screen. The WebView loads
 * monitor.html, which runs the same data and analysis code as the app and
 * reports back through [Bridge]. Keeping the analysis in one place (the
 * JavaScript) means alerts always agree with the levels the app shows.
 *
 * The service calls into the page on its own clock, because timers inside a
 * windowless WebView may be throttled.
 */
class MonitorService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var web: WebView? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var statusText = "Starting…"

    private val tick = object : Runnable {
        override fun run() {
            web?.evaluateJavascript("window.__monitorTick && window.__monitorTick()", null)
            handler.postDelayed(this, TICK_MS)
        }
    }

    // The CPU has to stay awake for the checks to keep running with the screen
    // off, but only while the market is open: the page reports the market
    // state (Bridge.marketState) and while it is closed the lock is released
    // and an alarm wakes the phone at the reopening.
    override fun onCreate() {
        super.onCreate()
        createChannels(this)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(ONGOING_ID, ongoing(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            } else {
                startForeground(ONGOING_ID, ongoing())
            }
        } catch (e: RuntimeException) {
            // Android refuses a foreground start from the background (for
            // example when it restarts the service by itself). Give up quietly;
            // the user can start monitoring again from the app.
            stopSelf()
            return
        }
        running = true
        instance = this
        holdWake(true) // until the page reports the market state
        web = newWebView()
        handler.postDelayed(tick, TICK_MS)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun newWebView(): WebView = WebView(this).apply {
        settings.javaScriptEnabled = true // only the bundled page ever loads; see AppWebClient
        settings.domStorageEnabled = true // settings and the candle cache are shared with the app
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        // Not on screen, so tell WebView its renderer still matters.
        setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        webViewClient = AppWebClient(assets, settings.userAgentString) { dead -> rendererGone(dead) }
        addJavascriptInterface(Bridge(), "AndroidMonitor")
        loadUrl("${AppWebClient.ORIGIN}/monitor.html")
    }

    // The renderer crashed or was killed for memory: start a fresh page.
    private fun rendererGone(dead: WebView) {
        handler.post {
            if (!running || web !== dead) return@post
            dead.destroy()
            web = newWebView()
        }
    }

    // Long-lived by design while the market is open; released when it closes
    // and in onDestroy.
    @SuppressLint("WakelockTimeout", "Wakelock")
    private fun holdWake(on: Boolean) {
        val lock = wakeLock ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "xauusd:monitor")
            .also { wakeLock = it }
        if (on && !lock.isHeld) lock.acquire()
        if (!on && lock.isHeld) lock.release()
    }

    private fun alarmIntent(): PendingIntent = PendingIntent.getBroadcast(
        this, 2,
        Intent(this, MonitorAlarmReceiver::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun alarms() = getSystemService(Context.ALARM_SERVICE) as AlarmManager

    /** The market opened (or a wake-up alarm fired): keep the CPU awake and check now. */
    internal fun wake() {
        handler.post {
            if (!running) return@post
            holdWake(true)
            web?.evaluateJavascript(
                "window.__monitorResync && window.__monitorResync(); window.__monitorTick && window.__monitorTick()",
                null,
            )
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        // If Android kills the process for memory, bring monitoring back.
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        if (instance === this) instance = null
        handler.removeCallbacks(tick)
        alarms().cancel(alarmIntent())
        web?.destroy()
        web = null
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** Called from the page's JavaScript thread; work is posted to the main thread. */
    private inner class Bridge {
        /**
         * open: the market is open now. nextChangeMs: when that changes (epoch ms).
         * While closed, let the phone sleep and set an alarm for the reopening.
         * It must be an exact alarm: Android delivers an inexact one up to
         * hours late, which would miss the open.
         */
        @JavascriptInterface
        fun marketState(open: Boolean, nextChangeMs: Double) {
            handler.post {
                if (!running) return@post
                if (open) {
                    alarms().cancel(alarmIntent())
                    holdWake(true)
                } else {
                    val at = nextChangeMs.toLong().coerceAtLeast(System.currentTimeMillis() + 60_000)
                    val am = alarms()
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()) {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, alarmIntent())
                    } else {
                        // Exact alarms switched off for this app: the best Android allows.
                        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, alarmIntent())
                    }
                    holdWake(false)
                }
            }
        }

        @JavascriptInterface
        fun status(text: String) {
            handler.post {
                if (!running || text == statusText) return@post
                statusText = text.take(200)
                notifications().notify(ONGOING_ID, ongoing())
            }
        }

        @JavascriptInterface
        fun alert(title: String, body: String, key: String) {
            handler.post {
                if (!running) return@post
                val n = Notification.Builder(this@MonitorService, CHANNEL_ALERTS)
                    .setSmallIcon(R.drawable.ic_stat_levels)
                    .setContentTitle(title.take(120))
                    .setContentText(body.take(300))
                    .setStyle(Notification.BigTextStyle().bigText(body.take(600)))
                    .setContentIntent(openApp())
                    .setAutoCancel(true)
                    .setShowWhen(true)
                    .build()
                // One notification per level and kind: a repeat replaces the old one.
                notifications().notify(key, ALERT_ID, n)
            }
        }
    }

    private fun ongoing(): Notification {
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, MonitorService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_MONITOR)
            .setSmallIcon(R.drawable.ic_stat_levels)
            .setContentTitle("XAUUSD alerts on")
            .setContentText(statusText)
            .setContentIntent(openApp())
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this, 0,
        // Started from outside an activity, so it needs NEW_TASK.
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun notifications() = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    companion object {
        private const val ACTION_STOP = "com.xauusd.levels.STOP_MONITOR"
        private const val CHANNEL_MONITOR = "monitor"
        const val CHANNEL_ALERTS = "alerts"
        private const val ONGOING_ID = 1
        private const val ALERT_ID = 2
        private const val TICK_MS = 5_000L

        /** True while the service is alive in this process. */
        @Volatile
        var running = false
            private set

        // The running service, for the wake-up alarm. Cleared in onDestroy.
        @SuppressLint("StaticFieldLeak")
        @Volatile
        internal var instance: MonitorService? = null
            private set

        fun start(context: Context) {
            context.startForegroundService(Intent(context, MonitorService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, MonitorService::class.java))
        }

        fun createChannels(context: Context) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_MONITOR, "Monitoring status", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while background alerts are on"
                    setShowBadge(false)
                },
            )
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ALERTS, "Level alerts", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "Price near or through a support / resistance area"
                },
            )
        }
    }
}
