import { screen } from "@testing-library/react-native";
import { renderWithPaper } from "../helpers/testUtils";
import Notifications from "@/app/(tabs)/account/notifications";

describe("Notifications screen", () => {
  it("says notifications are coming soon, with no switches that imply alerts", async () => {
    await renderWithPaper(<Notifications />);

    expect(screen.getByText("Notifications are coming soon")).toBeTruthy();
    expect(
      screen.getByText(/doesn't send push notifications yet/i)
    ).toBeTruthy();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });
});
