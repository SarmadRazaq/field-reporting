import { useCallback, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  BackHandler,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  ToastAndroid,
  useWindowDimensions,
  Vibration,
  View,
} from 'react-native';
import { launchCamera, launchImageLibrary, type ImagePickerResponse } from 'react-native-image-picker';
import { requestNotifications } from 'react-native-permissions';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { draftIssues, photoSlotsLeft, type DraftIssue } from '../../core/rules';
import { LIMITS } from '../../core/types';
import { isNoSpaceError } from '../../infra/deviceStorage';
import { Button } from '../components/Button';
import { Notice } from '../components/Notice';
import { PhotoTile } from '../components/PhotoTile';
import { TopBar } from '../components/TopBar';
import { useCameraPermission } from '../hooks/useCameraPermission';
import { useDraft } from '../hooks/useDraft';
import { useFreeSpace } from '../hooks/useFreeSpace';
import { useOutboxCommands } from '../hooks/useOutbox';
import type { RootScreenProps } from '../navigation/types';
import { color, radius, space, type } from '../theme';

const REASON: Record<DraftIssue, string> = {
  no_photos: 'Add at least one photo',
  description_required: 'Describe what you found',
  description_too_long: `Keep the description under ${LIMITS.maxDescriptionChars} characters`,
  too_many_photos: `A report holds at most ${LIMITS.maxImages} photos`,
  photo_problem: "Remove the photo that can't be used",
};

const COLUMNS = 3;

/** Something about adding photos the inspector needs to see; stays until dismissed or fixed. */
type PhotoNote = { tone: 'amber' | 'info'; title: string; text: string };

export function NewReportScreen({ navigation }: RootScreenProps<'NewReport'>) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { drafts } = useOutboxCommands();
  const { draft, description, setDescription, flush } = useDraft();
  const camera = useCameraPermission();
  const storage = useFreeSpace();
  const [adding, setAdding] = useState(0);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<PhotoNote | null>(null);

  const images = draft?.images ?? [];
  const slots = draft ? photoSlotsLeft(draft) : LIMITS.maxImages;
  const issues = draftIssues({ description, images });
  const unusable = images.flatMap((img, i) => (img.problem ? [{ index: i, message: img.problem.message }] : []));
  const tile = Math.floor((width - space[5] * 2 - space[2] * (COLUMNS - 1)) / COLUMNS);
  const cameraBlocked = camera.status === 'blocked' || camera.status === 'unavailable';
  const noRoom = storage.level === 'full';

  const leave = useCallback(async () => {
    await flush();
    const hasContent = description.trim().length > 0 || images.length > 0;
    if (!hasContent) {
      if (draft) await drafts.discard(draft.id);
      navigation.goBack();
      return;
    }
    Alert.alert('Keep this report for later?', 'It stays on this phone as an unfinished report. It is not sent until you save it.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete it',
        style: 'destructive',
        onPress: async () => {
          if (draft) await drafts.discard(draft.id);
          navigation.goBack();
        },
      },
      { text: 'Keep for later', onPress: () => navigation.goBack() },
    ]);
  }, [description, draft, drafts, flush, images.length, navigation]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      void leave();
      return true;
    });
    return () => sub.remove();
  }, [leave]);

  /** Copies the picked photos in; returns how many were added. */
  async function addFrom(result: ImagePickerResponse): Promise<number> {
    if (result.didCancel || !draft) return 0;
    if (result.errorCode) {
      setNote(
        result.errorCode === 'camera_unavailable'
          ? { tone: 'amber', title: 'No camera on this device', text: 'You can still add photos from the gallery.' }
          : { tone: 'amber', title: "Couldn't open the photos", text: result.errorMessage ?? 'Try again, or use the other button.' },
      );
      return 0;
    }
    const uris = (result.assets ?? []).map(a => a.uri).filter((u): u is string => !!u);
    setAdding(uris.length);
    setNote(null);
    try {
      const added = await drafts.addPhotos(draft.id, uris);
      if (added < uris.length)
        setNote({
          tone: 'info',
          title: `Added ${added} of ${uris.length}`,
          text: `A report holds ${LIMITS.maxImages} photos. Start another report for the rest.`,
        });
      return added;
    } catch (e) {
      setNote(
        isNoSpaceError(e)
          ? { tone: 'amber', title: 'The phone is out of storage', text: 'Free up space, then add the photo again. Photos already added are safe.' }
          : { tone: 'amber', title: "That photo couldn't be copied", text: 'Try taking it again, or pick another.' },
      );
      return 0;
    } finally {
      setAdding(0);
      storage.refresh();
    }
  }

  /** One photo at a time, offering the next straight away: fewer taps with gloves on. */
  async function takePhoto(taken = images.length) {
    if (!(await camera.ensure())) return;
    const added = await addFrom(await launchCamera({ mediaType: 'photo', quality: 1, saveToPhotos: false, includeExtra: false }));
    const count = taken + added;
    if (!added || count >= LIMITS.maxImages) return;
    Alert.alert(`Photo added · ${count} of ${LIMITS.maxImages}`, undefined, [
      { text: 'Done', style: 'cancel' },
      { text: 'Take another', onPress: () => void takePhoto(count) },
    ]);
  }

  async function pickFromGallery() {
    addFrom(await launchImageLibrary({ mediaType: 'photo', quality: 1, selectionLimit: slots, includeExtra: false }));
  }

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    await flush();
    const result = await drafts.submit(draft.id);
    setSaving(false);
    if (!result.ok) return;
    Vibration.vibrate(20);
    AccessibilityInfo.announceForAccessibility('Saved on this phone');
    ToastAndroid.show('Saved on this phone', ToastAndroid.SHORT);
    navigation.goBack();
    // Asked now, when it means something: the notification is what lets sending go on in the background.
    // Android only shows the system prompt once; later calls return the stored answer.
    requestNotifications(['alert']).catch(() => {});
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
                  uri={`file://${img.processed?.path ?? img.sourcePath}`}
                  index={i}
                  size={tile}
                  state={img.problem ? 'problem' : img.processed ? 'ready' : 'preparing'}
                  onRemove={() => draft && drafts.removePhoto(draft.id, img.id)}
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

          {unusable.map(u => (
            <Notice key={u.index} tone="red" icon="warning" title={`Photo ${u.index + 1} can't be used`}>
              {`${u.message}. Remove it with the × on the photo, then take it again.`}
            </Notice>
          ))}

          {note ? (
            <Notice
              tone={note.tone}
              icon={note.tone === 'info' ? 'gallery' : 'warning'}
              title={note.title}
              action={<Button label="OK" variant="secondary" compact onPress={() => setNote(null)} />}
            >
              {note.text}
            </Notice>
          ) : null}

          {noRoom || storage.level === 'low' ? (
            <Notice tone="amber" icon="warning" title={noRoom ? 'This phone is out of storage' : 'This phone is low on storage'}>
              {noRoom
                ? 'Free up space in Settings to add photos. Reports already saved are safe.'
                : 'There may not be room for several full-size photos. Reports already saved are safe.'}
            </Notice>
          ) : null}

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
              disabled={full || cameraBlocked || noRoom || adding > 0}
              onPress={() => void takePhoto()}
            />
            <Button
              style={styles.source}
              label="From gallery"
              icon="gallery"
              variant="secondary"
              compact
              disabled={full || noRoom || adding > 0}
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
        {issues.length === 0 && adding === 0 ? (
          <Text style={[type.caption, styles.hint]}>Saves on this phone, then sends by itself when there is signal.</Text>
        ) : null}
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
