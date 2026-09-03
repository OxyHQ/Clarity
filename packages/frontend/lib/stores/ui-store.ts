import { create } from 'zustand';
import type { Message } from '@clarity/shared-types';

type RightPanel = 'credits' | 'thought' | 'canvas' | null;
type SidebarMode = 'search' | 'computer';

export interface CanvasArtifact {
  id: string;
  type: 'code' | 'markdown' | 'table' | 'chart' | 'image';
  content: unknown;
  title?: string;
  timestamp: number;
}

interface UIState {
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  sidebarMode: SidebarMode;
  rightPanel: RightPanel;
  thoughtMessageId: string | null;
  thoughtMessages: Message[];
  shortcutsDialogOpen: boolean;
  canvasArtifacts: CanvasArtifact[];

  // Actions
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  setRightPanel: (panel: RightPanel) => void;
  toggleRightPanel: (panel: RightPanel) => void;
  openThoughtPanel: (messageId: string) => void;
  setThoughtMessages: (messages: Message[]) => void;
  setShortcutsDialogOpen: (open: boolean) => void;
  toggleShortcutsDialog: () => void;
  addCanvasArtifact: (artifact: CanvasArtifact) => void;
  clearCanvasArtifacts: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: false,
  sidebarCollapsed: false,
  sidebarMode: 'search',
  rightPanel: null,
  thoughtMessageId: null,
  thoughtMessages: [],
  shortcutsDialogOpen: false,
  canvasArtifacts: [],

  toggleSidebar: () =>
    set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setSidebarOpen: (open) =>
    set({ sidebarOpen: open }),

  toggleSidebarCollapsed: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setSidebarCollapsed: (collapsed) =>
    set({ sidebarCollapsed: collapsed }),

  setSidebarMode: (mode) =>
    set({ sidebarMode: mode }),

  setRightPanel: (panel) =>
    set({ rightPanel: panel, ...(panel === null && { thoughtMessageId: null }) }),

  toggleRightPanel: (panel) =>
    set((state) => ({
      rightPanel: state.rightPanel === panel ? null : panel,
      ...(state.rightPanel === panel && { thoughtMessageId: null }),
    })),

  openThoughtPanel: (messageId) =>
    set({ rightPanel: 'thought', thoughtMessageId: messageId }),

  setThoughtMessages: (messages) =>
    set({ thoughtMessages: messages }),

  setShortcutsDialogOpen: (open) =>
    set({ shortcutsDialogOpen: open }),

  toggleShortcutsDialog: () =>
    set((state) => ({ shortcutsDialogOpen: !state.shortcutsDialogOpen })),

  addCanvasArtifact: (artifact) =>
    set((state) => ({ canvasArtifacts: [...state.canvasArtifacts, artifact] })),

  clearCanvasArtifacts: () =>
    set({ canvasArtifacts: [] }),
}));
