import { publicDemoGuard } from "@/lib/deployment";
import { allRecords, getSettings } from "@/lib/db";
import { failure } from "@/lib/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const cell = (value: unknown) =>
  '"' +
  String(value ?? "")
    .replace(/^[=+@\-\t\r]/, "'$&")
    .replaceAll('"', '""') +
  '"';
export async function GET(req: Request) {
  const guard = publicDemoGuard();
  if (guard) return guard;
  try {
    const records = allRecords();
    if (new URL(req.url).searchParams.get("format") === "csv") {
      const columns = [
        "id",
        "created_at",
        "mode",
        "status",
        "task",
        "model",
        "simulated_cost_usd",
        "actual_cost_usd",
        "simulated_latency_seconds",
        "measured_latency_ms",
        "human_quality_score",
        "prompt",
        "response",
      ];
      const rows = records.map((r) =>
        [
          r.id,
          r.createdAt,
          r.input.mode,
          r.status,
          r.input.task,
          r.preview.selected?.model.id,
          r.simulatedCost,
          r.actualCost,
          r.simulatedLatency,
          r.measuredLatencyMs,
          r.rating?.score,
          r.input.prompt,
          r.response,
        ]
          .map(cell)
          .join(","),
      );
      return new Response([columns.join(","), ...rows].join("\r\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=orchestra-history.csv",
        },
      });
    }
    return Response.json(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: getSettings(),
        records,
      },
      {
        headers: {
          "Content-Disposition":
            "attachment; filename=orchestra-workspace.json",
        },
      },
    );
  } catch (e) {
    return failure(e);
  }
}
