import { ChevronDown, Lock } from "lucide-react-native";
import { Button } from "@oxy.so/bloom/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@oxy.so/bloom/dropdown-menu";
import { View } from "react-native";
import { bloomIcon } from "@/lib/bloom-icon";
import { Text } from "@/components/ui/text";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "expo-router";
import config from "@/lib/config";
import { useEntitlements } from "@/lib/hooks/use-billing";
import { toast } from "@oxy.so/bloom/toast";
import { useTranslation } from "@/hooks/useTranslation";
import type { ClarityModelsResponse } from "@clarity/shared-types";

interface Model {
  id: string;
  name: string;
  description: string;
  requiredPlan: string | null;
  isLegacy: boolean;
}

// Cache models in memory (they don't change frequently)
let cachedModels: Model[] | null = null;
export const CLARITY_THINKING_MODEL_ID = 'clarity-thinking';

/** The thinking control maps to one exact public model ID. */
export function getThinkingModelId(): string {
  return CLARITY_THINKING_MODEL_ID;
}

/** Check if a model ID is a thinking model. */
export function isThinkingModel(modelId: string): boolean {
  return modelId === CLARITY_THINKING_MODEL_ID;
}

interface ModelSelectorProps {
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
}

function ModelRadioItem({ model, isLocked }: { model: Model; isLocked: boolean }) {
  return (
    <DropdownMenuRadioItem value={model.id}>
      <View className={`flex-col gap-0.5 flex-1 ${isLocked ? 'opacity-50' : ''}`}>
        <View className="flex-row items-center gap-1.5">
          <Text className="text-sm font-medium text-foreground">
            {model.name}
          </Text>
          {isLocked && <Lock size={11} className="text-muted-foreground" />}
          {model.requiredPlan && (
            <View className="bg-primary/10 px-1.5 py-0.5 rounded-full">
              <Text className="text-[10px] font-semibold text-primary">
                {model.requiredPlan}
              </Text>
            </View>
          )}
        </View>
        <Text className="text-xs text-muted-foreground">
          {model.description}
        </Text>
      </View>
    </DropdownMenuRadioItem>
  );
}

export function ModelSelector({
  selectedModel = "clarity-v1",
  onModelChange,
}: ModelSelectorProps) {
  const [value, setValue] = useState(selectedModel);
  const [models, setModels] = useState<Model[]>(cachedModels || []);
  const [loading, setLoading] = useState(!cachedModels);
  const { data: entitlements } = useEntitlements();
  const router = useRouter();
  const { t } = useTranslation();
  const allowedIds = useMemo(
    () => new Set(entitlements?.allowedModelIds || ['clarity-fast', 'clarity-v1']),
    [entitlements],
  );

  useEffect(() => {
    setValue(selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    if (!cachedModels) {
      fetch(`${config.apiUrl}/v1/models?chat=true`)
        .then((res) => res.json() as Promise<ClarityModelsResponse>)
        .then((data) => {
          const fetchedModels = data.data
            ?.map((m) => ({
              id: m.id,
              name: m.name,
              description: m.description ?? '',
              requiredPlan: m.required_plan ?? null,
              isLegacy: m.is_legacy ?? false,
            })) || [];
          cachedModels = fetchedModels;
          setModels(fetchedModels);
          setLoading(false);
        })
        .catch((error) => {
          console.error('[ModelSelector] Error fetching models:', error);
          cachedModels = [
            { id: "clarity-v1", name: "Clarity V1", description: "Balanced performance", requiredPlan: null, isLegacy: false },
          ];
          setModels(cachedModels);
          setLoading(false);
        });
    }
  }, []);

  const handleValueChange = (modelId: string) => {
    if (!allowedIds.has(modelId)) {
      const model = models.find(m => m.id === modelId);
      toast.info(t('subscribe.modelRequiresPlan', { plan: model?.requiredPlan || 'Go' }));
      router.push('/(biglayout)/subscribe');
      return;
    }
    setValue(modelId);
    onModelChange?.(modelId);
  };

  const currentModel = models.find((m) => m.id === value);

  const { regularModels, legacyModels } = useMemo(() => ({
    regularModels: models.filter(m => !m.isLegacy),
    legacyModels: models.filter(m => m.isLegacy),
  }), [models]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild label={t('models.selectModel')}>
        <Button
          size="sm"
          tone="neutral"
          appearance="plain"
          trailingIcon={bloomIcon(ChevronDown)}
          accessibilityLabel={t('models.selectModel')}
        >
          {currentModel?.name || "Clarity V1"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" minWidth={256}>
        <DropdownMenuLabel>{t('models.selectModel')}</DropdownMenuLabel>
        {loading ? (
          <DropdownMenuItem disabled>{t('models.loadingModels')}</DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuRadioGroup value={value} onValueChange={handleValueChange}>
              {regularModels.map((model) => (
                <ModelRadioItem key={model.id} model={model} isLocked={!allowedIds.has(model.id)} />
              ))}
            </DropdownMenuRadioGroup>
            {legacyModels.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>{t('models.legacyModels')}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent minWidth={256}>
                    <DropdownMenuRadioGroup value={value} onValueChange={handleValueChange}>
                      {legacyModels.map((model) => (
                        <ModelRadioItem key={model.id} model={model} isLocked={!allowedIds.has(model.id)} />
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
