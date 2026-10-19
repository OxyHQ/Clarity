import { View, Pressable, Platform } from 'react-native';
import { toast } from '@oxy.so/bloom/toast';
import { Image } from 'expo-image';
import { KeyboardAwareScrollView } from '@/lib/keyboard';
import { CustomMarkdown } from '@/components/ui/markdown';
import { Text } from '@/components/ui/text';
import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import type { ScrollViewInstance } from 'react-native';
import { processMessage } from '@/lib/message-processor';
import { cn } from '@/lib/utils';
import { ThinkingIndicator } from '@/components/chat/thinking-indicator';
import {
  Copy,
  ThumbsUp,
  ThumbsDown,
  Pencil,
  Check,
  Share2,
  Download,
  RefreshCw,
  MoreHorizontal,
  ChevronDown,
  ChevronUp,
  Globe,
  MessageCircle,
  Clock,
  Brain,
  type LucideIcon,
} from 'lucide-react-native';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { Button, GlyphButton } from '@oxy.so/bloom/button';
import { bloomIcon, MenuRowIcon } from '@/lib/bloom-icon';
import Animated, {
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ui/reasoning';
import {
  ALIA_API_ROUTES,
  getImagesFromContent,
  getResearchActiveLabel,
  getTextFromContent,
  getToolActiveLabel,
  getToolLabel,
  type Message as ProductMessage,
  type ResearchProgress as ResearchProgressData,
  toolRendererKey,
  useAliaApi,
} from '@alia.onl/sdk';
import { CLARITY_TOOL_RENDERERS } from '@/components/chat/clarity-tool-renderers';
import { useScrollToBottom } from '@/hooks/use-scroll-to-bottom';
import { ResearchProgressCard } from '@/components/chat/research-progress-card';
import { Skeleton } from '@/components/ui/skeleton';
import { useShareSearch } from '@/hooks/useShareSearch';
import { useTranslation } from '@/hooks/useTranslation';
import { SourceList } from '@/components/search/source-list';
import {
  citationUrls,
  collectMessageSources,
  hostnameOf,
  linkCitations,
  resultDomains,
  type Source,
} from '@/lib/message-sources';

const isWeb = Platform.OS === 'web';

type MessagePart = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

type Message = ProductMessage & {
  id: string;
  parts?: MessagePart[];
};

type ChatInterfaceProps = {
  /** The conversation the votes are stored in; a new search has none yet. */
  conversationId?: string;
  messages: ProductMessage[];
  scrollViewRef: React.RefObject<ScrollViewInstance | null>;
  isLoading?: boolean;
  conversationLoading?: boolean;
  onSuggestionPress?: (message: string) => void;
  onStartEdit?: (messageId: string, content: string) => void;
  onCopyMessage?: (content: string) => void;
  bottomPadding?: number;
  onAtBottomChange?: (isAtBottom: boolean) => void;
};

function isClarityMessage(m: Message): boolean {
  return m.role === 'assistant';
}

function getMessageText(message: Message): string {
  let rawText = '';
  if (message.content) {
    rawText = getTextFromContent(message.content);
  } else if (message.parts && Array.isArray(message.parts)) {
    rawText = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text || '')
      .join('');
  }
  const processed = processMessage(rawText, 'app');
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
  return message.toolInvocations.filter((t) => t.state === 'result').length;
}

/** Pulsing bullet for tool execution status. */
const ToolBullet = React.memo(function ToolBullet({ isRunning }: { isRunning: boolean }) {
  const opacity = useSharedValue(1);
  React.useEffect(() => {
    if (isRunning) {
      opacity.value = withRepeat(
        withSequence(withTiming(0.3, { duration: 500 }), withTiming(1, { duration: 500 })),
        -1,
      );
    } else {
      opacity.value = withTiming(1, { duration: 150 });
    }
    return () => cancelAnimation(opacity);
  }, [isRunning, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={style}>
      <Text style={{ color: isRunning ? '#eab308' : '#22c55e', fontSize: 10 }}>{'●'}</Text>
    </Animated.View>
  );
});

/** A step's glyph, by what kind of tool it is: the web, messages, the clock, memory. */
const TOOL_ICON: Record<string, LucideIcon> = {
  webSearch: Globe,
  webScraper: Globe,
  browse: Globe,
  deepResearch: Globe,
  sendMessage: MessageCircle,
  getCurrentDate: Clock,
  memory: Brain,
};

function toolIcon(toolName: string): LucideIcon {
  if (toolRendererKey(toolName)?.startsWith('clarity:')) return Globe;
  return TOOL_ICON[toolName] ?? Globe;
}

/** Collapsible "Completed N steps" section above AI response */
const CompletedSteps = React.memo(function CompletedSteps({ message }: { message: Message }) {
  const [expanded, setExpanded] = useState(false);
  const completedCount = getCompletedStepsCount(message);
  const hasRunningTools = message.toolInvocations?.some(
    (t) => t.state === 'call' || t.state === 'partial-call',
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
          style={expanded ? undefined : { transform: [{ rotate: '-90deg' }] }}
        />
        <Text className="text-xs text-muted-foreground font-medium">
          {hasRunningTools
            ? `Working... (${completedCount} steps completed)`
            : `Completed ${completedCount} step${completedCount !== 1 ? 's' : ''}`}
        </Text>
      </Pressable>

      {expanded && (
        <View className="relative pl-2">
          {/* Connecting line down the step list */}
          <View className="absolute left-[13px] top-1 bottom-1 w-px bg-border" />

          {message.toolInvocations?.map((t, ti) => {
            const key = t.toolCallId || `tool-${message.id}-${ti}`;
            const toolLabel = getToolLabel(t.toolName);
            const CategoryIcon = toolIcon(t.toolName);
            const isRunning = t.state === 'call' || t.state === 'partial-call';

            const args =
              t.args && typeof t.args === 'object' && !Array.isArray(t.args)
                ? (t.args as Record<string, unknown>)
                : null;
            const url = typeof args?.url === 'string' ? args.url : undefined;
            const query = typeof args?.query === 'string' ? args.query : undefined;
            const hostname = url ? hostnameOf(url) : undefined;
            const domains = hostname ? [] : resultDomains(t);

            return (
              <View key={key} className="flex-row items-start gap-2 py-1">
                <View className="w-5 h-5 rounded-md bg-muted items-center justify-center shrink-0">
                  <CategoryIcon size={11} className="text-muted-foreground" />
                </View>
                <View className="flex-1 gap-1">
                  <Text className="text-xs text-foreground flex-1 flex-shrink">
                    <Text className="font-bold">{toolLabel}</Text>
                    {query ? (
                      <Text className="text-muted-foreground">
                        {' '}
                        "{query.length > 40 ? `${query.slice(0, 40)}...` : query}"
                      </Text>
                    ) : null}
                  </Text>
                  {hostname && (
                    <View className="flex-row items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 self-start">
                      <Globe size={11} className="text-muted-foreground shrink-0" />
                      <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                        {hostname}
                      </Text>
                    </View>
                  )}
                  {domains.length > 0 && (
                    <View className="flex-row flex-wrap gap-1">
                      {domains.map((domain) => (
                        <View
                          key={domain}
                          className="flex-row items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1"
                        >
                          <Globe size={11} className="text-muted-foreground shrink-0" />
                          <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                            {domain}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
                <ToolBullet isRunning={isRunning} />
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
});

/** Action bar below each AI response */
const ResponseActionBar = React.memo(function ResponseActionBar({
  conversationId,
  messageId,
  messageText,
  isCopied,
  myVote,
  sourcesCount,
  sourcesExpanded,
  onToggleSources,
  handleCopyMessage,
  handleVote,
}: {
  conversationId?: string;
  messageId: string;
  messageText: string;
  isCopied: boolean;
  myVote: 'up' | 'down' | null;
  sourcesCount: number;
  sourcesExpanded: boolean;
  onToggleSources: () => void;
  handleCopyMessage: (messageId: string, content: string) => void;
  handleVote: (messageId: string, vote: 'up' | 'down') => void;
}) {
  const { t } = useTranslation();
  const handleShare = useShareSearch(conversationId);

  const handleDownload = useCallback(() => {
    toast.info('Download coming soon');
  }, []);

  const handleRewrite = useCallback(() => {
    toast.info('Rewrite coming soon');
  }, []);

  return (
    <View className="flex-row items-center justify-between mt-2 pt-1">
      {/* Left actions */}
      <View className="flex-row items-center gap-0.5">
        <GlyphButton
          size={32}
          glyphSize={14}
          icon={bloomIcon(Share2)}
          onPress={handleShare}
          accessibilityLabel={t('actions.share')}
        />
        <GlyphButton
          size={32}
          glyphSize={14}
          icon={bloomIcon(Download)}
          onPress={handleDownload}
          accessibilityLabel={t('actions.download')}
        />
        <GlyphButton
          size={32}
          glyphSize={14}
          icon={bloomIcon(isCopied ? Check : Copy)}
          onPress={() => handleCopyMessage(messageId, messageText)}
          accessibilityLabel={t('actions.copy')}
        />
        <GlyphButton
          size={32}
          glyphSize={14}
          icon={bloomIcon(RefreshCw)}
          onPress={handleRewrite}
          accessibilityLabel={t('actions.rewrite')}
        />

        {sourcesCount > 0 && (
          <Button
            appearance="plain"
            size="sm"
            trailingIcon={bloomIcon(sourcesExpanded ? ChevronUp : ChevronDown)}
            onPress={onToggleSources}
            aria-expanded={sourcesExpanded}
          >
            {`${sourcesCount} source${sourcesCount !== 1 ? 's' : ''}`}
          </Button>
        )}
      </View>

      {/* Right actions */}
      <View className="flex-row items-center gap-0.5">
        <GlyphButton
          size={32}
          glyphSize={14}
          icon={bloomIcon(ThumbsUp)}
          onPress={() => handleVote(messageId, 'up')}
          pressed={myVote === 'up'}
          accessibilityLabel={t('actions.goodResponse')}
        />
        <GlyphButton
          size={32}
          glyphSize={14}
          icon={bloomIcon(ThumbsDown)}
          onPress={() => handleVote(messageId, 'down')}
          pressed={myVote === 'down'}
          accessibilityLabel={t('actions.badResponse')}
        />
        <GlyphButton
          size={32}
          glyphSize={14}
          icon={bloomIcon(MoreHorizontal)}
          accessibilityLabel={t('actions.more')}
        />
      </View>
    </View>
  );
});

/** Catalogue tools whose results are pages: they belong in the answer's source list. */
const ANSWER_SOURCE_TOOLS = new Set([
  'clarity:search',
  'clarity:getDocument',
  'clarity:getDocumentByUrl',
]);

/**
 * The finished catalogue calls of one answer (`oxy_clarity__searchJobs`, …), drawn with the
 * card the product page draws for the same thing. A tool Clarity has no card for is described
 * by the step list and the answer's text instead.
 */
const CatalogueResults = React.memo(function CatalogueResults({ message }: { message: Message }) {
  const drawn = (message.toolInvocations ?? []).flatMap((invocation) => {
    if (invocation.state !== 'result') return [];
    const key = toolRendererKey(invocation.toolName);
    // Pages are the answer's own sources, listed (and cited) under it.
    if (!key || ANSWER_SOURCE_TOOLS.has(key)) return [];
    const render = CLARITY_TOOL_RENDERERS[key];
    if (!render) return [];
    const [app, tool] = key.split(':');
    return [
      <View key={invocation.toolCallId}>
        {render({
          app,
          tool,
          toolCallId: invocation.toolCallId,
          input: invocation.args,
          output: invocation.result,
          ...(message.agentInfo ? { agentId: message.agentInfo.id } : {}),
        })}
      </View>,
    ];
  });
  return drawn.length > 0 ? <View className="mb-2 gap-2">{drawn}</View> : null;
});

/** Extracted assistant message content to avoid Record<string, unknown> inside View children */
const AssistantContent = React.memo(function AssistantContent({
  conversationId,
  m,
  messageText,
  isLoading,
  isLastMessage,
  isCopied,
  myVote,
  sources,
  citations,
  handleCopyMessage,
  handleVote,
}: {
  conversationId?: string;
  m: Message;
  messageText: string;
  isLoading?: boolean;
  isLastMessage: boolean;
  isCopied: boolean;
  myVote: 'up' | 'down' | null;
  sources: Source[];
  citations: ReadonlyMap<number, string>;
  handleCopyMessage: (messageId: string, content: string) => void;
  handleVote: (messageId: string, vote: 'up' | 'down') => void;
}) {
  const msg = m as Message & {
    researchProgress?: ResearchProgressData;
    thinking?: string;
    isStreaming?: boolean;
  };

  const showThinkingIndicator = isLoading && isLastMessage && !messageText;
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const toggleSources = useCallback(() => setSourcesExpanded((prev) => !prev), []);
  const displayText = useMemo(
    () => linkCitations(messageText, citations),
    [messageText, citations],
  );

  let activeStatus: string | undefined;
  if (showThinkingIndicator) {
    const activeTool = m.toolInvocations?.find(
      (t) => t.state === 'call' || t.state === 'partial-call',
    );
    if (activeTool) {
      activeStatus = getToolActiveLabel(activeTool.toolName);
    } else if (msg.researchProgress?.phase && msg.researchProgress.phase !== 'complete') {
      activeStatus = getResearchActiveLabel(msg.researchProgress.phase);
    } else if (msg.thinking) {
      activeStatus = 'Reasoning...';
    }
  }

  return (
    <View className="w-full">
      {/* Completed steps collapsible */}
      {m.agentInfo ? (
        <Text className="mb-1 text-xs font-medium text-muted-foreground">{m.agentInfo.name}</Text>
      ) : null}

      <CompletedSteps message={m} />

      {/* Clarity's own cards for what its catalogue returned (jobs, news, quotes, pages) */}
      <CatalogueResults message={m} />

      {/* Deep Research Progress */}
      {msg.researchProgress != null && <ResearchProgressCard progress={msg.researchProgress} />}

      {/* Thinking / Reasoning */}
      {msg.thinking != null && (
        <View className="mb-3 w-full">
          <Reasoning isStreaming={isLoading && isLastMessage && !messageText}>
            <ReasoningTrigger />
            <ReasoningContent>{msg.thinking}</ReasoningContent>
          </Reasoning>
        </View>
      )}

      {/* Message content */}
      {(messageText.length > 0 || msg.isStreaming === true) && (
        <View className="font-sans text-base text-foreground w-full">
          <CustomMarkdown content={displayText} />
        </View>
      )}

      {/* The links the answer was built from */}
      {messageText.length > 0 && (
        <SourceList sources={sources} expanded={sourcesExpanded} onToggle={toggleSources} />
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
          conversationId={conversationId}
          messageId={m.id}
          messageText={messageText}
          isCopied={isCopied}
          myVote={myVote}
          sourcesCount={sources.length}
          sourcesExpanded={sourcesExpanded}
          onToggleSources={toggleSources}
          handleCopyMessage={handleCopyMessage}
          handleVote={handleVote}
        />
      )}
    </View>
  );
});

type MessageRowProps = {
  conversationId?: string;
  m: Message;
  index: number;
  isNewMessage: boolean;
  isAssistant: boolean;
  isLoading?: boolean;
  isLastMessage: boolean;
  isCopied: boolean;
  myVote: 'up' | 'down' | null;
  handleCopyMessage: (messageId: string, content: string) => void;
  handleVote: (messageId: string, vote: 'up' | 'down') => void;
  onStartEdit?: (messageId: string, content: string) => void;
};

const MessageRow = React.memo(function MessageRow({
  conversationId,
  m,
  index,
  isNewMessage,
  isLoading,
  isLastMessage,
  isCopied,
  myVote,
  handleCopyMessage,
  handleVote,
  onStartEdit,
}: MessageRowProps) {
  const messageText = getMessageText(m);
  const messageImages = getMessageImages(m);
  const { t } = useTranslation();
  const bubble = (
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
      <Text className="font-sans text-base text-foreground font-normal">{messageText}</Text>
    </View>
  );

  // The links behind the answer: search results, pages read, research sources
  // Stable across streamed text: tool and research events are what change them.
  const sources = useMemo(() => collectMessageSources(m), [m.toolInvocations, m.researchProgress]);
  const citations = useMemo(() => citationUrls(m), [m.toolInvocations, m.researchProgress]);

  return (
    <Animated.View
      key={m.id || `msg-${index}`}
      entering={isNewMessage ? FadeInUp.springify() : undefined}
      className={cn('w-full', index > 0 && 'mt-4 md:mt-6')}
    >
      {/* User message bubble */}
      {m.role === 'user' && (
        <View className="relative flex-row items-end gap-0.5 justify-end group">
          {/* Hover actions (web only) */}
          {isWeb && (
            <View className="flex-row gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity mb-1">
              <GlyphButton
                size={32}
                glyphSize={14}
                icon={bloomIcon(Pencil)}
                onPress={() => onStartEdit?.(m.id, messageText)}
                accessibilityLabel={t('common.edit')}
              />
              <GlyphButton
                size={32}
                glyphSize={14}
                icon={bloomIcon(isCopied ? Check : Copy)}
                onPress={() => handleCopyMessage(m.id, messageText)}
                accessibilityLabel={t('actions.copy')}
              />
            </View>
          )}

          {isWeb ? (
            bubble
          ) : (
            // Native: a tap on the bubble offers the actions the web shows on hover.
            <DropdownMenu>
              <DropdownMenuTrigger asChild label={t('actions.more')}>
                <Pressable>{bubble}</Pressable>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  leading={<MenuRowIcon icon={Copy} />}
                  onPress={() => handleCopyMessage(m.id, messageText)}
                >
                  {t('actions.copy')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  leading={<MenuRowIcon icon={Pencil} />}
                  onPress={() => onStartEdit?.(m.id, messageText)}
                >
                  {t('common.edit')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </View>
      )}

      {/* Assistant message */}
      {m.role === 'assistant' && (
        <AssistantContent
          conversationId={conversationId}
          m={m}
          messageText={messageText}
          isLoading={isLoading}
          isLastMessage={isLastMessage}
          isCopied={isCopied}
          myVote={myVote}
          sources={sources}
          citations={citations}
          handleCopyMessage={handleCopyMessage}
          handleVote={handleVote}
        />
      )}
    </Animated.View>
  );
});

const imageThumbStyle = { width: 120, height: 120 };

export const ChatInterface = React.memo(function ChatInterface({
  conversationId,
  messages,
  scrollViewRef,
  isLoading,
  conversationLoading,
  onStartEdit,
  onCopyMessage,
  bottomPadding = 160,
  onAtBottomChange,
}: ChatInterfaceProps) {
  const { t } = useTranslation();
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [votedMessages, setVotedMessages] = useState<Record<string, 'up' | 'down'>>({});
  const voteInFlightRef = useRef<Set<string>>(new Set());
  const aliaApi = useAliaApi();

  const { isAtBottom, onScroll, onContentSizeChange } = useScrollToBottom(scrollViewRef);

  useEffect(() => {
    onAtBottomChange?.(isAtBottom);
  }, [isAtBottom, onAtBottomChange]);

  const prevMessageCountRef = useRef(messages.length);
  useEffect(() => {
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  const filteredMessages = useMemo(
    () =>
      messages.filter(
        (message): message is Message => typeof message.id === 'string' && message.id.length > 0,
      ),
    [messages],
  );

  const handleCopyMessage = useCallback(
    async (messageId: string, content: string) => {
      await Clipboard.setStringAsync(content);
      setCopiedMessageId(messageId);
      setTimeout(() => setCopiedMessageId(null), 2000);
      toast.success(t('chat.copiedToClipboard'));
      onCopyMessage?.(content);
    },
    [onCopyMessage, t],
  );

  const handleVote = useCallback(
    (messageId: string, vote: 'up' | 'down') => {
      if (voteInFlightRef.current.has(messageId)) return;
      let newVote: 'up' | 'down' | null = null;
      setVotedMessages((prev) => {
        newVote = prev[messageId] === vote ? null : vote;
        if (newVote) return { ...prev, [messageId]: newVote };
        const { [messageId]: _, ...rest } = prev;
        return rest;
      });
      if (!conversationId) return;
      voteInFlightRef.current.add(messageId);
      aliaApi
        .patch(ALIA_API_ROUTES.conversations.vote(conversationId, messageId), { vote: newVote })
        .then(() => toast.success(t('chat.thanksFeedback')))
        .catch(() => {
          setVotedMessages((prev) => {
            const { [messageId]: _, ...rest } = prev;
            return rest;
          });
        })
        .finally(() => voteInFlightRef.current.delete(messageId));
    },
    [conversationId, t, aliaApi],
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
    [bottomPadding],
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
                <Skeleton style={{ width: '65%', height: 48, borderRadius: 24 }} />
              </View>
              <View className="items-start gap-2.5">
                <Skeleton style={{ width: '80%', height: 14, borderRadius: 8 }} />
                <Skeleton style={{ width: '70%', height: 14, borderRadius: 8 }} />
                <Skeleton style={{ width: '45%', height: 14, borderRadius: 8 }} />
              </View>
            </View>
          ) : null)}

        {filteredMessages.map((m, index) => {
          const isAssistant = isClarityMessage(m);
          const isNewMessage = index >= prevMessageCountRef.current;

          return (
            <MessageRow
              key={m.id || `msg-${index}`}
              conversationId={conversationId}
              m={m}
              index={index}
              isNewMessage={isNewMessage}
              isAssistant={isAssistant}
              isLoading={isLoading}
              isLastMessage={index === filteredMessages.length - 1}
              isCopied={copiedMessageId === m.id}
              myVote={votedMessages[m.id] ?? null}
              handleCopyMessage={handleCopyMessage}
              handleVote={handleVote}
              onStartEdit={onStartEdit}
            />
          );
        })}
      </View>
    </KeyboardAwareScrollView>
  );
});
