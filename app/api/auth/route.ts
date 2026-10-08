import { currentSession } from "@/lib/auth";

export async function GET() {
  const session = await currentSession();
  return Response.json({
    signedIn: session.signedIn,
    organization: session.organization,
    role: session.role,
  });
}
