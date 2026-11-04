package com.fieldreports.upload

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.PowerManager
import android.util.Log
import java.io.File
import kotlin.random.Random
import org.json.JSONArray
import org.json.JSONObject

/**
 * Sends the reports the app handed over while it is in the background, in
 * native code, so nothing depends on JS timers (React Native pauses them in
 * the background). Same rules as src/core/deliver.ts: one report at a time in
 * the order given, chunks sized to the link, transient failures retried with
 * backoff for as long as it runs, permanent ones left for the inspector.
 *
 * It never touches the reports database. What happened to each report goes to
 * a small results file, and the app applies it when it takes the reports
 * back, even if the process died in between.
 */
class BackgroundSender private constructor(
  private val context: Context,
  private val reports: List<Report>,
  baseUrl: String,
  private val listener: Listener,
) {
  interface Listener {
    fun progress(title: String, text: String, percent: Int)

    /** Every report was either sent or needs the inspector. */
    fun finished()
  }

  private class State(val report: Report) {
    var kind = "pending"
    var at = 0L
    var problem: JSONObject? = null
    val uploadedBytes = HashMap<String, Long>()
    var attempts = 0
    var nextAttemptAt = 0L
    var issue: JSONObject? = null
    /** A commit is out and its answer not yet in; still true if the sender is stopped meanwhile. */
    @Volatile var committing = false
  }

  @Volatile private var stopped = false
  private val lock = Object()
  private val states = reports.map { State(it) }
  private val protocol = UploadProtocol(baseUrl) { stopped }
  private var chunk = CHUNK_START
  /** After a failure, nothing is tried before this: the link is usually down for every report, not just one. */
  @Volatile private var holdUntil = 0L
  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private val wakeLock = context.getSystemService(PowerManager::class.java)
    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FieldReports:send")
    .apply { setReferenceCounted(false) }
  private val networkCallback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) {
      // A connection came back: stop waiting out the backoff.
      for (s in states) s.nextAttemptAt = 0
      holdUntil = 0
      wake()
    }
  }
  private val thread = Thread({ run() }, "FieldReports-sender")

  private fun start() {
    write()
    try {
      connectivity?.registerDefaultNetworkCallback(networkCallback)
    } catch (e: Exception) {
      Log.w(TAG, "no network callback", e)
    }
    thread.start()
  }

  /**
   * Stops sending and returns only once the sender thread has ended, so no
   * request of ours is still on the wire when the app starts its own. Every
   * call has a timeout, so this is bounded; cancelling repeatedly covers a call
   * that was being set up while we cancelled. Returns false if the thread
   * somehow outlived the bound.
   */
  private fun stop(): Boolean {
    stopped = true
    val deadline = System.currentTimeMillis() + STOP_WAIT_MS
    while (thread.isAlive && System.currentTimeMillis() < deadline) {
      protocol.cancel()
      wake()
      thread.join(STOP_POLL_MS)
    }
    val ended = !thread.isAlive
    if (!ended) Log.w(TAG, "sender thread still running after ${STOP_WAIT_MS / 1000}s")
    release()
    write()
    return ended
  }

  private fun release() {
    try {
      connectivity?.unregisterNetworkCallback(networkCallback)
    } catch (_: Exception) {}
    if (wakeLock.isHeld) wakeLock.release()
  }

  private fun wake() = synchronized(lock) { lock.notifyAll() }

  /** Sleeps up to `ms`, ending early (and throwing Stopped) if the sender is stopped meanwhile. */
  private fun pause(ms: Long) {
    synchronized(lock) { if (!stopped) lock.wait(ms.coerceAtLeast(1)) }
    if (stopped) throw Failure.Stopped()
  }

  private fun run() {
    try {
      while (!stopped) {
        val waiting = states.filter { it.kind == "pending" }
        if (waiting.isEmpty()) {
          if (!stopped) listener.finished()
          return
        }
        val now = System.currentTimeMillis()
        val next = if (now < holdUntil) null else waiting.firstOrNull { it.nextAttemptAt <= now }
        if (next == null) {
          if (wakeLock.isHeld) wakeLock.release()
          notifyProgress(null)
          val until = maxOf(holdUntil, waiting.minOf { it.nextAttemptAt })
          synchronized(lock) { if (!stopped) lock.wait((until - now).coerceAtLeast(1)) }
          continue
        }
        attempt(next)
      }
    } catch (e: InterruptedException) {
      // Stopping.
    } catch (e: Exception) {
      Log.e(TAG, "sender crashed", e)
    } finally {
      release()
    }
  }

  private fun attempt(s: State) {
    try {
      deliver(s)
      s.kind = "uploaded"
      s.at = System.currentTimeMillis()
      s.issue = null
      Log.i(TAG, "${s.report.id} sent in the background")
    } catch (e: Failure.Stopped) {
      return
    } catch (e: Failure.Permanent) {
      s.kind = "needs_attention"
      s.problem = JSONObject().put("code", e.code).put("message", e.message).apply {
        e.status?.let { put("status", it) }
        e.imageId?.let { put("imageId", it) }
      }
      Log.i(TAG, "${s.report.id} needs attention: ${e.message}")
    } catch (e: Failure) {
      if (stopped) return
      val transient = e as? Failure.Transient
      s.attempts += 1
      val online = connectivity?.activeNetwork != null
      val wait = maxOf(backoffMs(s.attempts, if (online) BACKOFF_MAX_MS else BACKOFF_OFFLINE_MAX_MS), transient?.retryAfterMs ?: 0)
      s.nextAttemptAt = System.currentTimeMillis() + wait
      holdUntil = s.nextAttemptAt
      val now = System.currentTimeMillis()
      s.issue = JSONObject()
        .put("reason", transient?.reason ?: "server")
        .put("message", e.message)
        .put("at", now)
        .put("since", s.issue?.optLong("since", now) ?: now)
      Log.i(TAG, "${s.report.id} attempt ${s.attempts} failed (${e.message}); retry in ${wait / 1000}s")
    } catch (e: java.io.IOException) {
      // The photo file can't be read.
      s.kind = "needs_attention"
      s.problem = JSONObject().put("code", "photo_missing").put("message", "A photo is no longer on this phone")
    }
    write()
  }

  /** Mirrors deliver() in src/core/deliver.ts from the manifest on. */
  private fun deliver(s: State) {
    val report = s.report
    for ((index, p) in report.photos.withIndex()) {
      val file = File(p.path)
      if (!file.exists() || file.length() != p.size)
        throw Failure.Permanent("photo_missing", "Photo ${index + 1} is no longer on this phone", imageId = p.id)
      if (p.size > MAX_IMAGE_BYTES)
        throw Failure.Permanent("too_large", "Photo ${index + 1} is over the 5 MB limit", imageId = p.id)
    }
    var corruptions = 0
    repeat(MAX_ROUNDS) {
      try {
        val offsets = protocol.putManifest(report) ?: return
        clearIssue(s)
        for ((index, photo) in report.photos.withIndex()) upload(s, index, photo, offsets[photo.id] ?: 0)
        notifyProgress(s, committing = true)
        s.committing = true
        val result = try {
          protocol.commit(report.id)
        } catch (e: Failure.Stopped) {
          // Cancelled with the commit out: the server may have published it. Keep the flag for the results.
          throw e
        } catch (e: Exception) {
          s.committing = false
          throw e
        }
        s.committing = false
        when (result) {
          is UploadProtocol.Commit.Committed -> return
          is UploadProtocol.Commit.Incomplete -> {}
          is UploadProtocol.Commit.Corrupted -> {
            corruptions += 1
            if (corruptions > MAX_CORRUPTIONS)
              throw Failure.Permanent("corrupted_repeatedly", "A photo keeps arriving damaged", imageId = result.imageId)
          }
        }
      } catch (e: Failure.Restart) {
        Log.i(TAG, "${report.id}: ${e.message}; starting over")
        for (p in report.photos) s.uploadedBytes[p.id] = 0
      }
    }
    throw Failure.Transient("server", "The server keeps asking for the upload again")
  }

  private fun upload(s: State, index: Int, photo: Photo, from: Long) {
    var offset = from
    var resyncs = 0
    var busyWaits = 0
    s.uploadedBytes[photo.id] = offset
    while (offset < photo.size) {
      wakeLock.acquire(WAKE_LOCK_MS)
      notifyProgress(s, photoIndex = index)
      val length = minOf(chunk.toLong(), photo.size - offset).toInt()
      val started = System.currentTimeMillis()
      val (next, resynced) = try {
        protocol.sendChunk(s.report.id, photo, offset, length)
      } catch (e: Failure.Transient) {
        // The server is still finishing a request that was cancelled at the hand-off. That isn't a
        // failure of the link: wait briefly and send the same chunk, without backoff or a smaller chunk.
        if (e.reason == "busy" && busyWaits < MAX_BUSY_WAITS) {
          busyWaits += 1
          pause(e.retryAfterMs ?: BUSY_WAIT_MS)
          continue
        }
        chunk = maxOf(CHUNK_MIN, chunk / 2)
        throw e
      }
      busyWaits = 0
      if (resynced) {
        if (++resyncs > 5) throw Failure.Transient("server", "Upload position keeps changing")
      } else {
        if (length >= chunk && System.currentTimeMillis() - started < CHUNK_FAST_MS) chunk = minOf(CHUNK_MAX, chunk * 2)
        resyncs = 0
      }
      offset = minOf(next, photo.size)
      s.uploadedBytes[photo.id] = offset
      clearIssue(s)
      write()
    }
  }

  private fun clearIssue(s: State) {
    s.attempts = 0
    s.issue = null
  }

  private fun notifyProgress(s: State?, photoIndex: Int = 0, committing: Boolean = false) {
    val waiting = states.count { it.kind == "pending" }
    val title = if (waiting == 1) "Sending 1 report" else "Sending $waiting reports"
    if (s == null) {
      val issue = states.firstOrNull { it.kind == "pending" }?.issue
      listener.progress(title, if (issue != null) "Waiting to try again · ${issue.optString("message")}" else "Waiting to try again", -1)
      return
    }
    if (committing) return listener.progress(title, "Confirming with the server", -1)
    val sent = s.report.photos.sumOf { s.uploadedBytes[it.id] ?: 0 }
    val total = s.report.photos.sumOf { it.size }.coerceAtLeast(1)
    val percent = ((sent * 100) / total).toInt()
    listener.progress(title, "Photo ${photoIndex + 1} of ${s.report.photos.size} · $percent%", percent)
  }

  /** The results file, written whole and renamed into place so it is never half-written. */
  @Synchronized
  private fun write() {
    // After a stop, only stop() itself writes: a late chunk must not overwrite results the app already took.
    if (stopped && Thread.currentThread() === thread) return
    val out = JSONArray()
    for (s in states) {
      val item = JSONObject().put("id", s.report.id).put("kind", s.kind)
      when (s.kind) {
        "uploaded" -> item.put("at", s.at)
        "needs_attention" -> item.put("problem", s.problem)
        else -> {
          val bytes = JSONObject()
          for ((id, n) in s.uploadedBytes) bytes.put(id, n)
          item.put("uploadedBytes", bytes).put("issue", s.issue ?: JSONObject.NULL).put("committing", s.committing)
        }
      }
      out.put(item)
    }
    try {
      val tmp = File(context.filesDir, "$RESULTS_FILE.tmp")
      tmp.writeText(out.toString())
      if (!tmp.renameTo(results(context))) Log.w(TAG, "could not save results")
    } catch (e: Exception) {
      Log.w(TAG, "could not save results", e)
    }
  }

  companion object {
    private const val TAG = "BackgroundSender"
    private const val RESULTS_FILE = "background-sender.json"
    private const val MAX_IMAGE_BYTES = 5_000_000L
    private const val MAX_ROUNDS = 6
    private const val MAX_CORRUPTIONS = 2
    private const val CHUNK_MIN = 16 * 1024
    private const val CHUNK_MAX = 1024 * 1024
    private const val CHUNK_START = 64 * 1024
    private const val CHUNK_FAST_MS = 4_000L
    private const val BACKOFF_BASE_MS = 2_000L
    private const val BACKOFF_MAX_MS = 60_000L
    private const val BACKOFF_OFFLINE_MAX_MS = 300_000L
    /** Longer than the longest call (a chunk, 60 s), so a stop always outlasts the request it cancels. */
    private const val STOP_WAIT_MS = UploadProtocol.CHUNK_TIMEOUT_MS + 10_000L
    private const val STOP_POLL_MS = 250L
    /** A 423 means another request (usually the app's own, just cancelled) still holds the photo. */
    private const val MAX_BUSY_WAITS = 5
    private const val BUSY_WAIT_MS = 2_000L
    /** Longer than one chunk can take; renewed before every chunk. */
    private const val WAKE_LOCK_MS = 2 * 60_000L

    @Volatile private var current: BackgroundSender? = null

    val isSending: Boolean
      get() = current?.let { !it.stopped && it.thread.isAlive } == true

    /** Starts sending `reportsJson` (as built by src/core/handoff.ts), replacing any sender already running. */
    @Synchronized
    fun start(context: Context, reportsJson: String, baseUrl: String, listener: Listener) {
      current?.stop()
      val list = JSONArray(reportsJson)
      val reports = (0 until list.length()).map { i ->
        val r = list.getJSONObject(i)
        val images = r.getJSONArray("images")
        Report(
          id = r.getString("id"),
          description = r.getString("description"),
          createdAt = if (r.isNull("createdAt")) null else r.getString("createdAt"),
          photos = (0 until images.length()).map { j ->
            val p = images.getJSONObject(j)
            Photo(p.getString("id"), p.getString("path").removePrefix("file://"), p.getLong("size"), p.getString("sha256"))
          },
        )
      }
      current = BackgroundSender(context.applicationContext, reports, baseUrl, listener).also { it.start() }
    }

    /**
     * Stops the sender, if one is running, and returns once its thread has ended
     * (true), so nothing it sent is still in flight. False only if it outlived the bound.
     */
    @Synchronized
    fun stop(): Boolean {
      val ended = current?.stop() ?: true
      current = null
      return ended
    }

    /** What the last sender did, or null; removed once read, so it is applied once. */
    @Synchronized
    fun takeResults(context: Context): String? {
      val file = results(context)
      if (!file.exists()) return null
      return try {
        file.readText()
      } catch (e: Exception) {
        null
      } finally {
        file.delete()
      }
    }

    private fun results(context: Context) = File(context.filesDir, RESULTS_FILE)

    private fun backoffMs(attempt: Int, maxMs: Long): Long {
      val exp = minOf(maxMs, BACKOFF_BASE_MS shl (attempt - 1).coerceIn(0, 20))
      return exp / 2 + (Random.nextDouble() * exp / 2).toLong()
    }
  }
}
