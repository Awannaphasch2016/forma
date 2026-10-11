export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function errorResponse(error: unknown) {
  if (error instanceof HttpError)
    return Response.json({ error: error.message }, { status: error.status });
  console.error(
    "Request failed:",
    error instanceof Error
      ? { name: error.name, message: error.message }
      : "Unknown error",
  );
  return Response.json(
    {
      error:
        "The request could not be completed. Check the server configuration and try again.",
    },
    { status: 500 },
  );
}
export async function jsonBody(request: Request) {
  if (Number(request.headers.get("content-length")) > 24_000)
    throw new HttpError(413, "Message is too large.");
  const text = await request.text();
  if (text.length > 24_000) throw new HttpError(413, "Message is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) throw new HttpError(403, "Request origin is not allowed.");
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "Request origin is not allowed.");
  }
  const requestHost = new URL(request.url).host;
  const headerHost = request.headers.get("host")?.split(",")[0]?.trim();
  if (originHost === requestHost || (headerHost && originHost === headerHost)) {
    return;
  }
  const appUrl = process.env.APP_URL;
  if (appUrl && origin === new URL(appUrl).origin) return;
  throw new HttpError(403, "Request origin is not allowed.");
}
