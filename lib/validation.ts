import { z } from "zod";
const money = z.number().finite().min(0).max(1e9);
const modelIds = z.array(z.string().min(1).max(200)).max(100);
export const inputSchema = z.object({
  prompt: z.string().trim().min(1, "Enter a request first.").max(50000),
  task: z.enum(["coding", "analysis", "writing", "qa"]),
  importance: z.enum(["low", "medium", "high"]),
  userId: z.string().min(1).max(100),
  qualityFloor: z.number().finite().min(0).max(1),
  latencyTarget: z.number().finite().positive().max(600),
  strictLatency: z.boolean(),
  maxRequestCost: money.nullable(),
  outputTokens: z.number().int().min(32).max(8192),
  weights: z
    .object({
      quality: z.number().finite().min(0).max(1),
      cost: z.number().finite().min(0).max(1),
      latency: z.number().finite().min(0).max(1),
    })
    .refine(
      (w) => w.quality + w.cost + w.latency > 0,
      "At least one priority must be above zero.",
    ),
  preferredModels: modelIds,
  blockedModels: modelIds,
  localOnly: z.boolean(),
  mode: z.enum(["simulation", "local"]),
});
export const settingsSchema = z.object({
  teamName: z.string().trim().min(1).max(100),
  monthlyBudget: money,
  monthlyRequests: z.number().int().min(1).max(10000000),
  scenario: z.enum(["early", "balanced", "tight", "custom"]),
  simulatedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((s) => {
      const d = new Date(s + "T00:00:00Z");
      return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }, "Use a valid calendar date."),
  openingSpend: money,
  users: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        name: z.string().trim().min(1).max(100),
        role: z.string().max(100),
        budget: money.nullable(),
      }),
    )
    .min(1)
    .max(20)
    .refine(
      (users) => new Set(users.map((u) => u.id)).size === users.length,
      "User IDs must be unique.",
    ),
  blockedModels: modelIds,
});
export const runSchema = z.object({
  input: inputSchema,
  idempotencyKey: z.string().uuid(),
});
export const ratingSchema = z.object({
  id: z.string().uuid(),
  correctness: z.number().int().min(1).max(5),
  completeness: z.number().int().min(1).max(5),
  instructionFollowing: z.number().int().min(1).max(5),
});
