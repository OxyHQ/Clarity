import { create } from 'zustand';

type SidebarMode = 'search' | 'computer';

interface UIState {
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  sidebarMode: SidebarMode;

  setSidebarOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarMode: (mode: SidebarMode) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: false,
  sidebarCollapsed: false,
  sidebarMode: 'search',

  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setSidebarMode: (mode) => set({ sidebarMode: mode }),
}));
