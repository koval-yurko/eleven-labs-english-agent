import { redirect } from "next/navigation";

/** The app is the report list. */
export default function Home() {
  redirect("/reports");
}
