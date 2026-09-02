import { useEffect, useState } from "react";
import { Platform, Pressable, Share, TextInput as RNTextInput, View } from "react-native";
import { AlertTriangle, Download, Info, Shield, ShieldCheck, ShieldX } from "lucide-react-native";
import { useOxy } from "@oxyhq/services";
import { toast } from "@oxyhq/bloom/toast";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { useApiClient } from "@/lib/api/use-api-client";
import { useTranslation } from "@/hooks/useTranslation";

interface ThreatEntry {
  id: string;
  timestamp: string;
  severity: "info" | "warning" | "critical";
  agentName: string;
  description: string;
}

interface AuditSummary {
  totalSessions: number;
  completedSessions: number;
  failedSessions: number;
  totalSteps: number;
  threatDetections: number;
}

const SEVERITY_COLORS: Record<ThreatEntry["severity"], string> = {
  info: "text-blue-500",
  warning: "text-yellow-500",
  critical: "text-red-500",
};

const SEVERITY_BG: Record<ThreatEntry["severity"], string> = {
  info: "bg-blue-500/10",
  warning: "bg-yellow-500/10",
  critical: "bg-red-500/10",
};

const SEVERITY_ICONS = {
  info: Info,
  warning: AlertTriangle,
  critical: ShieldX,
} as const;

export function SecuritySection() {
  const { isAuthenticated } = useOxy();
  const { t } = useTranslation();
  const client = useApiClient();
  const [threats, setThreats] = useState<ThreatEntry[]>([]);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [exportFormat, setExportFormat] = useState<"json" | "csv">("json");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      setThreats([]);
      setSummary(null);
      return;
    }
    let active = true;
    setLoading(true);
    Promise.all([
      client.get<AuditSummary>("/audit/summary"),
      client.get<{ threats: ThreatEntry[] }>("/audit/threats", { params: { limit: "20" } }),
    ]).then(([nextSummary, result]) => {
      if (!active) return;
      setSummary(nextSummary);
      setThreats(result.threats);
    }).catch(() => {
      if (active) toast.error(t("settings.security.exportFailed"));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [client, isAuthenticated, t]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const params: Record<string, string> = { format: exportFormat };
      if (fromDate) params.from = fromDate;
      if (toDate) params.to = toDate;
      const data = await client.get<unknown>("/audit/export", { params });
      const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);

      if (Platform.OS === "web") {
        const blob = new Blob([content], {
          type: exportFormat === "json" ? "application/json" : "text/csv",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `clarity-audit-${new Date().toISOString().split("T")[0]}.${exportFormat}`;
        anchor.click();
        URL.revokeObjectURL(url);
      } else {
        await Share.share({
          message: content,
          title: `Clarity Audit Export (${exportFormat.toUpperCase()})`,
        });
      }
      toast.success(t("settings.security.exportSuccess"));
    } catch {
      toast.error(t("settings.security.exportFailed"));
    } finally {
      setExporting(false);
    }
  };

  const inputClass = "border border-border rounded-lg px-3 py-2 bg-background text-foreground text-sm";

  return (
    <View className="gap-8">
      <View className="gap-3">
        <View className="flex-row items-center gap-2">
          <Shield size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t("settings.security.defaultPermissions")}</Text>
        </View>
        <View className="border border-border rounded-lg p-3 gap-1">
          <Text className="text-sm font-medium">Managed by the Clarity agent in Alia</Text>
          <Text className="text-xs text-muted-foreground">
            Permission and approval rules stay fail-closed here until Alia publishes an agent-scoped settings contract.
          </Text>
        </View>
      </View>

      <View className="gap-3">
        <View className="flex-row items-center gap-2">
          <ShieldX size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t("settings.security.threatLog")}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">{t("settings.security.threatLogDesc")}</Text>
        {loading ? (
          <Text className="text-sm text-muted-foreground">Loading audit activity…</Text>
        ) : threats.length === 0 ? (
          <View className="items-center py-8 gap-2">
            <ShieldCheck size={32} className="text-muted-foreground" />
            <Text className="text-sm text-muted-foreground">{t("settings.security.noThreats")}</Text>
          </View>
        ) : (
          <View className="gap-2">
            {threats.slice(0, 10).map((threat) => {
              const SeverityIcon = SEVERITY_ICONS[threat.severity];
              return (
                <View key={threat.id} className={`flex-row items-start gap-2 p-3 rounded-lg ${SEVERITY_BG[threat.severity]}`}>
                  <SeverityIcon size={14} className={`mt-0.5 ${SEVERITY_COLORS[threat.severity]}`} />
                  <View className="flex-1">
                    <View className="flex-row items-center justify-between">
                      <Text className={`text-xs font-semibold uppercase ${SEVERITY_COLORS[threat.severity]}`}>
                        {threat.severity}
                      </Text>
                      <Text className="text-xs text-muted-foreground">
                        {new Date(threat.timestamp).toLocaleDateString()}
                      </Text>
                    </View>
                    <Text className="text-xs text-muted-foreground mt-0.5">{threat.agentName}</Text>
                    <Text className="text-sm text-foreground mt-1" numberOfLines={2}>{threat.description}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        )}
      </View>

      <View className="gap-3">
        <View className="flex-row items-center gap-2">
          <Download size={18} className="text-primary" />
          <Text className="text-sm font-semibold">{t("settings.security.auditExport")}</Text>
        </View>
        <Text className="text-xs text-muted-foreground">{t("settings.security.auditExportDesc")}</Text>
        {summary && (
          <View className="flex-row gap-4 py-2">
            <View><Text className="text-lg font-bold">{summary.totalSessions}</Text><Text className="text-xs text-muted-foreground">Sessions</Text></View>
            <View><Text className="text-lg font-bold">{summary.totalSteps}</Text><Text className="text-xs text-muted-foreground">Steps</Text></View>
            <View><Text className="text-lg font-bold">{summary.threatDetections}</Text><Text className="text-xs text-muted-foreground">Threats</Text></View>
          </View>
        )}
        <View className="flex-row gap-2">
          <RNTextInput className={`${inputClass} flex-1`} placeholder="From: YYYY-MM-DD" placeholderTextColor="#9ca3af" value={fromDate} onChangeText={setFromDate} />
          <RNTextInput className={`${inputClass} flex-1`} placeholder="To: YYYY-MM-DD" placeholderTextColor="#9ca3af" value={toDate} onChangeText={setToDate} />
        </View>
        <View className="flex-row gap-2">
          {(["json", "csv"] as const).map((format) => (
            <Pressable key={format} onPress={() => setExportFormat(format)} className={`px-3 py-1.5 rounded-lg border ${exportFormat === format ? "border-primary bg-primary/10" : "border-border"}`}>
              <Text className={exportFormat === format ? "text-primary font-medium uppercase" : "text-muted-foreground uppercase"}>{format}</Text>
            </Pressable>
          ))}
        </View>
        <Button onPress={handleExport} disabled={exporting || !isAuthenticated}>
          <Text>{exporting ? t("settings.security.exporting") : t("settings.security.exportButton")}</Text>
        </Button>
      </View>
    </View>
  );
}
