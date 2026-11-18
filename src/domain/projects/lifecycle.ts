import * as z from "zod/v4";

export const deleteProjectSchema = z.strictObject({
  name: z.string().min(1).max(160),
});

export type ProjectDeletionResult = {
  id: string;
  deleted: true;
  stoppedCollectors: boolean;
};
