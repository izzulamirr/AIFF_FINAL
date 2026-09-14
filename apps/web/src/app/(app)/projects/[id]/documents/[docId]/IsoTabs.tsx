"use client";

import { useState, type ReactNode } from "react";

export interface IsoTab {
  id: string;
  label: string;
  content: ReactNode;
}

// Content for every tab is already server-rendered (it's cheap -- these are
// small comparison tables, not re-fetched per click) -- this component only
// owns which one is visible, toggled with `hidden` rather than unmounting so
// switching tabs never re-runs data fetching or loses scroll position.
export function IsoTabs({ tabs }: { tabs: IsoTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id);

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
              active === tab.id ? "border-blue-600 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} hidden={active !== tab.id}>
          {tab.content}
        </div>
      ))}
    </div>
  );
}
