import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, IconButton } from './button';
import { icon } from './icon';
import { Text } from './text';
import { colors, radius, space } from './theme';

/** The asset the receipt upload expects, whoever took the picture. */
export type CameraShot = {
  uri: string;
  file: Blob | null;
  width: number;
  height: number;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onShot: (shot: CameraShot) => void;
};

/**
 * A real camera in the browser. There, `ImagePicker.launchCameraAsync` is only a
 * file input with `capture="camera"` set, which a desktop opens as a file dialog
 * — so the receipt photo came from the disk instead of the lens. This sheet asks
 * getUserMedia for the stream and paints the live frame onto a canvas, returning
 * the same shape the picker would have handed back.
 */
export function CameraCapture({ open, onClose, onShot }: Props) {
  const insets = useSafeAreaInsets();
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);

  // Opening the sheet already is the decision to use the camera, so the browser
  // prompt belongs here instead of behind a second, easily missed tap.
  useEffect(() => {
    if (!open || !permission || permission.granted || asked.current) return;
    asked.current = true;
    requestPermission();
  }, [open, permission, requestPermission]);

  /** The stream ends with the sheet, so the next visit starts cold again. */
  function close() {
    setReady(false);
    setError(null);
    onClose();
  }

  async function shutter() {
    setBusy(true);
    setError(null);
    try {
      const picture = await camera.current?.takePictureAsync({ quality: 0.85 });
      if (!picture) throw new Error('The camera is still warming up — try again.');
      const file = await (await fetch(picture.uri)).blob();
      setReady(false);
      onShot({ uri: picture.uri, file, width: picture.width, height: picture.height });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not take the photo.');
    } finally {
      setBusy(false);
    }
  }

  const granted = Boolean(permission?.granted);

  return (
    <Modal visible={open} animationType="fade" onRequestClose={close} statusBarTranslucent>
      <View style={styles.root}>
        {open && granted ? (
          <CameraView
            ref={camera}
            style={StyleSheet.absoluteFill}
            facing="back"
            onCameraReady={() => setReady(true)}
            onMountError={({ message }) => setError(message)}
          />
        ) : null}

        <View style={[styles.top, { paddingTop: insets.top + space.sm }]}>
          <IconButton
            name={icon.close}
            label="Close the camera"
            onPress={close}
            style={styles.close}
          />
        </View>

        <View style={[styles.bottom, { paddingBottom: insets.bottom + space.lg }]}>
          {granted ? (
            <>
              <Text variant="caption" tone="muted" style={styles.hint}>
                Fill the frame with the whole bill — flat, and in good light.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Take the photo"
                disabled={!ready || busy}
                onPress={shutter}
                style={[styles.shutter, (!ready || busy) && styles.shutterIdle]}
              >
                <View style={styles.shutterDot} />
              </Pressable>
            </>
          ) : (
            <>
              <Text variant="caption" tone="muted" style={styles.hint}>
                This browser needs your go-ahead before it can show the camera.
              </Text>
              <Button
                title="Allow the camera"
                icon={icon.camera}
                onPress={() => requestPermission()}
              />
            </>
          )}
          {error ? (
            <Text variant="caption" tone="warn" style={styles.hint} accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const SHUTTER = 72;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'flex-end',
    paddingHorizontal: space.md,
  },
  close: {
    backgroundColor: colors.glass,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radius.pill,
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    backgroundColor: colors.glass,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  hint: { textAlign: 'center' },
  shutter: {
    width: SHUTTER,
    height: SHUTTER,
    borderRadius: SHUTTER / 2,
    borderWidth: 3,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.xs,
  },
  shutterIdle: { opacity: 0.45 },
  shutterDot: {
    width: SHUTTER - 18,
    height: SHUTTER - 18,
    borderRadius: (SHUTTER - 18) / 2,
    backgroundColor: colors.accent,
  },
});
