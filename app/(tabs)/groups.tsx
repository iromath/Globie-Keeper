import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { GroupRow } from '@/components/groups/group-row';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { space } from '@/components/ui/theme';
import { useMyGroups } from '@/lib/queries';

/**
 * Every table this account belongs to. A group is only reachable from here or
 * from a share, so this is what keeps memberships findable after a sign-out.
 */
export default function MyGroupsScreen() {
  const groups = useMyGroups();
  const all = groups.data?.groups ?? [];

  return (
    <Screen
      header={{
        title: 'Groups',
        subtitle:
          all.length === 0
            ? 'Open a table or join one with a code.'
            : `${all.length} ${all.length === 1 ? 'table' : 'tables'} you belong to`,
      }}
    >
      {groups.isLoading ? (
        <View style={styles.list} accessibilityElementsHidden>
          <Skeleton height={62} />
          <Skeleton height={62} />
          <Skeleton height={62} />
        </View>
      ) : groups.error ? (
        <Card>
          <Text variant="title">Could not load your groups</Text>
          <Text variant="body" tone="muted">
            {groups.error.message}
          </Text>
          <Button
            variant="secondary"
            compact
            icon={icon.refresh}
            title="Try again"
            onPress={() => groups.refetch()}
            style={styles.inline}
          />
        </Card>
      ) : all.length === 0 ? (
        <EmptyState
          icon={icon.peopleOutline}
          title="No tables yet"
          body="Start a dinner from Home or join one with an invite code, and it lands here."
          action={
            <Button
              variant="secondary"
              compact
              icon={icon.add}
              title="Go to Home"
              onPress={() => router.navigate('/')}
            />
          }
        />
      ) : (
        <View style={styles.list}>
          {all.map((group) => (
            <GroupRow
              key={group.id}
              group={group}
              onPress={() => router.push({ pathname: '/groups/[id]', params: { id: group.id } })}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.sm },
  inline: { alignSelf: 'flex-start' },
});
