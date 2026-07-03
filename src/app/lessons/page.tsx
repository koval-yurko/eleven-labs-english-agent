import { redirect } from "next/navigation";

/** The lessons list is now the home page; keep /lessons working for old bookmarks. */
export default function LessonsIndexPage() {
  redirect("/");
}
