import { createHash } from "node:crypto";

import {
  type SourcePostObserved,
  SourcePostObservedSchema,
  type TargetConfig,
} from "@tibo-radar/contracts";

export function createDemoFixtures(
  config: TargetConfig,
  referenceTime = new Date(),
): SourcePostObserved[] {
  const examples = [
    {
      id: "1001",
      ageHours: 30,
      text: "Capacity work shipped. We are watching the rollout closely.",
    },
    {
      id: "1002",
      ageHours: 8,
      text: "The next usage reset is planned for tomorrow if the rollout stays healthy.",
    },
    { id: "1003", ageHours: 1, text: "One more milestone complete. Reset timing update soon." },
  ];
  return examples.map(({ id, ageHours, text }) => {
    const timestamp = new Date(referenceTime.getTime() - ageHours * 60 * 60 * 1_000).toISOString();
    return SourcePostObservedSchema.parse({
      postId: id,
      authorId: config.target.userId,
      authorDisplayName: config.target.displayName,
      authorHandle: config.target.handle,
      authorAvatarUrl: null,
      sourceKind: id === "1003" ? "reply" : "post",
      conversationId: id,
      referencedPostIds: [],
      language: "en",
      sourceUrl: `https://x.com/${config.target.handle}/status/${id}`,
      text,
      contentHash: createHash("sha256").update(text).digest("hex"),
      createdAt: timestamp,
      observedAt: timestamp,
      editedAt: null,
      deletedAt: null,
    });
  });
}
