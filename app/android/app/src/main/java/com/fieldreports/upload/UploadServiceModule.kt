package com.fieldreports.upload

import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext

/** JS control of [UploadForegroundService]: start while work is waiting, update its text, stop when done. */
class UploadServiceModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

  private var running = false
  private var keepAliveTaskId: Int? = null

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
      startKeepAlive()
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
    stopKeepAlive()
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

  /**
   * React Native stops firing JS timers while the app is in the background,
   * unless a headless JS task is running. fetch() hands back its result through
   * a timer, and retries and timeouts are timers too, so without this the
   * uploader would stall at the first fetch after the app is left. A task that
   * lives exactly as long as the service keeps them running. The JS side
   * registers it in index.js as a promise that never settles; it is finished here.
   */
  private fun startKeepAlive() = UiThreadUtil.runOnUiThread {
    val tasks = HeadlessJsTaskContext.getInstance(context)
    if (keepAliveTaskId?.let { tasks.isTaskRunning(it) } == true) return@runOnUiThread
    keepAliveTaskId = tasks.startTask(HeadlessJsTaskConfig(KEEP_ALIVE_TASK, Arguments.createMap(), 0, true))
  }

  private fun stopKeepAlive() = UiThreadUtil.runOnUiThread {
    val id = keepAliveTaskId ?: return@runOnUiThread
    keepAliveTaskId = null
    val tasks = HeadlessJsTaskContext.getInstance(context)
    if (tasks.isTaskRunning(id)) tasks.finishTask(id)
  }

  // Required by NativeEventEmitter on the JS side.
  @ReactMethod
  fun addListener(eventName: String) {}

  @ReactMethod
  fun removeListeners(count: Double) {}

  companion object {
    const val STOPPED_EVENT = "UploadServiceStopped"
    const val KEEP_ALIVE_TASK = "FieldReportsKeepAlive"
    private const val TAG = "UploadService"

    @Volatile
    private var instance: UploadServiceModule? = null

    /** Called by the service when Android stops it, not the app. */
    fun serviceStopped(reason: String) {
      val module = instance ?: return
      module.running = false
      module.stopKeepAlive()
      if (module.context.hasActiveReactInstance()) module.context.emitDeviceEvent(STOPPED_EVENT, reason)
    }
  }
}
