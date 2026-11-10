import { useState } from "react";
import { fireEvent, screen } from "@testing-library/react-native";
import { freezeNow, renderWithPaper, typeDate } from "../helpers/testUtils";
import { DateField } from "@/components/DateField";

const NOW = new Date(2026, 10, 9, 15, 0);

beforeEach(() => freezeNow(NOW));
afterEach(() => jest.useRealTimers());

describe("DateField", () => {
  it("shows its label and the chosen date", async () => {
    await renderWithPaper(
      <DateField label="Date" value={new Date(2026, 10, 2)} onChange={jest.fn()} />
    );

    expect(screen.getAllByText("Date (MM/DD/YYYY)").length).toBeGreaterThan(0);
    expect(screen.getByTestId("date-field")).toHaveProp("value", "11/02/2026");
  });

  it("defaults to today when no date is given", async () => {
    await renderWithPaper(<DateField onChange={jest.fn()} />);

    expect(screen.getByTestId("date-field")).toHaveProp("value", "11/09/2026");
  });

  it("explains when a future day starts counting", async () => {
    await renderWithPaper(
      <DateField value={new Date(2026, 10, 12)} onChange={jest.fn()} />
    );

    expect(
      screen.getByText("Counts toward balances from Nov 12, 2026.")
    ).toBeTruthy();
  });

  it("shows nothing extra for today or a past day", async () => {
    const view = await renderWithPaper(
      <DateField value={new Date(2026, 10, 9)} onChange={jest.fn()} />
    );
    expect(screen.queryByText(/Counts toward balances/)).toBeNull();

    await view.rerender(
      <DateField value={new Date(2026, 9, 1)} onChange={jest.fn()} />
    );
    expect(screen.queryByText(/Counts toward balances/)).toBeNull();
  });

  it("calls onChange with the typed day", async () => {
    const onChange = jest.fn();
    await renderWithPaper(<DateField value={NOW} onChange={onChange} />);

    await fireEvent.changeText(screen.getByTestId("date-field"), "11/12/2026");

    expect(onChange).toHaveBeenLastCalledWith(new Date(2026, 10, 12));
  });

  it("reports null while the typed day is incomplete, keeping the text", async () => {
    const onChange = jest.fn();
    function Harness() {
      const [value, setValue] = useState<Date | null>(NOW);
      return (
        <DateField
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    await renderWithPaper(<Harness />);
    const input = screen.getByTestId("date-field");

    await fireEvent(input, "change", { nativeEvent: { text: "11/1" } });
    await fireEvent.changeText(input, "11/1");

    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId("date-field")).toHaveProp("value", "11/1");
    expect(screen.queryByText(/Counts toward balances/)).toBeNull();
  });

  describe("typed days that do not exist", () => {
    function Harness({ onChange }: { onChange: (d: Date | null) => void }) {
      const [value, setValue] = useState<Date | null>(NOW);
      return (
        <DateField
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    it.each(["02/30/2026", "13/45/2026", "01/01/0026"])(
      "rejects %s instead of rolling it over, keeping the text",
      async (text) => {
        const onChange = jest.fn();
        await renderWithPaper(<Harness onChange={onChange} />);

        await typeDate(screen.getByTestId("date-field"), text);

        expect(onChange).toHaveBeenLastCalledWith(null);
        expect(onChange).not.toHaveBeenCalledWith(expect.any(Date));
        expect(screen.getByTestId("date-field")).toHaveProp("value", text);
      }
    );

    it.each(["01/01/1999", "01/01/0026"])(
      "rejects %s as outside 2000-2100 and says so",
      async (text) => {
        const onChange = jest.fn();
        await renderWithPaper(<Harness onChange={onChange} />);

        await typeDate(screen.getByTestId("date-field"), text);

        expect(onChange).toHaveBeenLastCalledWith(null);
        expect(screen.getByText(/^Must be between/)).toBeTruthy();
      }
    );

    it("accepts a real leap day", async () => {
      const onChange = jest.fn();
      await renderWithPaper(<Harness onChange={onChange} />);

      await typeDate(screen.getByTestId("date-field"), "02/29/2028");

      expect(onChange).toHaveBeenLastCalledWith(new Date(2028, 1, 29));
    });

    it("accepts a real day typed after a rejected one", async () => {
      const onChange = jest.fn();
      await renderWithPaper(<Harness onChange={onChange} />);
      const input = screen.getByTestId("date-field");

      await typeDate(input, "02/30/2026");
      await typeDate(input, "03/05/2026");

      expect(onChange).toHaveBeenLastCalledWith(new Date(2026, 2, 5));
    });
  });
});
