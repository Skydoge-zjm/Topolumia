import * as z from "zod/v4";

export const pythonIdentitySchema = z.object({
  executable: z.string(),
  version: z.string(),
  prefix: z.string(),
  basePrefix: z.string().optional(),
  kind: z.string(),
  projectVenv: z.string().nullable().optional(),
  manager: z.string().optional(),
  realExecutable: z.string().optional(),
});
export type PythonIdentity = z.infer<typeof pythonIdentitySchema>;
export const probeResultSchema = z.looseObject({
  status: z.string(),
  detail: z.string().optional(),
  version: z.string().nullable().optional(),
  python: pythonIdentitySchema.optional(),
  frontend: z.string().optional(),
  packages: z.record(z.string(), z.string().nullable()).optional(),
  executables: z.record(z.string(), z.string().nullable()).optional(),
  gpuAvailable: z.boolean().nullable().optional(),
  gpuTest: z.string().optional(),
  cudaVersion: z.string().nullable().optional(),
  cudnnVersion: z.string().nullable().optional(),
  ncclVersion: z.string().nullable().optional(),
  devices: z.array(z.object({ name: z.string(), memoryMiB: z.number().optional() })).optional(),
  items: z
    .array(
      z.object({
        name: z.string(),
        version: z.string(),
        source: z.string().optional(),
      }),
    )
    .optional(),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;
export type EnvironmentFact = {
  label: string;
  labelEn: string;
  value: string;
  valueEn?: string;
};
export type GpuInfo = {
  index: number;
  name: string;
  driverVersion: string;
  totalMiB: number | null;
  freeMiB: number | null;
};
export type ComponentResult = {
  status: string;
  detail?: string;
  version?: string | null;
  location?: string;
  recovery?: string | null;
  facts?: EnvironmentFact[];
  python?: PythonIdentity;
  summary?: string;
  gpus?: GpuInfo[];
  driverCudaMax?: string | null;
  gpuAvailable?: boolean | null;
  gpuTest?: string;
  cudaVersion?: string | null;
  cudnnVersion?: string | null;
  ncclVersion?: string | null;
  devices?: { name: string; memoryMiB?: number }[];
  packageName?: string;
  origin?: "environment" | "host";
};
export type ResearchComponent = ComponentResult & {
  id: string;
  scope: "host" | "research";
  checkedAt: string | null;
};
export type ResearchInspection = {
  schemaVersion: string;
  fingerprint: string;
  selection: { kind: string; prefix?: string; pythonCommand?: string };
  name: string;
  status: "idle" | "running" | "completed";
  startedAt: string | null;
  checkedAt: string | null;
  stale: boolean;
  components: ResearchComponent[];
};

export const researchInspectionSchema = z.object({
  schemaVersion: z.string(),
  fingerprint: z.string(),
  selection: z.object({
    kind: z.string(),
    prefix: z.string().optional(),
    pythonCommand: z.string().optional(),
  }),
  name: z.string(),
  status: z.enum(["idle", "running", "completed"]),
  startedAt: z.string().nullable(),
  checkedAt: z.string().nullable(),
  stale: z.boolean(),
  components: z
    .array(
      z.object({
        id: z.string(),
        scope: z.enum(["host", "research"]),
        checkedAt: z.string().nullable(),
        status: z.string(),
        detail: z.string().optional(),
        version: z.string().nullable().optional(),
        location: z.string().optional(),
        recovery: z.string().nullable().optional(),
        facts: z
          .array(
            z.object({
              label: z.string(),
              labelEn: z.string(),
              value: z.string(),
              valueEn: z.string().optional(),
            }),
          )
          .optional(),
        python: pythonIdentitySchema.optional(),
        summary: z.string().optional(),
        gpus: z
          .array(
            z.object({
              index: z.number(),
              name: z.string(),
              driverVersion: z.string(),
              totalMiB: z.number().nullable(),
              freeMiB: z.number().nullable(),
            }),
          )
          .optional(),
        driverCudaMax: z.string().nullable().optional(),
        gpuAvailable: z.boolean().nullable().optional(),
        gpuTest: z.string().optional(),
        cudaVersion: z.string().nullable().optional(),
        cudnnVersion: z.string().nullable().optional(),
        ncclVersion: z.string().nullable().optional(),
        devices: z.array(z.object({ name: z.string(), memoryMiB: z.number().optional() })).optional(),
        packageName: z.string().optional(),
        origin: z.enum(["environment", "host"]).optional(),
      }),
    )
    .max(10),
});
