import type { Metadata } from "next";
import { EFFECTIVE_DATE, SUPPORT_EMAIL } from "../legal";

// Static and public. App Store Connect validates the privacy-policy URL and the App Review team
// opens it, both without a session — which is why `src/proxy.ts` exempts this path from the Auth0
// gate. Gating it would 302 the validator into a login page and read as a broken link.
// See docs/2026-08-13-expo-s7-ship.md §5.3.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Privacy Policy — English Tutor",
  description: "What English Tutor collects, why, and who else receives it.",
};

export default function PrivacyPage() {
  return (
    <article>
      <h1>Privacy Policy</h1>
      <p className="muted">Effective {EFFECTIVE_DATE}</p>

      <p>
        English Tutor is a spoken-English practice app. You keep a personal collection of words,
        group them into lessons, and hold a live two-way voice conversation with an AI tutor about
        them. Everything below follows from those three things — we collect what the lesson needs
        and nothing for advertising.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Your email address and account identifier.</strong> Sign-in is handled by Auth0.
          We store the identifier it issues you and use it to scope every row of your data to you;
          no query in the app runs without it.
        </li>
        <li>
          <strong>Your voice, during a lesson.</strong> While a conversation is running, your
          microphone audio is streamed live so the tutor can hear and answer you. Recording starts
          when you start a session and stops when you end it.
        </li>
        <li>
          <strong>What you write and say.</strong> The words and lessons you create, the transcript
          of each conversation, and the summaries generated from it.
        </li>
      </ul>

      <h2>What we do not collect</h2>
      <ul>
        <li>
          <strong>No tracking.</strong> We do not track you across other companies&rsquo; apps or
          websites, and we do not share or sell your data to data brokers or advertisers.
        </li>
        <li>
          <strong>No advertising identifiers</strong>, and no third-party analytics or advertising
          SDKs in the mobile app.
        </li>
        <li>
          <strong>No crash or diagnostics reporting.</strong> The app ships no crash-reporting SDK,
          so no device diagnostics are collected.
        </li>
        <li>
          <strong>No contacts, photos, location, or health data.</strong> The app asks for one
          permission — the microphone — and only for the conversation itself.
        </li>
      </ul>

      <h2>Who else receives your data</h2>
      <p>
        We use a small number of service providers to run the app. Each receives only what its job
        requires, and each processes it on our behalf:
      </p>
      <ul>
        <li>
          <strong>Auth0</strong> (Okta) — sign-in. Holds your email address and password
          credentials; we never see your password.
        </li>
        <li>
          <strong>ElevenLabs</strong> — the voice conversation. Receives your live microphone audio
          to transcribe it and to speak the tutor&rsquo;s replies, and returns the transcript.
        </li>
        <li>
          <strong>Anthropic</strong> — the language model. Receives the words in your collection in
          order to assign a difficulty level and to write translations, word forms, and example
          sentences.
        </li>
        <li>
          <strong>Supabase</strong> — the database where your words, lessons, transcripts, and
          summaries are stored.
        </li>
        <li>
          <strong>Vercel</strong> — hosting for the web app and its server functions.
        </li>
        <li>
          <strong>LangSmith</strong> (LangChain) — when enabled, records traces of the app&rsquo;s
          own language-model calls for debugging. Those traces can include the word text sent in the
          request.
        </li>
      </ul>
      <p>
        These providers operate in the United States and the European Union, so your data may be
        processed outside your country of residence.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Your words, lessons, and transcripts are kept until you delete them or ask us to delete your
        account, because the point of the collection is that it accumulates. Live audio is not
        stored by us as audio — it is streamed for the duration of the conversation, and what
        persists is the transcript.
      </p>

      <h2>Your choices</h2>
      <ul>
        <li>
          <strong>The microphone.</strong> You can refuse or revoke microphone access in iOS
          Settings at any time. The rest of the app keeps working; only the voice conversation
          stops.
        </li>
        <li>
          <strong>Deleting content.</strong> You can delete individual words and whole lessons from
          inside the app.
        </li>
        <li>
          <strong>Deleting your account.</strong> Email us and we will delete your account and
          everything attached to it.
        </li>
      </ul>

      <h2>Children</h2>
      <p>
        English Tutor is not directed at children under 13, and we do not knowingly collect their
        personal information.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes materially we will update the effective date above and, where the
        change affects data already collected, tell you in the app.
      </p>

      <h2>Contact</h2>
      <p>
        Questions, or a deletion request: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        See also the <a href="/support">support page</a>.
      </p>
    </article>
  );
}
