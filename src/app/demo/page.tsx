import type { Metadata } from "next";
import { getOwnerId, getUserEmail } from "../../lib/auth/session";
import { getServiceSupabase, hasSupabaseEnv } from "../../lib/supabase/server";
import { checkSupabase, checkElevenLabs, checkAnthropic, type Check } from "../../lib/health";
import { addPing } from "./actions";
import { AskClaude } from "./AskClaude";

export const metadata: Metadata = {
  title: "Demo — integration smoke test",
};

function Status({ label, check }: { label: string; check: Check }) {
  return (
    <div className="row">
      <span className="dot" style={{ color: check.ok ? "var(--ok)" : "var(--error)" }}>
        ●
      </span>
      <strong>{label}</strong>
      <span className="muted">— {check.detail}</span>
    </div>
  );
}

export default async function DemoPage() {
  const [ownerId, email] = await Promise.all([getOwnerId(), getUserEmail()]);
  const [supabase, elevenlabs] = await Promise.all([checkSupabase(), checkElevenLabs()]);
  const anthropic = checkAnthropic();

  let pings: { note: string; created_at: string }[] = [];
  if (ownerId && hasSupabaseEnv()) {
    const { data } = await getServiceSupabase()
      .from("health_pings")
      .select("note, created_at")
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false })
      .limit(5);
    pings = (data as { note: string; created_at: string }[] | null) ?? [];
  }

  const auth: Check = {
    ok: Boolean(ownerId),
    detail: ownerId ? `signed in as ${email ?? ownerId}` : "not signed in",
  };

  return (
    <>
      <h1>Integration smoke test</h1>
      <p className="muted">Confirms the four pieces this scaffold keeps are wired correctly.</p>

      <section className="panel">
        <Status label="Auth0" check={auth} />
        <Status label="Supabase" check={supabase} />
        <Status label="ElevenLabs" check={elevenlabs} />
        <Status label="LangChain + Claude" check={anthropic} />
        <p className="muted" style={{ marginTop: "1rem" }}>
          <a href="/">🎙️ Lessons</a> · <a href="/auth/logout">Log out</a> ·{" "}
          <a href="/api/health">/api/health</a>
        </p>
      </section>

      <section className="panel">
        <h2>Supabase write test</h2>
        <p className="muted">
          Inserts an owner-scoped row into <code>health_pings</code>, then reads it back.
        </p>
        <form action={addPing}>
          <input name="note" placeholder="a short note" maxLength={200} />
          <button type="submit" disabled={!ownerId}>
            Insert ping row
          </button>
        </form>
        {pings.length > 0 ? (
          <ul>
            {pings.map((p, i) => (
              <li key={i}>
                {p.note || "(empty)"}{" "}
                <span className="muted">· {new Date(p.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No rows yet for this account.</p>
        )}
      </section>

      <section className="panel">
        <h2>Ask Claude (LangChain)</h2>
        <p className="muted">
          Sends your prompt through <code>@langchain/anthropic</code> on the server.
        </p>
        <AskClaude />
      </section>
    </>
  );
}
