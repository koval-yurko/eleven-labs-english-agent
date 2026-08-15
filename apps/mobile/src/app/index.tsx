import { Redirect } from "expo-router";

/**
 * `/` sends you to the collection — the same redirect `apps/web/src/app/page.tsx` performs.
 *
 * Until now `/` **was** the lessons list, on the reasoning that "there is no landing screen worth a
 * tap on a phone" (S5 D50). That is a fair point about landing screens and it is not what changed:
 * the web's `/` is not a landing screen either, it is a redirect, and the destination it picks is
 * the Words page. Two apps that disagree about which screen the app opens on are two apps.
 */
export default function RootIndex() {
  return <Redirect href="/lesson-items" />;
}
