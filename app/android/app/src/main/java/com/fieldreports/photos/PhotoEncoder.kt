package com.fieldreports.photos

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.Build
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Turns a camera original into a JPEG under a byte limit, decoding it once.
 *
 * The steps (long edge, quality) come from the JS core, which owns the policy.
 * The photo is decoded at the size of the first step and every later step is
 * scaled down from that bitmap, so a detailed 50 MP photo that needs four
 * tries is still read from disk and decoded only once. If decoding runs out of
 * memory, it is retried at the next smaller step's size.
 *
 * On Android 9+ decoding goes through ImageDecoder, which reads HEIC/HEIF as
 * well as JPEG, PNG and WebP and applies EXIF orientation. Older phones use
 * BitmapFactory (no HEIC) and rotate by the EXIF tag here.
 */
object PhotoEncoder {

  data class Step(val maxEdge: Int, val quality: Int)

  sealed class Result {
    data class Ok(val size: Int, val width: Int, val height: Int) : Result()
    object Unreadable : Result()
    object TooLarge : Result()
  }

  /** The photo can't be decoded at any size: corrupt, or a format this phone doesn't read. */
  private class NotAnImage(message: String) : IOException(message)

  fun encodeToFit(src: File, dest: File, steps: List<Step>, maxBytes: Long): Result {
    var base: Bitmap? = null
    var baseEdge = 0
    var smallestFailedEdge = Int.MAX_VALUE
    var decodedOnce = false
    try {
      for (step in steps) {
        if (step.maxEdge >= smallestFailedEdge) continue
        if (base == null || baseEdge < step.maxEdge) {
          base?.recycle()
          base = null
          try {
            base = decode(src, step.maxEdge)
            baseEdge = step.maxEdge
          } catch (e: OutOfMemoryError) {
            smallestFailedEdge = step.maxEdge
            continue
          } catch (e: IOException) {
            return Result.Unreadable
          }
        }
        decodedOnce = true
        val bitmap = base!!
        val scaled = scaleToFit(bitmap, step.maxEdge)
        val width = scaled.width
        val height = scaled.height
        val bytes = ByteArrayOutputStream(1 shl 20)
        try {
          scaled.compress(Bitmap.CompressFormat.JPEG, step.quality, bytes)
        } catch (e: OutOfMemoryError) {
          smallestFailedEdge = step.maxEdge
          continue
        } finally {
          if (scaled !== bitmap) scaled.recycle()
        }
        if (bytes.size() <= maxBytes) {
          FileOutputStream(dest).use { out ->
            bytes.writeTo(out)
            out.fd.sync()
          }
          return Result.Ok(bytes.size(), width, height)
        }
      }
    } finally {
      base?.recycle()
    }
    return if (decodedOnce) Result.TooLarge else Result.Unreadable
  }

  /** Decode with the long edge at least `maxEdge` where the photo allows, subsampling to save memory. */
  private fun decode(src: File, maxEdge: Int): Bitmap =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) decodeWithImageDecoder(src, maxEdge) else decodeWithBitmapFactory(src, maxEdge)

  private fun decodeWithImageDecoder(src: File, maxEdge: Int): Bitmap =
    try {
      ImageDecoder.decodeBitmap(ImageDecoder.createSource(src)) { decoder, info, _ ->
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        decoder.setTargetSampleSize(sampleSize(info.size.width, info.size.height, maxEdge))
      }
    } catch (e: ImageDecoder.DecodeException) {
      throw NotAnImage(e.message ?: "decode failed")
    }

  private fun decodeWithBitmapFactory(src: File, maxEdge: Int): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(src.path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw NotAnImage("not an image this phone can read")
    val options = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, maxEdge) }
    val bitmap = BitmapFactory.decodeFile(src.path, options) ?: throw NotAnImage("decode failed")
    return applyOrientation(bitmap, src)
  }

  /** Largest power of two that keeps the long edge at or above `maxEdge`. */
  private fun sampleSize(width: Int, height: Int, maxEdge: Int): Int {
    var sample = 1
    while (max(width, height) / (sample * 2) >= maxEdge) sample *= 2
    return sample
  }

  private fun scaleToFit(bitmap: Bitmap, maxEdge: Int): Bitmap {
    val longEdge = max(bitmap.width, bitmap.height)
    if (longEdge <= maxEdge) return bitmap
    val scale = maxEdge.toDouble() / longEdge
    return Bitmap.createScaledBitmap(
      bitmap,
      max(1, (bitmap.width * scale).roundToInt()),
      max(1, (bitmap.height * scale).roundToInt()),
      true,
    )
  }

  private fun applyOrientation(bitmap: Bitmap, src: File): Bitmap {
    val orientation = try {
      ExifInterface(src.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } catch (e: IOException) {
      ExifInterface.ORIENTATION_NORMAL
    }
    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.postRotate(90f); matrix.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.postRotate(270f); matrix.postScale(-1f, 1f) }
      else -> return bitmap
    }
    val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    if (rotated !== bitmap) bitmap.recycle()
    return rotated
  }
}
