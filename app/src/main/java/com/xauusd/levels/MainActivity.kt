package com.xauusd.levels

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView

/**
 * A thin shell: one WebView showing the bundled web UI (assets/www), served
 * by [AppWebClient]. Background alerts live in [MonitorService]; the page
 * controls them through [Bridge].
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
            javaScriptEnabled = true // only the bundled UI ever loads; see AppWebClient
            domStorageEnabled = true // settings and the candle cache live in localStorage
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        // If the renderer dies, rebuild the screen instead of crashing.
        web.webViewClient = AppWebClient(assets, web.settings.userAgentString) { recreate() }
        web.addJavascriptInterface(Bridge(), "AndroidApp")
        MonitorService.createChannels(this)
        setContentView(web)
        web.loadUrl("${AppWebClient.ORIGIN}/index.html")
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        // Permissions or battery settings may have changed while away.
        notifyPage()
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

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_NOTIFICATIONS) {
            // Without the permission the alerts could not be shown, so do not
            // start; the page then offers the notification settings instead.
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startMonitor()
            notifyPage()
        }
    }

    private fun notificationsAllowed(): Boolean =
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).areNotificationsEnabled()

    private fun startMonitor() {
        try {
            MonitorService.start(this)
        } catch (e: RuntimeException) {
            // Android can refuse a foreground-service start; the page keeps showing "Off".
        }
        // The service flips its running flag in onCreate, just after this returns.
        web.postDelayed({ notifyPage() }, 600)
    }

    private fun notifyPage() {
        web.evaluateJavascript("window.__onNativeState && window.__onNativeState()", null)
    }

    private fun open(intent: Intent, fallback: Intent? = null) {
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            if (fallback != null) try {
                startActivity(fallback)
            } catch (ignored: ActivityNotFoundException) {
            }
        }
    }

    /** Methods the page calls as window.AndroidApp. They run on a WebView thread. */
    private inner class Bridge {
        @JavascriptInterface
        fun monitoring(): Boolean = MonitorService.running

        /** "state|status text", e.g. "running|4012 · R 4020.50 (+8)". See MonitorService.state. */
        @JavascriptInterface
        fun monitorState(): String =
            if (MonitorService.running) "${MonitorService.state}|${MonitorService.statusLine}" else "${MonitorService.state}|"

        @JavascriptInterface
        fun notificationsAllowed(): Boolean = this@MainActivity.notificationsAllowed()

        /** The "Level alerts" channel can be switched off on its own in Android settings. */
        @JavascriptInterface
        fun alertChannelEnabled(): Boolean {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channel = nm.getNotificationChannel(MonitorService.CHANNEL_ALERTS) ?: return true
            return channel.importance != NotificationManager.IMPORTANCE_NONE
        }

        @JavascriptInterface
        fun openAlertChannelSettings() = runOnUiThread {
            open(
                Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    .putExtra(Settings.EXTRA_CHANNEL_ID, MonitorService.CHANNEL_ALERTS),
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
            )
        }

        @JavascriptInterface
        fun batteryUnrestricted(): Boolean =
            (getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)

        @JavascriptInterface
        fun startMonitoring() = runOnUiThread {
            val needsRuntimeGrant = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            when {
                needsRuntimeGrant -> requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
                !this@MainActivity.notificationsAllowed() -> notifyPage()
                else -> startMonitor()
            }
        }

        @JavascriptInterface
        fun stopMonitoring() = runOnUiThread {
            MonitorService.stop(this@MainActivity)
            web.postDelayed({ notifyPage() }, 300)
        }

        @JavascriptInterface
        fun openNotificationSettings() = runOnUiThread {
            open(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        }

        @JavascriptInterface
        fun openBatterySettings() = runOnUiThread {
            open(
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.fromParts("package", packageName, null)),
            )
        }
    }

    private companion object {
        const val REQUEST_NOTIFICATIONS = 1
    }
}
