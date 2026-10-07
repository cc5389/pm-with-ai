import { previewRequest } from "@/lib/service";
import { inputSchema } from "@/lib/validation";
import { body, failure } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    const b = (await body(req)) as { input: unknown };
    return Response.json(previewRequest(inputSchema.parse(b?.input)));
  } catch (e) {
    return failure(e);
  }
}
