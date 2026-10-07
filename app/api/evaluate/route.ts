import { evaluate, BENCHMARK_PROMPTS } from "@/lib/benchmark";
import { AppError, getSettings } from "@/lib/db";
import { MODELS } from "@/lib/catalog";
import { inputSchema } from "@/lib/validation";
import { body, failure } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json({ prompts: BENCHMARK_PROMPTS });
}
export async function POST(req: Request) {
  try {
    const b = (await body(req)) as { input: unknown };
    const input = inputSchema.parse(b?.input);
    if (input.mode !== "simulation")
      throw new AppError(
        "The comparison uses simulation profiles. Switch to Simulation mode first.",
      );
    return Response.json(evaluate(getSettings(), MODELS, input));
  } catch (e) {
    return failure(e);
  }
}
