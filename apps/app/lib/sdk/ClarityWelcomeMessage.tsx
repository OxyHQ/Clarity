import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/text';
import Animated, { FadeIn } from 'react-native-reanimated';
import { ArrowRight } from 'lucide-react-native';
import type { WelcomeSuggestion } from './types';

export type { WelcomeSuggestion };

export type SearchCategory = 'all' | 'academic' | 'news' | 'code' | 'social';

export interface ClarityWelcomeMessageProps {
  greeting: string;
  subtitle?: string;
  suggestions?: WelcomeSuggestion[];
  onSuggestionPress?: (text: string) => void;
  selectedCategory?: SearchCategory;
  onCategoryChange?: (category: SearchCategory) => void;
}

const CATEGORIES: { id: SearchCategory; label: string; isNew?: boolean }[] = [
  { id: 'all', label: 'All' },
  { id: 'academic', label: 'Academic' },
  { id: 'news', label: 'News' },
  { id: 'code', label: 'Code' },
  { id: 'social', label: 'Social', isNew: true },
];

function CategoryTab({
  label,
  isSelected,
  isNew,
  onPress,
}: {
  label: string;
  isSelected: boolean;
  isNew?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: isSelected }}
      className={
        isSelected
          ? 'font-sans font-medium select-none transition-colors duration-300 relative flex-row gap-1.5 items-center text-sm whitespace-nowrap cursor-pointer rounded-lg px-3 h-8 bg-accent border border-transparent text-foreground'
          : 'font-sans font-medium select-none transition-colors duration-300 relative flex-row gap-1.5 items-center text-sm whitespace-nowrap cursor-pointer rounded-lg px-3 h-8 opacity-80 border border-solid border-border text-foreground hover:bg-muted'
      }
    >
      <Text
        className={
          isSelected
            ? 'text-sm font-medium text-foreground'
            : 'text-sm font-medium text-foreground opacity-80'
        }
      >
        {label}
      </Text>
      {isNew && (
        <View className="inline-flex items-center rounded-full px-1.5">
          <Text className="text-[11px] font-medium text-primary">New</Text>
        </View>
      )}
    </Pressable>
  );
}

function SuggestionCard({
  text,
  onPress,
}: {
  text: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="group flex-row w-full items-center text-left py-2 px-2 rounded-lg cursor-pointer transition-colors hover:bg-muted"
    >
      <Text className="font-sans text-muted-foreground text-sm flex-1" numberOfLines={1}>
        {text}
      </Text>
      <View className="inline-flex shrink-0 ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
        <ArrowRight size={16} className="text-muted-foreground" />
      </View>
    </Pressable>
  );
}

export function ClarityWelcomeMessage({
  suggestions = [],
  onSuggestionPress,
  selectedCategory = 'all',
  onCategoryChange,
}: ClarityWelcomeMessageProps) {
  return (
    <View className="flex w-full flex-col rounded-xl border border-border/50">
      {/* Tab header */}
      {onCategoryChange && (
        <View className="flex-row items-center gap-1 rounded-t-xl bg-muted p-2">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            className="min-w-0 flex-1"
            contentContainerStyle={{ flexDirection: 'row' }}
          >
            <View className="flex-row flex-nowrap w-max items-center gap-2 relative">
              {CATEGORIES.map((cat) => (
                <CategoryTab
                  key={cat.id}
                  label={cat.label}
                  isSelected={selectedCategory === cat.id}
                  isNew={cat.isNew}
                  onPress={() => onCategoryChange(cat.id)}
                />
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {/* Suggestion cards */}
      {suggestions.length > 0 && (
        <Animated.View entering={FadeIn.duration(400)} className="border-t border-border/50">
          <View className="px-2 pb-2 pt-3">
            <View className="flex-col gap-0.5">
              {suggestions.map((item) => (
                <SuggestionCard
                  key={item.id}
                  text={item.description}
                  onPress={() => onSuggestionPress?.(item.description)}
                />
              ))}
            </View>
          </View>
        </Animated.View>
      )}
    </View>
  );
}
