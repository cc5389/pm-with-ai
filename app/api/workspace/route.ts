import { isPublicDemo, publicDemoGuard } from "@/lib/deployment";
import { demoWorkspace, emptyDemoState } from "@/lib/demo";
import { workspace } from "@/lib/service";
import { saveSettings, transaction } from "@/lib/db";
import { settingsSchema } from "@/lib/validation";
import { body, failure } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  if (isPublicDemo())
    return Response.json(demoWorkspace(emptyDemoState()), {
      headers: { "Cache-Control": "no-store" },
    });
  try {
    return Response.json(workspace());
  } catch (e) {
    return failure(e);
  }
}
export async function POST(req: Request) {
  const guard = publicDemoGuard();
  if (guard) return guard;
  try {
    const s = settingsSchema.parse(await body(req));
    transaction(() => saveSettings(s));
    return Response.json(workspace());
  } catch (e) {
    return failure(e);
  }
}
