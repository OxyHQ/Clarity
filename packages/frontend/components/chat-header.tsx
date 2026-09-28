import { View, Pressable, useWindowDimensions } from "react-native";
import { Sparkles, Globe, ImageIcon, MoreHorizontal, Share2, Menu, type LucideIcon } from "lucide-react-native";
import { Button, GlyphButton } from "@oxy.so/bloom/button";
import { Tabs, TabsTrigger } from "@oxy.so/bloom/tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { toast } from "@oxy.so/bloom/toast";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { ModelSelector } from "@/components/model-selector";
import { bloomIcon } from "@/lib/bloom-icon";
import { useUIStore } from "@/lib/stores/ui-store";

export type ConversationTab = "answer" | "links" | "images";

interface ChatHeaderProps {
  title: string;
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
  onSearchPress?: () => void;
  onClear?: () => void;
  isConversation?: boolean;
  activeTab?: ConversationTab;
  onTabChange?: (tab: ConversationTab) => void;
}

const TAB_CONFIG: Array<{ id: ConversationTab; labelKey: string; icon: LucideIcon }> = [
  { id: "answer", labelKey: "chatHeader.tabAnswer", icon: Sparkles },
  { id: "links", labelKey: "chatHeader.tabLinks", icon: Globe },
  { id: "images", labelKey: "chatHeader.tabImages", icon: ImageIcon },
];

export function ChatHeader({
  title,
  selectedModel,
  onModelChange,
  onSearchPress,
  onClear,
  isConversation = false,
  activeTab = "answer",
  onTabChange,
}: ChatHeaderProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const router = useRouter();
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const isLargeScreen = dimensions.width >= 768;
  const [showClearDialog, setShowClearDialog] = useState(false);

  const handleDrawerToggle = () => {
    setSidebarOpen(true);
  };

  const handleClearConversation = () => {
    setShowClearDialog(true);
  };

  const confirmClearConversation = () => {
    onClear?.();
  };

  const handleExport = () => {
    toast.info(t("chatHeader.exportComingSoon"));
  };

  const handleShare = () => {
    toast.info(t("chatHeader.shareComingSoon"));
  };

  const handleSettings = () => {
    router.push("/(app)/settings");
  };

  const handleHelp = () => {
    toast.info(t("chatHeader.helpComingSoon"));
  };

  // Non-conversation header (landing page)
  if (!isConversation) {
    return (
      <>
        <View
          className="flex-row items-center justify-between px-4"
          style={{ paddingTop: insets.top, height: 56 + insets.top }}
        >
          <View className="flex-row items-center gap-2">
            {!isLargeScreen && (
              <GlyphButton
                size={36}
                glyphSize={20}
                icon={bloomIcon(Menu)}
                onPress={handleDrawerToggle}
                accessibilityLabel="Open menu"
              />
            )}
            <ModelSelector
              selectedModel={selectedModel}
              onModelChange={onModelChange}
            />
          </View>
        </View>

        <ConfirmationDialog
          open={showClearDialog}
          onOpenChange={setShowClearDialog}
          title={t("chatHeader.clearConfirmTitle")}
          description={t("chatHeader.clearConfirmDescription")}
          confirmText={t("chatHeader.clear")}
          cancelText={t("common.cancel")}
          confirmVariant="destructive"
          onConfirm={confirmClearConversation}
        />
      </>
    );
  }

  // Conversation header with tabs
  return (
    <>
      <View
        className="border-b border-border bg-background"
        style={{ paddingTop: insets.top }}
      >
        <View className="mx-auto w-full max-w-[720px] px-4 md:px-6">
          <View className="flex-row items-center justify-between">
            {/* Left: drawer toggle (mobile) + tabs */}
            <View className="flex-row items-center gap-1">
              {!isLargeScreen && (
                <GlyphButton
                  size={36}
                  glyphSize={20}
                  icon={bloomIcon(Menu)}
                  onPress={handleDrawerToggle}
                  accessibilityLabel="Open menu"
                  style={{ marginRight: 4 }}
                />
              )}

              <Tabs
                value={activeTab}
                onValueChange={(value) => onTabChange?.(value as ConversationTab)}
                variant="underline"
                label="Conversation views"
              >
                {TAB_CONFIG.map((tab) => (
                  <TabsTrigger
                    key={tab.id}
                    value={tab.id}
                    label={t(tab.labelKey)}
                    leadingIcon={bloomIcon(tab.icon)}
                  />
                ))}
              </Tabs>
            </View>

            {/* Right: dots menu + share */}
            <View className="flex-row items-center gap-1">
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  <Pressable className="text-muted-foreground h-8 rounded-lg px-2 items-center justify-center">
                    <MoreHorizontal size={18} className="text-muted-foreground" />
                  </Pressable>
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="end">
                  <DropdownMenu.Item key="export" onSelect={handleExport}>
                    <DropdownMenu.ItemIcon ios={{ name: "arrow.down.doc" }} />
                    <DropdownMenu.ItemTitle>{t("chatHeader.export")}</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item key="settings" onSelect={handleSettings}>
                    <DropdownMenu.ItemIcon ios={{ name: "gearshape" }} />
                    <DropdownMenu.ItemTitle>{t("chatHeader.settings")}</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item key="help" onSelect={handleHelp}>
                    <DropdownMenu.ItemIcon ios={{ name: "questionmark.circle" }} />
                    <DropdownMenu.ItemTitle>{t("chatHeader.help")}</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item key="clear" destructive onSelect={handleClearConversation}>
                    <DropdownMenu.ItemIcon ios={{ name: "trash" }} />
                    <DropdownMenu.ItemTitle>{t("chatHeader.clearConversation")}</DropdownMenu.ItemTitle>
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>

              <Button size="sm" leadingIcon={bloomIcon(Share2)} onPress={handleShare}>
                {t("chatHeader.share")}
              </Button>
            </View>
          </View>
        </View>
      </View>

      <ConfirmationDialog
        open={showClearDialog}
        onOpenChange={setShowClearDialog}
        title={t("chatHeader.clearConfirmTitle")}
        description={t("chatHeader.clearConfirmDescription")}
        confirmText={t("chatHeader.clear")}
        cancelText={t("common.cancel")}
        confirmVariant="destructive"
        onConfirm={confirmClearConversation}
      />
    </>
  );
}
