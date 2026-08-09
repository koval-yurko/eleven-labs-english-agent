"use client";

import { useActionState } from "react";
import { askClaudeAction } from "./actions";
import { Button } from "../Button";

export function AskClaude() {
  const [answer, formAction, pending] = useActionState(askClaudeAction, null);
  return (
    <form action={formAction}>
      <textarea
        name="prompt"
        placeholder="Ask Claude something — e.g. Explain 'break the ice' in one sentence."
      />
      <Button type="submit" disabled={pending}>
        {pending ? "Asking…" : "Ask Claude"}
      </Button>
      {answer ? <pre>{answer}</pre> : null}
    </form>
  );
}
