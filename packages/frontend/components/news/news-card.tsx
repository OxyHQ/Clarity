/**
 * One news story as a card — Discover's grid, and what Clarity's agent shows for
 * a `listNews` result in the chat (`components/chat/clarity-tool-renderers.tsx`).
 * The lead article supplies the image, the link and the publisher.
 */
import { useCallback } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { Clock, Heart, MoreHorizontal, Newspaper } from 'lucide-react-native';
import { GlyphButton } from '@oxy.so/bloom/button';

import type { NewsStory } from '@clarity/shared-types';

import { Text } from '@/components/ui/text';
import { useTranslation } from '@/hooks/useTranslation';
import { bloomIcon } from '@/lib/bloom-icon';
import { relativeTimeAgo } from '@/lib/relative-time';
import { hostnameOf } from '@/lib/sources';
import { useColorScheme } from '@/lib/useColorScheme';
import { cn } from '@/lib/utils';

export interface Article {
  id: string;
  title: string;
  description?: string;
  imageUrl?: string;
  url: string;
  publisher?: string;
  faviconUrls: string[];
  sourceCount: number;
  /** Absent when the article states no publication date — then no time is shown. */
  publishedAt?: Date;
  rankingScore: number;
}

/** A story as a card: the lead article supplies the image, link and publisher. */
export function toArticle(story: NewsStory): Article {
  const lead = story.articles.find((article) => article.imageUrl) ?? story.articles[0];
  const faviconUrls = [
    ...new Set(
      story.articles.flatMap((article) => (article.faviconUrl ? [article.faviconUrl] : [])),
    ),
  ];
  return {
    id: story.id,
    title: story.title,
    description: story.summary ?? lead?.description,
    imageUrl: lead?.imageUrl,
    url: lead?.canonicalUrl ?? '',
    publisher: lead?.publisher ?? (lead ? hostnameOf(lead.canonicalUrl) : undefined),
    faviconUrls,
    sourceCount: Math.max(story.sourceCount, story.articles.length),
    publishedAt: story.lastPublishedAt ? new Date(story.lastPublishedAt) : undefined,
    rankingScore: story.rankingScore,
  };
}

/* ================================================================
   Source Favicons (stacked circles)
   ================================================================ */

function SourceIcons({ faviconUrls, count }: { faviconUrls: string[]; count: number }) {
  const { colors } = useColorScheme();
  const displayed = Math.min(Math.max(count, 1), 3);
  const circleColors = [colors.primary, colors.muted, colors.surface];

  return (
    <View className="flex-row items-center">
      <View className="flex-row" style={{ width: displayed * 9 + 5 }}>
        {Array.from({ length: displayed }).map((_, i) => {
          const style = {
            width: 14,
            height: 14,
            borderRadius: 7,
            borderWidth: 1.5,
            borderColor: colors.card,
            marginLeft: i === 0 ? 0 : -5,
            zIndex: displayed - i,
            backgroundColor: circleColors[i % circleColors.length],
          };
          const favicon = faviconUrls[i];
          return favicon ? (
            <Image key={i} source={{ uri: favicon }} style={style} contentFit="cover" />
          ) : (
            <View key={i} style={style} />
          );
        })}
      </View>
    </View>
  );
}

/* ================================================================
   News Card
   ================================================================ */

export function NewsCard({ article, featured }: { article: Article; featured?: boolean }) {
  const { colors } = useColorScheme();
  const { t } = useTranslation();
  const open = useCallback(() => {
    if (article.url) void Linking.openURL(article.url);
  }, [article.url]);

  return (
    <Pressable
      onPress={open}
      accessibilityRole="link"
      className={cn(
        'group',
        featured
          ? 'flex-col md:flex-row md:gap-6'
          : 'rounded-xl border border-border/50 bg-card overflow-hidden',
      )}
    >
      {/* Image */}
      <View
        className={cn(
          'relative overflow-hidden bg-muted',
          featured ? 'aspect-[3/2] min-h-[200px] rounded-xl md:w-[43%]' : 'aspect-[3/2]',
        )}
      >
        {article.imageUrl ? (
          <Image
            source={{ uri: article.imageUrl }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={300}
          />
        ) : (
          <View className="flex-1 items-center justify-center">
            <Newspaper size={32} color={colors.mutedForeground} />
          </View>
        )}
        {/* Publisher badge */}
        {article.publisher ? (
          <View className="absolute top-2 left-2 rounded-md bg-background/80 px-2 py-0.5">
            <Text className="text-[10px] font-medium text-foreground" numberOfLines={1}>
              {article.publisher}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Content */}
      <View className={cn('flex-1 justify-between', featured ? 'gap-2 py-2' : 'py-3 px-4 gap-2')}>
        <Text
          className={cn(
            'text-foreground font-medium leading-snug',
            featured ? 'text-xl md:text-2xl' : 'text-sm',
          )}
          numberOfLines={3}
        >
          {article.title}
        </Text>

        {featured && article.description ? (
          <Text className="text-sm text-muted-foreground leading-relaxed" numberOfLines={6}>
            {article.description}
          </Text>
        ) : null}

        {/* Footer */}
        <View className="flex-row items-center justify-between mt-auto pt-1">
          <View className="flex-row items-center gap-2">
            <SourceIcons faviconUrls={article.faviconUrls} count={article.sourceCount} />
            <Text className="text-xs font-medium text-muted-foreground">
              {t('discover.sources', { count: article.sourceCount })}
            </Text>
            {article.publishedAt ? (
              <View className="flex-row items-center gap-1 ml-2">
                <Clock size={12} color={colors.mutedForeground} />
                <Text className="text-xs font-medium text-muted-foreground">
                  {relativeTimeAgo(article.publishedAt)}
                </Text>
              </View>
            ) : null}
          </View>
          <View className="flex-row items-center">
            <GlyphButton icon={bloomIcon(Heart)} size={32} accessibilityLabel={t('actions.like')} />
            <GlyphButton
              icon={bloomIcon(MoreHorizontal)}
              size={32}
              accessibilityLabel={t('actions.more')}
            />
          </View>
        </View>
      </View>
    </Pressable>
  );
}
