package com.xauusd.levels

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Wakes background monitoring when the market reopens (see MonitorService.Bridge.marketState). */
class MonitorAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        MonitorService.instance?.wake()
    }
}
