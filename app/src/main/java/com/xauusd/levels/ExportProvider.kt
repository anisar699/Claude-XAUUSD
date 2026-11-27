package com.xauusd.levels

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/**
 * Hands an exported file (the trade journal or the level report, as CSV) to the app the user
 * shares it with. Files live in cache/exports; access is granted per share
 * with a temporary read permission, so the provider itself is not exported.
 */
class ExportProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    private fun fileFor(uri: Uri): File {
        val name = uri.lastPathSegment ?: throw FileNotFoundException()
        // Only plain names inside the exports folder.
        if (name.contains('/') || name.contains("..")) throw FileNotFoundException()
        val ctx = context ?: throw FileNotFoundException()
        val f = File(exportDir(ctx.cacheDir), name)
        if (!f.isFile) throw FileNotFoundException()
        return f
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("read only")
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun getType(uri: Uri): String =
        if (uri.lastPathSegment?.endsWith(".csv") == true) "text/csv" else "application/octet-stream"

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor {
        val f = fileFor(uri)
        val cols = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val cursor = MatrixCursor(cols)
        cursor.addRow(cols.map { if (it == OpenableColumns.SIZE) f.length() else if (it == OpenableColumns.DISPLAY_NAME) f.name else null }.toTypedArray())
        return cursor
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?): Int = 0
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?): Int = 0

    companion object {
        fun authority(packageName: String) = "$packageName.exports"
        fun exportDir(cache: File) = File(cache, "exports").apply { mkdirs() }
    }
}
