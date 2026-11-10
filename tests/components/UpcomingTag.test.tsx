import { screen } from "@testing-library/react-native";
import { renderWithPaper } from "../helpers/testUtils";
import { UpcomingTag } from "@/components/UpcomingTag";

describe("UpcomingTag", () => {
  it("is read as text, not announced as a button", async () => {
    await renderWithPaper(<UpcomingTag />);

    expect(screen.getByText("Upcoming")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upcoming" })).toBeNull();
    expect(screen.getAllByRole("text", { name: "Upcoming" }).length).toBeGreaterThan(0);
  });
});
