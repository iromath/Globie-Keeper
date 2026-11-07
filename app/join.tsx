import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { useJoinGroup } from '@/lib/queries';
import { useSession } from '@/lib/session-context';

export default function JoinScreen() {
  const params = useLocalSearchParams<{ code?: string | string[] }>();
  const { session } = useSession();
  const joinGroup = useJoinGroup();

  const fromLink = (Array.isArray(params.code) ? params.code[0] : (params.code ?? ''))
    .trim()
    .toUpperCase();
  const [code, setCode] = useState(fromLink);

  const canJoin = code.trim().length >= 4;

  async function onJoin() {
    if (!canJoin) return;
    const result = await joinGroup.mutateAsync({
      inviteToken: code.trim(),
      displayName: session?.displayName ?? '',
    });
    router.replace({ pathname: '/groups/[id]', params: { id: result.group.id } });
  }

  return (
    <Screen
      header={{
        title: 'Join a group',
        subtitle: 'One code is all it takes to sit at the table.',
        back: true,
      }}
    >
      <Card>
        <SectionHeading
          glyph={icon.qr}
          title="Join with a code"
          hint={
            fromLink
              ? 'Your link arrived with a code. Check it matches, then join.'
              : 'Paste the invite code a member sent you.'
          }
        />
        <Field
          label="Invite code"
          value={code}
          onChangeText={setCode}
          placeholder="The code from the invite"
          autoCapitalize="characters"
          autoCorrect={false}
          error={joinGroup.error?.message}
        />
        <Button
          title="Join group"
          icon={icon.personAdd}
          onPress={onJoin}
          loading={joinGroup.isPending}
          disabled={!canJoin}
        />
        <Button
          title="Scan the QR code instead"
          variant="ghost"
          compact
          icon={icon.scan}
          onPress={() => router.push('/scan')}
        />
      </Card>

      <Button
        variant="ghost"
        compact
        icon={icon.arrowForward}
        title="Not now"
        onPress={() => router.replace('/')}
      />
    </Screen>
  );
}
