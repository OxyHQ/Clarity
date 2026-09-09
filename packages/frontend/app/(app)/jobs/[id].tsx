import { useCallback, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ArrowLeft,
  Briefcase,
  Building2,
  CalendarClock,
  ExternalLink,
  Flag,
  MapPin,
  Wallet,
} from "lucide-react-native";

import type { JobReportReason } from "@clarity/shared-types";

import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useJobPosting, useReportJobPosting } from "@/lib/hooks/use-jobs";
import { formatLocations, formatPostedAt, formatSalary } from "@/lib/jobs-format";
import { useColorScheme } from "@/lib/useColorScheme";
import { useTranslation } from "@/hooks/useTranslation";

const REPORT_REASONS: JobReportReason[] = [
  "scam",
  "already_filled",
  "misleading",
  "discriminatory",
  "other",
];

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const job = useJobPosting(typeof id === "string" ? id : undefined);
  const report = useReportJobPosting(typeof id === "string" ? id : undefined);
  const [reportOpen, setReportOpen] = useState(false);

  const openCanonical = useCallback(() => {
    const target = job.data?.applyUrl ?? job.data?.canonicalUrl;
    if (target) void Linking.openURL(target);
  }, [job.data]);

  const posting = job.data;
  const salary = formatSalary(posting?.salary);
  const location = posting ? formatLocations(posting.locations, posting.applicantLocationRequirements) : undefined;
  const posted = formatPostedAt(posting?.publishedAt ?? posting?.firstSeenAt);

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="border-b border-border bg-background z-10">
        <View
          className="flex-row items-center gap-3 px-4 h-14"
          style={{ maxWidth: 860, alignSelf: "center", width: "100%" }}
        >
          <Pressable onPress={() => router.back()} className="p-1" accessibilityRole="button">
            <ArrowLeft size={20} color={colors.foreground} />
          </Pressable>
          <Text className="font-sans text-sm font-medium text-foreground">{t("jobs.title")}</Text>
        </View>
      </View>

      <ScrollView className="flex-1" contentContainerClassName="pb-16" showsVerticalScrollIndicator={false}>
        <View
          className="w-full px-4 py-6 gap-5"
          style={{ maxWidth: 860, alignSelf: "center", width: "100%" }}
        >
          {job.isPending ? (
            <View className="gap-3">
              <Skeleton className="h-8 w-3/4 rounded-lg" />
              <Skeleton className="h-5 w-1/3 rounded-lg" />
              <Skeleton className="h-56 w-full rounded-xl" />
            </View>
          ) : job.isError || !posting ? (
            <View className="rounded-xl border border-border/60 bg-card p-6 gap-3 items-start">
              <Text className="text-sm font-medium text-foreground">{t("jobs.detailErrorTitle")}</Text>
              <Text className="text-sm text-muted-foreground">{t("jobs.detailErrorBody")}</Text>
              <Pressable
                onPress={() => job.refetch()}
                accessibilityRole="button"
                className="h-9 rounded-xl border border-input px-4 items-center justify-center"
              >
                <Text className="text-sm font-medium text-foreground">{t("jobs.retry")}</Text>
              </Pressable>
            </View>
          ) : (
            <>
              {posting.status !== "active" ? (
                <View className="rounded-xl border border-border/60 bg-muted/50 p-3">
                  <Text className="text-xs text-muted-foreground">
                    {t(`jobs.status.${posting.status}`)}
                  </Text>
                </View>
              ) : null}

              <View className="gap-2">
                <Text className="text-2xl font-semibold text-foreground">{posting.title}</Text>
                <View className="flex-row items-center gap-1.5">
                  <Building2 size={14} color={colors.mutedForeground} />
                  <Text className="text-base text-muted-foreground">{posting.employer.name}</Text>
                </View>
              </View>

              <View className="flex-row flex-wrap items-center gap-x-4 gap-y-2">
                {posting.workplaceType ? (
                  <View className="flex-row items-center gap-1">
                    <Briefcase size={13} color={colors.mutedForeground} />
                    <Text className="text-sm text-muted-foreground">
                      {t(`jobs.workplace.${posting.workplaceType}`)}
                    </Text>
                  </View>
                ) : null}
                {location ? (
                  <View className="flex-row items-center gap-1">
                    <MapPin size={13} color={colors.mutedForeground} />
                    <Text className="text-sm text-muted-foreground">{location}</Text>
                  </View>
                ) : null}
                {salary ? (
                  <View className="flex-row items-center gap-1">
                    <Wallet size={13} color={colors.mutedForeground} />
                    <Text className="text-sm text-muted-foreground">{salary}</Text>
                  </View>
                ) : null}
                {posted ? (
                  <View className="flex-row items-center gap-1">
                    <CalendarClock size={13} color={colors.mutedForeground} />
                    <Text className="text-sm text-muted-foreground">{posted}</Text>
                  </View>
                ) : null}
              </View>

              {posting.employmentTypes.length > 0 ? (
                <View className="flex-row flex-wrap gap-1.5">
                  {posting.employmentTypes.map((type) => (
                    <View key={type} className="rounded-md bg-muted px-2 py-1">
                      <Text className="text-[11px] font-medium text-muted-foreground">
                        {t(`jobs.employment.${type}`)}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {/* Attribution first: Clarity indexed this listing, it did not publish it. */}
              <View className="rounded-xl border border-border/60 bg-card p-4 gap-3">
                <Text className="text-xs text-muted-foreground">
                  {t("jobs.indexedNotice", { domain: posting.source.domain })}
                </Text>
                <Pressable
                  onPress={openCanonical}
                  accessibilityRole="link"
                  className="h-10 rounded-xl bg-primary px-4 flex-row items-center justify-center gap-2"
                >
                  <ExternalLink size={14} color={colors.primaryForeground} />
                  <Text className="text-sm font-medium text-primary-foreground">
                    {t("jobs.viewOriginal")}
                  </Text>
                </Pressable>
                {posting.otherSources.length > 0 ? (
                  <View className="gap-1 pt-1 border-t border-border/40">
                    <Text className="text-xs font-medium text-foreground">{t("jobs.otherSources")}</Text>
                    {posting.otherSources.map((source) => (
                      <Pressable
                        key={source.canonicalUrl}
                        onPress={() => void Linking.openURL(source.canonicalUrl)}
                        accessibilityRole="link"
                      >
                        <Text className="text-xs text-muted-foreground">{source.domain}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>

              {posting.description ? (
                <View className="gap-2">
                  <Text className="text-sm font-medium text-foreground">{t("jobs.descriptionHeading")}</Text>
                  <Text className="text-sm text-muted-foreground leading-relaxed">{posting.description}</Text>
                </View>
              ) : null}

              {posting.skills.length > 0 ? (
                <View className="gap-2">
                  <Text className="text-sm font-medium text-foreground">{t("jobs.skillsHeading")}</Text>
                  <View className="flex-row flex-wrap gap-1.5">
                    {posting.skills.map((skill) => (
                      <View key={skill} className="rounded-md border border-border/60 px-2 py-1">
                        <Text className="text-[11px] text-muted-foreground">{skill}</Text>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {posting.qualifications ? (
                <View className="gap-2">
                  <Text className="text-sm font-medium text-foreground">{t("jobs.qualificationsHeading")}</Text>
                  <Text className="text-sm text-muted-foreground leading-relaxed">{posting.qualifications}</Text>
                </View>
              ) : null}

              {posting.responsibilities ? (
                <View className="gap-2">
                  <Text className="text-sm font-medium text-foreground">{t("jobs.responsibilitiesHeading")}</Text>
                  <Text className="text-sm text-muted-foreground leading-relaxed">{posting.responsibilities}</Text>
                </View>
              ) : null}

              {/* Reports are an operator signal only; they never change ranking. */}
              <View className="gap-2 pt-2 border-t border-border/40">
                {report.isSuccess ? (
                  <Text className="text-xs text-muted-foreground">{t("jobs.reportThanks")}</Text>
                ) : (
                  <>
                    <Pressable
                      onPress={() => setReportOpen((open) => !open)}
                      accessibilityRole="button"
                      className="flex-row items-center gap-1.5"
                    >
                      <Flag size={12} color={colors.mutedForeground} />
                      <Text className="text-xs text-muted-foreground">{t("jobs.report")}</Text>
                    </Pressable>
                    {reportOpen ? (
                      <View className="flex-row flex-wrap gap-1.5">
                        {REPORT_REASONS.map((reason) => (
                          <Pressable
                            key={reason}
                            disabled={report.isPending}
                            onPress={() => report.mutate({ reason })}
                            accessibilityRole="button"
                            className="rounded-full border border-border/60 px-3 py-1 hover:bg-accent"
                          >
                            <Text className="text-[11px] text-foreground">
                              {t(`jobs.reportReason.${reason}`)}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                    {report.isError ? (
                      <Text className="text-xs text-muted-foreground">{t("jobs.reportError")}</Text>
                    ) : null}
                  </>
                )}
                <Text className="text-xs text-muted-foreground">{t("jobs.reportNotice")}</Text>
              </View>

              <Text className="text-xs text-muted-foreground">{t("jobs.disclaimer")}</Text>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
