import React from "react";
import { View, Pressable } from "react-native";
import { Text } from "@/components/ui/text";
import { BaseSidebar } from "@/components/base-sidebar";
import { useRouter, usePathname } from "expo-router";
import { useTranslation } from "@/hooks/useTranslation";
import {
  User,
  Settings2,
  CreditCard,
  Palette,
  Brain,
  PenTool,
  Smartphone,
  Bot,
  Blocks,
  Plug,
  Zap,
  MessageSquarePlus,
  Shield,
  ArrowLeft,
  type LucideIcon,
} from "lucide-react-native";

interface SettingsSection {
  id: string;
  route: string;
  icon: LucideIcon;
  labelKey: string;
}

const SECTIONS: SettingsSection[] = [
  { id: "account", route: "/(app)/settings", icon: User, labelKey: "settings.sections.account" },
  { id: "general", route: "/(app)/settings/general", icon: Settings2, labelKey: "settings.sections.general" },
  { id: "usage", route: "/(app)/settings/usage", icon: CreditCard, labelKey: "settings.sections.billing" },
  { id: "personalization", route: "/(app)/settings/personalization", icon: Palette, labelKey: "settings.sections.personalization" },
  { id: "memory", route: "/(app)/settings/memory", icon: Brain, labelKey: "settings.sections.memory" },
  { id: "writing-style", route: "/(app)/settings/writing-style", icon: PenTool, labelKey: "settings.sections.writingStyle" },
  { id: "accounts", route: "/(app)/settings/accounts", icon: Smartphone, labelKey: "settings.sections.accounts" },
  { id: "bots", route: "/(app)/settings/bots", icon: Bot, labelKey: "settings.sections.bots" },
  { id: "mcp", route: "/(app)/settings/mcp", icon: Blocks, labelKey: "settings.sections.mcp" },
  { id: "integrations", route: "/(app)/settings/integrations", icon: Plug, labelKey: "settings.sections.integrations" },
  { id: "skills", route: "/(app)/settings/skills", icon: Zap, labelKey: "settings.sections.skills" },
  { id: "security", route: "/(app)/settings/security", icon: Shield, labelKey: "settings.sections.security" },
  { id: "feedback", route: "/(app)/settings/feedback", icon: MessageSquarePlus, labelKey: "settings.sections.feedback" },
];

export const SettingsSidebar = React.memo(function SettingsSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  const activeId = React.useMemo(() => {
    if (pathname.includes("/settings/general")) return "general";
    if (pathname.includes("/settings/usage")) return "usage";
    if (pathname.includes("/settings/personalization")) return "personalization";
    if (pathname.includes("/settings/memory")) return "memory";
    if (pathname.includes("/settings/writing-style")) return "writing-style";
    if (pathname.includes("/settings/accounts")) return "accounts";
    if (pathname.includes("/settings/bots")) return "bots";
    if (pathname.includes("/settings/mcp")) return "mcp";
    if (pathname.includes("/settings/integrations")) return "integrations";
    if (pathname.includes("/settings/skills")) return "skills";
    if (pathname.includes("/settings/security")) return "security";
    if (pathname.includes("/settings/feedback")) return "feedback";
    return "account";
  }, [pathname]);

  const handleSelect = (section: SettingsSection) => {
    router.push(section.route as Parameters<typeof router.push>[0]);
  };

  const handleBack = () => {
    router.replace("/(app)");
  };

  const header = (
    <View className="px-3 pt-4 pb-2">
      <Pressable
        onPress={handleBack}
        className="flex-row items-center gap-2 px-2 h-8 rounded-lg hover:bg-sidebar-accent"
      >
        <ArrowLeft size={16} className="text-muted-foreground" />
        <Text className="text-sm font-medium text-foreground">{t("common.back")}</Text>
      </Pressable>
    </View>
  );

  const footer = <View />;

  return (
    <BaseSidebar header={header} footer={footer}>
      <View className="px-3 py-1">
        <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase px-2 mb-1">
          {t("settings.title")}
        </Text>
        <View className="gap-0.5">
          {SECTIONS.map((section) => {
            const Icon = section.icon;
            const isActive = activeId === section.id;

            return (
              <Pressable
                key={section.id}
                onPress={() => handleSelect(section)}
                className={`flex-row items-center rounded-lg px-2 h-8 ${
                  isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/50"
                }`}
              >
                <Icon
                  size={16}
                  className={isActive ? "text-foreground" : "text-muted-foreground"}
                />
                <Text
                  className={`ml-2 text-sm flex-1 ${
                    isActive ? "font-medium text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {t(section.labelKey)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </BaseSidebar>
  );
});
