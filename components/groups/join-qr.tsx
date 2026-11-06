import { StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { joinUrl } from '@/lib/invite';

type Props = {
  inviteToken: string;
  size?: number;
};

/**
 * The invite as something a camera can read. The plate is white on purpose —
 * a dark-on-dark code fails to scan in low light — and the payload is the same
 * `joinUrl` the Share sheet sends, so both routes land on the same screen.
 */
export function JoinQr({ inviteToken, size = 156 }: Props) {
  const code = inviteToken.toUpperCase();

  return (
    <View style={styles.panel}>
      <View
        style={styles.plate}
        accessible
        accessibilityRole="image"
        accessibilityLabel={`QR code to join with invite ${code}`}
      >
        <QRCode
          value={joinUrl(inviteToken)}
          size={size}
          color={colors.ink}
          backgroundColor="#FFFFFF"
          ecl="M"
          quietZone={8}
        />
      </View>
      <View style={styles.copy}>
        <Text variant="label">Scan to join</Text>
        <Text variant="caption" tone="muted">
          Point a phone camera here. The join screen opens with the invite already filled in.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  plate: {
    padding: space.xs,
    borderRadius: radius.sm,
    backgroundColor: '#FFFFFF',
  },
  copy: { flex: 1, minWidth: 140, gap: space.xs },
});
