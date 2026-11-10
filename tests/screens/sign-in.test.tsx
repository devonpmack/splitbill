import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { renderWithPaper } from "../helpers/testUtils";
import SignIn from "@/app/(auth)/sign-in";

const mockPush = jest.fn();
const mockSignIn = jest.fn();

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";

beforeEach(() => {
  jest.clearAllMocks();
  mockSignIn.mockResolvedValue({ error: null });
  (router as unknown as { push: jest.Mock }).push = mockPush;
  (useAuth as jest.Mock).mockReturnValue({ signIn: mockSignIn });
});

import { APP_NAME } from "@/lib/app-name";

describe("SignIn screen", () => {
  it("shows the app name as the title", async () => {
    await renderWithPaper(<SignIn />);

    expect(screen.getByText(APP_NAME)).toBeTruthy();
  });

  it("validates that both fields are filled", async () => {
    await renderWithPaper(<SignIn />);

    await fireEvent.press(screen.getByText("Sign In"));

    expect(screen.getByText("Please fill in all fields")).toBeTruthy();
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it("calls signIn with the entered credentials", async () => {
    await renderWithPaper(<SignIn />);

    await fireEvent.changeText(
      screen.getByPlaceholderText("you@example.com"),
      "a@x.com"
    );
    await fireEvent.changeText(
      screen.getByPlaceholderText("Enter your password"),
      "secret"
    );
    await fireEvent.press(screen.getByText("Sign In"));

    await waitFor(() =>
      expect(mockSignIn).toHaveBeenCalledWith("a@x.com", "secret")
    );
  });

  it("shows the auth error message on failure", async () => {
    mockSignIn.mockResolvedValue({ error: new Error("Invalid login") });
    await renderWithPaper(<SignIn />);

    await fireEvent.changeText(
      screen.getByPlaceholderText("you@example.com"),
      "a@x.com"
    );
    await fireEvent.changeText(
      screen.getByPlaceholderText("Enter your password"),
      "secret"
    );
    await fireEvent.press(screen.getByText("Sign In"));

    await waitFor(() => expect(screen.getByText("Invalid login")).toBeTruthy());
  });

  it("navigates to sign-up", async () => {
    await renderWithPaper(<SignIn />);

    await fireEvent.press(screen.getByText("Sign Up"));

    expect(mockPush).toHaveBeenCalledWith("/(auth)/sign-up");
  });
});
