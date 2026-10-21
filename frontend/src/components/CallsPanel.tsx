import { Phone } from 'lucide-react';
import type { CallFeedItem } from '../hooks/useGateway';
import { formatTime } from '../format';
import { FeedPanel, Parties } from './FeedPanel';

interface Props {
  calls: CallFeedItem[];
  recipientFor: (modemId: string) => string | undefined;
}

function callStatus(call: CallFeedItem): string {
  if (!call.ended) return 'Ringing…';
  const rings = call.ended.rings ?? 0;
  const ringText = rings > 0 ? ` after ${rings} ring${rings === 1 ? '' : 's'}` : '';
  return call.ended.reason === 'missed' ? `Missed call${ringText}` : `Ended (${call.ended.reason})`;
}

export function CallsPanel({ calls, recipientFor }: Props) {
  return (
    <FeedPanel
      title="Recent Incoming Calls"
      icon={Phone}
      iconClassName="bg-indigo-100 text-indigo-600"
      count={calls.length}
      emptyText="No calls received yet"
    >
      {calls.map((call) => (
        <li
          key={call.id}
          className="p-4 hover:bg-slate-50 transition-colors flex items-center justify-between"
        >
          <div className="flex items-center gap-3">
            <div className="bg-slate-100 p-2 rounded-full">
              <Phone className="w-4 h-4 text-slate-500" />
            </div>
            <div>
              <Parties
                from={call.number}
                to={call.recipientNumber ?? recipientFor(call.modemId)}
                modemId={call.modemId}
              />
              <p className="text-xs text-slate-500 mt-0.5">{callStatus(call)}</p>
            </div>
          </div>
          <span className="text-xs text-slate-400 whitespace-nowrap ml-2">
            {formatTime(call.timestamp)}
          </span>
        </li>
      ))}
    </FeedPanel>
  );
}
