import React from "react";
import { Button } from "@oxy.so/bloom/button";
import { ChevronDown } from "lucide-react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { bloomIcon } from "@/lib/bloom-icon";
import { useTranslation } from "@/hooks/useTranslation";

export type ScrollButtonProps = {
  isAtBottom: boolean;
  onScrollToBottom: () => void;
  className?: string;
};

function ScrollButton({
  className,
  isAtBottom,
  onScrollToBottom,
}: ScrollButtonProps) {
  const { t } = useTranslation();
  if (isAtBottom) return null;

  return (
    <Animated.View entering={FadeInDown.duration(150)} exiting={FadeOutDown.duration(150)}>
      <Button
        appearance="outline"
        size="lg"
        iconOnly
        icon={bloomIcon(ChevronDown)}
        onPress={onScrollToBottom}
        accessibilityLabel={t("actions.scrollToBottom")}
        className={className}
      />
    </Animated.View>
  );
}

export { ScrollButton };
