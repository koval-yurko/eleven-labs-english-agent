import type { Metadata } from "next";
import { OfflineApp } from "../OfflineApp";

// Fully static so the service worker can precache it and serve it — for ANY offline navigation —
// as the app-shell (see public/sw.js + OfflineApp). No session / data access; renders without
// the network, then upgrades to the mirror-backed view on the client.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Offline — Idiomatic",
};

export default function OfflinePage() {
  return <OfflineApp />;
}
