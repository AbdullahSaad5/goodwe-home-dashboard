import { createContext, useContext, type ReactNode } from 'react';

export const DEFAULT_REPORTING_TIME_ZONE = 'Asia/Karachi';

const ReportingTimeZoneContext = createContext(DEFAULT_REPORTING_TIME_ZONE);

export function ReportingTimeZoneProvider({
  timeZone,
  children,
}: {
  timeZone: string;
  children: ReactNode;
}) {
  return (
    <ReportingTimeZoneContext.Provider value={timeZone}>
      {children}
    </ReportingTimeZoneContext.Provider>
  );
}

export function useReportingTimeZone(): string {
  return useContext(ReportingTimeZoneContext);
}
