import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { AppColorName } from '@oxyhq/bloom/theme';
import { applyAppColorToDocument } from '../app-color-presets';
import { setColorSchemeSafe } from '../set-color-scheme-safe';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeState {
  mode: ThemeMode;
  appColor: AppColorName;
  setMode: (mode: ThemeMode) => void;
  setAppColor: (color: AppColorName) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: 'system',
      appColor: 'amber',
      setMode: (mode: ThemeMode) => set({ mode }),
      setAppColor: (appColor: AppColorName) => set({ appColor }),
    }),
    {
      name: 'theme-storage',
      storage: createJSONStorage(() => AsyncStorage),
      onRehydrateStorage: () => (state) => {
        if (!state?.mode) return;
        setColorSchemeSafe(state.mode);
        if (Platform.OS === 'web' && typeof document !== 'undefined') {
          const resolved = state.mode === 'system'
            ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
            : state.mode;
          document.documentElement.classList.toggle('dark', resolved === 'dark');
          if (state.appColor) {
            applyAppColorToDocument(state.appColor, resolved as 'light' | 'dark');
          }
        }
      },
      migrate: (persisted: any, version: number) => {
        if (persisted && 'accentColor' in persisted) {
          const old = persisted.accentColor;
          if (old === 'blue') persisted.appColor = 'blue';
          else if (old === 'green') persisted.appColor = 'green';
          else persisted.appColor = 'purple';
          delete persisted.accentColor;
        }
        return persisted;
      },
      version: 1,
    }
  )
);
