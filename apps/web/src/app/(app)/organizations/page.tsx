import { permanentRedirect } from "next/navigation";

// `/organizations` is what this page used to be called. The word in the UI is
// now CLIENT, so the route is `/clients` -- but links, bookmarks and anything
// somebody pasted into an email still point here, and a 404 is a poor reward for
// having used the app before the rename.
//
// `permanentRedirect` (308) rather than a temporary one: the old path is not
// coming back, and a permanent redirect lets a browser stop asking.
export default function OrganizationsRedirect() {
  permanentRedirect("/clients");
}
