import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface Props {
  title: string;
  icon: LucideIcon;
  iconClassName: string;
  count: number;
  emptyText: string;
  children: ReactNode;
}

export function FeedPanel({ title, icon: Icon, iconClassName, count, emptyText, children }: Props) {
  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3 bg-slate-50/50">
        <div className={`p-1.5 rounded-md ${iconClassName}`}>
          <Icon className="w-4 h-4" />
        </div>
        <h2 className="font-semibold text-slate-800 text-sm">{title}</h2>
        <span className="ml-auto bg-slate-100 text-slate-600 text-xs py-1 px-2.5 rounded-full font-medium">
          {count}
        </span>
      </div>
      <div className="p-0 overflow-y-auto max-h-[380px]">
        {count === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-slate-400">
            <Icon className="w-8 h-8 mb-2 opacity-20" />
            <p className="text-sm">{emptyText}</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">{children}</ul>
        )}
      </div>
    </section>
  );
}

interface PartiesProps {
  from: string;
  to: string | undefined;
  modemId: string;
}

/** "From → To [modem]" line shared by the SMS and call feeds. */
export function Parties({ from, to, modemId }: PartiesProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <span className="text-xs text-slate-400 font-medium">From:</span>
        <span className="font-bold text-sm text-slate-900">{from}</span>
      </div>
      {to && (
        <>
          <span className="text-slate-300 text-xs">→</span>
          <div className="flex items-center gap-1">
            <span className="text-xs text-slate-400 font-medium">To:</span>
            <span className="font-mono text-xs font-semibold px-2 py-0.5 bg-blue-50 text-blue-700 rounded border border-blue-200">
              {to}
            </span>
          </div>
        </>
      )}
      <span className="px-1.5 py-0.5 text-[10px] font-mono font-medium bg-slate-100 text-slate-600 rounded border border-slate-200">
        {modemId}
      </span>
    </div>
  );
}
