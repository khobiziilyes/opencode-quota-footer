export type QuotaWindow = {
  windowMinutes: number;
  remainingPercent: number;
};

export type QuotaSnapshot = {
  windows: QuotaWindow[];
  observedAt: number | null;
};

export function parseQuotaHeaders(headers: Pick<Headers, "get">): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const name of ["primary", "secondary"]) {
    const used = headers.get(`x-codex-${name}-used-percent`);
    const duration = headers.get(`x-codex-${name}-window-minutes`);
    if (!used?.trim() || !duration?.trim()) continue;

    const usedPercent = Number(used);
    const windowMinutes = Number(duration);
    if (
      !Number.isFinite(usedPercent) ||
      usedPercent < 0 ||
      usedPercent > 100 ||
      !Number.isInteger(windowMinutes) ||
      windowMinutes <= 0
    ) continue;

    windows.push({ windowMinutes, remainingPercent: 100 - usedPercent });
  }
  return windows;
}

export function formatQuota(snapshot: QuotaSnapshot): string {
  if (snapshot.windows.length === 0) return "Codex unavailable";
  return `Codex ${snapshot.windows.map(({ windowMinutes, remainingPercent }) => {
    const duration = windowMinutes % 1440 === 0
      ? `${windowMinutes / 1440}d`
      : windowMinutes % 60 === 0
        ? `${windowMinutes / 60}h`
        : `${windowMinutes}m`;
    return `${duration} ${Math.round(remainingPercent)}% left`;
  }).join(" · ")}`;
}

export function createQuotaState() {
  let observation: {
    sessionID: string;
    windows: QuotaWindow[];
    observedAt: number;
  } | undefined;

  return {
    observe(sessionID: string, headers: Pick<Headers, "get">, now: number): void {
      const windows = parseQuotaHeaders(headers);
      observation = windows.length > 0
        ? { sessionID, windows, observedAt: now }
        : undefined;
    },
    read(sessionID: string, now: number): QuotaSnapshot {
      if (observation && now - observation.observedAt >= 300_000) {
        observation = undefined;
      }
      if (!observation || observation.sessionID !== sessionID) {
        return { windows: [], observedAt: null };
      }
      return {
        windows: observation.windows.map((window) => ({ ...window })),
        observedAt: observation.observedAt,
      };
    },
    clear(): void {
      observation = undefined;
    },
  };
}
