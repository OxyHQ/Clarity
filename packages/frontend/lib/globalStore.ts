import type { AliaAttachment } from '@alia.onl/sdk';
import { create } from 'zustand';

/** A file in the composer, waiting for the next turn — Alia's attachment shape. */
export type Attachment = AliaAttachment;

/**
 * The search composer's own state: what is attached to the next turn, and the
 * modes it is sent with (`ClarityChatRuntime`'s `turnRequest` reads them).
 */
interface StoreState {
  attachments: Attachment[];
  addAttachment: (attachment: Attachment) => void;
  updateAttachment: (id: string, updates: Partial<Attachment>) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;

  /** Web search, on unless the person turned it off for their next turns. */
  webSearchMode: boolean;
  setWebSearchMode: (value: boolean) => void;

  deepResearchMode: boolean;
  setDeepResearchMode: (value: boolean) => void;
}

export const useStore = create<StoreState>((set) => ({
  attachments: [],
  addAttachment: (attachment) =>
    set((state) => ({ attachments: [...state.attachments, attachment] })),
  updateAttachment: (id, updates) =>
    set((state) => ({
      attachments: state.attachments.map((a) => (a.id === id ? { ...a, ...updates } : a)),
    })),
  removeAttachment: (id) =>
    set((state) => ({ attachments: state.attachments.filter((a) => a.id !== id) })),
  clearAttachments: () => set({ attachments: [] }),

  webSearchMode: true,
  setWebSearchMode: (value) => set({ webSearchMode: value }),

  deepResearchMode: false,
  setDeepResearchMode: (value) => set({ deepResearchMode: value }),
}));
