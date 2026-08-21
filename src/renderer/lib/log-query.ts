import dayjs, { type Dayjs } from "dayjs";
import type { AppLogPage, LogQuery, RequestLogPage } from "../../shared/contracts/logs";

export interface LogFilterValues {
  range: [Dayjs, Dayjs];
  accountId: string;
  upstreamId: string;
  clientModel: string;
  upstreamModel: string;
  sessionId: string;
  status: string;
  keyword: string;
  level: string;
  scope: string;
}

export const todayLogFilters = (): LogFilterValues => ({
  range: [dayjs().startOf("day"), dayjs().startOf("day")],
  accountId: "",
  upstreamId: "",
  clientModel: "",
  upstreamModel: "",
  sessionId: "",
  status: "",
  keyword: "",
  level: "",
  scope: ""
});

export const withTodayRange = (filters: LogFilterValues): LogFilterValues => {
  const today = dayjs().startOf("day");
  return { ...filters, range: [today, today] };
};

export const isTodayRange = (range: [Dayjs, Dayjs]): boolean => {
  const today = dayjs().startOf("day");
  return range[0].isSame(today, "day") && range[1].isSame(today, "day");
};

export const moveLogQueryToToday = (query: LogQuery, pageSize: number): LogQuery => {
  const start = dayjs().startOf("day");
  return {
    ...query,
    page: 1,
    pageSize,
    startAt: start.unix(),
    endAt: start.add(1, "day").unix()
  };
};

export const toLogQuery = (filters: LogFilterValues, page: number, pageSize: number): LogQuery => ({
  page,
  pageSize,
  startAt: filters.range[0].startOf("day").unix(),
  endAt: filters.range[1].add(1, "day").startOf("day").unix(),
  ...(filters.accountId ? { accountId: filters.accountId } : {}),
  ...(filters.upstreamId ? { upstreamId: filters.upstreamId } : {}),
  ...(filters.clientModel ? { clientModel: filters.clientModel } : {}),
  ...(filters.upstreamModel ? { upstreamModel: filters.upstreamModel } : {}),
  ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
  ...(filters.status ? { status: filters.status } : {}),
  ...(filters.keyword ? { keyword: filters.keyword } : {}),
  ...(filters.level ? { level: filters.level } : {}),
  ...(filters.scope ? { scope: filters.scope } : {})
});

export const currentLogQuery = (
  pageData: RequestLogPage | AppLogPage,
  page = pageData.page
): LogQuery => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    ...pageData.query,
    page,
    pageSize: pageData.pageSize || 10,
    startAt: pageData.query?.startAt ?? pageData.startAt ?? Math.floor(start.getTime() / 1000),
    endAt: pageData.query?.endAt ?? pageData.endAt ?? Math.floor(end.getTime() / 1000)
  };
};
