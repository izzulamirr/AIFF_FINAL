import Link from "next/link";
import type { organizations } from "@easy/db";
import { createOrganization, selectOrganization } from "@/app/(app)/actions";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { IconArrowRight, IconBuilding, IconPlus } from "@/components/ui/icons";

// STEP 2 of the flow, and the first thing anybody chooses: which CLIENT.
//
//   login -> CLIENT -> dashboard (every project) -> project -> its work
//
// "Client" is the word in the UI; the data model calls the same thing an
// ORGANIZATION (the `organizations` table, `organizationId` throughout). The two
// are one concept -- a refinery whose drawings this firm checks -- and the
// vocabulary is split on purpose rather than by accident: renaming the column
// would need a migration against a live database, and the word a person reads is
// worth getting right today either way. Anywhere you see `organization` in the
// code, read "client".
//
// What choosing does depends on who is choosing:
//
//   Document Control   remembers the choice and opens the sidebar, scoped to it.
//   A checker          follows a link to that client's projects -- they have no
//                      sidebar to open.
//
// Document Control also creates clients here: an account with none has nothing
// to choose until it makes one.

type Client = typeof organizations.$inferSelect;

const cardClass = "card group flex w-full items-center gap-3.5 text-left transition hover:border-border-strong hover:shadow-md";

function ClientCard({ client }: { client: Client }) {
  return (
    <>
      <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-primary-soft text-link">
        <IconBuilding />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate font-medium">
          {client.name}
          <IconArrowRight
            size={15}
            className="flex-none text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100"
          />
        </p>
        <Badge className="mt-1 capitalize">{client.planTier}</Badge>
      </div>
    </>
  );
}

export function ClientPicker({ organizations: clients, isDcc }: { organizations: Client[]; isDcc: boolean }) {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={isDcc ? "Choose a client" : "Clients"}
        description={
          isDcc
            ? "Pick the client you are working for. Their projects, drawings and progress appear once you do."
            : "Choose a client to see their projects."
        }
      />

      {clients.length === 0 ? (
        <div className="card">
          <EmptyState icon={<IconBuilding />} title={isDcc ? "You don't have a client yet" : "You're not assigned to a client yet"}>
            {isDcc
              ? "Create one below to start adding projects."
              : "You see the clients you have been added to. Ask Document Control to add you to yours, and their projects will appear here."}
          </EmptyState>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {clients.map((client) => (
            <li key={client.id}>
              {isDcc ? (
                <form action={selectOrganization}>
                  <input type="hidden" name="organizationId" value={client.id} />
                  <button type="submit" className={cardClass}>
                    <ClientCard client={client} />
                  </button>
                </form>
              ) : (
                <Link href={`/projects?org=${client.id}`} className={cardClass}>
                  <ClientCard client={client} />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      {isDcc && (
        <form action={createOrganization} className="card flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 sm:max-w-sm">
            <label htmlFor="client-name" className="field-label">
              New client
            </label>
            <input id="client-name" name="name" placeholder="New client name" required className="input" />
          </div>
          <button className="btn btn-primary">
            <IconPlus size={16} />
            Create client
          </button>
        </form>
      )}
    </div>
  );
}
