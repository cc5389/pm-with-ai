import { publicDemoGuard } from "@/lib/deployment";
import { history } from "@/lib/db";
import { failure } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const guard = publicDemoGuard();
  if (guard) return guard;
  try {
    return Response.json(history());
  } catch (e) {
    return failure(e);
  }
}
