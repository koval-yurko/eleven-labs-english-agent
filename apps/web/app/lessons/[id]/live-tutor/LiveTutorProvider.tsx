"use client";

import { ConversationProvider } from "@elevenlabs/react";
import { type RefObject } from "react";
import { LiveTutorController } from "./LiveTutorController";

/**
 * Wraps the live-tutor controller in the ElevenLabs `ConversationProvider` so the
 * controller's `useConversation` hook has its context (T018). The provider holds no
 * lesson logic — it only establishes the realtime session context; the teacher voice and
 * Claude LLM are configured on the agent itself (R5), not here.
 */
export function LiveTutorProvider({
  lessonId,
  audioRef,
}: {
  lessonId: string;
  audioRef: RefObject<HTMLAudioElement | null>;
}) {
  return (
    <ConversationProvider>
      <LiveTutorController lessonId={lessonId} audioRef={audioRef} />
    </ConversationProvider>
  );
}
