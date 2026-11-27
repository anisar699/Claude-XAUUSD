package com.xauusd.levels

import android.content.Context
import java.io.File

/**
 * The level record's rows (see js/data/levelrec.js): one CSV file in the
 * app's private storage, appended to by the app screen and the background
 * monitor. About 4 MB a year. Not backed up by Android (allowBackup is off):
 * the report download is the copy that leaves the phone.
 */
object LevelLog {
    private val lock = Any()

    fun file(ctx: Context): File = File(File(ctx.filesDir, "levels").apply { mkdirs() }, "level-record-v1.csv")

    /** Appends [text] (whole lines), writing [header] first into a new or empty file. */
    fun append(ctx: Context, header: String, text: String): Boolean = synchronized(lock) {
        try {
            val f = file(ctx)
            if (!f.isFile || f.length() == 0L) f.writeText(header.trimEnd('\n') + "\n", Charsets.UTF_8)
            f.appendText(text, Charsets.UTF_8)
            true
        } catch (e: Exception) {
            false
        }
    }

    fun read(ctx: Context): String = synchronized(lock) {
        try {
            val f = file(ctx)
            if (f.isFile) f.readText(Charsets.UTF_8) else ""
        } catch (e: Exception) {
            ""
        }
    }

    fun clear(ctx: Context): Boolean = synchronized(lock) {
        val f = file(ctx)
        !f.exists() || f.delete()
    }

    /** Copies the record to [dest] (header only if nothing is recorded yet). */
    fun copyTo(ctx: Context, header: String, dest: File): Boolean = synchronized(lock) {
        try {
            val f = file(ctx)
            if (f.isFile && f.length() > 0L) f.copyTo(dest, overwrite = true)
            else dest.writeText(header.trimEnd('\n') + "\n", Charsets.UTF_8)
            true
        } catch (e: Exception) {
            false
        }
    }
}
