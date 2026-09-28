import Link from "next/link";
import type { ComponentType } from "react";
import { and, eq, inArray } from "drizzle-orm";
import { documents, extractedTags } from "@easy/db";
import { getDb } from "@/lib/db";
import { isoLinesOf } from "@/lib/isoLines";
import { kindOfDocument } from "@/lib/docTypes";
import { normalizeSpecClassCode } from "@/lib/verifySpecCrossCheck";
import { PageHeader } from "@/components/ui/PageHeader";
import { Badge } from "@/components/ui/primitives";
import { IconArrowRight, IconClipboard, IconCompare, IconLibrary, IconNest } from "@/components/ui/icons";

// WHAT TO DO IN THIS PROJECT. A person who is not Document Control lands here after
// choosing a project, and picks one of the three things they can do with it:
//
//   ISO checking     each line: design basis, bill of material, P&ID, hook-up, spools, container fit
//   Pipe specs       each piping class: the client's spec against the admin item list
//   Cutting plate    the parts on the cutting drawing, nested onto stock plate
//
// Each card says what is there to open, so nobody walks into an empty page to find out.

type Icon = ComponentType<{ size?: number; className?: string }>;

interface Feature {
  href: string;
  title: string;
  text: string;
  icon: Icon;
  /** What there is to open. Null when nothing yet -- the card then says so instead. */
  facts: string[];
  emptyNote: string;
}

function FeatureCard({ feature }: { feature: Feature }) {
  const Icon = feature.icon;
  const ready = feature.facts.length > 0;
  return (
    <Link
      href={feature.href}
      className="card group flex h-full flex-col gap-4 transition hover:border-border-strong hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-primary-soft text-link">
        <Icon size={22} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-1.5 text-base font-semibold">
          {feature.title}
          <IconArrowRight
            size={15}
            className="flex-none text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100"
          />
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{feature.text}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
        {ready ? feature.facts.map((f) => <Badge key={f}>{f}</Badge>) : <span className="text-xs text-muted-foreground">{feature.emptyNote}</span>}
      </div>
    </Link>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function ProjectHub({ projectId, projectName, libraryHref }: { projectId: string; projectName: string; libraryHref: string }) {
  const db = getDb();
  const docs = await db.select().from(documents).where(eq(documents.projectId, projectId));

  const lines = await isoLinesOf(projectId);

  const specDocs = docs.filter((d) => d.docType === "spec_sheet");
  const clientDocs = specDocs.filter((d) => kindOfDocument(d.docType, d.fileName)?.key === "client_spec");
  const adminDocs = specDocs.filter((d) => kindOfDocument(d.docType, d.fileName)?.key === "admin_spec");
  const classTags = clientDocs.length
    ? await db
        .select({ tagNumber: extractedTags.tagNumber })
        .from(extractedTags)
        .where(and(inArray(extractedTags.documentId, clientDocs.map((d) => d.id)), eq(extractedTags.tagType, "spec_class")))
    : [];
  const classes = new Set(classTags.map((t) => normalizeSpecClassCode(t.tagNumber))).size;

  const cutting = docs.filter((d) => d.docType === "cutting").length;

  const features: Feature[] = [
    {
      href: `/projects/${projectId}?feature=iso`,
      title: "ISO checking",
      text: "Check each line number: design basis, bill of material, P&ID, instrument hook-up, spools and container fit.",
      icon: IconClipboard,
      facts: lines.length > 0 ? [plural(lines.length, "line")] : [],
      emptyNote: "No isometrics have been uploaded yet.",
    },
    {
      href: `/projects/${projectId}/specs`,
      title: "Pipe specs",
      text: "Compare the client's piping classes with the admin item list, size by size, with every difference marked.",
      icon: IconCompare,
      facts: classes > 0 ? [plural(classes, "class", "classes"), plural(adminDocs.length, "admin list")] : [],
      emptyNote: "No client spec has been read yet.",
    },
    {
      href: `/cutting?project=${projectId}`,
      title: "Cutting plate",
      text: "See the parts read off the cutting drawing and how they nest onto stock plate.",
      icon: IconNest,
      facts: cutting > 0 ? [plural(cutting, "cutting drawing")] : [],
      emptyNote: "No cutting drawing has been uploaded yet.",
    },
  ];

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={projectName}
        back={{ href: "/clients", label: "Clients" }}
        description="Choose what you want to check in this project."
        actions={
          <Link href={libraryHref} className="btn btn-secondary">
            <IconLibrary size={16} />
            Library
          </Link>
        }
      />
      <div className="grid gap-4 md:grid-cols-3">
        {features.map((f) => (
          <FeatureCard key={f.href} feature={f} />
        ))}
      </div>
    </div>
  );
}
