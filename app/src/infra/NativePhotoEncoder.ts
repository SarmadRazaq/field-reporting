import { NativeModules } from 'react-native';
import type { EncodeRequest, EncodeResult, EncodeStep, ImageEncoder } from '../core/ports';

interface PhotoEncoderNative {
  encodeToFit(src: string, dest: string, steps: EncodeStep[], maxBytes: number): Promise<EncodeResult>;
}

/**
 * The app's own Kotlin encoder (android/app/src/main/java/com/fieldreports/photos).
 * One call per photo: it decodes once, applies orientation, tries each step on
 * that bitmap and writes the first JPEG that fits. Pixels never reach JS.
 * Metadata, including GPS, is not copied into the output.
 */
export class NativePhotoEncoder implements ImageEncoder {
  private readonly native = NativeModules.PhotoEncoder as PhotoEncoderNative | undefined;

  encodeToFit({ src, dest, steps, maxBytes }: EncodeRequest): Promise<EncodeResult> {
    if (!this.native) throw new Error('The PhotoEncoder native module is missing from this build');
    return this.native.encodeToFit(src, dest, [...steps], maxBytes);
  }
}
