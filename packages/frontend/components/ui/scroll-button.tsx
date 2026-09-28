import React from "react";
import { Button } from "@oxy.so/bloom/button";
import { ChevronDown } from "lucide-react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { bloomIcon } from "@/lib/bloom-icon";

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
  if (isAtBottom) return null;

  return (
    <Animated.View entering={FadeInDown.duration(150)} exiting={FadeOutDown.duration(150)}>
      <Button
        variant="outline"
        size="lg"
        iconOnly
        icon={bloomIcon(ChevronDown)}
        onPress={onScrollToBottom}
        accessibilityLabel="Scroll to bottom"
        className={className}
      />
    </Animated.View>
  );
}

export { ScrollButton };
