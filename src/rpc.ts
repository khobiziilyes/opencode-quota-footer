import { Rpc } from "@opencode/plugin/rpc";
import type { QuotaSnapshot } from "./quota.ts";

export const Quota = Rpc.define({
  id: "opencode-quota-footer",
  methods: {
    snapshot: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", minLength: 1 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          windows: {
            type: "array",
            maxItems: 2,
            items: {
              type: "object",
              properties: {
                windowMinutes: { type: "integer", minimum: 1 },
                remainingPercent: { type: "number", minimum: 0, maximum: 100 },
              },
              required: ["windowMinutes", "remainingPercent"],
              additionalProperties: false,
            },
          },
          observedAt: { type: ["number", "null"] },
        },
        required: ["windows", "observedAt"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: { schema: { type: "object", additionalProperties: false } },
  },
});

export function sessionInput(input: unknown): string {
  if (
    typeof input !== "object" || input === null || Array.isArray(input) ||
    !("sessionID" in input) || typeof input.sessionID !== "string" ||
    !input.sessionID || !Object.hasOwn(input, "sessionID") || Object.keys(input).length !== 1
  ) throw new Error("Invalid snapshot input");
  return input.sessionID;
}

export function isQuotaSnapshot(value: unknown): value is QuotaSnapshot {
  if (
    typeof value !== "object" || value === null ||
    !("windows" in value) || !Array.isArray(value.windows) ||
    value.windows.length > 2 || !("observedAt" in value) ||
    Object.keys(value).length !== 2
  ) return false;
  if (value.windows.length === 0) return value.observedAt === null;
  return typeof value.observedAt === "number" && Number.isFinite(value.observedAt) &&
    value.windows.every((window: unknown) =>
      typeof window === "object" && window !== null &&
      "windowMinutes" in window && typeof window.windowMinutes === "number" &&
      Number.isInteger(window.windowMinutes) && window.windowMinutes > 0 &&
      "remainingPercent" in window && typeof window.remainingPercent === "number" &&
      Number.isFinite(window.remainingPercent) &&
      window.remainingPercent >= 0 && window.remainingPercent <= 100 &&
      Object.keys(window).length === 2
    );
}
