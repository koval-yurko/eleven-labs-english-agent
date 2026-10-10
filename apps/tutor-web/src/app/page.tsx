import { redirect } from "next/navigation";

/** The Words page is the landing page now; `/` sends you there. Lessons live at `/lessons`. */
export default function RootPage() {
  redirect("/lesson-items");
}
