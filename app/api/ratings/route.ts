import { rateRecord } from "@/lib/service";
import { ratingSchema } from "@/lib/validation";
import { body, failure } from "@/lib/http";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    const r = ratingSchema.parse(await body(req));
    return Response.json(
      rateRecord(r.id, r.correctness, r.completeness, r.instructionFollowing),
    );
  } catch (e) {
    return failure(e);
  }
}
