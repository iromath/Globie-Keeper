import { CameraView, scanFromURLAsync, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, IconButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { haptics } from '@/components/ui/haptics';
import { Icon, icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { parseInviteCode } from '@/lib/invite';

/** A wrong code is reported once, not on every frame the camera sees it. */
const MISS_MS = 1600;

export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

  // One scan is acted on; the camera keeps emitting until the screen unmounts.
  const settled = useRef(false);
  const missedAt = useRef(0);

  function accept(payload: string) {
    if (settled.current) return;

    const code = parseInviteCode(payload);
    if (!code) {
      const now = Date.now();
      if (now - missedAt.current < MISS_MS) return;
      missedAt.current = now;
      haptics.warn();
      setNotice('That code is not a Globie Keeper invite. Try another one.');
      return;
    }

    settled.current = true;
    haptics.success();
    setNotice(null);
    router.replace({ pathname: '/join', params: { code } });
  }

  async function pickImage() {
    setBusy(true);
    setNotice(null);
    try {
      const picked = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
      });
      const uri = picked.assets?.[0]?.uri;
      if (!uri) return;

      const results = await scanFromURLAsync(uri, ['qr']);
      const data = results[0]?.data;
      if (!data) {
        haptics.warn();
        setNotice('No invite code found in that image.');
        return;
      }
      accept(data);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not read that image.');
    } finally {
      setBusy(false);
    }
  }

  function enterManually() {
    router.replace('/join');
  }

  /** A refusal is silent unless we say so — the button would simply look dead. */
  async function allowCamera() {
    setAsking(true);
    setNotice(null);
    try {
      const next = await requestPermission();
      if (!next.granted) {
        haptics.warn();
        setNotice(
          next.canAskAgain
            ? 'The camera stayed off. Allow it for this site, then try again — or pick a screenshot.'
            : 'Camera access is blocked for this site. Pick a screenshot, or enter the code below.'
        );
      }
    } finally {
      setAsking(false);
    }
  }

  if (!permission?.granted) {
    return (
      <Screen
        header={{
          title: 'Scan invite',
          subtitle: 'Point the camera at the QR code a member sent you.',
          back: true,
        }}
      >
        <Card>
          <SectionHeading
            glyph={icon.scan}
            title="Scan the invite"
            hint="Globie reads the QR code a member shares, so nobody has to retype six characters."
          />
          <Button
            title="Allow camera"
            icon={icon.camera}
            onPress={allowCamera}
            loading={asking}
            disabled={!permission}
          />
          <Button
            variant="secondary"
            title="Pick a screenshot"
            icon={icon.images}
            onPress={pickImage}
            loading={busy}
          />
          <Button
            variant="ghost"
            compact
            title="Enter the code instead"
            icon={icon.link}
            onPress={enterManually}
          />
          {notice ? (
            <Text variant="caption" tone="warn" accessibilityLiveRegion="polite">
              {notice}
            </Text>
          ) : (
            <Text variant="caption" tone="dim">
              The camera is only used while this screen is open.
            </Text>
          )}
        </Card>
      </Screen>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={torch}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={({ data }) => accept(data)}
        onMountError={({ message }) => setNotice(message)}
      />

      <View style={styles.overlay} pointerEvents="box-none">
        <View style={[styles.top, { paddingTop: insets.top + space.xl }]}>
          {/* The camera fills the screen, so the way out floats over it. */}
          <IconButton
            name={icon.chevronBack}
            label="Back"
            onPress={() => router.back()}
            style={{
              position: 'absolute',
              left: space.md,
              top: insets.top + space.sm,
              backgroundColor: colors.glass,
              borderWidth: 1,
              borderColor: colors.hairline,
            }}
          />
          <View style={styles.hint}>
            <Icon name={icon.qr} size={16} color={colors.accent} />
            <View style={styles.hintCopy}>
              <Text variant="label">Point at the invite code</Text>
              <Text variant="caption" tone="muted">
                It is read the moment it is in frame.
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.frame} pointerEvents="none">
          <View style={[styles.corner, styles.cornerTopLeft]} />
          <View style={[styles.corner, styles.cornerTopRight]} />
          <View style={[styles.corner, styles.cornerBottomLeft]} />
          <View style={[styles.corner, styles.cornerBottomRight]} />
        </View>

        <View style={[styles.bottom, { paddingBottom: insets.bottom + space.lg }]}>
          {notice ? (
            <Text
              variant="caption"
              tone="warn"
              accessibilityLiveRegion="polite"
              style={styles.notice}
            >
              {notice}
            </Text>
          ) : null}
          <View style={styles.controls}>
            <Button
              variant="secondary"
              compact
              title="Pick a screenshot"
              icon={icon.images}
              onPress={pickImage}
              loading={busy}
              style={styles.control}
            />
            <IconButton
              name={torch ? icon.flashlight : icon.flashlightOutline}
              label={torch ? 'Turn the light off' : 'Turn the light on'}
              tone={torch ? 'accent' : 'default'}
              size={20}
              onPress={() => setTorch((on) => !on)}
            />
            <Button
              variant="ghost"
              compact
              title="Enter code"
              icon={icon.link}
              onPress={enterManually}
              style={styles.control}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const CORNER = 26;
const CORNER_WIDTH = 3;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  top: { paddingTop: space.xl, paddingHorizontal: space.lg, width: '100%' },
  hint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  hintCopy: { gap: 1 },
  frame: { width: 244, height: 244 },
  corner: {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
    borderColor: colors.accent,
  },
  cornerTopLeft: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderTopLeftRadius: radius.md,
  },
  cornerTopRight: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderTopRightRadius: radius.md,
  },
  cornerBottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
    borderBottomLeftRadius: radius.md,
  },
  cornerBottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
    borderBottomRightRadius: radius.md,
  },
  bottom: {
    width: '100%',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    backgroundColor: colors.glass,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  notice: { textAlign: 'center' },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
  },
  control: { flexGrow: 1, maxWidth: 240 },
});
