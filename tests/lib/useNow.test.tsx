import { AppState } from "react-native";
import { act, renderHook } from "@testing-library/react-native";
import { useNow } from "@/lib/useNow";
import { isUpcoming } from "@/lib/dates";

const START = new Date("2026-11-09T12:00:00.000Z");
const inMs = (ms: number) => new Date(START.getTime() + ms).toISOString();
const MAX_TIMEOUT = 2 ** 31 - 1;
// The timer fires this long after a date so a refetch at the date sees the row.
const SLACK = 2_000;

let appStateHandler: ((state: string) => void) | undefined;
const mockRemove = jest.fn();
let setTimeoutSpy: jest.SpyInstance;
let clearTimeoutSpy: jest.SpyInstance;

// React and the test renderer schedule short timers of their own; the hook's
// are the ones at least a second out.
function hookDelays(): number[] {
  return setTimeoutSpy.mock.calls
    .map((call) => call[1] as number)
    .filter((delay) => delay >= 1000);
}

beforeEach(() => {
  jest.useFakeTimers({ now: START });
  setTimeoutSpy = jest.spyOn(global, "setTimeout");
  clearTimeoutSpy = jest.spyOn(global, "clearTimeout");
  appStateHandler = undefined;
  mockRemove.mockClear();
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation(((_type: string, handler: (state: string) => void) => {
      appStateHandler = handler;
      return { remove: mockRemove };
    }) as never);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("useNow", () => {
  it("returns the current time", async () => {
    const { result } = await renderHook(() => useNow([]));

    expect(result.current.getTime()).toBe(START.getTime());
  });

  it("schedules nothing when no date is upcoming", async () => {
    await renderHook(() => useNow([inMs(-1000), START.toISOString()]));

    expect(hookDelays()).toEqual([]);
  });

  it("advances now and calls onElapsed when the soonest upcoming date arrives", async () => {
    const onElapsed = jest.fn();
    const { result } = await renderHook(() =>
      useNow([inMs(60_000), inMs(10_000)], onElapsed)
    );
    // One timer moves the display at the date, one refetches 2 s later.
    expect(hookDelays()).toEqual([10_000, 10_000 + SLACK]);

    await act(async () => {
      jest.advanceTimersByTime(10_000 + SLACK - 1);
    });
    // The display has moved to the date; the refetch waits out the slack.
    expect(onElapsed).not.toHaveBeenCalled();
    expect(isUpcoming(inMs(10_000), result.current)).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(result.current.getTime()).toBe(START.getTime() + 10_000 + SLACK);
  });

  it("moves on to the next upcoming date after the first elapses", async () => {
    const onElapsed = jest.fn();
    const { result } = await renderHook(() =>
      useNow([inMs(10_000), inMs(60_000)], onElapsed)
    );

    await act(async () => {
      jest.advanceTimersByTime(10_000 + SLACK);
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(50_000);
    });
    expect(onElapsed).toHaveBeenCalledTimes(2);
    expect(result.current.getTime()).toBe(START.getTime() + 60_000 + SLACK);

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(onElapsed).toHaveBeenCalledTimes(2);
  });

  it("reschedules for the remainder when the timer fires before the date", async () => {
    const onElapsed = jest.fn();
    await renderHook(() => useNow([inMs(10_000)], onElapsed));

    // The wall clock is 5 s behind the timer, as after a clock adjustment.
    jest.setSystemTime(START.getTime() - 5_000);
    await act(async () => {
      jest.advanceTimersByTime(10_000 + SLACK);
    });
    expect(onElapsed).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it("splits a delay longer than setTimeout allows and only elapses at the date", async () => {
    const onElapsed = jest.fn();
    const { result } = await renderHook(() =>
      useNow([inMs(MAX_TIMEOUT + 5_000 - SLACK)], onElapsed)
    );
    expect(hookDelays()).toEqual([MAX_TIMEOUT, MAX_TIMEOUT]);

    await act(async () => {
      jest.advanceTimersByTime(MAX_TIMEOUT);
    });
    expect(onElapsed).not.toHaveBeenCalled();
    expect(result.current.getTime()).toBe(START.getTime() + MAX_TIMEOUT);

    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it("clears its timer and AppState listener on unmount", async () => {
    const onElapsed = jest.fn();
    const { unmount } = await renderHook(() =>
      useNow([inMs(10_000)], onElapsed)
    );
    const index = setTimeoutSpy.mock.calls.findIndex(
      (c) => c[1] === 10_000 + SLACK
    );
    const timerId = setTimeoutSpy.mock.results[index].value;

    await unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
    expect(mockRemove).toHaveBeenCalled();
    jest.advanceTimersByTime(20_000 + SLACK);
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it("re-evaluates now when the app returns to the foreground", async () => {
    const { result } = await renderHook(() => useNow([]));

    jest.setSystemTime(START.getTime() + 3_600_000);
    await act(async () => {
      appStateHandler?.("active");
    });

    expect(result.current.getTime()).toBe(START.getTime() + 3_600_000);
  });

  it("ignores AppState changes other than active", async () => {
    const { result } = await renderHook(() => useNow([]));

    jest.setSystemTime(START.getTime() + 3_600_000);
    await act(async () => {
      appStateHandler?.("background");
    });

    expect(result.current.getTime()).toBe(START.getTime());
  });

  it("picks up a changed date list", async () => {
    const onElapsed = jest.fn();
    let dates: string[] = [];
    const { rerender } = await renderHook(() => useNow(dates, onElapsed));
    expect(hookDelays()).toEqual([]);

    dates = [inMs(5_000)];
    await rerender({});
    expect(hookDelays()).toEqual([5_000, 5_000 + SLACK]);

    await act(async () => {
      jest.advanceTimersByTime(5_000 + SLACK);
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it("waits 2 s past the date, so a refetch at the date sees the row", async () => {
    const onElapsed = jest.fn();
    await renderHook(() => useNow([inMs(10_000)], onElapsed));

    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    expect(onElapsed).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(SLACK);
    });
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it("classes a row created after minutes on screen as already counting: no timer, no refetch", async () => {
    const onElapsed = jest.fn();
    let dates: string[] = [];
    const seen: boolean[] = [];
    let created = "";
    const { rerender } = await renderHook(() => {
      const now = useNow(dates, onElapsed);
      if (created) seen.push(isUpcoming(created, now));
      return now;
    });

    // Ten minutes later the user adds an expense; the server stamps its now().
    jest.setSystemTime(START.getTime() + 10 * 60_000);
    created = new Date(Date.now() - 1_000).toISOString();
    dates = [created];
    await rerender({});
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((upcoming) => !upcoming)).toBe(true);
    expect(hookDelays()).toEqual([]);
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it("returns a fresh time on every render, not the time of the last tick", async () => {
    const { result, rerender } = await renderHook(() => useNow([]));

    jest.setSystemTime(START.getTime() + 600_000);
    await rerender({});

    expect(result.current.getTime()).toBe(START.getTime() + 600_000);
  });

  describe("inside the 2 s slack after a date", () => {
    it("still refetches, once, when an unrelated re-render happens just after the date", async () => {
      const onElapsed = jest.fn();
      const { rerender } = await renderHook(() =>
        useNow([inMs(10_000)], onElapsed)
      );

      await act(async () => {
        jest.advanceTimersByTime(10_500);
      });
      await rerender({});
      expect(onElapsed).not.toHaveBeenCalled();

      await act(async () => {
        jest.advanceTimersByTime(SLACK);
      });
      expect(onElapsed).toHaveBeenCalledTimes(1);
    });

    it("still refetches when the app returns to the foreground inside the slack", async () => {
      const onElapsed = jest.fn();
      await renderHook(() => useNow([inMs(10_000)], onElapsed));

      jest.setSystemTime(START.getTime() + 10_500);
      await act(async () => {
        appStateHandler?.("active");
      });
      await act(async () => {
        jest.advanceTimersByTime(SLACK);
      });

      expect(onElapsed).toHaveBeenCalledTimes(1);
    });

    it("refetches at the first opportunity when the app was suspended past the date and slack", async () => {
      const onElapsed = jest.fn();
      await renderHook(() => useNow([inMs(10_000)], onElapsed));

      jest.setSystemTime(START.getTime() + 15_000);
      await act(async () => {
        appStateHandler?.("active");
      });
      await act(async () => {
        jest.advanceTimersByTime(0);
      });

      expect(onElapsed).toHaveBeenCalledTimes(1);
    });

    it("fires exactly once per elapsed date, whatever re-renders or foreground events follow", async () => {
      const onElapsed = jest.fn();
      const { rerender } = await renderHook(() =>
        useNow([inMs(10_000)], onElapsed)
      );

      await act(async () => {
        jest.advanceTimersByTime(10_500);
      });
      await rerender({});
      await act(async () => {
        appStateHandler?.("active");
      });
      await act(async () => {
        jest.advanceTimersByTime(SLACK);
      });
      await rerender({});
      await act(async () => {
        appStateHandler?.("active");
        jest.advanceTimersByTime(60_000);
      });

      expect(onElapsed).toHaveBeenCalledTimes(1);
    });

    it("does not refetch for a date that was already past when it first appeared", async () => {
      const onElapsed = jest.fn();
      let dates: string[] = [];
      const { rerender } = await renderHook(() => useNow(dates, onElapsed));

      jest.setSystemTime(START.getTime() + 60_000);
      dates = [inMs(59_000)];
      await rerender({});
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });

      expect(onElapsed).not.toHaveBeenCalled();
    });

    it("does not refetch for a row that was cancelled before its date", async () => {
      const onElapsed = jest.fn();
      let dates = [inMs(10_000)];
      const { rerender } = await renderHook(() => useNow(dates, onElapsed));

      dates = [];
      await rerender({});
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });

      expect(onElapsed).not.toHaveBeenCalled();
    });
  });

  it("moves the display to the date itself, before the refetch fires", async () => {
    const onElapsed = jest.fn();
    const seen: number[] = [];
    await renderHook(() => {
      const now = useNow([inMs(10_000)], onElapsed);
      seen.push(now.getTime());
      return now;
    });

    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });

    expect(seen[seen.length - 1]).toBe(START.getTime() + 10_000);
    expect(isUpcoming(inMs(10_000), new Date(seen[seen.length - 1]))).toBe(false);
    expect(onElapsed).not.toHaveBeenCalled();
  });
});
