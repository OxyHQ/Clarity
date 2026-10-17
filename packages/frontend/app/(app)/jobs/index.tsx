import { useCallback, useMemo, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, MapPin, Search, Wallet } from 'lucide-react-native';

import type {
  JobEmploymentType,
  JobSearchRequest,
  JobSeniority,
  JobWorkplaceType,
} from '@clarity/shared-types';

import { JobCard } from '@/components/jobs/job-card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useJobSearch } from '@/lib/hooks/use-jobs';
import { useColorScheme } from '@/lib/useColorScheme';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';
import { bloomIcon } from '@/lib/bloom-icon';
import { Button, GlyphButton } from '@oxy.so/bloom/button';
import { Chip } from '@oxy.so/bloom/chip';

const WORKPLACE_TYPES: JobWorkplaceType[] = ['remote', 'hybrid', 'onsite'];
const SENIORITY_LEVELS: JobSeniority[] = [
  'intern',
  'entry',
  'mid',
  'senior',
  'lead',
  'director',
  'executive',
];
const EMPLOYMENT_TYPES: JobEmploymentType[] = [
  'full_time',
  'part_time',
  'contract',
  'temporary',
  'internship',
];
const RECENCY_WINDOWS = { any: 0, day: 1, week: 7, month: 30 } as const;
type Recency = keyof typeof RECENCY_WINDOWS;

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export default function JobsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;

  const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState('');
  const [locationDraft, setLocationDraft] = useState('');
  const [location, setLocation] = useState('');
  const [workplaceTypes, setWorkplaceTypes] = useState<JobWorkplaceType[]>([]);
  const [employmentTypes, setEmploymentTypes] = useState<JobEmploymentType[]>([]);
  const [seniorities, setSeniorities] = useState<JobSeniority[]>([]);
  const [salaryMin, setSalaryMin] = useState('');
  const [recency, setRecency] = useState<Recency>('any');

  const request = useMemo<JobSearchRequest>(() => {
    const days = RECENCY_WINDOWS[recency];
    const minimum = Number(salaryMin.replace(/[^0-9.]/g, ''));
    return {
      ...(query ? { query } : {}),
      ...(location ? { locations: [location] } : {}),
      ...(workplaceTypes.length ? { workplaceTypes } : {}),
      ...(employmentTypes.length ? { employmentTypes } : {}),
      ...(seniorities.length ? { seniorities } : {}),
      ...(Number.isFinite(minimum) && minimum > 0
        ? { salary: { min: minimum, interval: 'year' as const } }
        : {}),
      ...(days > 0
        ? { publishedAfter: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() }
        : {}),
      limit: 20,
    };
  }, [query, location, workplaceTypes, employmentTypes, seniorities, salaryMin, recency]);

  const search = useJobSearch(request);
  const jobs = useMemo(
    () => (search.data?.pages ?? []).flatMap((page) => page.data),
    [search.data],
  );
  const degraded = search.data?.pages[0]?.degraded;

  const submit = useCallback(() => {
    setQuery(queryDraft.trim());
    setLocation(locationDraft.trim());
  }, [queryDraft, locationDraft]);

  const openJob = useCallback((id: string) => router.push(`/(app)/jobs/${id}`), [router]);

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="border-b border-border bg-background z-10">
        <View
          className="flex-row items-center gap-3 px-4 h-14"
          style={{ maxWidth: 1080, alignSelf: 'center', width: '100%' }}
        >
          {!isLargeScreen && (
            <GlyphButton
              icon={bloomIcon(ArrowLeft)}
              accessibilityLabel={t('common.back')}
              onPress={() => router.back()}
            />
          )}
          <Text className="font-sans text-sm font-medium text-foreground">{t('jobs.title')}</Text>
        </View>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-12"
        showsVerticalScrollIndicator={false}
      >
        <View
          className="w-full px-4 py-6 gap-5"
          style={{ maxWidth: 1080, alignSelf: 'center', width: '100%' }}
        >
          <View className="gap-1">
            <Text className="text-2xl font-semibold text-foreground">{t('jobs.heading')}</Text>
            <Text className="text-sm text-muted-foreground">{t('jobs.subheading')}</Text>
          </View>

          {/* ── Query and location ── */}
          <View className={cn('gap-2', isLargeScreen && 'flex-row')}>
            <View className={cn('flex-row items-center gap-2', isLargeScreen && 'flex-1')}>
              <Search size={16} color={colors.mutedForeground} />
              <Input
                className="flex-1"
                value={queryDraft}
                onChangeText={setQueryDraft}
                onSubmitEditing={submit}
                returnKeyType="search"
                placeholder={t('jobs.queryPlaceholder')}
                accessibilityLabel={t('jobs.queryPlaceholder')}
              />
            </View>
            <View className={cn('flex-row items-center gap-2', isLargeScreen && 'w-72')}>
              <MapPin size={16} color={colors.mutedForeground} />
              <Input
                className="flex-1"
                value={locationDraft}
                onChangeText={setLocationDraft}
                onSubmitEditing={submit}
                returnKeyType="search"
                placeholder={t('jobs.locationPlaceholder')}
                accessibilityLabel={t('jobs.locationPlaceholder')}
              />
            </View>
            <Button onPress={submit}>{t('jobs.searchAction')}</Button>
          </View>

          {/* ── Filters ── */}
          <View className="gap-3">
            <View className="flex-row flex-wrap gap-2">
              {WORKPLACE_TYPES.map((type) => (
                <Chip
                  key={type}
                  size="xl"
                  role="checkbox"
                  checked={workplaceTypes.includes(type)}
                  onCheckedChange={() => setWorkplaceTypes((current) => toggle(current, type))}
                >
                  {t(`jobs.workplace.${type}`)}
                </Chip>
              ))}
            </View>
            <View className="flex-row flex-wrap gap-2">
              {EMPLOYMENT_TYPES.map((type) => (
                <Chip
                  key={type}
                  size="xl"
                  role="checkbox"
                  checked={employmentTypes.includes(type)}
                  onCheckedChange={() => setEmploymentTypes((current) => toggle(current, type))}
                >
                  {t(`jobs.employment.${type}`)}
                </Chip>
              ))}
            </View>
            <View className="flex-row flex-wrap gap-2">
              {SENIORITY_LEVELS.map((level) => (
                <Chip
                  key={level}
                  size="xl"
                  role="checkbox"
                  checked={seniorities.includes(level)}
                  onCheckedChange={() => setSeniorities((current) => toggle(current, level))}
                >
                  {t(`jobs.seniority.${level}`)}
                </Chip>
              ))}
            </View>
            <View className="flex-row flex-wrap items-center gap-2">
              {(Object.keys(RECENCY_WINDOWS) as Recency[]).map((window) => (
                <Chip
                  key={window}
                  size="xl"
                  role="radio"
                  selected={recency === window}
                  onPress={() => setRecency(window)}
                >
                  {t(`jobs.recency.${window}`)}
                </Chip>
              ))}
              <View className="flex-row items-center gap-2 ml-auto">
                <Wallet size={14} color={colors.mutedForeground} />
                <Input
                  className="w-40"
                  value={salaryMin}
                  onChangeText={setSalaryMin}
                  inputMode="numeric"
                  placeholder={t('jobs.salaryPlaceholder')}
                  accessibilityLabel={t('jobs.salaryPlaceholder')}
                />
              </View>
            </View>
          </View>

          {/* ── States ── */}
          {degraded ? (
            <View className="rounded-xl border border-border/60 bg-muted/40 p-3">
              <Text className="text-xs text-muted-foreground">{t('jobs.degraded')}</Text>
            </View>
          ) : null}

          {search.isPending ? (
            <View className="gap-3">
              {[0, 1, 2, 3].map((item) => (
                <Skeleton key={item} className="h-32 w-full rounded-xl" />
              ))}
            </View>
          ) : search.isError ? (
            <View className="rounded-xl border border-border/60 bg-card p-6 gap-3 items-start">
              <Text className="text-sm font-medium text-foreground">{t('jobs.errorTitle')}</Text>
              <Text className="text-sm text-muted-foreground">{t('jobs.errorBody')}</Text>
              <Button appearance="outline" tone="neutral" onPress={() => search.refetch()}>
                {t('jobs.retry')}
              </Button>
            </View>
          ) : jobs.length === 0 ? (
            <View className="rounded-xl border border-border/60 bg-card p-6 gap-2">
              <Text className="text-sm font-medium text-foreground">{t('jobs.emptyTitle')}</Text>
              <Text className="text-sm text-muted-foreground">{t('jobs.emptyBody')}</Text>
            </View>
          ) : (
            <View className="gap-3">
              {jobs.map((job) => (
                <JobCard key={job.id} job={job} onPress={() => openJob(job.id)} />
              ))}
              {search.hasNextPage ? (
                <Button
                  appearance="outline"
                  tone="neutral"
                  onPress={() => search.fetchNextPage()}
                  disabled={search.isFetchingNextPage}
                >
                  {search.isFetchingNextPage ? t('jobs.loadingMore') : t('jobs.loadMore')}
                </Button>
              ) : null}
            </View>
          )}

          <Text className="text-xs text-muted-foreground">{t('jobs.disclaimer')}</Text>
        </View>
      </ScrollView>
    </View>
  );
}
