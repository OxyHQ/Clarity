import React, { useState } from "react";
import { View, ScrollView, type ViewProps } from "react-native";
import { GlyphButton } from "@oxy.so/bloom/button";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { bloomIcon } from "@/lib/bloom-icon";
import { Copy, Check } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import SyntaxHighlighter from "react-native-syntax-highlighter";
import { atomOneLight } from "react-syntax-highlighter/styles/hljs";
import { useTranslation } from "@/hooks/useTranslation";

// --- CodeBlock (root container) ---

export type CodeBlockProps = ViewProps;

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <View
      className={cn(
        "w-full overflow-hidden rounded-xl border border-border bg-card",
        className
      )}
      {...props}
    >
      {children}
    </View>
  );
}

// --- CodeBlockCode (highlighted content) ---

export type CodeBlockCodeProps = {
  code: string;
  language?: string;
  className?: string;
};

function CodeBlockCode({
  code,
  language = "tsx",
  className,
}: CodeBlockCodeProps) {
  if (!code) {
    return (
      <View className={cn("p-4", className)}>
        <Text className="text-sm text-foreground" style={{ fontFamily: "monospace" }}>
          {" "}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} className={cn("", className)}>
      <SyntaxHighlighter
        language={language}
        style={atomOneLight}
        fontSize={13}
        highlighter="hljs"
        customStyle={{
          backgroundColor: "transparent",
          padding: 16,
          margin: 0,
        }}
      >
        {code}
      </SyntaxHighlighter>
    </ScrollView>
  );
}

// --- CodeBlockGroup (header/footer bar) ---

export type CodeBlockGroupProps = ViewProps & {
  language?: string;
  code?: string;
};

function CodeBlockGroup({
  children,
  className,
  language,
  code,
  ...props
}: CodeBlockGroupProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (code) {
      await Clipboard.setStringAsync(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <View
      className={cn(
        "flex-row items-center justify-between border-b border-border px-4 py-2",
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          {language && (
            <Text className="text-xs text-muted-foreground">{language}</Text>
          )}
          {code && (
            <GlyphButton
              size={24}
              glyphSize={14}
              icon={bloomIcon(copied ? Check : Copy)}
              onPress={handleCopy}
              accessibilityLabel={t("actions.copyCode")}
            />
          )}
        </>
      )}
    </View>
  );
}

export { CodeBlock, CodeBlockCode, CodeBlockGroup };
