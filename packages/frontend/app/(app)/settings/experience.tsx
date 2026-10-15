import { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useOxy } from '@oxy.so/services';
import { useSupervision } from '@oxy.so/services/ui';
import { useAuth } from '@oxy.so/services/ui/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@oxy.so/bloom/button';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Loading } from '@oxy.so/bloom/loading';
import type { Experience } from '@clarity.surf/sdk/experience';
import { SettingsHeader } from '@/components/settings/settings-header';
import type { ExperienceEmployer } from '@/components/experience/ExperienceEmployerField';
import { ExperienceEditor } from '@/components/experience/ExperienceEditor';
import { useExperienceClient } from '@/lib/api/use-experience-client';
import { useTranslation } from '@/hooks/useTranslation';

export default function SettingsExperienceScreen() {
  const { user, canUsePrivateApi, isAuthenticated, oxyServices } = useAuth();
  const { activeSessionId } = useOxy();
  const supervision = useSupervision();
  const showEmployerMedia =
    supervision.data !== undefined &&
    (!supervision.data.self || supervision.data.self.status === 'ended');
  const { t } = useTranslation();
  const experience = useExperienceClient();
  const client = useQueryClient();
  const [editing, setEditing] = useState<Experience | 'new' | null>(null);
  const allowed = canUsePrivateApi && user?.kind === 'personal';
  const queryKey = ['experience', user?.id, activeSessionId, isAuthenticated, canUsePrivateApi];
  const query = useQuery({
    queryKey,
    queryFn: () => experience.list(user?.id ?? ''),
    enabled: allowed,
    retry: false,
    gcTime: 0,
  });
  const ids = [
    ...new Set((query.data?.items ?? []).map((entry) => entry.employerOxyAccountId)),
  ].sort();
  const employers = useQuery({
    queryKey: ['oxy', 'organizations', 'batch', ids, user?.id, activeSessionId, showEmployerMedia],
    queryFn: async (): Promise<{
      items: { requestedAccountId: string; organization: ExperienceEmployer }[];
      missingIds: string[];
    }> => {
      if (supervision.data === undefined) throw new Error('Current account protection is required');
      return showEmployerMedia
        ? oxyServices.organizations.batch({ ids })
        : oxyServices.safety.organizations({ ids });
    },
    enabled: allowed && supervision.data !== undefined && ids.length > 0,
    retry: false,
    gcTime: 0,
  });
  const companies = new Map(
    supervision.data !== undefined && !employers.isError
      ? employers.data?.items.map((item) => [item.requestedAccountId, item.organization])
      : [],
  );
  useFocusEffect(
    useCallback(() => {
      if (allowed) void query.refetch();
    }, [allowed, query.refetch]),
  );
  return (
    <View className="flex-1 bg-background">
      <SettingsHeader title={t('settings.experience')} showBack showMenu={showEmployerMedia} />
      <ScrollView className="flex-1" contentContainerClassName="p-5 gap-5 max-w-2xl w-full">
        <Text className="text-muted-foreground">
          {t(
            showEmployerMedia ? 'profile.experience.publicHint' : 'supervisedAccess.experienceHint',
          )}
        </Text>
        {!allowed ? (
          <Text className="text-muted-foreground">{t('profile.experience.sessionRequired')}</Text>
        ) : (
          <>
            <Button onPress={() => setEditing('new')}>{t('profile.experience.add')}</Button>
            {query.isPending ? (
              <Loading />
            ) : query.isError ? (
              <View className="gap-2">
                <Text accessibilityRole="alert" className="text-muted-foreground">
                  {t('profile.experience.loadError')}
                </Text>
                <Button appearance="plain" tone="neutral" onPress={() => void query.refetch()}>
                  {t('common.retry')}
                </Button>
              </View>
            ) : !query.data?.items.length ? (
              <Text className="text-muted-foreground">{t('profile.experience.emptyOwner')}</Text>
            ) : (
              query.data.items.map((entry) => {
                const company = companies.get(entry.employerOxyAccountId);
                return (
                  <View
                    key={entry.id}
                    className="flex-row items-start gap-3 border-b border-border pb-5"
                  >
                    <Avatar
                      source={showEmployerMedia ? company?.avatar : undefined}
                      name={company?.name ?? t('profile.experience.unavailableEmployer')}
                      size={40}
                      shape="squircle"
                    />
                    <View className="flex-1 gap-1">
                      <Text className="text-foreground text-lg font-semibold">{entry.title}</Text>
                      <Text className="text-foreground">
                        {company?.name ?? t('profile.experience.unavailableEmployer')}
                      </Text>
                      <Text className="text-muted-foreground">
                        {entry.startDate} – {entry.endDate ?? t('profile.experience.present')}
                      </Text>
                      {entry.location ? (
                        <Text className="text-muted-foreground">{entry.location}</Text>
                      ) : null}
                    </View>
                    <Button
                      appearance="plain"
                      tone="neutral"
                      size="sm"
                      accessibilityLabel={t('profile.experience.editRole', { title: entry.title })}
                      onPress={() => setEditing(entry)}
                    >
                      {t('common.edit')}
                    </Button>
                  </View>
                );
              })
            )}
          </>
        )}
      </ScrollView>
      {editing && allowed && user ? (
        <ExperienceEditor
          key={editing === 'new' ? 'new' : editing.id}
          ownerId={user.id}
          entry={editing === 'new' ? undefined : editing}
          employer={editing === 'new' ? undefined : companies.get(editing.employerOxyAccountId)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void client.invalidateQueries({ queryKey: ['experience', user.id] });
          }}
        />
      ) : null}
    </View>
  );
}
