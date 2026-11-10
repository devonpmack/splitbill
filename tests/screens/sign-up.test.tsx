import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { renderWithPaper } from "../helpers/testUtils";
import SignUp from "@/app/(auth)/sign-up";

const mockPush = jest.fn();
const mockSignUp = jest.fn();

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";

async function fillForm(values?: {
  name?: string;
  email?: string;
  password?: string;
}) {
  await fireEvent.changeText(
    screen.getByPlaceholderText("John Doe"),
    values?.name ?? "Alice"
  );
  await fireEvent.changeText(
    screen.getByPlaceholderText("you@example.com"),
    values?.email ?? "a@x.com"
  );
  await fireEvent.changeText(
    screen.getByPlaceholderText("At least 6 characters"),
    values?.password ?? "secret"
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSignUp.mockResolvedValue({ error: null });
  (router as unknown as { push: jest.Mock }).push = mockPush;
  (useAuth as jest.Mock).mockReturnValue({ signUp: mockSignUp });
});

import { APP_NAME } from "@/lib/app-name";

describe("SignUp screen", () => {
  it("shows the app name as the title", async () => {
    await renderWithPaper(<SignUp />);

    expect(screen.getByText(APP_NAME)).toBeTruthy();
  });

  it("requires all fields", async () => {
    await renderWithPaper(<SignUp />);

    await fireEvent.press(screen.getByText("Create Account"));

    expect(screen.getByText("Please fill in all fields")).toBeTruthy();
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it("rejects short passwords", async () => {
    await renderWithPaper(<SignUp />);
    await fillForm({ password: "123" });

    await fireEvent.press(screen.getByText("Create Account"));

    expect(
      screen.getByText("Password must be at least 6 characters")
    ).toBeTruthy();
    expect(mockSignUp).not.toHaveBeenCalled();
  });

  it("calls signUp and shows the success message", async () => {
    await renderWithPaper(<SignUp />);
    await fillForm();

    await fireEvent.press(screen.getByText("Create Account"));

    await waitFor(() =>
      expect(mockSignUp).toHaveBeenCalledWith("a@x.com", "secret", "Alice")
    );
    expect(
      screen.getByText(
        "Account created! Check your email to verify, or sign in now."
      )
    ).toBeTruthy();
  });

  it("shows the auth error on failure", async () => {
    mockSignUp.mockResolvedValue({ error: new Error("Email taken") });
    await renderWithPaper(<SignUp />);
    await fillForm();

    await fireEvent.press(screen.getByText("Create Account"));

    await waitFor(() => expect(screen.getByText("Email taken")).toBeTruthy());
  });

  it("navigates to sign-in", async () => {
    await renderWithPaper(<SignUp />);

    await fireEvent.press(screen.getByText("Sign In"));

    expect(mockPush).toHaveBeenCalledWith("/(auth)/sign-in");
  });
});
