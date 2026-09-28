import React from "react";
import { Mic } from "lucide-react-native";
import { GlyphButton } from "@oxy.so/bloom/button";
import { toast } from "@oxy.so/bloom/toast";
import { bloomIcon } from "@/lib/bloom-icon";

export function PromptInputMicButton() {
  const handlePress = () => {
    toast.info("Speech-to-text is not available yet.");
  };

  return (
    <GlyphButton
      size={32}
      glyphSize={16}
      icon={bloomIcon(Mic)}
      onPress={handlePress}
      accessibilityLabel="Voice input"
    />
  );
}
