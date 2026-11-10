import { fireEvent, screen } from "@testing-library/react-native";
import { renderWithPaper } from "../helpers/testUtils";
import Account from "@/app/(tabs)/account/index";

const mockPush = jest.fn();
const mockSignOut = jest.fn();
const mockSetMode = jest.fn();
const mockConfirm = jest.fn();

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/confirm", () => ({ useConfirm: jest.fn() }));
jest.mock("@/lib/theme-preference", () => ({ useThemePreference: jest.fn() }));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";
import { useConfirm } from "@/lib/confirm";
import { useThemePreference } from "@/lib/theme-preference";

beforeEach(() => {
  jest.clearAllMocks();
  (router as unknown as { push: jest.Mock }).push = mockPush;
  (useAuth as jest.Mock).mockReturnValue({
    user: { email: "me@x.com", user_metadata: { full_name: "Alice" } },
    signOut: mockSignOut,
  });
  (useConfirm as jest.Mock).mockReturnValue(mockConfirm);
  (useThemePreference as jest.Mock).mockReturnValue({
    mode: "system",
    setMode: mockSetMode,
  });
});

describe("Account screen", () => {
  it("navigates to the edit-profile screen", async () => {
    await renderWithPaper(<Account />);

    await fireEvent.press(screen.getByText("Edit Profile"));

    expect(mockPush).toHaveBeenCalledWith("/(tabs)/account/edit-profile");
  });

  it("navigates to notifications and help", async () => {
    await renderWithPaper(<Account />);

    await fireEvent.press(screen.getByText("Notifications"));
    await fireEvent.press(screen.getByText("Help & Support"));

    expect(mockPush).toHaveBeenCalledWith("/(tabs)/account/notifications");
    expect(mockPush).toHaveBeenCalledWith("/(tabs)/account/help");
  });

  it("navigates to the delete-account screen", async () => {
    await renderWithPaper(<Account />);

    await fireEvent.press(screen.getByText("Delete Account"));

    expect(mockPush).toHaveBeenCalledWith("/(tabs)/account/delete-account");
  });

  it("confirms before signing out, wiring signOut as the callback", async () => {
    await renderWithPaper(<Account />);

    await fireEvent.press(screen.getByText("Sign Out"));

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const arg = mockConfirm.mock.calls[0][0];
    expect(arg.title).toBe("Sign Out");
    expect(arg.destructive).toBe(true);
    expect(arg.onConfirm).toBe(mockSignOut);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("changes the theme mode via the segmented buttons", async () => {
    await renderWithPaper(<Account />);

    await fireEvent.press(screen.getByText("Dark"));

    expect(mockSetMode).toHaveBeenCalledWith("dark");
  });
});
