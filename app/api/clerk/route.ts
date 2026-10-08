import { clerkPublishable } from "@/lib/sign-in";

export async function GET() {
  const result = clerkPublishable(process.env.CLERK_PUBLISHABLE_KEY);
  return Response.json(result.body, { status: result.status });
}
