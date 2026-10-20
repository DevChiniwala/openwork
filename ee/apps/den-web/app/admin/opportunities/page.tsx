import { Suspense } from "react";
import { AdminOpportunitiesPage } from "../../../components/admin/admin-opportunities-page";

export const metadata = { title: "Opportunities | OpenWork admin" };

export default function OpportunitiesPage() {
  return <Suspense><AdminOpportunitiesPage /></Suspense>;
}
