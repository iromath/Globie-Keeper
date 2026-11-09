import { router, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Icon, icon } from '@/components/ui/icon';
import { BabyKaeNa } from '@/components/ui/mascot';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { ApiError } from '@/lib/api';
import { useAgentChat, useHelp } from '@/lib/queries';
import { useSession } from '@/lib/session-context';
import type { ManualSection } from '@/lib/types';

type Turn = { id: string; from: 'you' | 'globie'; text: string };

/**
 * The user manual (§2.22), in one component with two hosts: the `/help` route
 * and the sign-in screen, which has no navigator to push a route into.
 *
 * The sections come from `GET /api/help` — the same copy Globie is taught, so a
 * button quoted here and a button quoted in a reply can never disagree.
 */
export function HelpManual({ onClose }: { onClose?: () => void }) {
  const help = useHelp();
  const chat = useAgentChat();
  const { session } = useSession();

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const sections = useMemo(() => {
    const all = help.data?.sections ?? [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return all;
    // Every word must appear somewhere in the section, in any order — "pay
    // share" finds "Pay your share" without matching on exact phrasing.
    return all.filter((section) => {
      const haystack = [
        section.title,
        section.summary,
        ...section.steps,
        ...section.keywords,
      ]
        .join(' ')
        .toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [help.data, query]);

  function say(from: Turn['from'], text: string) {
    setTurns((current) => [...current, { id: `t${current.length}`, from, text }]);
  }

  /**
   * A question about the app, not about one group: no `groupId`, so the server
   * answers from the manual alone (§2.22). Conversation only — nothing here can
   * move money or edit a bill.
   */
  async function ask() {
    const line = draft.trim();
    if (!line || chat.isPending) return;

    setDraft('');
    setError(null);
    const history = turns.slice(-6).map((turn) => ({
      role: turn.from === 'you' ? ('user' as const) : ('assistant' as const),
      content: turn.text,
    }));
    say('you', line);

    try {
      const response = await chat.mutateAsync({
        message: line,
        groupId: null,
        billId: null,
        history,
      });
      say('globie', response.reply);
    } catch (cause) {
      // No chat model configured: the manual below still answers everything.
      if (cause instanceof ApiError && cause.code === 'assistant_not_configured') {
        say('globie', 'My chat is not switched on right now. The sections below cover every screen.');
        return;
      }
      setError(cause instanceof Error ? cause.message : 'Globie could not answer that.');
    }
  }

  return (
    <Screen
      header={{
        title: 'Help & manual',
        subtitle: 'Every screen, in the order you use it.',
        back: true,
        onBack: onClose,
      }}
    >
      {session ? (
        <Card>
          <View style={styles.head}>
            <BabyKaeNa
              size={42}
              variant="badge"
              mood={chat.isPending ? 'cheer' : 'idle'}
              sparkles={false}
              label={null}
            />
            <View style={styles.flex}>
              <Text variant="title">Ask Globie</Text>
              <Text variant="caption" tone="muted">
                Answers from this manual. It cannot change a bill.
              </Text>
            </View>
          </View>

          {turns.map((turn) => (
            <View
              key={turn.id}
              style={[styles.bubble, turn.from === 'you' ? styles.youBubble : styles.globieBubble]}
            >
              <Text variant="caption" tone={turn.from === 'you' ? 'ink' : 'muted'}>
                {turn.from === 'you' ? 'You' : 'Globie'}
              </Text>
              <Text variant="body" tone={turn.from === 'you' ? 'ink' : 'default'}>
                {turn.text}
              </Text>
            </View>
          ))}

          {error ? (
            <View accessibilityLiveRegion="polite" style={styles.errorBox}>
              <Icon name={icon.alert} size={14} color={colors.danger} />
              <Text variant="caption" tone="danger" style={styles.flex}>
                {error}
              </Text>
            </View>
          ) : null}

          <Field
            label="Your question"
            value={draft}
            onChangeText={setDraft}
            placeholder="How do I pay my share?"
            returnKeyType="send"
            onSubmitEditing={() => void ask()}
            editable={!chat.isPending}
          />
          <Button
            title="Ask"
            icon={icon.send}
            onPress={() => void ask()}
            loading={chat.isPending}
            disabled={draft.trim().length === 0}
          />
        </Card>
      ) : null}

      <Field
        label="Search the manual"
        value={query}
        onChangeText={setQuery}
        placeholder="pay share, tipping, points…"
        autoCapitalize="none"
        returnKeyType="search"
      />

      {help.isPending ? (
        <>
          <Skeleton height={92} />
          <Skeleton height={92} />
          <Skeleton height={92} />
        </>
      ) : help.isError ? (
        <Card>
          <Text variant="title">The manual did not load</Text>
          <Text variant="body" tone="muted">
            Check your connection. Every screen is still reachable from the tab bar.
          </Text>
          <Button
            title="Try again"
            variant="secondary"
            icon={icon.refresh}
            onPress={() => void help.refetch()}
          />
        </Card>
      ) : sections.length === 0 ? (
        <EmptyState
          icon={icon.helpOutline}
          title="No section matches that"
          body="Try one word from the screen you are on — split, confirm, pay, tip, points, donate."
          action={
            <Button title="Clear search" variant="secondary" onPress={() => setQuery('')} />
          }
        />
      ) : (
        sections.map((section) => (
          <ManualCard
            key={section.id}
            section={section}
            expanded={open === section.id}
            onToggle={() => setOpen(open === section.id ? null : section.id)}
          />
        ))
      )}
    </Screen>
  );
}

function ManualCard({
  section,
  expanded,
  onToggle,
}: {
  section: ManualSection;
  expanded: boolean;
  onToggle: () => void;
}) {
  // Group screens need an id the Help page does not have, so the button leads
  // to the group list instead of pretending it can open one particular bill.
  const needsGroup = section.screen?.includes('[') ?? false;
  const route = section.screen ? (needsGroup ? '/groups' : section.screen) : null;

  return (
    <Card enter={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${section.title}. ${section.summary}`}
        aria-expanded={expanded}
        onPress={onToggle}
        style={styles.sectionHead}
      >
        <View style={styles.sectionCopy}>
          <Text variant="title">{section.title}</Text>
          <Text variant="body" tone="muted">
            {section.summary}
          </Text>
        </View>
        <Icon
          name={expanded ? icon.chevronUp : icon.chevronDown}
          size={18}
          color={colors.muted}
        />
      </Pressable>

      {expanded ? (
        <View style={styles.steps}>
          {section.steps.map((step, index) => (
            <View key={step} style={styles.step}>
              <Text variant="caption" tone="accent" style={styles.stepNumber}>
                {index + 1}
              </Text>
              <Text variant="body" style={styles.flex}>
                {step}
              </Text>
            </View>
          ))}
          {route ? (
            <Button
              title={needsGroup ? 'Pick your group' : 'Open'}
              variant="secondary"
              compact
              icon={icon.arrowForward}
              iconSide="right"
              style={styles.openButton}
              onPress={() => router.push(route as Href)}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  bubble: {
    gap: 2,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    maxWidth: '92%',
  },
  globieBubble: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderTopLeftRadius: radius.sm,
  },
  youBubble: {
    alignSelf: 'flex-end',
    backgroundColor: colors.accent,
    borderColor: colors.accent,
    borderTopRightRadius: radius.sm,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerWash,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  sectionCopy: { flex: 1, gap: 2 },
  steps: { gap: space.md, paddingTop: space.xs },
  step: { flexDirection: 'row', gap: space.md },
  stepNumber: { width: 18, paddingTop: 3, textAlign: 'center' },
  openButton: { alignSelf: 'flex-start' },
});
