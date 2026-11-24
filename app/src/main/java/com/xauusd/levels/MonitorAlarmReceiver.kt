package com.xauusd.levels

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The monitor's alarm (see MonitorService.Bridge.marketState): at the market
 * reopening, and every 15 minutes while it is open. A running service is
 * woken to check now; if Android killed the app while monitoring was on, the
 * service is started again.
 */
class MonitorAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val service = MonitorService.instance
        if (service != null) service.wake()
        else if (MonitorService.wanted(context)) MonitorService.revive(context)
    }
}
