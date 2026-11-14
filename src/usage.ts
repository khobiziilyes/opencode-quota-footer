import type { QuotaWindow } from "./quota.ts";

export async function fetchQuotaUsage(accessToken: string, accountID: string, signal: AbortSignal): Promise<QuotaWindow[]> {
  const unavailable = () => new Error("Quota unavailable");
  if (
    typeof accessToken !== "string" || !/^[\x21-\x7e]+$/.test(accessToken) ||
    typeof accountID !== "string" || !/^[\x21-\x7e]+$/.test(accountID) || signal.aborted
  ) throw unavailable();

  const abort = new AbortController();
  const forward = () => abort.abort();
  signal.addEventListener("abort", forward, { once: true });
  const deadline = setTimeout(forward, 10_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancel: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      void reader?.cancel().catch(() => {});
      reject(unavailable());
    };
    abort.signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([cancelled, (async () => {
      const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "ChatGPT-Account-Id": accountID,
        },
        signal: abort.signal,
      });
      if (abort.signal.aborted || response.status !== 200 ||
        Number(response.headers.get("content-length")) > 131_072 || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      reader = response.body.getReader();
      let size = 0;
      let text = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        while (true) {
          const chunk = await reader.read();
          if (abort.signal.aborted) throw unavailable();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 131_072) throw unavailable();
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
        reader = undefined;
      }
      const data = JSON.parse(text);
      const windows: QuotaWindow[] = [];
      for (const name of ["primary_window", "secondary_window"]) {
        const window = data?.rate_limit?.[name];
        if (
          typeof window?.used_percent !== "number" || !Number.isFinite(window.used_percent) ||
          window.used_percent < 0 || window.used_percent > 100 ||
          !Number.isSafeInteger(window.limit_window_seconds) || window.limit_window_seconds <= 0 ||
          window.limit_window_seconds % 60 !== 0
        ) continue;
        windows.push({
          windowMinutes: window.limit_window_seconds / 60,
          remainingPercent: 100 - window.used_percent,
        });
      }
      if (!windows.length) throw unavailable();
      return windows;
    })()]);
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", forward);
    abort.signal.removeEventListener("abort", cancel);
  }
}
