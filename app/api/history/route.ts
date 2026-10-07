import { history } from "@/lib/db";
import { failure } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(history());
  } catch (e) {
    return failure(e);
  }
}
