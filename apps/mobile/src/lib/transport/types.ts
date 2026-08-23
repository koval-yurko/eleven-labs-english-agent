import type { TutorTransport, TutorTransportEvents } from "@tutor/shared/tutor/transport";

/**
 * A transport, as React Native has to express one.
 *
 * The contract in `@tutor/shared/tutor/transport` is deliberately free of React — a transport need
 * not be a hook anywhere else. Here it must be: `@elevenlabs/react-native`'s `useConversation`
 * registers its callbacks with `ConversationProvider` and unregisters them on unmount, so the
 * transport has to live at the same place in the tree as the session that owns it.
 *
 * Every adapter takes its events ONCE and is expected to hold them in a ref, because the session
 * rebuilds them on every render and a transport that captured the first set would stop collecting
 * the moment anything changed. That rule is the adapter's, not the session's — see
 * `elevenlabs.ts` for how it is kept.
 */
export type TutorTransportHook = (events: TutorTransportEvents) => TutorTransport;
