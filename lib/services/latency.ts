// Adds a small delay to every service call so the demo feels like a real
// network backend. Tests set SIMULATED_LATENCY_MS=0.

export function simulatedLatency(): Promise<void> {
  const ms = Number(process.env.SIMULATED_LATENCY_MS ?? 120);
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
