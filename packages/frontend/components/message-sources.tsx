import React from "react";
import { View, Pressable, Linking } from "react-native";
import { Image } from "expo-image";
import { Button } from "@oxy.so/bloom/button";
import { Text } from "@/components/ui/text";
import { faviconUrl } from "@/components/ui/source";
import type { Source } from "@/lib/message-sources";
import { cn } from "@/lib/utils";

/** How many chips the collapsed row shows before "+N". */
const COLLAPSED_COUNT = 4;

function openSource(url: string) {
  void Linking.openURL(url);
}

function Favicon({ url, size }: { url: string; size: number }) {
  return (
    <Image
      source={{ uri: faviconUrl(url) }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      contentFit="cover"
    />
  );
}

/**
 * The links an answer was built from, under the answer: a row of site chips,
 * or — expanded from the action bar's "N sources" — the full list with titles.
 */
export const MessageSources = React.memo(function MessageSources({
  sources,
  expanded,
  onToggle,
}: {
  sources: Source[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (sources.length === 0) return null;

  if (expanded) {
    return (
      <View className="mt-3 gap-1.5">
        {sources.map((source, index) => (
          <Pressable
            key={source.url}
            accessibilityRole="link"
            onPress={() => openSource(source.url)}
            className="flex-row items-start gap-2.5 rounded-xl border border-border/60 bg-card px-3 py-2 active:opacity-80 web:hover:bg-muted/50"
          >
            <Text className="text-xs text-muted-foreground w-4 pt-0.5">{index + 1}</Text>
            <View className="flex-1 gap-0.5">
              <View className="flex-row items-center gap-1.5">
                <Favicon url={source.url} size={14} />
                <Text className="text-xs text-muted-foreground" numberOfLines={1}>{source.domain}</Text>
              </View>
              <Text className="text-sm font-medium text-foreground" numberOfLines={2}>{source.title}</Text>
              {source.snippet ? (
                <Text className="text-xs text-muted-foreground" numberOfLines={2}>{source.snippet}</Text>
              ) : null}
            </View>
          </Pressable>
        ))}
      </View>
    );
  }

  const shown = sources.slice(0, COLLAPSED_COUNT);
  const hidden = sources.length - shown.length;
  return (
    <View className="mt-3 flex-row flex-wrap gap-1.5">
      {shown.map((source) => (
        <Pressable
          key={source.url}
          accessibilityRole="link"
          accessibilityLabel={source.title}
          onPress={() => openSource(source.url)}
          className={cn(
            "flex-row items-center gap-1.5 rounded-full bg-muted pl-1.5 pr-2.5 h-7 max-w-[220px]",
            "web:hover:bg-muted-foreground/20 active:opacity-80",
          )}
        >
          <Favicon url={source.url} size={16} />
          <Text className="text-xs text-muted-foreground flex-shrink" numberOfLines={1}>{source.domain}</Text>
        </Pressable>
      ))}
      {hidden > 0 && (
        <Button variant="secondary" size="xs" onPress={onToggle}>
          {`+${hidden}`}
        </Button>
      )}
    </View>
  );
});
