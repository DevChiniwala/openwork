import { and, asc, desc, eq, gte, isNotNull, isNull, lte, sql } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, ConfigObjectTable, MemberTable, OrganizationTable, TelemetryEventTable } from "@openwork-ee/den-db/schema"
import { adminOpportunitiesSchema } from "@openwork/types/den/admin-organization"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { adminRoute, queryValidator } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { ADMIN_MAX_PAGE_OFFSET, normalizeAdminPageRequest, sanitizeAdminSearchForLike } from "./scale-performance.js"

// A transparent heuristic, not an employer directory. A verified address on an
// unlisted domain is a signal only; never merge organizations by email domain.
const PERSONAL_EMAIL_DOMAINS = [
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr", "yahoo.de", "yahoo.co.jp", "ymail.com", "rocketmail.com",
  "outlook.com", "hotmail.com", "hotmail.co.uk", "hotmail.fr", "live.com", "live.co.uk", "live.fr", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "aim.com", "proton.me", "protonmail.com", "pm.me",
  "tuta.com", "tuta.io", "tutanota.com", "tutanota.de", "fastmail.com", "fastmail.fm", "hey.com",
  "mail.com", "email.com", "gmx.com", "gmx.net", "gmx.de", "web.de", "yandex.com", "yandex.ru", "ya.ru",
  "mail.ru", "inbox.ru", "bk.ru", "list.ru", "qq.com", "foxmail.com", "163.com", "126.com",
  "naver.com", "daum.net", "hanmail.net", "zoho.com", "rediffmail.com", "yopmail.com", "mailinator.com",
]

const querySchema = z.object({
  days: z.enum(["7", "30", "90"]).default("30"),
  minMembers: z.enum(["1", "2", "5", "10"]).default("2"),
  companyEmail: z.enum(["0", "1"]).default("0"),
  setup: z.enum(["any", "skills", "mcp", "both"]).default("any"),
  sort: z.enum(["recent", "active", "members"]).default("recent"),
  search: z.string().max(160).optional(), limit: z.string().optional(), offset: z.string().optional(),
})

export async function readAdminOpportunities(input: z.infer<typeof querySchema>, now = new Date()) {
  const request = normalizeAdminPageRequest(input)
  const from = new Date(now.getTime() - Number(input.days) * 86_400_000)
  const domain = sql<string>`lower(trim(substring_index(${AuthUserTable.email}, '@', -1)))`
  const personalDomains = sql.join(PERSONAL_EMAIL_DOMAINS.map((value) => sql`${value}`), sql`, `)
  const companyDomain = sql<string | null>`case when ${AuthUserTable.emailVerified} = true
    and ${AuthUserTable.email} regexp '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
    and ${domain} not in (${personalDomains}) then ${domain} else null end`
  // Look up each current person's activity through telemetry_event_member_ts.
  // Sign-in timestamps and activity in another organization are not app usage
  // here. Missing/disabled telemetry stays unobserved, never guessed from login.
  const people = db.$with("opportunity_people").as(db.select({
    organizationId: MemberTable.organizationId, userId: MemberTable.userId,
    companyDomain: companyDomain.as("company_domain"),
    lastActiveMs: sql<number | null>`(select unix_timestamp(max(${TelemetryEventTable.event_timestamp})) * 1000
      from ${TelemetryEventTable} where ${TelemetryEventTable.member_id} = ${MemberTable.id}
      and ${TelemetryEventTable.org_id} = ${MemberTable.organizationId}
      and ${gte(TelemetryEventTable.event_timestamp, from)} and ${lte(TelemetryEventTable.event_timestamp, now)}
      and ${TelemetryEventTable.event_timestamp} >= ${MemberTable.joinedAt})`.as("last_active_ms"),
  }).from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt), lte(MemberTable.joinedAt, now), eq(MemberTable.isSetupAgent, false))))
  const teams = db.$with("opportunity_teams").as(db.select({
    organizationId: people.organizationId,
    members: sql<number>`count(distinct ${people.userId})`.as("members"),
    activeMembers: sql<number>`count(distinct case when ${people.lastActiveMs} is not null then ${people.userId} end)`.as("active_members"),
    lastActiveMs: sql<number>`max(${people.lastActiveMs})`.as("last_active_ms"),
    companyEmailMembers: sql<number>`count(distinct case when ${people.companyDomain} is not null then ${people.userId} end)`.as("company_email_members"),
    companyDomain: sql<string | null>`min(${people.companyDomain})`.as("company_domain"),
    companyDomainCount: sql<number>`count(distinct ${people.companyDomain})`.as("company_domain_count"),
    domainSearch: sql<number>`max(case when ${people.companyDomain} like ${`%${sanitizeAdminSearchForLike(request.search)}%`} escape '|' then 1 else 0 end)`.as("domain_search"),
  }).from(people).groupBy(people.organizationId))
  // Count metadata only. Never read skill text, MCP addresses or credentials.
  const setup = db.$with("opportunity_setup").as(db.select({
    organizationId: ConfigObjectTable.organizationId,
    skills: sql<number>`sum(case when ${ConfigObjectTable.objectType} = 'skill' then 1 else 0 end)`.as("skills"),
    mcpConnections: sql<number>`sum(case when ${ConfigObjectTable.objectType} = 'mcp' then 1 else 0 end)`.as("mcp_connections"),
  }).from(ConfigObjectTable).where(and(eq(ConfigObjectTable.status, "active"), isNull(ConfigObjectTable.deletedAt)))
    .groupBy(ConfigObjectTable.organizationId))
  const skills = sql<number>`coalesce(${setup.skills}, 0)`
  const mcpConnections = sql<number>`coalesce(${setup.mcpConnections}, 0)`
  const pattern = `%${sanitizeAdminSearchForLike(request.search)}%`
  const filter = and(
    gte(teams.members, Number(input.minMembers)), isNotNull(teams.lastActiveMs),
    input.companyEmail === "1" ? gte(teams.companyEmailMembers, 1) : undefined,
    input.setup === "skills" || input.setup === "both" ? sql`${skills} > 0` : undefined,
    input.setup === "mcp" || input.setup === "both" ? sql`${mcpConnections} > 0` : undefined,
    request.search ? sql`(lower(${OrganizationTable.name}) like ${pattern} escape '|'
      or lower(${OrganizationTable.slug}) like ${pattern} escape '|' or ${teams.domainSearch} = 1)` : undefined,
  )
  const order = input.sort === "members" ? desc(teams.members) : input.sort === "active" ? desc(teams.activeMembers) : desc(teams.lastActiveMs)
  const base = () => db.with(people, teams, setup)
  const [rows, totals] = await Promise.all([
    base().select({ id: OrganizationTable.id, name: OrganizationTable.name, slug: OrganizationTable.slug,
      members: teams.members, activeMembers: teams.activeMembers, lastActiveMs: teams.lastActiveMs,
      companyEmailMembers: teams.companyEmailMembers, companyDomain: teams.companyDomain, companyDomainCount: teams.companyDomainCount,
      skills, mcpConnections,
    }).from(teams).innerJoin(OrganizationTable, eq(OrganizationTable.id, teams.organizationId))
      .leftJoin(setup, eq(setup.organizationId, teams.organizationId)).where(filter)
      .orderBy(order, desc(teams.lastActiveMs), asc(OrganizationTable.id)).limit(request.limit).offset(request.offset),
    base().select({ total: sql<number>`count(*)` }).from(teams).innerJoin(OrganizationTable, eq(OrganizationTable.id, teams.organizationId))
      .leftJoin(setup, eq(setup.organizationId, teams.organizationId)).where(filter),
  ])
  const total = Number(totals[0]?.total ?? 0)
  return {
    from: from.toISOString(), to: now.toISOString(), generatedAt: now.toISOString(),
    organizations: rows.map(({ lastActiveMs, ...row }) => ({ ...row, members: Number(row.members), activeMembers: Number(row.activeMembers),
      companyEmailMembers: Number(row.companyEmailMembers), companyDomainCount: Number(row.companyDomainCount),
      skills: Number(row.skills), mcpConnections: Number(row.mcpConnections), lastActiveAt: new Date(Number(lastActiveMs)).toISOString(),
    })),
    page: { limit: request.limit, offset: request.offset, total, returned: rows.length, hasMore: request.offset < ADMIN_MAX_PAGE_OFFSET && request.offset + rows.length < total },
  }
}

export function registerAdminOpportunitiesRoute<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  // Internal platform-admin reporting, not an organization product entitlement.
  app.get("/v1/admin/opportunities", describeRoute({
    tags: ["Admin"], summary: "Find organizations with observed app adoption",
    description: "Platform-admin-only, server-paginated organization signals. Defaults to two joined human users and observed organization-scoped telemetry in the last 30 days, most recent first. Company-email signals use verified addresses excluding known personal providers; they do not establish employment. Cloud setup counts active, non-deleted skill and MCP metadata. Missing telemetry does not imply inactivity. No content, credentials, billing lookups or external enrichment.",
    responses: { 200: jsonResponse("Organization opportunities returned.", adminOpportunitiesSchema),
      400: jsonResponse("Invalid report filters.", invalidRequestSchema),
      401: jsonResponse("Authentication required.", unauthorizedSchema), 403: jsonResponse("Platform admin access required.", forbiddenSchema) },
  }), adminRoute(), queryValidator(querySchema), async c => {
    c.header("Cache-Control", "no-store")
    return c.json(await readAdminOpportunities(c.req.valid("query")))
  })
}
