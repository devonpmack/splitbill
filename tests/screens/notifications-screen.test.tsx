import { screen } from "@testing-library/react-native";
import { APP_NAME } from "@/lib/app-name";
import { renderWithPaper } from "../helpers/testUtils";
import Notifications from "@/app/(tabs)/account/notifications";

describe("Notifications screen", () => {
  it("says notifications are coming soon, with no switches that imply alerts", async () => {
    await renderWithPaper(<Notifications />);

    expect(screen.getByText("Notifications are coming soon")).toBeTruthy();
    expect(
      screen.getByText(`${APP_NAME} doesn't send push notifications yet.`)
    ).toBeTruthy();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });
});
