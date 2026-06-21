import { View, Pressable, Platform } from "react-native";
import { toast } from "@/components/sonner";
import { Image } from "expo-image";
import { KeyboardAwareScrollView } from "@/lib/keyboard";
import { CustomMarkdown } from "@/components/ui/markdown";
import { Text } from "@/components/ui/text";
import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { processMessage } from "@/lib/message-processor";
import { cn } from "@/lib/utils";
import { ThinkingIndicator } from "@/lib/sdk";
import {
  Copy, ThumbsUp, ThumbsDown, Pencil, Check, Share2,
  Download, RefreshCw, MoreHorizontal, ChevronDown,
} from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import Animated, {
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
} from "react-native-reanimated";
import * as Clipboard from "expo-clipboard";
import { Reasoning, ReasoningTrigger } from "@/components/ui/reasoning";
import {
  getToolLabel, getToolActiveLabel, getResearchActiveLabel,
  getTextFromContent, getImagesFromContent,
} from "@/lib/sdk";
import { useUIStore } from "@/lib/stores/ui-store";
import { useStore } from "@/lib/globalStore";
import type { ToolInvocation } from "@clarity/shared-types";
import { useScrollToBottom } from "@/hooks/use-scroll-to-bottom";
import { ResearchProgressCard } from "@/lib/sdk";
import type { ResearchProgress as ResearchProgressData } from "@/lib/sdk";
import { Skeleton } from "@/components/ui/skeleton";
import apiClient from "@/lib/api/client";
import { useTranslation } from "@/hooks/useTranslation";

const isWeb = Platform.OS === "web";

type MessagePart = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "function" | "data" | "tool";
  content?: string | Array<{ type: string; [key: string]: unknown }>;
  thinking?: string;
  parts?: MessagePart[];
  toolInvocations?: ToolInvocation[];
  source?: "text" | "voice";
  speaker?: "primary" | "cohost";
  isStreaming?: boolean;
  audioUrl?: string;
};

type ChatInterfaceProps = {
  messages: Message[];
  scrollViewRef: React.RefObject<GHScrollView>;
  isLoading?: boolean;
  conversationLoading?: boolean;
  onSuggestionPress?: (message: string) => void;
  onStartEdit?: (messageId: string, content: string) => void;
  onCopyMessage?: (content: string) => void;
  bottomPadding?: number;
  onAtBottomChange?: (isAtBottom: boolean) => void;
};

function isClarityMessage(m: Message): boolean {
  return m.role === "assistant";
}

function getMessageText(message: Message): string {
  let rawText = "";
  if (message.content) {
    rawText = getTextFromContent(message.content);
  } else if (message.parts && Array.isArray(message.parts)) {
    rawText = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join("");
  }
  const processed = processMessage(rawText, "app");
  return processed.text;
}

function getMessageImages(message: Message): string[] {
  if (message.content) {
    return getImagesFromContent(message.content);
  }
  return [];
}

/** Count completed tool invocations for "Completed N steps" */
function getCompletedStepsCount(message: Message): number {
  if (!message.toolInvocations) return 0;
  return message.toolInvocations.filter((t) => t.state === "result").length;
}

/** Pulsing bullet for tool execution status. */
const ToolBullet = React.memo(function ToolBullet({ isRunning }: { isRunning: boolean }) {
  const opacity = useSharedValue(1);
  React.useEffect(() => {
    if (isRunning) {
      opacity.value = withRepeat(
        withSequence(
          withTiming(0.3, { duration: 500 }),
          withTiming(1, { duration: 500 })
        ),
        -1
      );
    } else {
      opacity.value = withTiming(1, { duration: 150 });
    }
    return () => cancelAnimation(opacity);
  }, [isRunning, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={style}>
      <Text style={{ color: isRunning ? "#eab308" : "#22c55e", fontSize: 10 }}>{"●"}</Text>
    </Animated.View>
  );
});

/** Collapsible "Completed N steps" section above AI response */
const CompletedSteps = React.memo(function CompletedSteps({
  message,
  openThoughtPanel,
}: {
  message: Message;
  openThoughtPanel: (messageId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const completedCount = getCompletedStepsCount(message);
  const hasRunningTools = message.toolInvocations?.some(
    (t) => t.state === "call" || t.state === "partial-call"
  );

  if (completedCount === 0 && !hasRunningTools) return null;

  return (
    <View className="mb-2">
      <Pressable
        onPress={() => setExpanded((prev) => !prev)}
        className="flex-row items-center gap-1.5 py-1"
      >
        <ChevronDown
          size={14}
          className="text-muted-foreground"
          style={expanded ? undefined : { transform: [{ rotate: "-90deg" }] }}
        />
        <Text className="text-xs text-muted-foreground font-medium">
          {hasRunningTools
            ? `Working... (${completedCount} steps completed)`
            : `Completed ${completedCount} step${completedCount !== 1 ? "s" : ""}`}
        </Text>
      </Pressable>

      {expanded &&
        message.toolInvocations?.map((t, ti) => {
          const key = t.toolCallId || `tool-${message.id}-${ti}`;
          const toolLabel = getToolLabel(t.toolName);
          const isRunning = t.state === "call" || t.state === "partial-call";

          let description = "";
          if (t.args?.url) {
            const url = String(t.args.url);
            description = url.length > 40 ? url.substring(0, 40) + "..." : url;
          } else if (t.args?.query) {
            const q = String(t.args.query);
            description = `"${q.length > 30 ? q.substring(0, 30) + "..." : q}"`;
          }

          const isDone = t.state === "result";
          return (
            <Pressable
              key={key}
              className="flex-row items-center gap-2 py-1 pl-5 active:opacity-70"
              onPress={isDone ? () => openThoughtPanel(message.id) : undefined}
              disabled={!isDone}
            >
              <ToolBullet isRunning={isRunning} />
              <Text className="text-xs text-foreground flex-1 flex-shrink">
                <Text className="font-bold">{toolLabel}</Text>
                {description ? (
                  <Text className="text-muted-foreground"> {description}</Text>
                ) : null}
              </Text>
            </Pressable>
          );
        })}
    </View>
  );
});

/** Action bar below each AI response */
const ResponseActionBar = React.memo(function ResponseActionBar({
  messageId,
  messageText,
  isCopied,
  myVote,
  sourcesCount,
  handleCopyMessage,
  handleVote,
}: {
  messageId: string;
  messageText: string;
  isCopied: boolean;
  myVote: "up" | "down" | null;
  sourcesCount: number;
  handleCopyMessage: (messageId: string, content: string) => void;
  handleVote: (messageId: string, vote: "up" | "down") => void;
}) {
  const handleShare = useCallback(() => {
    toast.info("Share coming soon");
  }, []);

  const handleDownload = useCallback(() => {
    toast.info("Download coming soon");
  }, []);

  const handleRewrite = useCallback(() => {
    toast.info("Rewrite coming soon");
  }, []);

  return (
    <View className="flex-row items-center justify-between mt-2 pt-1">
      {/* Left actions */}
      <View className="flex-row items-center gap-0.5">
        <Pressable
          onPress={handleShare}
          className="h-8 w-8 rounded-full items-center justify-center"
        >
          <Share2 size={14} className="text-muted-foreground" />
        </Pressable>
        <Pressable
          onPress={handleDownload}
          className="h-8 w-8 rounded-full items-center justify-center"
        >
          <Download size={14} className="text-muted-foreground" />
        </Pressable>
        <Pressable
          onPress={() => handleCopyMessage(messageId, messageText)}
          className="h-8 w-8 rounded-full items-center justify-center"
        >
          {isCopied ? (
            <Check size={14} className="text-green-500" />
          ) : (
            <Copy size={14} className="text-muted-foreground" />
          )}
        </Pressable>
        <Pressable
          onPress={handleRewrite}
          className="h-8 w-8 rounded-full items-center justify-center"
        >
          <RefreshCw size={14} className="text-muted-foreground" />
        </Pressable>

        {sourcesCount > 0 && (
          <Pressable className="h-8 rounded-full px-3 flex-row items-center gap-1">
            <Text className="text-xs text-muted-foreground font-normal">
              {sourcesCount} source{sourcesCount !== 1 ? "s" : ""}
            </Text>
          </Pressable>
        )}
      </View>

      {/* Right actions */}
      <View className="flex-row items-center gap-0.5">
        <Pressable
          onPress={() => handleVote(messageId, "up")}
          className="h-8 w-8 rounded-full items-center justify-center"
        >
          <ThumbsUp
            size={14}
            className={myVote === "up" ? "text-primary" : "text-muted-foreground"}
          />
        </Pressable>
        <Pressable
          onPress={() => handleVote(messageId, "down")}
          className="h-8 w-8 rounded-full items-center justify-center"
        >
          <ThumbsDown
            size={14}
            className={myVote === "down" ? "text-primary" : "text-muted-foreground"}
          />
        </Pressable>
        <Pressable className="h-8 w-8 rounded-full items-center justify-center">
          <MoreHorizontal size={14} className="text-muted-foreground" />
        </Pressable>
      </View>
    </View>
  );
});

/** Extracted assistant message content to avoid Record<string, unknown> inside View children */
const AssistantContent = React.memo(function AssistantContent({
  m,
  messageText,
  isLoading,
  isLastMessage,
  isCopied,
  myVote,
  sourcesCount,
  handleCopyMessage,
  handleVote,
  openThoughtPanel,
}: {
  m: Message;
  messageText: string;
  isLoading?: boolean;
  isLastMessage: boolean;
  isCopied: boolean;
  myVote: "up" | "down" | null;
  sourcesCount: number;
  handleCopyMessage: (messageId: string, content: string) => void;
  handleVote: (messageId: string, vote: "up" | "down") => void;
  openThoughtPanel: (messageId: string) => void;
}) {
  const msg = m as Message & {
    researchProgress?: ResearchProgressData;
    thinking?: string;
    isStreaming?: boolean;
  };

  const showThinkingIndicator = isLoading && isLastMessage && !messageText;

  let activeStatus: string | undefined;
  if (showThinkingIndicator) {
    const activeTool = m.toolInvocations?.find(
      (t) => t.state === "call" || t.state === "partial-call"
    );
    if (activeTool) {
      activeStatus = getToolActiveLabel(activeTool.toolName);
    } else if (msg.researchProgress?.phase && msg.researchProgress.phase !== "complete") {
      activeStatus = getResearchActiveLabel(msg.researchProgress.phase);
    } else if (msg.thinking) {
      activeStatus = "Reasoning...";
    }
  }

  return (
    <View className="w-full">
      {/* Completed steps collapsible */}
      <CompletedSteps message={m} openThoughtPanel={openThoughtPanel} />

      {/* Deep Research Progress */}
      {msg.researchProgress != null && (
        <ResearchProgressCard progress={msg.researchProgress} />
      )}

      {/* Thinking / Reasoning */}
      {msg.thinking != null && (
        <View className="mb-3 w-full">
          <Reasoning isStreaming={isLoading && isLastMessage && !messageText}>
            <ReasoningTrigger onPress={() => openThoughtPanel(m.id)} />
          </Reasoning>
        </View>
      )}

      {/* Message content */}
      {(messageText.length > 0 || msg.isStreaming === true) && (
        <View className="font-sans text-base text-foreground w-full">
          <CustomMarkdown content={messageText} />
        </View>
      )}

      {/* ThinkingIndicator for streaming with no text yet */}
      {showThinkingIndicator && (
        <ThinkingIndicator
          isWorking={(m.toolInvocations?.length ?? 0) > 0}
          statusText={activeStatus}
        />
      )}

      {/* Response action bar */}
      {messageText.length > 0 && (
        <ResponseActionBar
          messageId={m.id}
          messageText={messageText}
          isCopied={isCopied}
          myVote={myVote}
          sourcesCount={sourcesCount}
          handleCopyMessage={handleCopyMessage}
          handleVote={handleVote}
        />
      )}
    </View>
  );
});

type MessageRowProps = {
  m: Message;
  index: number;
  isNewMessage: boolean;
  isAssistant: boolean;
  isLoading?: boolean;
  isLastMessage: boolean;
  isCopied: boolean;
  myVote: "up" | "down" | null;
  chatId: unknown;
  handleCopyMessage: (messageId: string, content: string) => void;
  handleVote: (messageId: string, vote: "up" | "down") => void;
  openThoughtPanel: (messageId: string) => void;
  onStartEdit?: (messageId: string, content: string) => void;
};

const MessageRow = React.memo(function MessageRow({
  m,
  index,
  isNewMessage,
  isAssistant,
  isLoading,
  isLastMessage,
  isCopied,
  myVote,
  chatId,
  handleCopyMessage,
  handleVote,
  openThoughtPanel,
  onStartEdit,
}: MessageRowProps) {
  const messageText = getMessageText(m);
  const messageImages = getMessageImages(m);

  // Count sources from completed tool results (search results)
  const sourcesCount = useMemo(() => {
    if (!m.toolInvocations) return 0;
    return m.toolInvocations.filter((t) => t.state === "result").length;
  }, [m.toolInvocations]);

  return (
    <Animated.View
      key={m.id || `msg-${index}`}
      entering={isNewMessage ? FadeInUp.springify() : undefined}
      className={cn("w-full", index > 0 && "mt-4 md:mt-6")}
    >
      {/* User message bubble */}
      {m.role === "user" && (
        <View className="relative flex-row items-end gap-0.5 justify-end group">
          {/* Hover actions (web only) */}
          {isWeb && (
            <View className="flex-row gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity mb-1">
              <Pressable
                onPress={() => onStartEdit?.(m.id, messageText)}
                className="h-8 w-8 rounded-full items-center justify-center"
              >
                <Pencil size={14} className="text-muted-foreground" />
              </Pressable>
              <Pressable
                onPress={() => handleCopyMessage(m.id, messageText)}
                className="h-8 w-8 rounded-full items-center justify-center"
              >
                {isCopied ? (
                  <Check size={14} className="text-green-500" />
                ) : (
                  <Copy size={14} className="text-muted-foreground" />
                )}
              </Pressable>
            </View>
          )}

          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Pressable>
                <View className="min-w-[48px] select-none p-3 bg-muted rounded-2xl" style={{ maxWidth: 600 }}>
                  {messageImages.length > 0 && (
                    <View className="flex-row flex-wrap gap-2 mb-2">
                      {messageImages.map((imgUrl, imgIdx) => (
                        <View
                          key={`img-${imgIdx}`}
                          className="rounded-xl overflow-hidden"
                          style={imageThumbStyle}
                        >
                          <Image source={{ uri: imgUrl }} className="w-full h-full" contentFit="cover" />
                        </View>
                      ))}
                    </View>
                  )}
                  <Text className="font-sans text-base text-foreground font-normal">
                    {messageText}
                  </Text>
                </View>
              </Pressable>
            </DropdownMenu.Trigger>
            {!isWeb && (
              <DropdownMenu.Content>
                <DropdownMenu.Item key="copy" onSelect={() => handleCopyMessage(m.id, messageText)}>
                  <DropdownMenu.ItemIcon ios={{ name: "doc.on.doc" }} />
                  <DropdownMenu.ItemTitle>Copy</DropdownMenu.ItemTitle>
                </DropdownMenu.Item>
                <DropdownMenu.Item key="edit" onSelect={() => onStartEdit?.(m.id, messageText)}>
                  <DropdownMenu.ItemIcon ios={{ name: "pencil" }} />
                  <DropdownMenu.ItemTitle>Edit</DropdownMenu.ItemTitle>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            )}
          </DropdownMenu.Root>
        </View>
      )}

      {/* Assistant message */}
      {m.role === "assistant" && (
        <AssistantContent
          m={m}
          messageText={messageText}
          isLoading={isLoading}
          isLastMessage={isLastMessage}
          isCopied={isCopied}
          myVote={myVote}
          sourcesCount={sourcesCount}
          handleCopyMessage={handleCopyMessage}
          handleVote={handleVote}
          openThoughtPanel={openThoughtPanel}
        />
      )}
    </Animated.View>
  );
});

const imageThumbStyle = { width: 120, height: 120 };

export const ChatInterface = React.memo(function ChatInterface({
  messages,
  scrollViewRef,
  isLoading,
  conversationLoading,
  onSuggestionPress,
  onStartEdit,
  onCopyMessage,
  bottomPadding = 160,
  onAtBottomChange,
}: ChatInterfaceProps) {
  const { t } = useTranslation();
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [votedMessages, setVotedMessages] = useState<Record<string, "up" | "down">>({});
  const voteInFlightRef = useRef<Set<string>>(new Set());
  const openThoughtPanel = useUIStore((s) => s.openThoughtPanel);
  const setThoughtMessages = useUIStore((s) => s.setThoughtMessages);
  const chatId = useStore((s) => s.chatId);

  const { isAtBottom, onScroll, onContentSizeChange } = useScrollToBottom(scrollViewRef);

  useEffect(() => {
    onAtBottomChange?.(isAtBottom);
  }, [isAtBottom, onAtBottomChange]);

  const prevMessageCountRef = useRef(messages.length);
  useEffect(() => {
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  const filteredMessages = useMemo(
    () => messages.filter((m) => m != null && m.role),
    [messages]
  );

  // Sync messages to the UI store so ThoughtPanel can access them
  const rightPanel = useUIStore((s) => s.rightPanel);
  useEffect(() => {
    if (rightPanel === "thought") {
      setThoughtMessages(messages as never[]);
    }
  }, [messages, setThoughtMessages, rightPanel]);

  const handleCopyMessage = useCallback(
    async (messageId: string, content: string) => {
      await Clipboard.setStringAsync(content);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
      toast.success(t("chat.copiedToClipboard"));
      onCopyMessage?.(content);
    },
    [onCopyMessage, t]
  );

  const handleVote = useCallback(
    (messageId: string, vote: "up" | "down") => {
      if (voteInFlightRef.current.has(messageId)) return;
      let newVote: "up" | "down" | null = null;
      setVotedMessages((prev) => {
        newVote = prev[messageId] === vote ? null : vote;
        if (newVote) return { ...prev, [messageId]: newVote };
        const { [messageId]: _, ...rest } = prev;
        return rest;
      });
      if (!chatId?.id) return;
      voteInFlightRef.current.add(messageId);
      apiClient
        .patch(`/conversations/${chatId.id}/messages/${messageId}/vote`, { vote: newVote })
        .then(() => toast.success(t("chat.thanksFeedback")))
        .catch(() => {
          setVotedMessages((prev) => {
            const { [messageId]: _, ...rest } = prev;
            return rest;
          });
        })
        .finally(() => voteInFlightRef.current.delete(messageId));
    },
    [chatId, t]
  );

  // Auto-scroll on new messages
  useEffect(() => {
    const timer = setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
    return () => clearTimeout(timer);
  }, [messages.length, isLoading, scrollViewRef]);

  const scrollContentStyle = useMemo(
    () => ({ flexGrow: 1, paddingTop: 80, paddingBottom: bottomPadding }),
    [bottomPadding]
  );

  return (
    <KeyboardAwareScrollView
      ref={scrollViewRef}
      bottomOffset={60}
      className="flex-1 bg-background"
      contentContainerStyle={scrollContentStyle}
      showsVerticalScrollIndicator={false}
      onScroll={onScroll}
      scrollEventThrottle={16}
      onContentSizeChange={onContentSizeChange}
    >
      <View className="mx-auto max-w-[720px] w-full p-4 md:p-6">
        {!messages.length &&
          (conversationLoading ? (
            <View className="gap-5 py-4">
              <View className="items-end">
                <Skeleton style={{ width: "65%", height: 48, borderRadius: 24 }} />
              </View>
              <View className="items-start gap-2.5">
                <Skeleton style={{ width: "80%", height: 14, borderRadius: 8 }} />
                <Skeleton style={{ width: "70%", height: 14, borderRadius: 8 }} />
                <Skeleton style={{ width: "45%", height: 14, borderRadius: 8 }} />
              </View>
            </View>
          ) : null)}

        {filteredMessages.map((m, index) => {
          const isAssistant = isClarityMessage(m);
          const isNewMessage = index >= prevMessageCountRef.current;

          return (
            <MessageRow
              key={m.id || `msg-${index}`}
              m={m}
              index={index}
              isNewMessage={isNewMessage}
              isAssistant={isAssistant}
              isLoading={isLoading}
              isLastMessage={index === filteredMessages.length - 1}
              isCopied={copiedMessageId === m.id}
              myVote={votedMessages[m.id] ?? null}
              chatId={chatId}
              handleCopyMessage={handleCopyMessage}
              handleVote={handleVote}
              openThoughtPanel={openThoughtPanel}
              onStartEdit={onStartEdit}
            />
          );
        })}
      </View>
    </KeyboardAwareScrollView>
  );
});
