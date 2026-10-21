export class ApiError extends Error {
  /**
   * A 401 for a session this tab no longer uses: the call was made as the shared-link session,
   * which the tab was leaving or had left (leaveSharedSession) by the time the answer came. It
   * says nothing about the session the tab uses now, so it is not "signed out" (isSignedOut).
   */
  sessionLeft = false;
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** The rest of the error body (e.g. `detail`, `problems`), for the few callers that use it. */
    public data: Record<string, unknown> = {},
    public correlationId?: string,
    public retryAt?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const UNREACHABLE = "We can't reach bizinsights right now. We'll keep trying.";

/** Read the body separately: a dropped download is as retryable as a failed fetch. */
export async function readApiResponse(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new ApiError(0, "network", UNREACHABLE);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    if (res.ok) throw new ApiError(res.status, "bad_response", "Unexpected response from the server");
    return {};
  }
}

/** Keep structured details for callers, but never trust an upstream error envelope's shape. */
export function apiFailure(status: number, body: unknown): ApiError {
  const data = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return new ApiError(status,
    typeof data.error === "string" ? data.error : "error",
    typeof data.message === "string" ? data.message : "Request failed",
    data);
}
