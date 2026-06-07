"use client";

import { ConversationProvider } from "@elevenlabs/react";
import { LiveStoryController } from "./LiveStoryController";

/**
 * Wraps the live-story controller in the ElevenLabs `ConversationProvider` so its
 * `useConversation` hook has context (T024). The provider holds no lesson logic — it only
 * establishes the realtime session context; the teacher voice + Claude LLM + client tools
 * are configured on the agent itself (R10), and the per-session clientTools are bound at
 * `startSession`. There is NO `<audio>` element in this mode.
 */
export function LiveStoryProvider({ lessonId }: { lessonId: string }) {
  return (
    <ConversationProvider>
      <LiveStoryController lessonId={lessonId} />
    </ConversationProvider>
  );
}
