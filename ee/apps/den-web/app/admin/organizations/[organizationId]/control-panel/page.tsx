import { AdminOrganizationPage } from "../../../../../components/admin/admin-organization-page";

export const metadata = { title: "Organization control panel | OpenWork admin" };

export default async function OrganizationControlPanelPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  return <AdminOrganizationPage key={organizationId} organizationId={organizationId} section="control-panel" />;
}
