import { ZodError } from "zod";
import { AppError } from "./db";
export async function body(request: Request): Promise<unknown> {
  const origin = request.headers.get("origin");
  if (origin) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new AppError("Invalid request origin.", 403);
    }
    const host = request.headers.get("host") || new URL(request.url).host;
    if (parsed.host !== host || !["http:", "https:"].includes(parsed.protocol))
      throw new AppError("Cross-origin writes are not allowed.", 403);
  }
  const text = await request.text();
  if (text.length > 100000) throw new AppError("Request is too large.", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("Invalid JSON body.");
  }
}
export function failure(error: unknown) {
  if (error instanceof ZodError)
    return Response.json(
      {
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 400 },
    );
  if (error instanceof AppError)
    return Response.json({ error: error.message }, { status: error.status });
  console.error(
    "Request failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  return Response.json(
    {
      error: "The request could not be completed. Check the local server log.",
    },
    { status: 500 },
  );
}
