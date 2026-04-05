import { View, Pressable, useWindowDimensions } from "react-native";
import { Sparkles, Globe, ImageIcon, MoreHorizontal, Share2, Menu } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/ui/text";
import { useNavigation, useRouter } from "expo-router";
import { DrawerNavigationProp } from "@react-navigation/drawer";
import * as DropdownMenu from "@/components/ui/dropdown-menu";
import { toast } from "@/components/sonner";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { ModelSelector } from "@/components/model-selector";
import { cn } from "@/lib/utils";

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

const TAB_CONFIG: Array<{ id: ConversationTab; labelKey: string; icon: React.ComponentType<{ size: number; className?: string }> }> = [
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
  const navigation = useNavigation<DrawerNavigationProp<never>>();
  const router = useRouter();
  const isLargeScreen = dimensions.width >= 768;
  const [showClearDialog, setShowClearDialog] = useState(false);

  const handleDrawerToggle = () => {
    navigation.toggleDrawer();
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
              <Pressable
                onPress={handleDrawerToggle}
                className="h-9 w-9 items-center justify-center rounded-full"
              >
                <Menu size={20} className="text-muted-foreground" />
              </Pressable>
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
                <Pressable
                  onPress={handleDrawerToggle}
                  className="h-9 w-9 items-center justify-center rounded-full mr-1"
                >
                  <Menu size={20} className="text-muted-foreground" />
                </Pressable>
              )}

              {TAB_CONFIG.map((tab) => {
                const isActive = activeTab === tab.id;
                const Icon = tab.icon;
                return (
                  <Pressable
                    key={tab.id}
                    onPress={() => onTabChange?.(tab.id)}
                    className={cn(
                      "relative flex-row gap-1.5 items-center py-3.5 px-2",
                      isActive ? "opacity-100" : "opacity-60"
                    )}
                  >
                    <Icon size={14} className="text-foreground" />
                    <Text className="font-sans font-medium text-sm text-foreground">
                      {t(tab.labelKey)}
                    </Text>
                    {isActive && (
                      <View className="absolute bottom-0 left-0 right-0 h-0.5 bg-foreground" />
                    )}
                  </Pressable>
                );
              })}
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

              <Pressable
                onPress={handleShare}
                className="bg-primary rounded-lg h-8 px-3 flex-row items-center gap-1"
              >
                <Share2 size={14} className="text-primary-foreground" />
                <Text className="text-primary-foreground text-sm font-medium">
                  {t("chatHeader.share")}
                </Text>
              </Pressable>
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
