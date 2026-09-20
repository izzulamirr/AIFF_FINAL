import Link from "next/link";
import type { organizations } from "@easy/db";
import { createOrganization, selectOrganization } from "@/app/(app)/actions";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { IconArrowRight, IconBuilding, IconPlus } from "@/components/ui/icons";

// Step one for everyone: which organization. What choosing does depends on who
// is choosing.
//
//   Document Control   remembers the choice and opens the sidebar, scoped to it.
//   A plain user       follows a link to that organization's projects -- they have
//                      no sidebar to open.
//
// Document Control also creates organizations here: an account with none has
// nothing to choose until it makes one.

type Organization = typeof organizations.$inferSelect;

const cardClass = "card group flex w-full items-center gap-3.5 text-left transition hover:border-border-strong hover:shadow-md";

function OrganizationCard({ organization }: { organization: Organization }) {
  return (
    <>
      <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-primary-soft text-link">
        <IconBuilding />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate font-medium">
          {organization.name}
          <IconArrowRight
            size={15}
            className="flex-none text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100"
          />
        </p>
        <Badge className="mt-1 capitalize">{organization.planTier}</Badge>
      </div>
    </>
  );
}

export function OrganizationPicker({ organizations: orgs, isDcc }: { organizations: Organization[]; isDcc: boolean }) {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={isDcc ? "Choose an organization" : "Organizations"}
        description={
          isDcc
            ? "Pick the organization you are working in. Its projects, drawings and tools appear once you do."
            : "Choose an organization to see its projects."
        }
      />

      {orgs.length === 0 ? (
        <div className="card">
          <EmptyState icon={<IconBuilding />} title={isDcc ? "You don't belong to an organization yet" : "No organizations yet"}>
            {isDcc ? "Create one below to start adding projects." : "Document Control sets these up. They will appear here once there are some."}
          </EmptyState>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {orgs.map((organization) => (
            <li key={organization.id}>
              {isDcc ? (
                <form action={selectOrganization}>
                  <input type="hidden" name="organizationId" value={organization.id} />
                  <button type="submit" className={cardClass}>
                    <OrganizationCard organization={organization} />
                  </button>
                </form>
              ) : (
                <Link href={`/projects?org=${organization.id}`} className={cardClass}>
                  <OrganizationCard organization={organization} />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      {isDcc && (
        <form action={createOrganization} className="card flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 sm:max-w-sm">
            <label htmlFor="org-name" className="field-label">
              New organization
            </label>
            <input id="org-name" name="name" placeholder="New organization name" required className="input" />
          </div>
          <button className="btn btn-primary">
            <IconPlus size={16} />
            Create organization
          </button>
        </form>
      )}
    </div>
  );
}
