package com.fieldreports.upload

import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject

/**
 * The server's resumable upload protocol, the same one src/core/protocol.ts
 * speaks, with the same failure classes as src/core/retry.ts:
 *
 *   PUT   /v1/reports/:id                 manifest; idempotent; answers with per-image offsets
 *   PATCH /v1/reports/:id/images/:image   raw bytes at Upload-Offset
 *   POST  /v1/reports/:id/commit          verify sha256s and publish; idempotent
 */

data class Photo(val id: String, val path: String, val size: Long, val sha256: String)

data class Report(val id: String, val description: String, val createdAt: String?, val photos: List<Photo>)

/** Why an attempt failed, sorted into what to do about it. */
sealed class Failure(message: String) : Exception(message) {
  /** Try again later, on our own. */
  class Transient(val reason: String, message: String, val retryAfterMs: Long? = null) : Failure(message)

  /** Stop and ask the inspector; the same bytes would get the same answer. */
  class Permanent(val code: String, message: String, val status: Int? = null, val imageId: String? = null) : Failure(message)

  /** The server no longer knows this report; send the manifest again. */
  class Restart(message: String) : Failure(message)

  /** The sender was told to stop (the app took the reports back). Not a failure. */
  class Stopped : Failure("stopped")
}

class UploadProtocol(private val baseUrl: String, private val isStopped: () -> Boolean) {

  @Volatile private var current: Call? = null

  /** Cancels the request in flight, if any. */
  fun cancel() {
    current?.cancel()
  }

  sealed class Commit {
    object Committed : Commit()
    object Incomplete : Commit()
    class Corrupted(val imageId: String) : Commit()
  }

  /** Returns null if the report is already committed, otherwise the offset the server holds per photo. */
  fun putManifest(report: Report): Map<String, Long>? {
    val images = JSONArray()
    for (p in report.photos) {
      images.put(JSONObject().put("id", p.id).put("sha256", p.sha256).put("size", p.size).put("mime", "image/jpeg"))
    }
    val body = JSONObject()
      .put("description", report.description)
      .put("createdAt", report.createdAt ?: JSONObject.NULL)
      .put("images", images)
    val (status, json, headers) = send(
      Request.Builder().url(url("/v1/reports/${report.id}")).put(body.toString().toRequestBody(JSON)).build(),
      CONTROL_TIMEOUT_MS,
    )
    if (status != 200 && status != 201) throw classify(status, json, headers)
    if (json?.optString("status") == "committed") return null
    val offsets = HashMap<String, Long>()
    val list = json?.optJSONArray("images") ?: JSONArray()
    for (i in 0 until list.length()) {
      val image = list.getJSONObject(i)
      offsets[image.getString("id")] = image.optLong("offset", 0)
    }
    return offsets
  }

  /** Sends `length` bytes of the photo from `offset`; returns the offset the server now holds and whether it moved us. */
  fun sendChunk(reportId: String, photo: Photo, offset: Long, length: Int): Pair<Long, Boolean> {
    val bytes = ByteArray(length)
    RandomAccessFile(File(photo.path), "r").use {
      it.seek(offset)
      it.readFully(bytes)
    }
    val request = Request.Builder()
      .url(url("/v1/reports/$reportId/images/${photo.id}"))
      .header("Upload-Offset", offset.toString())
      .patch(bytes.toRequestBody(OCTETS))
      .build()
    val (status, json, headers) = send(request, CHUNK_TIMEOUT_MS)
    if (status == 200 && json?.has("offset") == true) return json.getLong("offset") to false
    if (status == 409 && json?.optString("code") == "offset_mismatch" && json.has("offset")) return json.getLong("offset") to true
    if (status == 409 && json?.optString("code") == "already_committed") return (offset + length) to true
    throw classify(status, json, headers)
  }

  fun commit(reportId: String): Commit {
    val (status, json, headers) = send(
      Request.Builder().url(url("/v1/reports/$reportId/commit")).post(ByteArray(0).toRequestBody(null)).build(),
      CONTROL_TIMEOUT_MS,
    )
    if (status == 200) return Commit.Committed
    if (status == 409 && json?.optString("code") == "incomplete") return Commit.Incomplete
    if (status == 409 && json?.optString("code") == "checksum_mismatch" && json.has("imageId"))
      return Commit.Corrupted(json.getString("imageId"))
    throw classify(status, json, headers)
  }

  private fun url(path: String) = baseUrl.trimEnd('/') + path

  private fun send(request: Request, timeoutMs: Long): Triple<Int, JSONObject?, Map<String, String>> {
    if (isStopped()) throw Failure.Stopped()
    val call = client.newBuilder().callTimeout(timeoutMs, TimeUnit.MILLISECONDS).build().newCall(request)
    current = call
    try {
      call.execute().use { res -> return Triple(res.code, parse(res), res.headers.associate { it.first.lowercase() to it.second }) }
    } catch (e: IOException) {
      if (isStopped() || call.isCanceled()) throw Failure.Stopped()
      if (e is InterruptedIOException) throw Failure.Transient("timeout", "No answer from the server")
      throw Failure.Transient("offline", "No connection")
    } finally {
      current = null
    }
  }

  private fun parse(res: Response): JSONObject? {
    val text = res.body?.string().orEmpty()
    return try {
      if (text.isBlank()) null else JSONObject(text)
    } catch (e: Exception) {
      null
    }
  }

  companion object {
    const val CONTROL_TIMEOUT_MS = 30_000L
    const val CHUNK_TIMEOUT_MS = 60_000L
    private val JSON = "application/json".toMediaType()
    private val OCTETS = "application/offset+octet-stream".toMediaType()
    private val client = OkHttpClient.Builder().retryOnConnectionFailure(false).build()

    /** Same table as classifyResponse in src/core/retry.ts. */
    fun classify(status: Int, body: JSONObject?, headers: Map<String, String>): Failure {
      val detail = body?.optString("message")?.takeIf { it.isNotEmpty() }
      val retryAfter = retryAfterMs(headers["retry-after"])
      return when {
        status == 408 -> Failure.Transient("timeout", "The server timed out")
        status == 423 || status == 425 -> Failure.Transient("busy", "The server is still busy with this upload", retryAfter)
        status == 429 -> Failure.Transient("rate_limited", "The server asked us to slow down", retryAfter)
        status >= 500 -> Failure.Transient("server", "Server error ($status)", retryAfter)
        status == 404 -> Failure.Restart("The server no longer has this report")
        status == 413 -> Failure.Permanent("too_large", detail ?: "The server refused a photo as too large", status)
        status == 401 || status == 403 -> Failure.Permanent("forbidden", detail ?: "The server refused this upload", status)
        status == 409 -> Failure.Permanent("conflict", detail ?: "The server holds a different report with this id", status)
        status == 400 || status == 422 -> Failure.Permanent("invalid", detail ?: "The server rejected this report", status)
        else -> Failure.Permanent("refused", detail ?: "The server refused the upload ($status)", status)
      }
    }

    private fun retryAfterMs(raw: String?): Long? {
      val seconds = raw?.trim()?.toDoubleOrNull() ?: return null
      return (seconds * 1000).toLong().coerceAtLeast(0)
    }
  }
}
