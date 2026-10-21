import { MessageSquare } from 'lucide-react';
import type { SmsFeedItem } from '../hooks/useGateway';
import { formatTime } from '../format';
import { FeedPanel, Parties } from './FeedPanel';

interface Props {
  messages: SmsFeedItem[];
  recipientFor: (modemId: string) => string | undefined;
}

export function SmsPanel({ messages, recipientFor }: Props) {
  return (
    <FeedPanel
      title="Recent SMS Messages"
      icon={MessageSquare}
      iconClassName="bg-blue-100 text-blue-600"
      count={messages.length}
      emptyText="No messages received yet"
    >
      {messages.map((sms) => (
        <li key={sms.id} className="p-4 hover:bg-slate-50 transition-colors">
          <div className="flex justify-between items-start mb-1.5">
            <Parties
              from={sms.sender}
              to={sms.recipientNumber ?? recipientFor(sms.modemId)}
              modemId={sms.modemId}
            />
            <span className="text-xs text-slate-400 whitespace-nowrap ml-2">
              {formatTime(sms.timestamp)}
            </span>
          </div>
          <p className="text-sm text-slate-700 break-words">{sms.text}</p>
        </li>
      ))}
    </FeedPanel>
  );
}
