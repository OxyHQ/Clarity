import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ArrowLeft,
  Briefcase,
  Building2,
  CalendarClock,
  ExternalLink,
  MapPin,
  Search,
  Wallet,
} from "lucide-react-native";

import type {
  JobEmploymentType,
  JobSearchRequest,
  JobSearchResult,
  JobWorkplaceType,
} from "@clarity/shared-types";

import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useJobSearch } from "@/lib/hooks/use-jobs";
import { formatLocations, formatPostedAt, formatSalary } from "@/lib/jobs-format";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";

const WORKPLACE_TYPES: JobWorkplaceType[] = ["remote", "hybrid", "onsite"];
const EMPLOYMENT_TYPES: JobEmploymentType[] = [
  "full_time",
  "part_time",
  "contract",
  "temporary",
  "internship",
];
const RECENCY_WINDOWS = { any: 0, day: 1, week: 7, month: 30 } as const;
type Recency = keyof typeof RECENCY_WINDOWS;

function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className={cn(
        "h-8 rounded-full border px-3 items-center justify-center",
        active ? "border-primary bg-primary" : "border-border/60 bg-muted/40 hover:bg-accent",
      )}
    >
      <Text className={cn("text-xs font-medium", active ? "text-primary-foreground" : "text-foreground")}>
        {label}
      </Text>
    </Pressable>
  );
}

function MetaRow({ job }: { job: JobSearchResult }) {
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
          <Text className="text-xs text-muted-foreground">{t(`jobs.workplace.${job.workplaceType}`)}</Text>
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

function JobCard({ job, onPress }: { job: JobSearchResult; onPress: () => void }) {
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

      {job.employmentTypes.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5 pt-0.5">
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
          {t("jobs.sourceOn", { domain: job.source.domain })}
        </Text>
        {job.otherSources.length > 0 ? (
          <Text className="text-xs text-muted-foreground">
            {t("jobs.alsoPublished", { count: job.otherSources.length })}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function JobsScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;

  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [locationDraft, setLocationDraft] = useState("");
  const [location, setLocation] = useState("");
  const [workplaceTypes, setWorkplaceTypes] = useState<JobWorkplaceType[]>([]);
  const [employmentTypes, setEmploymentTypes] = useState<JobEmploymentType[]>([]);
  const [salaryMin, setSalaryMin] = useState("");
  const [recency, setRecency] = useState<Recency>("any");

  const request = useMemo<JobSearchRequest>(() => {
    const days = RECENCY_WINDOWS[recency];
    const minimum = Number(salaryMin.replace(/[^0-9.]/g, ""));
    return {
      ...(query ? { query } : {}),
      ...(location ? { locations: [location] } : {}),
      ...(workplaceTypes.length ? { workplaceTypes } : {}),
      ...(employmentTypes.length ? { employmentTypes } : {}),
      ...(Number.isFinite(minimum) && minimum > 0
        ? { salary: { min: minimum, interval: "year" as const } }
        : {}),
      ...(days > 0
        ? { publishedAfter: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() }
        : {}),
      limit: 20,
    };
  }, [query, location, workplaceTypes, employmentTypes, salaryMin, recency]);

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
          style={{ maxWidth: 1080, alignSelf: "center", width: "100%" }}
        >
          {!isLargeScreen && (
            <Pressable onPress={() => router.back()} className="p-1" accessibilityRole="button">
              <ArrowLeft size={20} color={colors.foreground} />
            </Pressable>
          )}
          <Text className="font-sans text-sm font-medium text-foreground">{t("jobs.title")}</Text>
        </View>
      </View>

      <ScrollView className="flex-1" contentContainerClassName="pb-12" showsVerticalScrollIndicator={false}>
        <View
          className="w-full px-4 py-6 gap-5"
          style={{ maxWidth: 1080, alignSelf: "center", width: "100%" }}
        >
          <View className="gap-1">
            <Text className="text-2xl font-semibold text-foreground">{t("jobs.heading")}</Text>
            <Text className="text-sm text-muted-foreground">{t("jobs.subheading")}</Text>
          </View>

          {/* ── Query and location ── */}
          <View className={cn("gap-2", isLargeScreen && "flex-row")}>
            <View className={cn("flex-row items-center gap-2", isLargeScreen && "flex-1")}>
              <Search size={16} color={colors.mutedForeground} />
              <Input
                className="flex-1"
                value={queryDraft}
                onChangeText={setQueryDraft}
                onSubmitEditing={submit}
                returnKeyType="search"
                placeholder={t("jobs.queryPlaceholder")}
                accessibilityLabel={t("jobs.queryPlaceholder")}
              />
            </View>
            <View className={cn("flex-row items-center gap-2", isLargeScreen && "w-72")}>
              <MapPin size={16} color={colors.mutedForeground} />
              <Input
                className="flex-1"
                value={locationDraft}
                onChangeText={setLocationDraft}
                onSubmitEditing={submit}
                returnKeyType="search"
                placeholder={t("jobs.locationPlaceholder")}
                accessibilityLabel={t("jobs.locationPlaceholder")}
              />
            </View>
            <Pressable
              onPress={submit}
              accessibilityRole="button"
              className="h-9 rounded-xl bg-primary px-4 items-center justify-center"
            >
              <Text className="text-sm font-medium text-primary-foreground">{t("jobs.searchAction")}</Text>
            </Pressable>
          </View>

          {/* ── Filters ── */}
          <View className="gap-3">
            <View className="flex-row flex-wrap gap-2">
              {WORKPLACE_TYPES.map((type) => (
                <FilterChip
                  key={type}
                  label={t(`jobs.workplace.${type}`)}
                  active={workplaceTypes.includes(type)}
                  onPress={() => setWorkplaceTypes((current) => toggle(current, type))}
                />
              ))}
            </View>
            <View className="flex-row flex-wrap gap-2">
              {EMPLOYMENT_TYPES.map((type) => (
                <FilterChip
                  key={type}
                  label={t(`jobs.employment.${type}`)}
                  active={employmentTypes.includes(type)}
                  onPress={() => setEmploymentTypes((current) => toggle(current, type))}
                />
              ))}
            </View>
            <View className="flex-row flex-wrap items-center gap-2">
              {(Object.keys(RECENCY_WINDOWS) as Recency[]).map((window) => (
                <FilterChip
                  key={window}
                  label={t(`jobs.recency.${window}`)}
                  active={recency === window}
                  onPress={() => setRecency(window)}
                />
              ))}
              <View className="flex-row items-center gap-2 ml-auto">
                <Wallet size={14} color={colors.mutedForeground} />
                <Input
                  className="w-40"
                  value={salaryMin}
                  onChangeText={setSalaryMin}
                  inputMode="numeric"
                  placeholder={t("jobs.salaryPlaceholder")}
                  accessibilityLabel={t("jobs.salaryPlaceholder")}
                />
              </View>
            </View>
          </View>

          {/* ── States ── */}
          {degraded ? (
            <View className="rounded-xl border border-border/60 bg-muted/40 p-3">
              <Text className="text-xs text-muted-foreground">{t("jobs.degraded")}</Text>
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
              <Text className="text-sm font-medium text-foreground">{t("jobs.errorTitle")}</Text>
              <Text className="text-sm text-muted-foreground">{t("jobs.errorBody")}</Text>
              <Pressable
                onPress={() => search.refetch()}
                accessibilityRole="button"
                className="h-9 rounded-xl border border-input px-4 items-center justify-center"
              >
                <Text className="text-sm font-medium text-foreground">{t("jobs.retry")}</Text>
              </Pressable>
            </View>
          ) : jobs.length === 0 ? (
            <View className="rounded-xl border border-border/60 bg-card p-6 gap-2">
              <Text className="text-sm font-medium text-foreground">{t("jobs.emptyTitle")}</Text>
              <Text className="text-sm text-muted-foreground">{t("jobs.emptyBody")}</Text>
            </View>
          ) : (
            <View className="gap-3">
              {jobs.map((job) => (
                <JobCard key={job.id} job={job} onPress={() => openJob(job.id)} />
              ))}
              {search.hasNextPage ? (
                <Pressable
                  onPress={() => search.fetchNextPage()}
                  disabled={search.isFetchingNextPage}
                  accessibilityRole="button"
                  className="h-10 rounded-xl border border-input items-center justify-center"
                >
                  <Text className="text-sm font-medium text-foreground">
                    {search.isFetchingNextPage ? t("jobs.loadingMore") : t("jobs.loadMore")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}

          <Text className="text-xs text-muted-foreground">{t("jobs.disclaimer")}</Text>
        </View>
      </ScrollView>
    </View>
  );
}
