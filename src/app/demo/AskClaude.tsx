"use client";

import { useActionState } from "react";
import { askClaudeAction } from "./actions";

export function AskClaude() {
  const [answer, formAction, pending] = useActionState(askClaudeAction, null);
  return (
    <form action={formAction}>
      <textarea
        name="prompt"
        placeholder="Ask Claude something — e.g. Explain 'break the ice' in one sentence."
      />
      <button type="submit" disabled={pending}>
        {pending ? "Asking…" : "Ask Claude"}
      </button>
      {answer ? <pre>{answer}</pre> : null}
    </form>
  );
}
