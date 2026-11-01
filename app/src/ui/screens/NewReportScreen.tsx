import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  useWindowDimensions,
  View,
} from 'react-native';
import { launchCamera, launchImageLibrary, type ImagePickerResponse } from 'react-native-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { draftIssues, photoSlotsLeft, type DraftIssue } from '../../core/rules';
import { LIMITS } from '../../core/types';
import { outbox } from '../../infra/outbox';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { PhotoTile } from '../components/PhotoTile';
import { TopBar } from '../components/TopBar';
import { useCameraPermission } from '../hooks/useCameraPermission';
import { useDraft } from '../hooks/useDraft';
import type { RootScreenProps } from '../navigation/types';
import { color, radius, space, type } from '../theme';

const REASON: Record<DraftIssue, string> = {
  no_photos: 'Add at least one photo',
  description_required: 'Describe what you found',
  description_too_long: `Keep the description under ${LIMITS.maxDescriptionChars} characters`,
  too_many_photos: `A report holds at most ${LIMITS.maxImages} photos`,
};

const COLUMNS = 3;

export function NewReportScreen({ navigation }: RootScreenProps<'NewReport'>) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { draft, description, setDescription, flush } = useDraft();
  const camera = useCameraPermission();
  const [adding, setAdding] = useState(0);
  const [saving, setSaving] = useState(false);

  const images = draft?.images ?? [];
  const slots = draft ? photoSlotsLeft(draft) : LIMITS.maxImages;
  const issues = draftIssues({ description, images });
  const tile = Math.floor((width - space[5] * 2 - space[2] * (COLUMNS - 1)) / COLUMNS);
  const cameraBlocked = camera.status === 'blocked' || camera.status === 'unavailable';

  const leave = useCallback(async () => {
    await flush();
    const hasContent = description.trim().length > 0 || images.length > 0;
    if (!hasContent) {
      if (draft) await outbox().discardDraft(draft.id);
      navigation.goBack();
      return;
    }
    Alert.alert('Keep this report for later?', 'It stays on this phone as an unfinished report. It is not sent until you save it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete it',
        style: 'destructive',
        onPress: async () => {
          if (draft) await outbox().discardDraft(draft.id);
          navigation.goBack();
        },
      },
      { text: 'Keep for later', onPress: () => navigation.goBack() },
    ]);
  }, [description, draft, flush, images.length, navigation]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      void leave();
      return true;
    });
    return () => sub.remove();
  }, [leave]);

  async function addFrom(result: ImagePickerResponse) {
    if (result.didCancel || !draft) return;
    if (result.errorCode) {
      ToastAndroid.show(result.errorCode === 'camera_unavailable' ? 'No camera on this device' : 'Could not open the photos', ToastAndroid.LONG);
      return;
    }
    const uris = (result.assets ?? []).map(a => a.uri).filter((u): u is string => !!u);
    setAdding(uris.length);
    try {
      const added = await outbox().addPhotos(draft.id, uris);
      if (added < uris.length) ToastAndroid.show(`Added ${added}. A report holds ${LIMITS.maxImages} photos.`, ToastAndroid.LONG);
    } catch {
      ToastAndroid.show('That photo could not be copied. Try another.', ToastAndroid.LONG);
    } finally {
      setAdding(0);
    }
  }

  async function takePhoto() {
    if (!(await camera.ensure())) return;
    addFrom(await launchCamera({ mediaType: 'photo', quality: 1, saveToPhotos: false, includeExtra: false }));
  }

  async function pickFromGallery() {
    addFrom(await launchImageLibrary({ mediaType: 'photo', quality: 1, selectionLimit: slots, includeExtra: false }));
  }

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    await flush();
    const result = await outbox().submit(draft.id);
    setSaving(false);
    if (!result.ok) return;
    ToastAndroid.show('Saved on this phone', ToastAndroid.SHORT);
    navigation.goBack();
  }

  const full = slots === 0;
  return (
    <KeyboardAvoidingView style={[styles.root, { paddingTop: insets.top }]} behavior="padding">
      <TopBar title="New report" onBack={() => void leave()} backIcon="close" backLabel="Close" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <View style={styles.field}>
          <View style={styles.labelRow}>
            <Text style={[type.title, { color: color.ink }]} nativeID="descLabel">
              What did you find?
            </Text>
            <Text style={[type.meta, { color: description.length > LIMITS.maxDescriptionChars * 0.9 ? color.amber700 : color.muted }]}>
              {description.length} / {LIMITS.maxDescriptionChars}
            </Text>
          </View>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Where it is and what is wrong"
            placeholderTextColor={color.muted}
            multiline
            maxLength={LIMITS.maxDescriptionChars}
            style={styles.input}
            underlineColorAndroid="transparent"
            textAlignVertical="top"
            accessibilityLabelledBy="descLabel"
            autoCapitalize="sentences"
          />
        </View>

        <View style={styles.field}>
          <View style={styles.labelRow}>
            <Text style={[type.title, { color: color.ink }]}>Photos</Text>
            <Text style={[type.meta, { color: color.muted }]}>
              {images.length} of {LIMITS.maxImages}
            </Text>
          </View>
          {images.length || adding ? (
            <View style={styles.grid}>
              {images.map((img, i) => (
                <PhotoTile
                  key={img.id}
                  uri={`file://${img.sourcePath}`}
                  index={i}
                  size={tile}
                  onRemove={() => draft && outbox().removePhoto(draft.id, img.id)}
                />
              ))}
              {Array.from({ length: adding }, (_, i) => (
                <View key={`adding-${i}`} style={[styles.placeholder, { width: tile, height: tile }]}>
                  <Text style={[type.meta, { color: color.muted }]}>Adding…</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={[type.body, { color: color.soft }]}>
              Add 1 to {LIMITS.maxImages}. Full-size camera photos are fine; they are made smaller before sending.
            </Text>
          )}

          {cameraBlocked ? (
            <Notice
              tone="amber"
              icon="cameraOff"
              title="Camera is turned off"
              action={<Button label="Open Settings" variant="navy" compact onPress={camera.openSettings} />}
            >
              Turn it on in Settings to take photos here. You can still pick from your gallery.
            </Notice>
          ) : null}

          <View style={styles.sources}>
            <Button
              style={styles.source}
              label="Take photo"
              icon="camera"
              variant="navy"
              compact
              disabled={full || cameraBlocked || adding > 0}
              onPress={takePhoto}
            />
            <Button
              style={styles.source}
              label="From gallery"
              icon="gallery"
              variant="secondary"
              compact
              disabled={full || adding > 0}
              onPress={pickFromGallery}
            />
          </View>
          {full ? (
            <Text style={[type.caption, { color: color.muted }]}>{LIMITS.maxImages} photos is the most one report can hold.</Text>
          ) : null}
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + space[3] }]}>
        <Button
          label={saving ? 'Saving…' : 'Save report'}
          onPress={save}
          disabled={!draft || issues.length > 0 || adding > 0 || saving}
          disabledReason={adding > 0 ? 'Adding photos…' : issues[0] ? REASON[issues[0]] : undefined}
        />
        <Text style={[type.caption, styles.hint]}>Saves on this phone, then sends by itself when there is signal.</Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { padding: space[5], gap: space[6] },
  field: { gap: space[3] },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  input: {
    ...type.input,
    color: color.ink,
    minHeight: 120,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.line2,
    borderRadius: radius.md,
    padding: 14,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  placeholder: { borderRadius: radius.md, backgroundColor: color.bg2, alignItems: 'center', justifyContent: 'center' },
  sources: { flexDirection: 'row', gap: space[2] },
  source: { flex: 1 },
  footer: { paddingHorizontal: space[5], paddingTop: space[3], backgroundColor: color.bg, borderTopWidth: 1, borderColor: color.line },
  hint: { color: color.muted, textAlign: 'center', marginTop: space[2] },
});
