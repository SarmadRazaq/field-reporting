package com.fieldreports.upload

import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS control of [UploadForegroundService] (start while work is waiting, update
 * its text, stop when done) and of the [BackgroundSender] that sends while the
 * app is in the background.
 */
class UploadServiceModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

  @Volatile private var running = false

  init {
    instance = this
  }

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
      Log.w(TAG, "stop intent refused, stopping directly", e)
      context.stopService(Intent(context, UploadForegroundService::class.java))
    }
  }

  @ReactMethod
  fun isRunning(promise: Promise) = promise.resolve(running)

  /**
   * The app is leaving the foreground: send `reportsJson` natively from here on.
   * Only while the service runs, since that is what keeps the process alive;
   * resolves false (and sends nothing) otherwise, and JS keeps the reports.
   */
  @ReactMethod
  fun handOff(reportsJson: String, baseUrl: String, promise: Promise) {
    if (!running) return promise.resolve(false)
    try {
      BackgroundSender.start(context, reportsJson, baseUrl, senderListener)
      promise.resolve(true)
    } catch (e: Exception) {
      Log.w(TAG, "hand-off refused", e)
      promise.resolve(false)
    }
  }

  /**
   * Stops the native sender and returns what happened to each report it had
   * (JSON, see src/core/handoff.ts), or null if there is nothing to apply.
   * Also picks up results left by a sender whose process died.
   */
  @ReactMethod
  fun takeBack(promise: Promise) {
    Thread {
      try {
        BackgroundSender.stop()
        promise.resolve(BackgroundSender.takeResults(context))
      } catch (e: Exception) {
        promise.reject("take_back_failed", e)
      }
    }.start()
  }

  @ReactMethod
  fun isSending(promise: Promise) = promise.resolve(BackgroundSender.isSending)

  private val senderListener = object : BackgroundSender.Listener {
    override fun progress(title: String, text: String, percent: Int) = update(title, text, percent.toDouble())

    override fun finished() {
      stop()
      emitStopped("done")
    }
  }

  private fun emitStopped(reason: String) {
    if (context.hasActiveReactInstance()) context.emitDeviceEvent(STOPPED_EVENT, reason)
  }

  /**
   * Whether Android's battery optimisation (Doze, app standby) applies to this
   * app. While it does, background wake-ups can be held back for an hour or more.
   */
  @ReactMethod
  fun isIgnoringBatteryOptimizations(promise: Promise) {
    val power = context.getSystemService(PowerManager::class.java)
    promise.resolve(power?.isIgnoringBatteryOptimizations(context.packageName) == true)
  }

  /**
   * Asks the inspector, through the system dialog, to let this app send while the
   * phone saves battery. Falls back to the system list if the dialog isn't available.
   */
  @ReactMethod
  fun requestIgnoreBatteryOptimizations() {
    val direct = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(direct)
    } catch (e: Exception) {
      context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }

  // Required by NativeEventEmitter on the JS side.
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Double) {}

  companion object {
    const val STOPPED_EVENT = "UploadServiceStopped"
    private const val TAG = "UploadService"

    @Volatile
    private var instance: UploadServiceModule? = null

    /** Called by the service when Android stops it, not the app. */
    fun serviceStopped(reason: String) {
      val module = instance ?: return
      module.running = false
      module.emitStopped(reason)
    }
  }
}
