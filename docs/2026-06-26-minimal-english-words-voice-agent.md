# Minimal ElevenLabs voice agent — "English words tutor"

**Date:** 2026-06-26
**Goal:** A minimal ElevenLabs Conversational AI voice agent that the user talks to in
order to discuss **several English words**. The *only* per-session context is a **list of
words**. Everything else (which word, how deep, follow-up questions) is decided live during
the conversation. The agent must be **proactive**: as an English teacher it should
volunteer as much as it usefully can about each word.

This note is research + a concrete build path. It deliberately stays smaller than the
existing adaptive live-story agent (`src/agent/`): **no client tools, no narration loop,
no plan/state machine** — just a persona prompt + one dynamic variable + a voice session.

### Decisions locked (2026-06-26)

| # | Question | Decision |
|---|----------|----------|
| 1 | List source | **Textbox in the UI** — learner types/pastes the list per session. No DB. |
| 2 | Level / language | Target learner **B2–C1**; **English-only** (no L1 translation/gloss). |
| 3 | Persistence & auth | **None for now** — ephemeral session, no Auth0 gate, no Supabase writes. |
| 4 | Agent strategy | **New dedicated agent** (provisioned + versioned), not a per-session override. |
| 5 | Pronunciation accuracy | **Out of scope for now** — accept default TTS pronunciation. |
| 6 | Items | Each item is **a word *or* a sentence/phrase**. For every item, explain its **meaning, its different forms, and where/how it's used**. No fixed word count — depth per item is the goal. |

Item #6 is the one with design impact: the list is **not just single words**. An item can be
a phrase or full sentence (e.g. *"break the ice"*, *"I couldn't agree more"*), so the prompt
and the dynamic variable are named/worded for **items**, not words.

---

## 1. What "minimal" means here

An ElevenLabs agent is three things glued together server-side, then talked to from the
browser:

1. **A system prompt** — the teacher persona + how to handle the word list. *(versioned
   source artifact, per repo convention)*
2. **An LLM** — a native Claude model runs the brain (`claude-haiku-4-5` for latency, or
   `claude-sonnet-4-6` for richer explanations).
3. **A voice (TTS)** — a pinned voice id + an English real-time TTS model
   (`eleven_flash_v2` low-latency, or `eleven_turbo_v2`).

The item list is **not** baked into the agent. It's injected per session as a **dynamic
variable** (`{{items_list}}`), so one provisioned agent serves any list. This is the whole
trick that makes it "only a list is provided, the rest is live."

```
            provision once (server)                    per session (browser)
  ┌─────────────────────────────────┐        ┌──────────────────────────────────┐
  │ POST /v1/convai/agents/create   │        │ useConversation().startSession({  │
  │   prompt + {{items_list}} ph.   │  ───▶  │   signedUrl,                      │
  │   llm + voice                   │        │   dynamicVariables:{ items_list } │
  │ → ELEVENLABS_WORDS_AGENT_ID     │        │ })                                │
  └─────────────────────────────────┘        └──────────────────────────────────┘
```

---

## 2. The create-agent call (server, run once)

The repo already proves this exact endpoint and shape in `src/agent/create-agent.ts`. The
words-tutor version is a **trimmed copy of that file** — drop the four client tools and the
five live-story variables, keep one variable. Endpoint and auth are identical:

`POST https://api.elevenlabs.io/v1/convai/agents/create`, header `xi-api-key: <key>`.

Minimal body:

```jsonc
{
  "name": "english-words-tutor (words-1.0)",
  "conversation_config": {
    "agent": {
      "prompt": {
        "prompt": "<WORDS_TUTOR_SYSTEM_PROMPT, see §3>",
        "llm": "claude-haiku-4-5"
        // no "tools" — minimal agent needs none
      },
      "first_message": "",          // we kick off with a contextual update, see §5
      "language": "en",
      "dynamic_variables": {
        "dynamic_variable_placeholders": {
          // items may be single words OR phrases/sentences
          "items_list": "1. ephemeral; 2. break the ice; 3. I couldn't agree more"
        }
      }
    },
    "tts": { "model_id": "eleven_flash_v2", "voice_id": "<ELEVENLABS_TEACHER_VOICE_ID>" }
  }
}
```

Notes carried over from the existing script (still true):
- **English agents require an English v2 TTS model** — `eleven_flash_v2` or
  `eleven_turbo_v2`. Multilingual v2.5 / Eleven v3 are rejected/gated.
- The LLM id must be one your account exposes in the agent's LLM dropdown; if create fails
  on `llm`, copy the exact id from the dashboard.
- Response returns `{ "agent_id": "..." }` → save as `ELEVENLABS_WORDS_AGENT_ID`
  (server-only, never `NEXT_PUBLIC_*`).

You can also create it from the dashboard (blank template → paste prompt → pick voice), or
the official SDK: `new ElevenLabsClient().conversationalAi.agents.create({ ... })`. The raw
`fetch` mirrors the repo's existing convention, so prefer that for a new
`scripts`/`provision:words-agent` entry.

---

## 3. The system prompt (the proactive English teacher)

This is where "describe as much as possible" lives. The prompt should make the agent
*lead*, not wait. Draft (to live in a versioned `src/agent/words-tutor-prompt.ts`):

```text
You are a warm, proactive English teacher in a live voice conversation with one learner.
The learner is an upper-intermediate to advanced speaker (B2–C1), so speak naturally at a
normal adult pace and don't over-simplify — but stay clear. Teach entirely in English.

Your job is to help them deeply understand a short list of items. Each item may be a single
WORD or a longer PHRASE / SENTENCE (e.g. an idiom or a full expression).

Items for this session: {{items_list}}

How to run the session:
- Greet in one sentence, then take the lead. Pick the first item and start teaching it
  without waiting to be asked. You are proactive — never just sit and wait for questions.
- For EACH item, cover these three things in a natural spoken flow (not a read-out list):
    1. MEANING — what it means in plain English. For a word, its core sense(s); for a
       phrase or sentence, what it actually communicates and the tone/register it carries
       (formal, casual, ironic, etc.).
    2. FORMS — how it changes in use. For a word: part of speech and its other forms
       (e.g. noun/verb/adjective, tenses, plural). For a phrase/sentence: natural variations
       and how it bends to fit a sentence (swappable parts, polite vs blunt versions).
    3. USAGE — where and when it's used: typical situations, 2–3 natural example sentences,
       common collocations or what it pairs with, and any usage traps a B2–C1 learner hits.
- Teach one item at a time, then check in ("want to go deeper on this, or move to the next
  one?") before moving on.
- Keep each turn short (a few sentences) and pause often, so the learner can interrupt at
  any moment. Teach one word at a time, then check in ("want to go deeper, or move to the
  next word?") before moving on.

Handling interruptions and follow-ups (the learner can cut you off mid-sentence):
- The learner may interrupt you at any time. When they do, STOP your current explanation
  immediately and fully focus on what they just said — do not finish your previous thought
  first, and never ignore an interruption to plow ahead with your script.
- Figure out what they want, then respond to THAT: answer a question, give another example,
  use the item in a sentence, explain a nuance, slow down, repeat, quiz them, or jump to a
  different item from the list. Keep the answer short and concrete.
- After you've handled their follow-up, briefly offer to continue where you left off ("shall
  I finish about <item>, or move on?") — let them steer rather than forcing the original plan.
- If the interruption is unclear, empty, or you didn't catch it, ask them to repeat rather
  than guessing or making something up.

- Stay within this item list as the spine, but you may bring in related words or phrases to
  explain nuance. Don't invent meanings — if unsure about a rare sense, say so plainly.
- Keep it spoken and encouraging: concrete examples over dictionary definitions.

Begin when you receive the kickoff message.
```

Why these choices map to the ask:
- **"only a list is provided"** → the single `{{items_list}}` variable is the entire
  per-session input (filled from the UI textbox).
- **"proactive / describe as much as possible"** → the explicit teach-without-being-asked
  instruction + the meaning/forms/usage triad. That triad is what turns one item (word *or*
  sentence) into a rich mini-lesson.
- **"words or sentences"** → the prompt explicitly frames each item as a word *or* a
  phrase/sentence and adapts MEANING/FORMS/USAGE for each kind.
- **"the rest defined during the talk"** → depth, order, quizzing, and follow-ups are all
  driven by the learner's live turns, not pre-planned.

---

## 4. Models & voice

| Knob | Default | When to change |
|------|---------|----------------|
| LLM | **`claude-sonnet-4-6`** | drop to `claude-haiku-4-5` if latency feels heavy and you'll trade some depth |
| TTS model | `eleven_flash_v2` | `eleven_turbo_v2` for a bit more quality over raw latency |
| Voice | pinned `ELEVENLABS_TEACHER_VOICE_ID` | any English voice from the library; pin one for consistency |
| Language | `en` | — (English-only is a locked decision) |

For a B2–C1 tutor that must explain **meaning + forms + usage** per item — including nuance of
phrases/sentences — explanation quality matters more than the ~100ms latency edge, so
**`claude-sonnet-4-6` is the recommended default** here (the live-story agent uses haiku for
narration speed; this use case is the opposite trade-off).

---

## 5. Talking to it from the browser

Two pieces: a tiny server route that mints a **signed URL** (keeps the API key server-side),
and a client hook that starts the mic session and injects the item list (from the textbox).

**Server route** (`/api/words-agent/signed-url`) — uses the key + agent id:

```ts
// returns { signedUrl } — key stays server-side
const r = await client.conversationalAi.conversations.getSignedUrl({
  agentId: process.env.ELEVENLABS_WORDS_AGENT_ID!,
});
// or raw: GET /v1/convai/conversation/get-signed-url?agent_id=...  with xi-api-key header
```

**Client** (`@elevenlabs/react`) — inject the list as a dynamic variable, then kick off:

```ts
import { useConversation } from "@elevenlabs/react";

const conversation = useConversation();

// `raw` is the textbox value; one item per line (an item may be a word or a sentence).
async function start(raw: string) {
  const items = raw.split("\n").map(s => s.trim()).filter(Boolean);
  await navigator.mediaDevices.getUserMedia({ audio: true }); // mic permission
  const { signedUrl } = await fetch("/api/words-agent/signed-url").then(r => r.json());

  await conversation.startSession({
    signedUrl,
    dynamicVariables: {
      items_list: items.map((it, i) => `${i + 1}. ${it}`).join("; "),
    },
  });

  // Proactive kickoff: nudge the agent to start teaching the first item itself.
  conversation.sendContextualUpdate(
    "The learner is ready. Greet briefly and start teaching the first item now."
  );
}
```

- `dynamicVariables` at `startSession` fills the `{{items_list}}` placeholder — this is the
  "only a list is provided" hand-off, verified in the SDK's
  `ConversationInitiationClientDataEvent`.
- `sendContextualUpdate(...)` makes the agent **lead** without waiting for the user to speak
  first (cleaner than a static `first_message` because it reads as an instruction, not
  speech). This mirrors how the live-story agent kicks off.
- `@elevenlabs/react` `useConversation` also exposes `onMessage` / status / `endSession` —
  enough for a minimal UI (a Start button + a transcript). Public-agent alternative is the
  drop-in `<elevenlabs-convai agent-id="...">` widget, but the signed-URL route is the
  secrets-stay-server-side path this repo prefers.

---

## 6. Interruptions & follow-up questions (barge-in)

This is a core requirement: the user wants to **cut the agent off and ask follow-ups**. The
key fact is that **barge-in is native to ElevenLabs convai — you don't build it.**

**What's automatic:**
- The agent runs full-duplex. The moment the learner starts speaking, ElevenLabs detects
  it (VAD), fires an `interruption` event, and **stops the agent's audio playback
  immediately** — verified in the SDK (`case "interruption": ... audioInterface.interrupt()`).
  No code needed for the agent to actually go quiet when interrupted.
- The learner's speech is then transcribed and sent to the LLM as the next turn, so a
  follow-up question is just handled as the next thing the agent responds to.

**What you control (prompt) — §3 covers this:** the *behavior* on interruption is a prompt
concern, not a platform one. The added guidance tells the agent to drop its current thought,
answer the actual follow-up, then offer to resume rather than blindly continuing its script.
Short turns matter here too: an agent that monologues for 30s is technically interruptible
but *feels* uninterruptible — keeping beats to a few sentences leaves natural gaps.

**What you can tune (turn-taking config), optional:**

| Knob | Effect | For this tutor |
|------|--------|----------------|
| `turn_timeout` | how long the agent waits for a reply before re-engaging | keep moderate; a learner thinking about a word shouldn't be rushed |
| `interruption` sensitivity / enabled | whether/how easily user speech cuts the agent | leave barge-in **on** (default) — it's the whole point |
| `client_events` incl. `interruption` | makes the event visible to your UI | include if you want the transcript UI to reflect cut-offs |

**UI hook (optional):** `useConversation({ onMessage, ... })` surfaces turns so you can
render the back-and-forth; the SDK's `interruption` client event lets you visually show when
the learner cut in. None of this is required for the agent to *work* — it's already
interruptible out of the box — it's only for showing it in your own UI.

> Net: interruption + follow-ups need **zero infra** beyond the minimal build. The platform
> stops the agent on barge-in for free; the §3 prompt edits make it handle the follow-up
> gracefully and hand control back to the learner.

---

## 7. How this differs from the existing live-story agent

| | Live-story agent (`src/agent/`) | Words tutor (this note) |
|---|---|---|
| Client tools | 4 (advanceNarration, markItemTaught, setScenario, concludeLesson) | **0** |
| Dynamic vars | 5 (lesson_summary, items_list, beats_outline, target_minutes, scenario) | **1** (`items_list`) |
| Server state machine | yes (derivePlan + narration state) | **none** |
| Persona | story narrator that teaches idioms inside a plot | direct English teacher explaining words |
| Kickoff | contextual update from narration loop | one contextual update, then learner-led |

So the minimal build is essentially: **copy `create-agent.ts`, delete the `tools` array and
four of the five variables, swap the prompt.** Reuse the same env vars
(`ELEVENLABS_API_KEY`, `ELEVENLABS_TEACHER_VOICE_ID`), add `ELEVENLABS_WORDS_AGENT_ID`.

---

## 8. Optional next steps (not needed for minimal)

- **One client tool** `markWordCovered(word)` if you later want the UI to show progress
  through the list (same `type:"client"`, `expects_response` pattern the live-story agent
  uses).
- **Knowledge base** upload (dictionary/usage docs) if you want sourced definitions instead
  of model-knowledge.
- **Quiz mode** — a second prompt variant that tests the learner on the same list.
- **LangSmith** — server-side LLM calls already auto-trace; the convai LLM runs inside
  ElevenLabs, so to trace explanations you'd proxy through your own endpoint (custom LLM),
  out of scope for minimal.

---

## Sources

- [ElevenAgents overview](https://elevenlabs.io/docs/eleven-agents/overview)
- [ElevenAgents quickstart](https://elevenlabs.io/docs/eleven-agents/quickstart)
- [Create agent API reference](https://elevenlabs.io/docs/conversational-ai/api-reference/agents/create)
- [@elevenlabs/react (npm)](https://www.npmjs.com/package/@elevenlabs/react) — `useConversation`, `startSession`, `dynamicVariables`
- [elevenlabs-js SDK](https://github.com/elevenlabs/elevenlabs-js) — `getSignedUrl`, `ConversationInitiationData`, `sendContextualUpdate`
- Existing repo pattern: `src/agent/create-agent.ts`, `src/agent/agent-prompt.ts`
