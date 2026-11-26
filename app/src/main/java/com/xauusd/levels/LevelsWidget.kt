package com.xauusd.levels

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.widget.RemoteViews
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Home-screen widget: price, change and the nearest resistance and support.
 *
 * It has no data source of its own. Whichever page is running (the app
 * screen, or background monitoring) hands it a snapshot through [push], at
 * most every 15 seconds; the widget shows the last one with its time. "Live"
 * is shown only while the snapshot is under [LIVE_MS] old: each push also
 * sets a redraw for just after that, so when updates stop the widget turns
 * to "Last <time>" by itself instead of looking live.
 */
class LevelsWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        render(context, manager, ids)
    }

    companion object {
        private const val PREFS = "widget"
        private const val KEY = "snapshot"
        private const val LIVE_MS = 120_000L

        /** Store a snapshot (JSON from js/data/widget.js) and redraw every widget. */
        fun push(context: Context, json: String) {
            if (json.length > 2000) return
            try {
                JSONObject(json)
            } catch (e: Exception) {
                return
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).apply()
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, LevelsWidget::class.java))
            if (ids.isEmpty()) return
            render(context, manager, ids)
            // Redraw once the snapshot has aged past "live" (replaced by the
            // next push while updates keep coming). Inexact is enough.
            val redraw = PendingIntent.getBroadcast(
                context, 4,
                Intent(context, LevelsWidget::class.java)
                    .setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE)
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager)
                .set(AlarmManager.RTC, System.currentTimeMillis() + LIVE_MS + 15_000, redraw)
        }

        private fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
            val views = RemoteViews(context.packageName, R.layout.widget_levels)
            val json = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
            val d = try {
                json?.let { JSONObject(it) }
            } catch (e: Exception) {
                null
            }
            if (d == null) {
                views.setTextViewText(R.id.w_price, "–")
                views.setTextViewText(R.id.w_change, "Open the app to load prices")
                views.setTextViewText(R.id.w_res, "")
                views.setTextViewText(R.id.w_sup, "")
                views.setTextViewText(R.id.w_time, "")
            } else {
                views.setTextViewText(R.id.w_price, d.optString("price", "–"))
                views.setTextViewText(R.id.w_change, d.optString("change", ""))
                if (!d.isNull("up")) {
                    views.setTextColor(R.id.w_change, if (d.optBoolean("up")) Color.parseColor("#26A69A") else Color.parseColor("#EF5350"))
                }
                views.setTextViewText(R.id.w_res, d.optString("r", ""))
                views.setTextViewText(R.id.w_sup, d.optString("s", ""))
                val at = d.optLong("at", 0L)
                val age = System.currentTimeMillis() - at
                val pattern = if (age < 20 * 3600_000L) "HH:mm" else "d MMM HH:mm"
                val time = if (at > 0) SimpleDateFormat(pattern, Locale.getDefault()).format(Date(at)) else ""
                val state = if (d.optBoolean("live") && age in 0 until LIVE_MS) "Live" else "Last"
                val session = d.optString("session", "")
                views.setTextViewText(R.id.w_time, listOf("$state $time", session).filter { it.isNotBlank() }.joinToString(" · "))
            }
            val open = PendingIntent.getActivity(
                context, 3,
                Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            views.setOnClickPendingIntent(R.id.w_root, open)
            manager.updateAppWidget(ids, views)
        }
    }
}
