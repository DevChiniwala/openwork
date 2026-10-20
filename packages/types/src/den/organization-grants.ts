import { z } from "zod";

export const ORGANIZATION_BENEFITS = ["freeAuto", "openworkWeb"] as const;
export const ORGANIZATION_GRANT_TYPES = ["access", "usage", "unlimited"] as const;
export type OrganizationBenefit = typeof ORGANIZATION_BENEFITS[number];
export const organizationBenefitSchema = z.enum(ORGANIZATION_BENEFITS);
export const organizationAccessSettingSchema = z.enum(["default", "enabled", "disabled"]);
export const organizationGrantInputSchema = z.object({
  /** Supplied once by the client, retained across retries after an ambiguous response. */
  requestId: z.uuid(),
  feature: organizationBenefitSchema,
  kind: z.enum(ORGANIZATION_GRANT_TYPES),
  amountUsd: z.number().finite().positive().max(1_000_000).multipleOf(0.01).nullable(),
  startsAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  reason: z.string().trim().min(3).max(500),
}).strict().superRefine((value, context) => {
  if ((value.kind === "usage") !== (value.amountUsd !== null)) context.addIssue({ code: "custom", path: ["amountUsd"], message: "Only an extra usage grant has an amount." });
  if (value.feature === "openworkWeb" && value.kind !== "access") context.addIssue({ code: "custom", path: ["kind"], message: "OpenWork Web supports feature access grants." });
  if (value.startsAt && value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(value.startsAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiration must be after the start." });
});
export const organizationGrantSchema = z.object({
  id: z.string(), feature: organizationBenefitSchema, kind: z.enum(ORGANIZATION_GRANT_TYPES),
  amountUsd: z.number().nullable(), usedUsd: z.number(), remainingUsd: z.number().nullable(),
  startsAt: z.string(), expiresAt: z.string().nullable(), createdAt: z.string(),
  revokedAt: z.string().nullable(), createdByUserId: z.string(), reason: z.string(),
  state: z.enum(["scheduled", "active", "expired", "exhausted", "revoked", "blocked"]),
});
export const organizationControlPanelSchema = z.object({
  enabled: z.boolean(), generatedAt: z.string(),
  access: z.object({
    freeAuto: z.object({ setting: organizationAccessSettingSchema, enabled: z.boolean(), source: z.string() }),
    openworkWeb: z.object({ setting: organizationAccessSettingSchema, enabled: z.boolean(), source: z.string() }),
  }),
  freeAuto: z.object({ weeklyLimitUsd: z.number(), extraRemainingUsd: z.number(), unlimited: z.boolean() }),
  grants: z.array(organizationGrantSchema),
  /** Old complimentary access remains effective until explicitly returned to default. */
  legacyWebAccess: z.boolean(),
  hasMore: z.boolean(),
  offset: z.number().int().nonnegative(),
});
export type OrganizationGrantInput = z.infer<typeof organizationGrantInputSchema>;
export type OrganizationGrant = z.infer<typeof organizationGrantSchema>;
export type OrganizationControlPanel = z.infer<typeof organizationControlPanelSchema>;
