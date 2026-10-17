/**
 * Clarity's power selector: how much power a search gets.
 *
 * The person picks one of Alia's seven power levels (`auto` … `ultra`) and never a
 * hosted model — Oxy chooses the model of the level for each request. A level is
 * locked when Clarity's agent gates it (`power_level.<level>`) and the person's
 * Clarity plan does not unlock it: Alia asks Clarity live
 * (`GET /v1/agents/:id/features`), and a locked pick opens the subscribe screen.
 */

import { POWER_LEVELS, type PowerLevel, useAgentFeatures } from '@alia.onl/sdk';
import { Button } from '@oxy.so/bloom/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@oxy.so/bloom/dropdown-menu';
import { ChevronDown, Lock } from 'lucide-react-native';
import { useMemo } from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { useFeatureLockedHandler } from '@/hooks/useClarityChat';
import { useTranslation } from '@/hooks/useTranslation';
import { bloomIcon } from '@/lib/bloom-icon';
import { CLARITY_AGENT_ID } from '@/lib/clarity-agent';
import { usePowerLevelStore } from '@/lib/stores/power-level-store';

/** The feature gate that locks a level, as Clarity's agent declares it. */
export const powerLevelFeature = (level: PowerLevel) => `power_level.${level}`;

function LevelItem({ level, isLocked }: { level: PowerLevel; isLocked: boolean }) {
  const { t } = useTranslation();
  return (
    <DropdownMenuRadioItem value={level}>
      <View className={`flex-col gap-0.5 flex-1 ${isLocked ? 'opacity-50' : ''}`}>
        <View className="flex-row items-center gap-1.5">
          <Text className="text-sm font-medium text-foreground">
            {t(`powerLevels.${level}.label`)}
          </Text>
          {isLocked && <Lock size={11} className="text-muted-foreground" />}
        </View>
        <Text className="text-xs text-muted-foreground">
          {t(`powerLevels.${level}.description`)}
        </Text>
      </View>
    </DropdownMenuRadioItem>
  );
}

export function ModelSelector() {
  const { t } = useTranslation();
  const powerLevel = usePowerLevelStore((state) => state.powerLevel);
  const setPowerLevel = usePowerLevelStore((state) => state.setPowerLevel);
  const onFeatureLocked = useFeatureLockedHandler();
  const { data: features } = useAgentFeatures(CLARITY_AGENT_ID);

  const locked = useMemo(
    () =>
      new Set(
        (features ?? [])
          .filter((feature) => feature.state === 'locked')
          .map((feature) => feature.key),
      ),
    [features],
  );

  const handleValueChange = (value: string) => {
    const level = POWER_LEVELS.find((candidate) => candidate === value);
    if (level === undefined) return;
    if (locked.has(powerLevelFeature(level))) {
      onFeatureLocked(powerLevelFeature(level));
      return;
    }
    setPowerLevel(level);
  };

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
          {t(`powerLevels.${powerLevel}.label`)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" minWidth={256}>
        <DropdownMenuLabel>{t('models.selectModel')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={powerLevel} onValueChange={handleValueChange}>
          {POWER_LEVELS.map((level) => (
            <LevelItem key={level} level={level} isLocked={locked.has(powerLevelFeature(level))} />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
