import { redirect } from "next/navigation";

/** The old /words page became /lessons (word sets + per-lesson conversation history). */
export default function WordsPage() {
  redirect("/lessons");
}
