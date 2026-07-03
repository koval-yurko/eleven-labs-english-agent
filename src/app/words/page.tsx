import { redirect } from "next/navigation";

/** The old /words page — word sets now live on the home page (per-lesson conversation history). */
export default function WordsPage() {
  redirect("/");
}
