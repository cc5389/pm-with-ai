import { previewRequest } from "@/lib/service";
import { inputSchema, settingsSchema } from "@/lib/validation";
import { body, failure } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    const b = (await body(req)) as { input: unknown; settings?: unknown };
    const settings =
      b?.settings === undefined ? undefined : settingsSchema.parse(b.settings);
    return Response.json(previewRequest(inputSchema.parse(b?.input), settings));
  } catch (e) {
    return failure(e);
  }
}
