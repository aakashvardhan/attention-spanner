import { DailyBrainDumpGate } from '../../shared/components/DailyBrainDumpGate';
import { safeOriginalUrl } from '../../shared/dailyBrainDump';

export function DailyGatePage() {
  return <DailyBrainDumpGate originalUrl={safeOriginalUrl(location.hash)} />;
}
