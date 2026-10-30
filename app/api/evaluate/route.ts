import { publicDemoGuard } from "@/lib/deployment";
import { evaluate, BENCHMARK_PROMPTS } from "@/lib/benchmark";
import { AppError, getSettings } from "@/lib/db";
import { MODELS } from "@/lib/catalog";
import { inputSchema, settingsSchema } from "@/lib/validation";
import { body, failure } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json({ prompts: BENCHMARK_PROMPTS });
}
export async function POST(req: Request) {
  const guard = publicDemoGuard();
  if (guard) return guard;
  try {
    const b = (await body(req)) as { input: unknown; settings?: unknown };
    const input = inputSchema.parse(b?.input);
    if (input.mode !== "simulation")
      throw new AppError(
        "The comparison uses simulation profiles. Switch to Simulation mode first.",
      );
    return Response.json(
      evaluate(
        b?.settings === undefined
          ? getSettings()
          : settingsSchema.parse(b.settings),
        MODELS,
        input,
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
