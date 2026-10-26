import type { Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../../env.js"
import { publicRoute } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"
import { getDesktopReleaseMetadata } from "../../desktop-releases.js"

const appVersionResponseSchema = z.object({
  minAppVersion: z.string(),
  latestAppVersion: z.string().min(1),
  publishedDesktopVersions: z.array(z.string().min(1)),
  maxDesktopVersion: z.string().min(1).nullable(),
  webUrl: z.string().min(1).optional(),
}).meta({ ref: "DenAppVersionResponse" })

export function registerVersionRoutes<T extends Env>(app: Hono<T>) {
  app.get(
    "/v1/app-version",
    describeRoute({
      tags: ["System"],
      security: [],
      summary: "Get desktop app version metadata",
      description:
        "Returns the supported desktop app range, stable published desktop releases, and this deployment's web app URL. Stable self-hosted deployments cap the range at their own release; hosted Cloud keeps its published release range. Organization allowlists may further restrict updates.",
      responses: {
        200: jsonResponse("Desktop app version metadata returned successfully.", appVersionResponseSchema),
      },
    }),
    publicRoute,
    async (c) => {
      c.header("Cache-Control", "public, max-age=300, stale-if-error=86400")
      // `webUrl` mirrors the install-config contract (`buildInstallConfig`) so a desktop
      // client configured with only the API URL can discover where the web app lives.
      return c.json({ ...(await getDesktopReleaseMetadata()), webUrl: env.webUrl })
    },
  )
}
