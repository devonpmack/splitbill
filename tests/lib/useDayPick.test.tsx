import { act, renderHook } from "@testing-library/react-native";
import { freezeNow } from "../helpers/testUtils";
import { startOfLocalDayISO } from "@/lib/dates";
import { useDayPick } from "@/lib/useDayPick";

const TODAY = new Date(2026, 10, 9, 15, 0);
const STORED = new Date(2026, 10, 5, 18, 30).toISOString();

beforeEach(() => freezeNow(TODAY));
afterEach(() => jest.useRealTimers());

describe("useDayPick on an edit screen", () => {
  it("shows the stored date and sends nothing while untouched", async () => {
    const { result } = await renderHook(() => useDayPick(STORED));

    expect(result.current.value).toEqual(new Date(STORED));
    expect(result.current.dateParam).toBeUndefined();
    expect(result.current.isInvalid).toBe(false);
  });

  it("sends nothing when the stored day is picked again", async () => {
    const { result } = await renderHook(() => useDayPick(STORED));

    await act(() => result.current.onChange(new Date(2026, 10, 5)));

    expect(result.current.dateParam).toBeUndefined();
  });

  it("sends today's midnight when a past row is moved to today", async () => {
    const { result } = await renderHook(() => useDayPick(STORED));

    await act(() => result.current.onChange(new Date(2026, 10, 9)));

    expect(result.current.dateParam).toBe(
      startOfLocalDayISO(new Date(2026, 10, 9))
    );
  });
});

describe("useDayPick on a create screen", () => {
  it("sends nothing for today and midnight for another day", async () => {
    const { result } = await renderHook(() => useDayPick());

    await act(() => result.current.onChange(new Date(2026, 10, 9)));
    expect(result.current.dateParam).toBeUndefined();

    await act(() => result.current.onChange(new Date(2026, 10, 12)));
    expect(result.current.dateParam).toBe(
      startOfLocalDayISO(new Date(2026, 10, 12))
    );
  });

  it("is invalid while the field reports no day", async () => {
    const { result } = await renderHook(() => useDayPick());

    await act(() => result.current.onChange(null));

    expect(result.current.isInvalid).toBe(true);
  });
});
