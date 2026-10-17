/**
 * One job posting as a card — the Jobs page's result row, and what Clarity's
 * agent shows for a `searchJobs` / `getJob` result in the chat
 * (`components/chat/clarity-tool-renderers.tsx`).
 *
 * Clarity indexed the listing; the employer's page stays the source, so the
 * card always names it.
 */
import { Pressable, View } from 'react-native';
import {
  Briefcase,
  Building2,
  CalendarClock,
  ExternalLink,
  MapPin,
  Wallet,
} from 'lucide-react-native';

import type { JobPosting } from '@clarity/shared-types';

import { Text } from '@/components/ui/text';
import { useTranslation } from '@/hooks/useTranslation';
import { formatLocations, formatPostedAt, formatSalary } from '@/lib/jobs-format';
import { useColorScheme } from '@/lib/useColorScheme';

/** A posting, with the search excerpt when it came from a search. */
export type JobCardPosting = JobPosting & { snippet?: string };

function MetaRow({ job }: { job: JobCardPosting }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const location = formatLocations(job.locations, job.applicantLocationRequirements);
  const salary = formatSalary(job.salary);
  const posted = formatPostedAt(job.publishedAt ?? job.firstSeenAt);

  return (
    <View className="flex-row flex-wrap items-center gap-x-4 gap-y-1">
      {job.workplaceType ? (
        <View className="flex-row items-center gap-1">
          <Briefcase size={12} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">
            {t(`jobs.workplace.${job.workplaceType}`)}
          </Text>
        </View>
      ) : null}
      {location ? (
        <View className="flex-row items-center gap-1">
          <MapPin size={12} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">{location}</Text>
        </View>
      ) : null}
      {salary ? (
        <View className="flex-row items-center gap-1">
          <Wallet size={12} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">{salary}</Text>
        </View>
      ) : null}
      {posted ? (
        <View className="flex-row items-center gap-1">
          <CalendarClock size={12} color={colors.mutedForeground} />
          <Text className="text-xs text-muted-foreground">{posted}</Text>
        </View>
      ) : null}
    </View>
  );
}

export function JobCard({ job, onPress }: { job: JobCardPosting; onPress: () => void }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="rounded-xl border border-border/50 bg-card p-4 gap-2 hover:bg-accent/30"
    >
      <Text className="text-base font-medium text-foreground" numberOfLines={2}>
        {job.title}
      </Text>
      <View className="flex-row items-center gap-1.5">
        <Building2 size={13} color={colors.mutedForeground} />
        <Text className="text-sm text-muted-foreground" numberOfLines={1}>
          {job.employer.name}
        </Text>
      </View>

      <MetaRow job={job} />

      {job.seniority || job.employmentTypes.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5 pt-0.5">
          {job.seniority ? (
            <View className="rounded-md bg-muted px-2 py-0.5">
              <Text className="text-[10px] font-medium text-muted-foreground">
                {t(`jobs.seniority.${job.seniority}`)}
              </Text>
            </View>
          ) : null}
          {job.employmentTypes.map((type) => (
            <View key={type} className="rounded-md bg-muted px-2 py-0.5">
              <Text className="text-[10px] font-medium text-muted-foreground">
                {t(`jobs.employment.${type}`)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {job.snippet ? (
        <Text className="text-sm text-muted-foreground leading-relaxed" numberOfLines={3}>
          {job.snippet}
        </Text>
      ) : null}

      {/* Clarity indexed this listing; the employer's page stays the source. */}
      <View className="flex-row items-center gap-1.5 pt-1 border-t border-border/40 mt-1">
        <ExternalLink size={12} color={colors.mutedForeground} />
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {t('jobs.sourceOn', { domain: job.source.domain })}
        </Text>
        {job.otherSources.length > 0 ? (
          <Text className="text-xs text-muted-foreground">
            {t('jobs.alsoPublished', { count: job.otherSources.length })}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
