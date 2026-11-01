package com.fieldreports.upload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.fieldreports.MainActivity

/**
 * Keeps the process in the foreground while reports are waiting, so the JS
 * uploader keeps running after the inspector leaves the app. The service does
 * no work itself; it only holds the "Sending reports" notification that Android
 * requires for that. The JS side starts it, updates the text and stops it.
 */
class UploadForegroundService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Sending reports"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    val percent = intent?.getIntExtra(EXTRA_PERCENT, -1) ?: -1
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      build(this, title, text, percent),
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
    )
    // If the OS kills us, don't restart empty: the JS side restarts the service when work remains.
    return START_NOT_STICKY
  }

  /** Android 15+ caps dataSync services at about six hours a day; stop cleanly when told. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  companion object {
    const val CHANNEL_ID = "uploads"
    const val NOTIFICATION_ID = 4001
    const val ACTION_START = "com.fieldreports.upload.START"
    const val ACTION_STOP = "com.fieldreports.upload.STOP"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_PERCENT = "percent"

    fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL_ID) != null) return
      val channel = NotificationChannel(CHANNEL_ID, "Sending reports", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while reports are waiting to reach the server"
        setShowBadge(false)
      }
      manager.createNotificationChannel(channel)
    }

    fun build(context: Context, title: String, text: String, percent: Int): Notification {
      ensureChannel(context)
      val open = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      return NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_upload)
        .setContentTitle(title)
        .setContentText(text)
        .setContentIntent(open)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setCategory(NotificationCompat.CATEGORY_PROGRESS)
        .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        .apply { if (percent >= 0) setProgress(100, percent, false) }
        .build()
    }
  }
}
