import { fireEvent, screen } from "@testing-library/react-native";
import { renderWithPaper } from "../helpers/testUtils";
import { RepeatingHeaderButton } from "@/components/recurring/RepeatingHeaderButton";
import { GroupHeaderActions } from "@/components/groups/GroupHeaderActions";

describe("RepeatingHeaderButton", () => {
  it("is a labelled button that opens the Repeating list", async () => {
    const onPress = jest.fn();
    await renderWithPaper(<RepeatingHeaderButton onPress={onPress} />);

    await fireEvent.press(screen.getByLabelText("Repeating"));

    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("GroupHeaderActions", () => {
  it("has settings, repeating and leave buttons", async () => {
    const onSettings = jest.fn();
    const onRepeating = jest.fn();
    const onLeave = jest.fn();
    await renderWithPaper(
      <GroupHeaderActions
        onSettings={onSettings}
        onRepeating={onRepeating}
        onLeave={onLeave}
      />
    );

    await fireEvent.press(screen.getByLabelText("Repeating"));
    await fireEvent.press(screen.getByLabelText("Group settings"));
    await fireEvent.press(screen.getByLabelText("Leave group"));

    expect(onRepeating).toHaveBeenCalledTimes(1);
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});
