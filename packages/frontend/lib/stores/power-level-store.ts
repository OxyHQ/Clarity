import { DEFAULT_POWER_LEVEL, isPowerLevel, type PowerLevel } from '@alia.onl/sdk';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface PowerLevelState {
  /** The Alia power level Clarity's chat sends every turn with (`auto` by default). */
  powerLevel: PowerLevel;
  setPowerLevel: (level: string) => void;
}

/**
 * The person's power level, kept on the device. Whether their plan unlocks it is
 * Alia's question to Clarity (the `power_level.<level>` feature gate); a refusal
 * opens the subscribe screen, the choice stays.
 */
export const usePowerLevelStore = create<PowerLevelState>()(
  persist(
    (set) => ({
      powerLevel: DEFAULT_POWER_LEVEL,
      setPowerLevel: (level) => {
        if (isPowerLevel(level)) set({ powerLevel: level });
      },
    }),
    {
      name: 'clarity-power-level',
      storage: createJSONStorage(() => AsyncStorage),
      merge: (persisted, current) => {
        const stored = (persisted as { powerLevel?: unknown } | undefined)?.powerLevel;
        return isPowerLevel(stored) ? { ...current, powerLevel: stored } : current;
      },
    },
  ),
);
