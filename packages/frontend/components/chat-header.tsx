import { View, useWindowDimensions } from "react-native";
import { Sparkles, Globe, ImageIcon, MoreHorizontal, Share2, Menu, FileDown, Settings, CircleHelp, Trash2, type LucideIcon } from "lucide-react-native";
import { Button, GlyphButton } from "@oxy.so/bloom/button";
import { Tabs, TabsTrigger } from "@oxy.so/bloom/tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@oxy.so/bloom/dropdown-menu";
import { toast } from "@oxy.so/bloom/toast";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { ModelSelector } from "@/components/model-selector";
import { bloomIcon, MenuRowIcon } from "@/lib/bloom-icon";
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
                accessibilityLabel={t("actions.openMenu")}
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
                  accessibilityLabel={t("actions.openMenu")}
                  style={{ marginRight: 4 }}
                />
              )}

              <Tabs
                value={activeTab}
                onValueChange={(value) => onTabChange?.(value as ConversationTab)}
                variant="underline"
                label={t("actions.conversationViews")}
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild label={t("actions.more")}>
                  <GlyphButton
                    size={32}
                    glyphSize={18}
                    icon={bloomIcon(MoreHorizontal)}
                    accessibilityLabel={t("actions.more")}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem leading={<MenuRowIcon icon={FileDown} />} onPress={handleExport}>
                    {t("chatHeader.export")}
                  </DropdownMenuItem>
                  <DropdownMenuItem leading={<MenuRowIcon icon={Settings} />} onPress={handleSettings}>
                    {t("chatHeader.settings")}
                  </DropdownMenuItem>
                  <DropdownMenuItem leading={<MenuRowIcon icon={CircleHelp} />} onPress={handleHelp}>
                    {t("chatHeader.help")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    tone="danger"
                    leading={<MenuRowIcon icon={Trash2} tone="danger" />}
                    onPress={handleClearConversation}
                  >
                    {t("chatHeader.clearConversation")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

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
