package com.fieldreports.photos

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import java.io.File
import java.util.concurrent.Executors

/**
 * JS access to [PhotoEncoder]. One call per photo, run on a single background
 * thread: never on the JS or UI thread, and never two full-size bitmaps in
 * memory at once, however many photos are queued.
 */
class PhotoEncoderModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {

  private val worker = Executors.newSingleThreadExecutor()

  override fun getName() = "PhotoEncoder"

  @ReactMethod
  fun encodeToFit(src: String, dest: String, steps: ReadableArray, maxBytes: Double, promise: Promise) {
    val ladder = (0 until steps.size()).map { i ->
      val step = steps.getMap(i) ?: throw IllegalArgumentException("step $i is not an object")
      PhotoEncoder.Step(step.getInt("maxEdge"), step.getInt("quality"))
    }
    worker.execute {
      try {
        val result = Arguments.createMap()
        when (val out = PhotoEncoder.encodeToFit(File(src), File(dest), ladder, maxBytes.toLong())) {
          is PhotoEncoder.Result.Ok -> {
            result.putString("kind", "ok")
            result.putInt("size", out.size)
            result.putInt("width", out.width)
            result.putInt("height", out.height)
          }
          PhotoEncoder.Result.Unreadable -> result.putString("kind", "unreadable")
          PhotoEncoder.Result.TooLarge -> result.putString("kind", "too_large")
        }
        promise.resolve(result)
      } catch (e: Exception) {
        // Disk errors and the like: not a verdict on the photo, so the JS side treats it as retryable.
        promise.reject("encode_failed", e.message, e)
      }
    }
  }

  override fun invalidate() {
    worker.shutdown()
    super.invalidate()
  }
}
