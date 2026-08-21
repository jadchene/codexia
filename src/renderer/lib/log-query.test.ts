import dayjs from "dayjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTodayRange, moveLogQueryToToday, todayLogFilters, withTodayRange } from "./log-query";

describe("log query day ranges", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves a followed date range to the new local day while preserving filters", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 22, 0, 0, 1));
    const previous = {
      ...todayLogFilters(),
      range: [dayjs("2026-08-21"), dayjs("2026-08-21")] as [dayjs.Dayjs, dayjs.Dayjs],
      upstreamId: "deepseek",
      status: "200"
    };

    const filters = withTodayRange(previous);
    const query = moveLogQueryToToday({
      page: 4,
      pageSize: 50,
      startAt: 1,
      endAt: 2,
      upstreamId: "deepseek",
      status: "200"
    }, 50);

    expect(filters.range[0].format("YYYY-MM-DD")).toBe("2026-08-22");
    expect(filters.upstreamId).toBe("deepseek");
    expect(filters.status).toBe("200");
    expect(query).toEqual({
      page: 1,
      pageSize: 50,
      upstreamId: "deepseek",
      status: "200",
      startAt: dayjs("2026-08-22").startOf("day").unix(),
      endAt: dayjs("2026-08-23").startOf("day").unix()
    });
  });

  it("recognizes only the current single-day range as following today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 22, 12, 0, 0));

    expect(isTodayRange([dayjs("2026-08-22"), dayjs("2026-08-22")])).toBe(true);
    expect(isTodayRange([dayjs("2026-08-21"), dayjs("2026-08-21")])).toBe(false);
    expect(isTodayRange([dayjs("2026-08-22"), dayjs("2026-08-23")])).toBe(false);
  });
});
