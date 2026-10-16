/**
 * Clarity's drawings of its own catalogue tools' results, inside Alia's thread.
 *
 * Keyed `clarity:<tool>`: the SDK parses the key from the tool's canonical name
 * (`oxy_clarity__searchJobs`), never from anything the model wrote. A card can only
 * show what the catalogue actually returned, and each is the component the product
 * page draws for the same thing — the Jobs card, the Discover card, the Finance card,
 * the list of pages. The same renderers draw a consulted agent's results.
 *
 * Every other tool (writes, notifications, places, the feature gates) gets the SDK's
 * generic tool card.
 */

import type { AliaToolRenderers, AliaToolResult } from '@alia.onl/sdk';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useState } from 'react';
import { View } from 'react-native';

import { JobCard, type JobCardPosting } from '@/components/jobs/job-card';
import { CryptoQuoteCard } from '@/components/market/crypto-quote-card';
import { NewsCard, toArticle } from '@/components/news/news-card';
import { SourceList } from '@/components/search/source-list';
import { Text } from '@/components/ui/text';
import { useTranslation } from '@/hooks/useTranslation';
import { marketCardView } from '@/lib/market-format';
import type { Source } from '@/lib/sources';
import {
  jobOf,
  jobsOfSearch,
  quotesOf,
  sourceOfDocument,
  sourcesOfSearch,
  storiesOfNews,
  unshownCount,
} from '@/lib/tool-outputs';

/** How many job cards a result shows before saying how many more there are. */
export const JOB_PREVIEW_MAX = 4;
/** How many news cards a result shows before saying how many more there are. */
export const NEWS_PREVIEW_MAX = 3;

function MoreNote({ count }: { count: number }) {
  const { t } = useTranslation();
  if (count === 0) return null;
  return <Text className="text-xs text-muted-foreground">{t('chat.moreResults', { count })}</Text>;
}

function Sources({ sources, startExpanded }: { sources: Source[]; startExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(startExpanded === true);
  if (sources.length === 0) return null;
  return (
    <View className="mb-2">
      <SourceList
        sources={sources}
        expanded={expanded}
        onToggle={() => setExpanded((value) => !value)}
      />
    </View>
  );
}

function Jobs({ jobs }: { jobs: JobCardPosting[] }) {
  const router = useRouter();
  if (jobs.length === 0) return null;
  const shown = jobs.slice(0, JOB_PREVIEW_MAX);
  return (
    <View className="gap-2 mb-2">
      {shown.map((job) => (
        <JobCard key={job.id} job={job} onPress={() => router.push(`/jobs/${job.id}`)} />
      ))}
      {/* Said, not hidden: four cards of eleven answer a different question. */}
      <MoreNote count={unshownCount(jobs.length, JOB_PREVIEW_MAX)} />
    </View>
  );
}

function News({ output }: { output: unknown }) {
  const stories = storiesOfNews(output);
  if (stories.length === 0) return null;
  return (
    <View className="gap-2 mb-2">
      {stories.slice(0, NEWS_PREVIEW_MAX).map((story) => (
        <NewsCard key={story.id} article={toArticle(story)} />
      ))}
      <MoreNote count={unshownCount(stories.length, NEWS_PREVIEW_MAX)} />
    </View>
  );
}

function Quotes({ output }: { output: unknown }) {
  const { locale } = useTranslation();
  const results = quotesOf(output);
  if (results.length === 0) return null;
  // The quote ages against the moment the result was drawn.
  const now = new Date();
  return (
    <View className="flex-row flex-wrap gap-3 mb-2">
      {results.map((result) => (
        <CryptoQuoteCard
          key={result.requested}
          label={result.requested}
          isLargeScreen={false}
          view={marketCardView({ result, isPending: false, isError: false, locale, now })}
        />
      ))}
    </View>
  );
}

const oneDocument = (result: AliaToolResult): React.ReactNode => {
  const source = sourceOfDocument(result.output);
  return source ? <Sources sources={[source]} startExpanded /> : null;
};

const oneJob = (result: AliaToolResult): React.ReactNode => {
  const job = jobOf(result.output);
  return job ? <Jobs jobs={[job]} /> : null;
};

export const CLARITY_TOOL_RENDERERS: AliaToolRenderers = {
  'clarity:search': (result) => <Sources sources={sourcesOfSearch(result.output)} />,
  'clarity:getDocument': oneDocument,
  'clarity:getDocumentByUrl': oneDocument,
  'clarity:listNews': (result) => <News output={result.output} />,
  'clarity:searchJobs': (result) => <Jobs jobs={jobsOfSearch(result.output)} />,
  'clarity:getJob': oneJob,
  'clarity:getJobByUrl': oneJob,
  'clarity:getMarketQuotes': (result) => <Quotes output={result.output} />,
};
