import { IconDownload, IconFile, IconLibrary } from "@/components/ui/icons";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { CATEGORY_LABEL, formatBytes, isLibraryCategory, type LibraryItem } from "@/lib/library";
import { deleteLibraryItem } from "./actions";
import { DeleteLibraryButton } from "./DeleteLibraryButton";

const day = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" });

// One library's files. The delete button is Document Control's; everyone who can
// see the list can download.
export function LibraryTable({ items, canEdit, emptyText }: { items: LibraryItem[]; canEdit: boolean; emptyText: string }) {
  if (items.length === 0) {
    return (
      <EmptyState icon={<IconLibrary />} title="Nothing here yet">
        {emptyText}
      </EmptyState>
    );
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Kind</th>
            <th>File</th>
            <th>Added</th>
            <th className="w-px"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <p className="font-medium">{item.title}</p>
                {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
              </td>
              <td>
                <Badge>{isLibraryCategory(item.category) ? CATEGORY_LABEL[item.category] : item.category}</Badge>
              </td>
              <td>
                <span className="flex items-center gap-2">
                  <IconFile size={15} className="flex-none text-muted-foreground" />
                  <span className="break-all">{item.fileName}</span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">{formatBytes(item.sizeBytes)}</span>
                </span>
              </td>
              <td className="whitespace-nowrap text-muted-foreground">
                {day.format(item.createdAt)}
                {item.uploadedByName && <span className="block text-xs">{item.uploadedByName}</span>}
              </td>
              <td className="whitespace-nowrap text-right">
                <span className="inline-flex items-center gap-2">
                  <a href={`/library/file/${item.id}`} className="btn btn-secondary btn-xs" aria-label={`Download ${item.title}`}>
                    <IconDownload size={13} />
                    Download
                  </a>
                  {canEdit && (
                    <DeleteLibraryButton
                      title={item.title}
                      onDelete={async () => {
                        "use server";
                        await deleteLibraryItem(item.id);
                      }}
                    />
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
