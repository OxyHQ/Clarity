import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { View, Pressable, type TextInput } from "react-native";
import { useColorScheme } from "@/lib/useColorScheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView } from "@/lib/keyboard";
import { LinearGradient } from "expo-linear-gradient";
import type { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { useStore } from "@/lib/globalStore";
import { Globe, X, Brain, Search, Menu, ArrowUp } from "lucide-react-native";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { PromptInput, type Attachment } from "@/components/ui/prompt-input";
import { ScrollButton } from "@/components/ui/scroll-button";
import { ChatInterface } from "@/components/chat-interface";
import { ChatHeader, type ConversationTab } from "@/components/chat-header";
import type { Message } from "@clarity/shared-types";
import { toast } from "@oxy.so/bloom/toast";
import { ComposerPill } from "@oxy.so/bloom/composer-panel";
import type { ComposerPanelAddMenuGroup } from "@oxy.so/bloom/composer-panel";
import { AlertTriangle, Pencil } from "lucide-react-native";
import { CreditWarningBanner } from "@/components/credit-warning-banner";
import { ModelSelector, getThinkingModelId, isThinkingModel } from "@/components/model-selector";
import { useModelStore } from "@/lib/stores/model-store";
import { useEntitlements } from "@/lib/hooks/use-billing";
import { useRouter } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import { WelcomeMessage } from "@/components/welcome-message";
import { ClarityWordmark } from "@/components/ui/clarity-wordmark";
import { useUIStore } from "@/lib/stores/ui-store";
import { useWindowDimensions } from "react-native";
import { ScrollView } from "react-native";
import { useImagePicker } from "@/hooks/useImagePicker";
import { useDocumentPicker } from "@/hooks/useDocumentPicker";
import { cn } from "@/lib/utils";
import { Image } from "react-native";
import { useSearchSuggestions, useRecordSuggestionUsage } from "@/lib/hooks/use-suggestions";
import { useConversations, prefetchConversation } from "@/lib/hooks/use-conversations";
import { useQueryClient } from "@tanstack/react-query";

type Mode = "search" | "deepResearch";

const MODE_CONFIG: Record<Mode, {
  label: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  color: string;
  onToast: string;
  offToast: string;
  featureId?: string;
}> = {
  search: {
    label: "modes.searchLabel",
    icon: Globe,
    color: "#3b82f6",
    onToast: "modes.searchOn",
    offToast: "modes.searchOff",
  },
  deepResearch: {
    label: "modes.deepResearchLabel",
    icon: Search,
    color: "#10b981",
    onToast: "modes.deepResearchOn",
    offToast: "modes.deepResearchOff",
    featureId: "deep-research",
  },
};

/** "3h ago" / "2d ago" — coarse enough for a card, no dependency pulled in for it. */
function relativeTimeAgo(date: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface ChatPageContentProps {
  messages: Message[];
  scrollViewRef: React.RefObject<GHScrollView | null>;
  isLoading: boolean;
  onSubmit: (value: string, attachments?: Attachment[]) => void;
  onSuggestionPress: (message: string) => void;
  onEditMessage: (messageId: string, newContent: string) => void;
  onStop?: () => void;
  onClear?: () => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
  disabled?: boolean;
  conversationLoading?: boolean;
}

const ModeChip = ({ icon: Icon, label, color, onDismiss }: {
  icon: React.ComponentType<{ size: number; color: string }>;
  label: string;
  color: string;
  onDismiss: () => void;
}) => (
  <View className="h-8 rounded-full px-3 flex-row items-center gap-1.5" style={{ backgroundColor: `${color}20` }}>
    <Icon size={14} color={color} />
    <Text className="text-xs font-medium" style={{ color }}>{label}</Text>
    <Pressable onPress={onDismiss} className="active:opacity-70">
      <X size={12} color={color} />
    </Pressable>
  </View>
);

export const ChatPageContent = ({
  messages, scrollViewRef, isLoading, onSubmit, onSuggestionPress,
  onEditMessage, onStop, onClear, selectedModel, onModelChange,
  disabled = false, conversationLoading,
}: ChatPageContentProps) => {
  const attachments = useStore((state) => state.attachments);
  const addAttachment = useStore((state) => state.addAttachment);
  const removeAttachment = useStore((state) => state.removeAttachment);
  const { data: entitlements } = useEntitlements();
  const router = useRouter();
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: conversationsData } = useConversations();
  const recentConversations = useMemo(() => {
    const all = conversationsData?.pages.flatMap((p) => p.conversations) ?? [];
    return [...all].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, 3);
  }, [conversationsData]);
  const handleOpenConversation = useCallback((id: string) => {
    prefetchConversation(qc, id);
    router.push(`/(app)/c/${id}`);
  }, [qc, router]);
  const [activeModes, setActiveModes] = useState<Set<Mode>>(new Set());
  const thinkingMode = isThinkingModel(selectedModel);
  const baseModel = useModelStore((s) => s.baseModel);
  const setBaseModel = useModelStore((s) => s.setBaseModel);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const dimensions = useWindowDimensions();
  const isLargeScreen = dimensions.width >= 768;

  useEffect(() => {
    const currentBase = useModelStore.getState().baseModel;
    if (!isThinkingModel(selectedModel) && selectedModel !== currentBase) {
      setBaseModel(selectedModel);
    }
  }, [selectedModel, setBaseModel]);

  const [inputValue, setInputValue] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ConversationTab>("answer");
  const { colors } = useColorScheme();
  const insets = useSafeAreaInsets();
  const [bottomBarHeight, setBottomBarHeight] = useState(160);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const hasMessages = messages.length > 0;
  const showConversationView = hasMessages || conversationLoading;

  // Landing page autocomplete: debounce input for search suggestions
  useEffect(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || trimmed.length < 2) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(trimmed), 200);
    return () => clearTimeout(timer);
  }, [inputValue]);

  const { data: searchSuggestions } = useSearchSuggestions(debouncedQuery);
  const { mutate: recordUsage } = useRecordSuggestionUsage();

  const completions = useMemo(() => {
    const trimmed = inputValue.trim();
    if (!trimmed || trimmed.length < 2 || !searchSuggestions?.length) return [];

    const lower = trimmed.toLowerCase();
    const results: Array<{ text: string; matchStart: number; matchEnd: number; suggestionId?: string }> = [];
    const seen = new Set<string>();

    for (const s of searchSuggestions) {
      if (results.length >= 6) break;
      const textLower = s.text.toLowerCase();
      if (seen.has(textLower)) continue;
      seen.add(textLower);

      const idx = textLower.indexOf(lower);
      results.push({
        text: s.text,
        matchStart: idx !== -1 ? idx : 0,
        matchEnd: idx !== -1 ? idx + trimmed.length : 0,
        suggestionId: s.suggestionId,
      });
    }

    return results;
  }, [searchSuggestions, inputValue]);

  const handleScrollToBottom = useCallback(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, [scrollViewRef]);

  const toggleMode = useCallback((mode: Mode) => {
    const config = MODE_CONFIG[mode];
    if (config.featureId && !entitlements?.features[config.featureId]) {
      toast.info(t("subscribe.featureRequiresPlan", { feature: t(config.label) }));
      router.push("/(biglayout)/subscribe");
      return;
    }
    setActiveModes((prev) => {
      const next = new Set(prev);
      if (next.has(mode)) {
        next.delete(mode);
        toast.info(t(config.offToast));
      } else {
        next.add(mode);
        toast.info(t(config.onToast));
      }
      if (mode === "deepResearch") {
        useStore.getState().setDeepResearchMode(next.has("deepResearch"));
      }
      return next;
    });
  }, [entitlements, t, router]);

  const handleStartEdit = useCallback((messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setInputValue(content);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setInputValue("");
  }, []);

  const handleSubmit = useCallback(() => {
    if (!inputValue.trim() || isLoading || disabled) return;
    if (editingMessageId) {
      onEditMessage(editingMessageId, inputValue);
      setEditingMessageId(null);
      setInputValue("");
      return;
    }
    onSubmit(inputValue, attachments.length > 0 ? attachments : undefined);
    setInputValue("");
    useStore.getState().clearAttachments();
  }, [inputValue, isLoading, disabled, editingMessageId, onEditMessage, onSubmit, attachments]);

  const handleSuggestionPress = useCallback((message: string) => {
    if (isLoading) return;
    onSuggestionPress(message);
  }, [isLoading, onSuggestionPress]);

  const handleThinkingMode = () => {
    if (thinkingMode) {
      onModelChange(baseModel);
      toast.info(t("modes.thinkingOff"));
    } else {
      onModelChange(getThinkingModelId());
      toast.info(t("modes.thinkingOn"));
    }
  };

  const handleImagePaste = useCallback((files: File[]) => {
    files.forEach((file) => {
      const id = `paste-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      addAttachment({
        id, uri: "", type: "image",
        name: file.name || "Pasted image",
        size: file.size || 0,
        mimeType: file.type || "image/png",
        isLoading: true,
      });
      const reader = new FileReader();
      reader.onload = () => {
        useStore.getState().updateAttachment(id, { uri: reader.result as string, isLoading: false });
      };
      reader.readAsDataURL(file);
    });
  }, [addAttachment]);

  const modeMenuItems = (
    <>
      <DropdownMenu.CheckboxItem
        key="deep-research"
        value={activeModes.has("deepResearch") ? "on" : "off"}
        onValueChange={() => toggleMode("deepResearch")}
      >
        <DropdownMenu.ItemIcon ios={{ name: "magnifyingglass" }} />
        <DropdownMenu.ItemTitle>Deep research</DropdownMenu.ItemTitle>
      </DropdownMenu.CheckboxItem>
      <DropdownMenu.CheckboxItem
        key="thinking"
        value={thinkingMode ? "on" : "off"}
        onValueChange={handleThinkingMode}
      >
        <DropdownMenu.ItemIcon ios={{ name: "brain" }} />
        <DropdownMenu.ItemTitle>Thinking mode</DropdownMenu.ItemTitle>
      </DropdownMenu.CheckboxItem>
    </>
  );

  const actionsLeftContent = (
    <>
      <Button
        variant={activeModes.has("search") ? "default" : "outline"}
        className="h-8 rounded-full px-3 flex-row items-center gap-2 text-muted-foreground hover:text-foreground font-normal text-xs"
        onPress={() => toggleMode("search")}
      >
        <Globe size={16} className={activeModes.has("search") ? "text-primary-foreground" : "text-muted-foreground"} />
      </Button>

      {thinkingMode && (
        <ModeChip icon={Brain} label={t("modes.thinkingLabel")} color="#a855f7" onDismiss={handleThinkingMode} />
      )}

      {activeModes.has("deepResearch") && (
        <ModeChip
          icon={MODE_CONFIG.deepResearch.icon}
          label={t(MODE_CONFIG.deepResearch.label)}
          color={MODE_CONFIG.deepResearch.color}
          onDismiss={() => toggleMode("deepResearch")}
        />
      )}

      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <Button variant="outline" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground">
            <Search size={16} className="text-muted-foreground" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="top" align="start" collisionPadding={8}>
          {modeMenuItems}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </>
  );

  const landingInputRef = useRef<TextInput>(null);
  const { pickImage } = useImagePicker();
  const { pickDocument } = useDocumentPicker();

  const handleAddPhotos = useCallback(async () => {
    const assets = await pickImage();
    if (assets && assets.length > 0) {
      assets.forEach((asset) => {
        addAttachment({
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          uri: asset.uri,
          type: "image",
          name: asset.name,
          size: asset.size,
          mimeType: asset.mimeType,
        });
      });
    }
  }, [addAttachment, pickImage]);

  const handleAddDocument = useCallback(async () => {
    const docs = await pickDocument();
    if (docs && docs.length > 0) {
      docs.forEach((doc) => {
        addAttachment({
          id: `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          uri: doc.uri,
          type: "document",
          name: doc.name,
          size: doc.size,
          mimeType: doc.mimeType,
        });
      });
    }
  }, [addAttachment, pickDocument]);

  const composerAddMenu: ComposerPanelAddMenuGroup[] = useMemo(() => [
    {
      label: "Add",
      rows: [
        { id: "upload-photos", label: "Upload files or images" },
        { id: "upload-document", label: "Upload document" },
      ],
    },
    {
      label: "Modes",
      rows: [
        { id: "deep-research", label: t(MODE_CONFIG.deepResearch.label), description: activeModes.has("deepResearch") ? "On" : undefined },
        { id: "thinking", label: t("modes.thinkingLabel"), description: thinkingMode ? "On" : undefined },
      ],
    },
  ], [t, activeModes, thinkingMode]);

  const handleAddMenuSelect = useCallback((rowId: string) => {
    if (rowId === "upload-photos") handleAddPhotos();
    else if (rowId === "upload-document") handleAddDocument();
    else if (rowId === "deep-research") toggleMode("deepResearch");
    else if (rowId === "thinking") handleThinkingMode();
  }, [handleAddPhotos, handleAddDocument, toggleMode, handleThinkingMode]);

  // ---- Conversation view: tab header + messages + sticky bottom follow-up input ----
  if (showConversationView) {
    return (
      <View className="relative flex h-full flex-col bg-background">
        {/* Sticky tab header */}
        <ChatHeader
          title="Clarity"
          selectedModel={selectedModel}
          onModelChange={onModelChange}
          onClear={onClear}
          isConversation
          activeTab={activeTab}
          onTabChange={setActiveTab}
        />

        {/* Scrollable content area */}
        <View className="relative flex-1 overflow-hidden">
          <ChatInterface
            messages={messages}
            scrollViewRef={scrollViewRef}
            isLoading={isLoading}
            conversationLoading={conversationLoading}
            onSuggestionPress={handleSuggestionPress}
            onStartEdit={handleStartEdit}
            bottomPadding={bottomBarHeight}
            onAtBottomChange={setIsAtBottom}
          />

          {/* Sticky bottom follow-up input */}
          <KeyboardStickyView
            offset={{ closed: 0, opened: 0 }}
            style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10 }}
            onLayout={(e) => setBottomBarHeight(e.nativeEvent.layout.height)}
          >
            {/* Gradient fade from content to input */}
            <LinearGradient
              colors={["transparent", colors.background]}
              locations={[0, 0.5]}
              style={{ paddingTop: 32, paddingBottom: insets.bottom }}
            >
              <CreditWarningBanner selectedModel={selectedModel} onSwitchModel={onModelChange} />

              {disabled && (
                <View className="mx-auto w-full max-w-[720px] px-4 pb-1">
                  <View className="flex-row items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2">
                    <AlertTriangle size={14} className="text-destructive" />
                    <Text className="text-xs text-destructive flex-1">{t("usageLimit.limitReachedBanner")}</Text>
                  </View>
                </View>
              )}

              <View className="mx-auto w-full max-w-[720px] px-4 md:px-6 py-3">
                <View className="relative">
                  <View style={{ position: "absolute", top: -48, right: 0, zIndex: -1 }}>
                    <ScrollButton isAtBottom={isAtBottom} onScrollToBottom={handleScrollToBottom} />
                  </View>
                  {editingMessageId && (
                    <View className="flex-row items-center gap-2 mb-2 px-1">
                      <Pencil size={14} className="text-primary" />
                      <Text className="text-xs text-muted-foreground flex-1">Editing message</Text>
                      <Pressable onPress={handleCancelEdit} className="active:opacity-70">
                        <X size={14} className="text-muted-foreground" />
                      </Pressable>
                    </View>
                  )}
                  <PromptInput
                    value={inputValue}
                    onValueChange={setInputValue}
                    onSubmit={handleSubmit}
                    isLoading={isLoading}
                    disabled={isLoading || disabled}
                    disableKeyboardAvoidance
                    attachments={attachments}
                    onAddAttachment={addAttachment}
                    onRemoveAttachment={removeAttachment}
                    onImagePaste={handleImagePaste}
                    autocomplete
                    leadingAddMenu
                    placeholder={disabled ? t("usageLimit.inputDisabledPlaceholder") : "Ask a follow-up..."}
                    onStop={onStop}
                    actionsLeft={actionsLeftContent}
                  />
                </View>
              </View>
            </LinearGradient>
          </KeyboardStickyView>
        </View>
      </View>
    );
  }

  // ---- Landing: centered search page ----
  return (
    <View className="isolate relative flex h-auto max-h-screen min-w-0 min-h-0 grow flex-col overflow-hidden bg-background">
          <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
            <View className="mx-auto w-full max-w-screen-md px-4 md:px-6 h-full">
                <View className="relative flex h-full flex-col">

                  {/* Mobile header (hidden on desktop) */}
                  {!isLargeScreen && (
                    <View className="py-4 pr-4 pl-1 h-14 flex-row items-center justify-between border-b border-border/50">
                      <View className="gap-x-1 flex-row items-center">
                        <Pressable
                          onPress={() => setSidebarOpen(true)}
                          className="h-9 w-9 items-center justify-center rounded-full"
                        >
                          <Menu size={20} className="text-muted-foreground" />
                        </Pressable>
                      </View>
                    </View>
                  )}

                  {/* Search section (vertically centered) */}
                  <View className="w-full grow flex-col items-center justify-center md:justify-start md:mt-0 md:flex z-10">
                    {/* Spacer pushes content toward center */}
                    <View style={{ height: isLargeScreen ? dimensions.height * 0.3 : dimensions.height * 0.12 }} />

                    {/* Search wrapper */}
                    <View className="relative flex w-full flex-col justify-center md:h-auto">

                      {/* Logo area */}
                      <View className="mb-6 flex w-full items-center justify-center pb-3">
                        <View className="h-auto">
                          <ClarityWordmark width={Math.min(dimensions.width * 0.5, 320)} />
                        </View>
                      </View>

                      {/* Search input — Bloom's real composer, used directly */}
                      <View className="w-full">
                        <ComposerPill
                          inputRef={landingInputRef}
                          value={inputValue}
                          onValueChange={setInputValue}
                          onSubmit={handleSubmit}
                          disabled={disabled}
                          placeholder={disabled ? t("usageLimit.inputDisabledPlaceholder") : "Ask anything..."}
                          addMenu={composerAddMenu}
                          onAddMenuSelect={handleAddMenuSelect}
                        />

                        {/* Active mode tags + model selector — Bloom's composer has no slot
                            for these; the model menu also has no room for the plan-lock
                            badge Clarity's own ModelSelector shows, so it stays separate. */}
                        <View className="mt-2 flex-row items-center justify-between px-1">
                          <View className="flex-row items-center gap-1.5 flex-wrap">
                            <Pressable
                              onPress={() => toggleMode("search")}
                              className="h-7 flex-row items-center gap-1.5 rounded-full px-3"
                              style={{ backgroundColor: activeModes.has("search") ? `${colors.primary}18` : `${colors.muted}60` }}
                            >
                              <Globe size={13} color={activeModes.has("search") ? colors.primary : colors.mutedForeground} />
                              <Text style={{ fontSize: 12, fontWeight: '500', color: activeModes.has("search") ? colors.primary : colors.mutedForeground }}>Focus</Text>
                            </Pressable>
                            {activeModes.has("deepResearch") && (
                              <ModeChip
                                icon={MODE_CONFIG.deepResearch.icon}
                                label={t(MODE_CONFIG.deepResearch.label)}
                                color={MODE_CONFIG.deepResearch.color}
                                onDismiss={() => toggleMode("deepResearch")}
                              />
                            )}
                            {thinkingMode && (
                              <ModeChip icon={Brain} label={t("modes.thinkingLabel")} color="#a855f7" onDismiss={handleThinkingMode} />
                            )}
                          </View>
                          <ModelSelector selectedModel={selectedModel} onModelChange={onModelChange} />
                        </View>

                        {/* Autocomplete suggestions */}
                        {completions.length > 0 && (
                          <View className="mt-2 bg-card rounded-2xl border border-border/60 shadow-sm px-2 py-1">
                            {completions.map((item) => (
                              <Pressable
                                key={item.suggestionId || item.text}
                                onPress={() => {
                                  if (item.suggestionId) recordUsage(item.suggestionId);
                                  setInputValue(item.text);
                                  onSubmit(item.text, attachments.length > 0 ? attachments : undefined);
                                  useStore.getState().clearAttachments();
                                }}
                                className="px-2 py-2 active:bg-muted rounded-lg flex-row items-center"
                              >
                                <Search size={14} className="text-muted-foreground mr-3 shrink-0" />
                                <Text className="text-sm text-foreground flex-1" numberOfLines={1}>
                                  <Text className="text-foreground">{item.text.slice(0, item.matchStart)}</Text>
                                  <Text className="text-primary font-medium">{item.text.slice(item.matchStart, item.matchEnd)}</Text>
                                  <Text className="text-foreground">{item.text.slice(item.matchEnd)}</Text>
                                </Text>
                                <ArrowUp size={14} className="text-muted-foreground ml-2 shrink-0 rotate-45" />
                              </Pressable>
                            ))}
                          </View>
                        )}
                      </View>
                    </View>

                    {/* Recent — real conversation history, styled like the reference's
                        "Recent tasks" cards. Nothing here is fabricated: no card shows
                        without a real conversation behind it, and there's no invented
                        screenshot or status — Clarity doesn't generate either. */}
                    {recentConversations.length > 0 ? (
                      <View className="mt-10 w-full max-w-3xl">
                        <View className="mb-3 flex-row items-center justify-between">
                          <Text className="text-base font-medium text-foreground">Recent</Text>
                          <Pressable onPress={() => router.push("/(app)/history")}>
                            <Text className="text-xs font-medium text-muted-foreground">{t("sidebar.seeAll")}</Text>
                          </Pressable>
                        </View>
                        <View className="flex-row flex-wrap gap-2 justify-center md:justify-start">
                          {recentConversations.map((conv) => (
                            <Pressable
                              key={conv.id}
                              onPress={() => handleOpenConversation(conv.id)}
                              onHoverIn={() => prefetchConversation(qc, conv.id)}
                              className="w-full sm:w-[260px] rounded-xl border border-border/60 bg-card shadow-sm px-3 pt-2 pb-3 active:opacity-80"
                            >
                              <View className="flex-row items-center gap-2 mb-1">
                                <Text className="flex-1 text-xs font-medium text-muted-foreground" numberOfLines={1}>
                                  {relativeTimeAgo(conv.updatedAt)}
                                </Text>
                              </View>
                              <Text className="text-sm font-semibold text-foreground mb-1" numberOfLines={1}>
                                {conv.title || t("sidebar.newSearch")}
                              </Text>
                              {conv.lastMessage && (
                                <Text className="text-xs leading-4 text-muted-foreground" numberOfLines={3}>
                                  {conv.lastMessage}
                                </Text>
                              )}
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    ) : (
                      <View className="mt-6 w-full">
                        <WelcomeMessage onSuggestionPress={handleSuggestionPress} />
                      </View>
                    )}

                    {/* Powered by */}
                    <Text className="mt-8 text-center text-xs text-muted-foreground/60">
                      Clarity is powered by Alia AI
                    </Text>

                  </View>
                </View>
            </View>
          </ScrollView>
    </View>
  );
};
