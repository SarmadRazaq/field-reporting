package com.fieldreports.upload

import android.app.NotificationManager
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/** JS control of [UploadForegroundService]: start while work is waiting, update its text, stop when done. */
class UploadServiceModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

  private var running = false

  override fun getName() = "UploadService"

  /**
   * Resolves true if the service is (now) in the foreground. Android 12+ refuses
   * to start one from the background, so the JS side starts it while the app is
   * visible; a refusal is reported, not thrown.
   */
  @ReactMethod
  fun start(title: String, text: String, percent: Double, promise: Promise) {
    val intent = Intent(context, UploadForegroundService::class.java).apply {
      action = UploadForegroundService.ACTION_START
      putExtra(UploadForegroundService.EXTRA_TITLE, title)
      putExtra(UploadForegroundService.EXTRA_TEXT, text)
      putExtra(UploadForegroundService.EXTRA_PERCENT, percent.toInt())
    }
    try {
      ContextCompat.startForegroundService(context, intent)
      running = true
      promise.resolve(true)
    } catch (e: Exception) {
      // ForegroundServiceStartNotAllowedException (API 31+) and friends.
      running = false
      promise.resolve(false)
    }
  }

  /** Changes the notification of a running service without restarting it. */
  @ReactMethod
  fun update(title: String, text: String, percent: Double) {
    if (!running) return
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.notify(
      UploadForegroundService.NOTIFICATION_ID,
      UploadForegroundService.build(context, title, text, percent.toInt()),
    )
  }

  @ReactMethod
  fun stop() {
    if (!running) return
    running = false
    val intent = Intent(context, UploadForegroundService::class.java).apply { action = UploadForegroundService.ACTION_STOP }
    try {
      context.startService(intent)
    } catch (e: Exception) {
      context.stopService(Intent(context, UploadForegroundService::class.java))
    }
  }

  @ReactMethod
  fun isRunning(promise: Promise) = promise.resolve(running)

  companion object {
    val supported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
  }
}
