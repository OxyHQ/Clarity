import React from "react";
import { View, type ViewProps } from "react-native";
import { CloseButton, GlyphButton } from "@oxy.so/bloom/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { ThumbsUp, ThumbsDown } from "lucide-react-native";
import { bloomIcon } from "@/lib/bloom-icon";

type FeedbackBarProps = ViewProps & {
  title?: string;
  icon?: React.ReactNode;
  onHelpful?: () => void;
  onNotHelpful?: () => void;
  onClose?: () => void;
};

export function FeedbackBar({
  className,
  title,
  icon,
  onHelpful,
  onNotHelpful,
  onClose,
  ...props
}: FeedbackBarProps) {
  return (
    <View
      className={cn(
        "flex-row items-center rounded-xl border border-border bg-background",
        className
      )}
      {...props}
    >
      <View className="flex-1 flex-row items-center gap-4 py-3 pl-4">
        {icon}
        {title && <Text className="text-sm font-medium">{title}</Text>}
      </View>

      <View className="flex-row items-center gap-0.5 px-3">
        <GlyphButton
          size={32}
          glyphSize={16}
          icon={bloomIcon(ThumbsUp)}
          onPress={onHelpful}
          accessibilityLabel="Helpful"
        />
        <GlyphButton
          size={32}
          glyphSize={16}
          icon={bloomIcon(ThumbsDown)}
          onPress={onNotHelpful}
          accessibilityLabel="Not helpful"
        />
      </View>

      <View className="border-l border-border items-center justify-center self-stretch px-3">
        <CloseButton size="md" onPress={onClose} accessibilityLabel="Close" />
      </View>
    </View>
  );
}
