import type { Metadata } from "next";
import { SUPPORT_EMAIL } from "../legal";

// Static and public, for the same reason as /privacy: App Store Connect requires a support URL and
// checks it without a session. `src/proxy.ts` exempts this path from the Auth0 gate.
// See docs/2026-08-13-expo-s7-ship.md §5.3.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Support — English Tutor",
  description: "How to get help with English Tutor.",
};

export default function SupportPage() {
  return (
    <article>
      <h1>Support</h1>

      <p>
        English Tutor is a spoken-English practice app: you collect words, group them into lessons,
        and talk them through out loud with an AI tutor.
      </p>

      <h2>Get in touch</h2>
      <p>
        Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> — bug reports, questions,
        feature requests, and account or data-deletion requests all go to the same place. Telling us
        what you were doing when something went wrong, and roughly when, is usually enough for us to
        find it.
      </p>

      <h2>Common questions</h2>

      <h3>The tutor cannot hear me</h3>
      <p>
        The app asks for the microphone the first time you start a conversation. If you declined,
        iOS will not ask again — turn it back on in{" "}
        <strong>Settings → English Tutor → Microphone</strong>, then start the session again.
      </p>

      <h3>Can I lock the screen during a lesson?</h3>
      <p>
        Yes. The conversation keeps running with the screen locked or the app in the background —
        the tutor keeps speaking and keeps listening, like a phone call. That is what the microphone
        indicator in the status bar means while a lesson is in progress.
      </p>

      <h3>Does it work offline?</h3>
      <p>
        Partly. Your lessons and words are stored on the device, so you can browse them and add to
        them with no connection; the changes sync when you are back online. The voice conversation
        itself needs a connection, because the tutor runs in the cloud.
      </p>

      <h3>Where did my new word&rsquo;s translation go?</h3>
      <p>
        Translations, word forms, and example sentences are written by a background job shortly
        after you add a word, so a brand-new word shows only its text for a little while. If it
        stays empty, the model had no useful answer for that entry — the word still works in
        lessons.
      </p>

      <h3>How do I delete my account?</h3>
      <p>
        Email us from the address you signed up with and we will delete the account and everything
        attached to it — words, lessons, transcripts, and summaries.
      </p>

      <h2>Privacy</h2>
      <p>
        What we collect and who else receives it is set out in the{" "}
        <a href="/privacy">privacy policy</a>.
      </p>
    </article>
  );
}
