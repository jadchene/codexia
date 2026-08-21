import { useEffect, useRef } from "react";

const ROLLOVER_GRACE_MS = 50;

export const millisecondsUntilNextDay = (now = new Date()): number => {
  const nextDay = new Date(now);
  nextDay.setHours(24, 0, 0, 0);
  return Math.max(0, nextDay.getTime() - now.getTime()) + ROLLOVER_GRACE_MS;
};

export const useDayRollover = (onRollover: () => void): void => {
  const callbackRef = useRef(onRollover);
  callbackRef.current = onRollover;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (): void => {
      timer = setTimeout(() => {
        callbackRef.current();
        schedule();
      }, millisecondsUntilNextDay());
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
};
