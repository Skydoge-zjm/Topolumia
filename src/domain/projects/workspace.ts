import * as z from "zod/v4";

const directory = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      ![...value].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ),
    "目录包含无效字符",
  );
export const projectWorkspaceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("managed") }),
  z.strictObject({ kind: z.literal("local"), directory }),
  z.strictObject({ kind: z.literal("ssh"), connectionId: z.uuid(), directory }),
]);
export const createProjectSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{1,100}$/)
    .optional(),
  name: z.string().trim().min(1).max(120),
  workspace: projectWorkspaceSchema.default({ kind: "managed" }),
});
export type ProjectWorkspaceChoice = z.infer<typeof projectWorkspaceSchema>;
export type ProjectWorkspace = {
  kind: ProjectWorkspaceChoice["kind"] | "unassigned";
  directory?: string;
  connectionId?: string;
  ownerId?: string;
  hostLabel?: string;
  connectionRevision?: number;
  revision: number;
};
