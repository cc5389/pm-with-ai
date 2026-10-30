import { publicDemoGuard } from "@/lib/deployment";
import { runRequest } from "@/lib/service";
import { runSchema } from "@/lib/validation";
import { body, failure } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const guard = publicDemoGuard();
  if (guard) return guard;
  try {
    const { input, idempotencyKey } = runSchema.parse(await body(req));
    return Response.json(await runRequest(input, idempotencyKey));
  } catch (e) {
    return failure(e);
  }
}
