import { ImageResponse } from "next/og";

/**
 * On-the-fly PWA icon generator (no binary assets, no extra deps). Serves square PNGs at
 * `/pwa/apple-touch-icon.png`, `/pwa/icon-192.png`, `/pwa/icon-512.png`,
 * `/pwa/icon-512-maskable.png`. The `.png` suffix keeps these OUT of the auth gate — the
 * `proxy.ts` matcher excludes any `*.png` path — so logged-out installs can fetch them.
 *
 * This is a branded PLACEHOLDER (pink gradient + "ET" wordmark). Drop real artwork by replacing
 * these routes with static files in `public/` (or `app/apple-icon.png`) when you have it.
 */

const ICONS: Record<string, { size: number; maskable: boolean }> = {
  "apple-touch-icon.png": { size: 180, maskable: false },
  "icon-192.png": { size: 192, maskable: false },
  "icon-512.png": { size: 512, maskable: false },
  "icon-512-maskable.png": { size: 512, maskable: true },
};

export function generateStaticParams() {
  return Object.keys(ICONS).map((icon) => ({ icon }));
}

export async function GET(_request: Request, ctx: { params: Promise<{ icon: string }> }) {
  const { icon } = await ctx.params;
  const spec = ICONS[icon];
  if (!spec) {
    return new Response("Not found", { status: 404 });
  }

  const { size, maskable } = spec;
  // Maskable icons must keep content inside the Android safe zone (~80%); pad the glyph in.
  const glyph = Math.round(size * (maskable ? 0.34 : 0.46));

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundImage: "linear-gradient(135deg, #ec4899 0%, #f472b6 100%)",
          color: "#ffffff",
        }}
      >
        <div
          style={{
            fontSize: glyph,
            fontWeight: 700,
            letterSpacing: "-0.05em",
            display: "flex",
          }}
        >
          ET
        </div>
      </div>
    ),
    {
      width: size,
      height: size,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    },
  );
}
