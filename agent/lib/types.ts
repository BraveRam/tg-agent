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
});

export const channelSchema = z.object({
  chatId: z.string().regex(/^-?\d+$/),
  name: z.string().min(1),
  language: z.enum(["en", "am", "om"]),
  style: z.string().default("Concise, natural news."),
  timezone: timezone.default("Africa/Nairobi"),
  images: z.enum(["auto", "never", "prefer"]).default("auto"),
});

export const jobInputSchema = z.object({
  channelId: z.string(),
  name: z.string().min(1),
  task: z.string().min(1),
  sources: z.array(sourceSchema).default([]),
  schedule: scheduleSchema.default({ kind: "interval", minutes: 5 }),
  trigger: z.enum(["scheduled", "source_updates"]).default("scheduled"),
  freshnessHours: z.number().min(1).max(168).default(24),
});

export type Schedule = z.infer<typeof scheduleSchema>;

export type Channel = z.infer<typeof channelSchema> & { id: string };

export type Job = Omit<z.infer<typeof jobInputSchema>, "trigger"> & {
  trigger?: "scheduled" | "source_updates";
  id: string;
  enabled: boolean;
  version: number;
  nextDue: number;
  deletedAt?: number;
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

export type Media = {
  url?: string;
  sourceChatId?: string;
  sourceMessageId?: number;
};

export type Post = {
  channelId: string;
  headline: string;
  text: string;
  media: Media[];
};

export type Publication = {
  id: string;
  channelId: string;
  runId: string | null;
  storyKey: string;
  headline: string;
  text: string;
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
