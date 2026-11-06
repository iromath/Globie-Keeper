import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Linking, Share, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon, icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { inviteMessage, inviteSubject, joinUrl } from '@/lib/invite';
import type { Group } from '@/lib/types';

import { JoinQr } from './join-qr';

type Props = {
  group: Pick<Group, 'name' | 'inviteToken'>;
  memberCount: number;
};

type Feedback = 'code' | 'invite' | null;

export function InviteCard({ group, memberCount }: Props) {
  const [feedback, setFeedback] = useState<Feedback>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const code = group.inviteToken.toUpperCase();
  const url = joinUrl(group.inviteToken);
  const message = inviteMessage(group);

  function report(next: Exclude<Feedback, null>) {
    setFeedback(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback(null), 2400);
  }

  async function copyCode() {
    await Clipboard.setStringAsync(code);
    report('code');
  }

  async function copyInvite() {
    await Clipboard.setStringAsync(message);
    report('invite');
  }

  async function share() {
    try {
      await Share.share({ title: inviteSubject(group), message, url });
    } catch {
      // Desktop browsers without a share sheet get the whole invite on the clipboard.
      await copyInvite();
    }
  }

  async function open(target: string) {
    try {
      await Linking.openURL(target);
    } catch {
      await copyInvite();
    }
  }

  const feedbackCopy =
    feedback === 'code'
      ? 'Code copied. Share it in any chat.'
      : feedback === 'invite'
        ? 'Invite copied. Share it in any chat.'
        : 'Anyone with the code or the link can join.';

  return (
    <Card>
      <View style={styles.head}>
        <View style={styles.disc}>
          <Icon name={icon.qr} size={18} color={colors.accent} />
        </View>
        <View style={styles.flex}>
          <Text variant="label" tone="muted">
            Invite code
          </Text>
          <Text variant="figure" selectable>
            {code}
          </Text>
        </View>
        <View style={styles.count}>
          <Text variant="label" tone="muted">
            Members
          </Text>
          <Text variant="title">{memberCount}</Text>
        </View>
      </View>

      <JoinQr inviteToken={group.inviteToken} />

      <Text variant="caption" tone="muted" selectable numberOfLines={1}>
        {url}
      </Text>

      <View style={styles.actions}>
        <Button title="Share invite" icon={icon.share} onPress={share} />
        <View style={styles.row}>
          <Button
            variant="secondary"
            compact
            icon={icon.copy}
            title="Copy code"
            onPress={copyCode}
            style={styles.action}
          />
          <Button
            variant="secondary"
            compact
            icon={icon.whatsapp}
            title="WhatsApp"
            onPress={() => open(`https://wa.me/?text=${encodeURIComponent(message)}`)}
            style={styles.action}
          />
          <Button
            variant="secondary"
            compact
            icon={icon.mail}
            title="Email"
            onPress={() =>
              open(
                `mailto:?subject=${encodeURIComponent(inviteSubject(group))}&body=${encodeURIComponent(message)}`
              )
            }
            style={styles.action}
          />
        </View>
      </View>

      <View style={styles.feedback} accessibilityLiveRegion="polite">
        <Icon
          name={feedback ? icon.checkCircle : icon.information}
          size={13}
          color={feedback ? colors.accent : colors.mutedDim}
        />
        <Text variant="caption" tone={feedback ? 'accent' : 'dim'}>
          {feedbackCopy}
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  disc: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.wash,
    borderWidth: 1,
    borderColor: 'rgba(110, 240, 190, 0.24)',
  },
  count: { alignItems: 'flex-end' },
  actions: { gap: space.sm },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  action: { flexGrow: 1 },
  feedback: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
