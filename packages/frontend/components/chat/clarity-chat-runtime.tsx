/**
 * The runtime under Clarity's own search page: Alia's conversation data layer
 * (`@gemies/sdk` runtime — the stream, the cache, attachments, the app assertion),
 * configured for Clarity's routes, Clarity's modes and Clarity's plans.
 *
 * Clarity draws every pixel of the page itself (`components/chat-page-content.tsx`);
 * what it does NOT do is talk to a model or keep conversations. A turn goes from this
 * page straight to Alia, under the person's Oxy session, with Clarity's agent as the
 * lead (Alia ADR 0020). There is no Clarity backend in between.
 *
 *  - `openConversation` / `closeConversation` — the route owns the address: a new
 *    conversation the first turn creates replaces `/` with `/c/:id`;
 *  - `turnRequest` — Clarity's composer modes: web search (on unless the person turned
 *    it off) and deep research;
 *  - `onFeatureLocked` — a gate of Clarity's agent refused (`deep_research`,
 *    `power_level.<level>`, `attachments.*`): Clarity's plans unlock it;
 *  - `faviconUrl` — Clarity's stored copy of each site's icon;
 *  - `app` — a conversation started here is labelled `clarity`.
 */

import { GemieChatLabelsProvider, GemieRuntimeProvider, type GemieRuntimeHost } from '@gemies/sdk';
import { useRouter } from 'expo-router';
import type React from 'react';
import { useMemo } from 'react';

import { useClarityChatLabels, useFeatureLockedHandler } from '@/hooks/useClarityChat';
import { CLARITY_APP, conversationPath } from '@/lib/clarity-agent';
import { useStore } from '@/lib/globalStore';
import { faviconUrl } from '@/lib/favicon';

export function ClarityChatRuntime({
  conversationId,
  children,
}: {
  /** The conversation the page shows; omitted on the new-search page. */
  conversationId?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const labels = useClarityChatLabels();
  const onFeatureLocked = useFeatureLockedHandler();

  const host = useMemo<GemieRuntimeHost>(
    () => ({
      openConversation: (id) => {
        if (id !== conversationId) router.replace(conversationPath(id));
      },
      closeConversation: () => {
        if (conversationId) router.replace('/');
      },
      turnRequest: () => {
        return { deepResearch: useStore.getState().deepResearchMode };
      },
      onFeatureLocked,
      faviconUrl,
    }),
    [conversationId, router, onFeatureLocked],
  );

  return (
    <GemieChatLabelsProvider labels={labels}>
      <GemieRuntimeProvider app={CLARITY_APP} host={host}>
        {children}
      </GemieRuntimeProvider>
    </GemieChatLabelsProvider>
  );
}
