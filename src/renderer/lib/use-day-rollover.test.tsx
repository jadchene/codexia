import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { millisecondsUntilNextDay, useDayRollover } from "./use-day-rollover";

afterEach(() => {
  vi.useRealTimers();
});

it("runs at the next local midnight and schedules the following day", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 21, 23, 59, 59, 900));
  const onRollover = vi.fn();
  renderHook(() => useDayRollover(onRollover));

  act(() => vi.advanceTimersByTime(millisecondsUntilNextDay()));
  expect(onRollover).toHaveBeenCalledOnce();

  act(() => vi.advanceTimersByTime(millisecondsUntilNextDay()));
  expect(onRollover).toHaveBeenCalledTimes(2);
});
