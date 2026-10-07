import { workspace } from "@/lib/service";
import { saveSettings, transaction } from "@/lib/db";
import { settingsSchema } from "@/lib/validation";
import { body, failure } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(workspace());
  } catch (e) {
    return failure(e);
  }
}
export async function POST(req: Request) {
  try {
    const s = settingsSchema.parse(await body(req));
    transaction(() => saveSettings(s));
    return Response.json(workspace());
  } catch (e) {
    return failure(e);
  }
}
