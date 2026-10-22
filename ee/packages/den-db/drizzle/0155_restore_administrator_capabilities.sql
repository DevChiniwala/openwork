-- Recover evidenced former super-admins, not every admin. 0138 retained accepted
-- invitations and claimed workspace claims; role changes also survive in legacy
-- audit_event.payload and operation audit_event.envelope. These are incomplete
-- historical evidence, NOT an authoritative snapshot of the pre-0138 roster.
-- Only active direct admins qualify. A later recorded role change/removal or
-- ownership transfer vetoes older evidence. Never match an invitation by email
-- alone (a removed/reinvited person may now have a different membership).
--
-- Store the recovery in an ordinary, visible team + permission set, without
-- reintroducing a role or changing new-organization/default Admin permissions.
-- Stable valid TypeIDs make retries no-ops. Memberships come first deliberately:
-- these tables have no foreign keys, and permissions are not active until the
-- final link exists. The permission set then fences the cohort against replays
-- after an owner has removed people or revoked the recovery.
INSERT INTO `team_member` (`id`, `team_id`, `org_membership_id`, `user_id`)
SELECT DISTINCT
  CONCAT('tmb_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', m.`id`), 256), 25)),
  CONCAT('tem_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', m.`organization_id`), 256), 25)),
  m.`id`, m.`user_id`
FROM `member` m
JOIN (
  SELECT im.`id` AS member_id, im.`organization_id`, im.`joined_at` AS proven_at
  FROM `invitation` i
  JOIN `member` im ON im.`invite_id` = i.`id` AND im.`organization_id` = i.`organization_id`
  JOIN `user` u ON u.`id` = im.`user_id` AND LOWER(u.`email`) = LOWER(i.`email`)
  WHERE i.`status` = 'accepted'
    AND FIND_IN_SET(CAST('super-admin' AS BINARY), CAST(REPLACE(i.`role`, ' ', '') AS BINARY)) > 0
  UNION ALL
  SELECT cm.`id`, cm.`organization_id`, c.`claimed_at`
  FROM `workspace_claim` c
  JOIN `member` cm ON cm.`organization_id` = c.`organization_id` AND cm.`user_id` = c.`claimed_by_user_id`
    AND cm.`created_at` <= c.`claimed_at` AND cm.`joined_at` <= c.`claimed_at`
  WHERE c.`status` = 'claimed'
    AND FIND_IN_SET(CAST('super-admin' AS BINARY), CAST(REPLACE(c.`role`, ' ', '') AS BINARY)) > 0
  UNION ALL
  SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(a.`envelope`, '$.changes.after.id')),
                  JSON_UNQUOTE(JSON_EXTRACT(a.`payload`, '$.targetOrgMembershipId'))),
         a.`org_id`, a.`created_at`
  FROM `audit_event` a
  WHERE a.`action` IN ('member.role_updated', 'organization.member.role_updated')
    AND FIND_IN_SET(CAST('super-admin' AS BINARY), CAST(REPLACE(COALESCE(
      JSON_UNQUOTE(JSON_EXTRACT(a.`envelope`, '$.changes.after.role')),
      JSON_UNQUOTE(JSON_EXTRACT(a.`payload`, '$.nextRole'))), ' ', '') AS BINARY)) > 0
) evidence ON evidence.member_id = m.`id` AND evidence.organization_id = m.`organization_id`
WHERE m.`removed_at` IS NULL AND m.`user_id` IS NOT NULL AND m.`is_setup_agent` = 0
  AND CAST(REPLACE(m.`role`, ' ', '') AS BINARY) = CAST('admin' AS BINARY)
  AND evidence.proven_at >= m.`created_at`
  AND NOT EXISTS (
    SELECT 1 FROM `audit_event` later
    WHERE later.`org_id` = m.`organization_id` AND later.`created_at` >= evidence.proven_at
      AND (
        (later.`action` IN ('member.role_updated', 'organization.member.role_updated', 'member.removed', 'organization.member.removed')
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(later.`envelope`, '$.changes.after.id')),
                       JSON_UNQUOTE(JSON_EXTRACT(later.`envelope`, '$.changes.before.id')),
                       JSON_UNQUOTE(JSON_EXTRACT(later.`payload`, '$.targetOrgMembershipId'))) = m.`id`
          AND (later.`action` IN ('member.removed', 'organization.member.removed') OR
            COALESCE(FIND_IN_SET(CAST('super-admin' AS BINARY), CAST(REPLACE(COALESCE(
              JSON_UNQUOTE(JSON_EXTRACT(later.`envelope`, '$.changes.after.role')),
              JSON_UNQUOTE(JSON_EXTRACT(later.`payload`, '$.nextRole'))), ' ', '') AS BINARY)), 0) = 0))
        OR (later.`action` IN ('member.ownership_transferred', 'organization.member.ownership_transferred')
          AND (JSON_UNQUOTE(JSON_EXTRACT(later.`payload`, '$.previousOwnerOrgMembershipId')) = m.`id`
            OR JSON_UNQUOTE(JSON_EXTRACT(later.`payload`, '$.newOwnerOrgMembershipId')) = m.`id`
            OR EXISTS (SELECT 1 FROM `audit_event_resource` r WHERE r.`event_id` = later.`id`
              AND r.`organization_id` = m.`organization_id` AND r.`resource_type` = 'member' AND r.`resource_id` = m.`id`)))
      )
  )
  AND NOT EXISTS (SELECT 1 FROM `permission_set` fence
    WHERE fence.`id` = CONCAT('pms_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', m.`organization_id`), 256), 25)))
  AND NOT EXISTS (SELECT 1 FROM `team_member` existing
    WHERE existing.`id` = CONCAT('tmb_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', m.`id`), 256), 25)));
--> statement-breakpoint
INSERT INTO `team` (`id`, `organization_id`, `name`, `member_count`, `grants_organization_admin`)
SELECT tm.`team_id`, m.`organization_id`, CONCAT('Restored administrators (', LEFT(SHA2(CONCAT('admin-recovery-0155:', m.`organization_id`), 256), 8), ')'), COUNT(*), 0
FROM `team_member` tm JOIN `member` m ON m.`id` = tm.`org_membership_id`
WHERE tm.`id` = CONCAT('tmb_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', m.`id`), 256), 25))
  AND NOT EXISTS (SELECT 1 FROM `team` existing WHERE existing.`id` = tm.`team_id`)
  AND NOT EXISTS (SELECT 1 FROM `permission_set` fence
    WHERE fence.`id` = CONCAT('pms_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', m.`organization_id`), 256), 25)))
GROUP BY tm.`team_id`, m.`organization_id`;
--> statement-breakpoint
INSERT INTO `permission_set` (`id`, `organization_id`, `default_key`, `name`)
SELECT CONCAT('pms_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', t.`organization_id`), 256), 25)),
  t.`organization_id`, NULL, 'Restored administrator permissions'
FROM `team` t
WHERE t.`id` = CONCAT('tem_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', t.`organization_id`), 256), 25))
  AND NOT EXISTS (SELECT 1 FROM `permission_set` existing
    WHERE existing.`id` = CONCAT('pms_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', t.`organization_id`), 256), 25)));
--> statement-breakpoint
-- Restore the pre-existing super-admin capabilities, including permission
-- administration (the replacement for custom-role administration), not newer
-- owner-only capabilities (deployments and agent permissions).
-- Explicit user decisions in the Admin set are preserved, including denials.
INSERT INTO `permission_set_permission` (`id`, `organization_id`, `permission_set_id`, `permission_key`, `status`, `source`)
SELECT CONCAT('psp_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', ps.`id`, ':', k.permission_key), 256), 25)),
  ps.`organization_id`, ps.`id`, k.permission_key,
  IF(EXISTS (SELECT 1 FROM `permission_set` defaults
    JOIN `permission_set_permission` decision ON decision.`permission_set_id` = defaults.`id`
    WHERE defaults.`organization_id` = ps.`organization_id` AND defaults.`default_key` = 'admin'
      AND decision.`permission_key` = k.permission_key AND decision.`source` = 'user'), 'deny', 'allow'),
  'migration'
FROM `permission_set` ps
CROSS JOIN (
  SELECT 'organization.update' AS permission_key UNION ALL SELECT 'branding.update'
  UNION ALL SELECT 'web_origins.manage' UNION ALL SELECT 'members.update'
  UNION ALL SELECT 'teams.manage_admin' UNION ALL SELECT 'sso.manage'
  UNION ALL SELECT 'scim.manage' UNION ALL SELECT 'api_keys.manage'
  UNION ALL SELECT 'desktop_policies.manage' UNION ALL SELECT 'egress_diagnostics.manage'
  UNION ALL SELECT 'billing_portal.use' UNION ALL SELECT 'connections.update'
  UNION ALL SELECT 'connections.delete' UNION ALL SELECT 'permissions.manage'
) k
WHERE ps.`id` = CONCAT('pms_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', ps.`organization_id`), 256), 25))
  AND NOT EXISTS (SELECT 1 FROM `permission_set_permission` existing
    WHERE existing.`permission_set_id` = ps.`id` AND existing.`permission_key` = k.permission_key);
--> statement-breakpoint
INSERT INTO `permission_set_team` (`id`, `organization_id`, `permission_set_id`, `team_id`)
SELECT CONCAT('pst_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', ps.`organization_id`), 256), 25)),
  ps.`organization_id`, ps.`id`, t.`id`
FROM `permission_set` ps JOIN `team` t ON t.`organization_id` = ps.`organization_id`
  AND t.`id` = CONCAT('tem_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', ps.`organization_id`), 256), 25))
WHERE ps.`id` = CONCAT('pms_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', ps.`organization_id`), 256), 25))
  AND NOT EXISTS (SELECT 1 FROM `permission_set_team` existing
    WHERE existing.`id` = CONCAT('pst_0', LEFT(SHA2(CONCAT('admin-recovery-0155:', ps.`organization_id`), 256), 25)));
