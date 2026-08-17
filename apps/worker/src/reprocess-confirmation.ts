import type { TargetConfig } from "@tibo-radar/contracts";
import { evaluateConfirmation, extractSignalWithRules } from "@tibo-radar/signal";

import type { SqliteWorkerRepository } from "./repository.js";

export interface ReprocessedConfirmation {
  postId: string;
  state: "confirmed_reset" | "retracted";
  reasonCode: string;
  eventId: string;
  occurredAt: string | null;
}

export async function reprocessStoredConfirmation(
  repository: SqliteWorkerRepository,
  target: TargetConfig,
  postId: string,
): Promise<ReprocessedConfirmation> {
  const normalizedPostId = postId.trim();
  if (!normalizedPostId) throw new Error("postId is required");

  const post = await repository.getReplayablePost(normalizedPostId);
  if (!post) throw new Error(`Post ${normalizedPostId} is not available for reprocessing`);

  const extraction = extractSignalWithRules(post.text, post.editedAt ?? post.createdAt);
  const decision = evaluateConfirmation({
    post,
    extraction,
    authoritativeUserIds: target.authoritativeUserIds,
    bankedResetPolicy: target.bankedResetPolicy,
  });
  if ((decision.state !== "confirmed_reset" && decision.state !== "retracted") || !decision.event) {
    throw new Error(
      `Post ${normalizedPostId} did not produce a confirmed event (${decision.reasonCode})`,
    );
  }

  await repository.saveConfirmation(post, decision);
  return {
    postId: normalizedPostId,
    state: decision.state,
    reasonCode: decision.reasonCode,
    eventId: decision.event.eventId,
    occurredAt: decision.event.occurredAt,
  };
}
