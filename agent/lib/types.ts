import { z } from "zod";
import { DateTime } from "luxon";

export const timezone = z
  .string()
  .refine((v) => DateTime.now().setZone(v).isValid, "Invalid IANA timezone");

export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(1).max(525600) }),
  z.object({
    kind: z.literal("calendar"),
    times: z
      .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
      .min(1)
      .max(24),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
    timezone,
  }),
]);

export const sourceSchema = z.object({
  kind: z.enum(["telegram", "web"]),
  reference: z.string().min(1),
  trust: z.enum(["verify", "always"]).default("verify"),
});

export const channelSchema = z.object({
  chatId: z.string().regex(/^-?\d+$/),
  name: z.string().min(1),
  language: z.enum(["en", "am", "om"]),
  style: z.string().default("Concise, natural news with source attribution."),
  timezone: timezone.default("Africa/Nairobi"),
  images: z.enum(["auto", "never", "prefer"]).default("auto"),
});

export const jobInputSchema = z.object({
  channelId: z.string(),
  name: z.string().min(1),
  task: z.string().min(1),
  sources: z.array(sourceSchema).default([]),
  schedule: scheduleSchema.default({ kind: "interval", minutes: 5 }),
  freshnessHours: z.number().min(1).max(168).default(24),
});

export type Schedule = z.infer<typeof scheduleSchema>;

export type Channel = z.infer<typeof channelSchema> & { id: string };

export type Job = z.infer<typeof jobInputSchema> & {
  id: string;
  enabled: boolean;
  version: number;
  nextDue: number;
};

export type Run = {
  id: string;
  jobId: string;
  version: number;
  status: string;
  leaseUntil: number;
  sessionId: string | null;
  due: number;
};

export type Evidence = {
  url: string;
  claim: string;
  sourceMessageId?: number;
  sourceChatId?: string;
};

export type Media = {
  url?: string;
  sourceChatId?: string;
  sourceMessageId?: number;
  credit: string;
  reuseAllowed: boolean;
};

export type Post = {
  channelId: string;
  headline: string;
  text: string;
  evidence: Evidence[];
  media: Media[];
};

export type Publication = {
  id: string;
  channelId: string;
  runId: string | null;
  storyKey: string;
  headline: string;
  text: string;
  evidence: Evidence[];
  media: Media[];
  messageIds: number[];
  status: string;
  sentAt: number | null;
  operation: string;
  previousText?: string;
  attempts: number;
  retryAt: number;
  error: string | null;
};
