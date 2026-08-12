import { getQaService } from "../../../qa/service";
import { QaError, QaRequestSchema, invalidRequest, type QaRequest, type QaResponse } from "../../../qa/types";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type QaRunner = { run(input: QaRequest): Promise<QaResponse> };

export async function handleQaRequest(request: Request, runner?: QaRunner): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw invalidRequest("Request body must be valid JSON");
    }
    const parsed = QaRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues[0]?.message);
    const result = await (runner ?? getQaService()).run(parsed.data);
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    const qaError =
      error instanceof QaError
        ? error
        : new QaError("internal_error", 500, "The query failed", { cause: error });
    return NextResponse.json(
      { error: { code: qaError.code, message: qaError.message } },
      { status: qaError.status },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleQaRequest(request);
}
