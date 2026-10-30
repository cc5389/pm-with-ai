/** Vercel is always a public, browser-owned simulation demo. */
export function isPublicDemo() {
  return (
    process.env.VERCEL === "1" || process.env.ORCHESTRA_PUBLIC_DEMO === "1"
  );
}
export function publicDemoGuard() {
  return isPublicDemo()
    ? Response.json(
        {
          error:
            "The public demo keeps workspace data in your browser. Server workspace access and real inference are disabled.",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      )
    : null;
}
