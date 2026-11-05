export const MAX_AGENT_IMAGES = 8;
export const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024;
export type AgentImageAttachment = {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
};
export type StoredAgentImageAttachment = AgentImageAttachment & {
  path: string;
};
export function publicAgentAttachment({
  id,
  name,
  mediaType,
  sizeBytes,
}: StoredAgentImageAttachment | AgentImageAttachment): AgentImageAttachment {
  return { id, name, mediaType, sizeBytes };
}
export function imagePromptParts(
  attachments: StoredAgentImageAttachment[] = [],
) {
  return attachments.map((image) => ({
    type: "image",
    path: image.path,
    mimeType: image.mediaType,
    name: image.name,
  }));
}
