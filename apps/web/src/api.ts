import type {
  ForecastSnapshot,
  RadarApiErrorPayload,
  RadarEventsResponse,
  RadarResetStatusResponse,
  RadarStatus,
} from "@tibo-radar/contracts";

export class RadarApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as RadarApiErrorPayload | null;
    throw new RadarApiError(
      response.status,
      payload?.error.message ?? `请求失败（${response.status}）`,
    );
  }
  return (await response.json()) as T;
}

export async function loadRadar(timezone: string, signal?: AbortSignal) {
  const encodedTimezone = encodeURIComponent(timezone);
  const [status, forecast, events, reset] = await Promise.all([
    request<RadarStatus>("/api/status", signal),
    request<ForecastSnapshot>(`/api/forecast?timezone=${encodedTimezone}`, signal),
    request<RadarEventsResponse>("/api/events?window=24h", signal),
    request<RadarResetStatusResponse>("/api/reset-status", signal),
  ]);
  return { status, forecast, events, reset };
}
