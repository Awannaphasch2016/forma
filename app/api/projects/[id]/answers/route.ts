import { z } from "zod";
import { requireMember } from "@/lib/auth";
import { answerHitl } from "@/lib/hitl";
import { dispatchJob } from "@/lib/queue";
import { errorResponse, HttpError, jsonBody, sameOrigin } from "@/lib/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    sameOrigin(request);
    const member = await requireMember();
    const { id } = await context.params;
    const parsed = z
      .object({
        requestId: z.uuid(),
        answer: z.string().trim().min(1).max(12000),
      })
      .safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new HttpError(400, "Enter an answer of up to 12,000 characters.");
    const job = await answerHitl({
      projectId: id,
      organizationId: member.organizationId,
      roleId: member.roleId,
      userId: member.userId,
      requestId: parsed.data.requestId,
      answer: parsed.data.answer,
    });
    await dispatchJob(job.id).catch(() => {});
    return Response.json({ jobId: job.id }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
