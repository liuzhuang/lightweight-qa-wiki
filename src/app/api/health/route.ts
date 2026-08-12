import { getHealthStatus, type HealthResponse } from "../../../qa/service";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function handleHealthRequest(
  healthCheck: () => Promise<HealthResponse> = getHealthStatus,
): Promise<Response> {
  const health = await healthCheck();
  return NextResponse.json(health, { status: health.status === "ok" ? 200 : 503 });
}

export async function GET(): Promise<Response> {
  return handleHealthRequest();
}
