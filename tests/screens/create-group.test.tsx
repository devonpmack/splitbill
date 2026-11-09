import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { renderWithPaper } from "../helpers/testUtils";
import CreateGroup from "@/app/group-create";

const mockBack = jest.fn();
const mockCreateAsync = jest.fn();
const mockCheckAsync = jest.fn();
const mockShowError = jest.fn();

jest.mock("expo-router", () => ({ router: { back: jest.fn() } }));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useGroups", () => ({
  useCreateGroup: jest.fn(),
  useCheckEmailExists: jest.fn(),
}));
jest.mock("@/lib/snackbar", () => ({ useSnackbar: jest.fn() }));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";
import { useCreateGroup, useCheckEmailExists } from "@/lib/queries/useGroups";
import { useSnackbar } from "@/lib/snackbar";

const EMAIL_PLACEHOLDER = "friend@example.com";

async function addEmail(email: string) {
  await fireEvent.changeText(
    screen.getByPlaceholderText(EMAIL_PLACEHOLDER),
    email
  );
  await fireEvent(
    screen.getByPlaceholderText(EMAIL_PLACEHOLDER),
    "submitEditing"
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateAsync.mockResolvedValue({ id: "grp-1" });
  mockCheckAsync.mockResolvedValue(true);
  (router as unknown as { back: jest.Mock }).back = mockBack;
  (useAuth as jest.Mock).mockReturnValue({ user: { email: "me@x.com" } });
  (useCreateGroup as jest.Mock).mockReturnValue({
    mutateAsync: mockCreateAsync,
    isPending: false,
  });
  (useCheckEmailExists as jest.Mock).mockReturnValue({
    mutateAsync: mockCheckAsync,
    isPending: false,
  });
  (useSnackbar as jest.Mock).mockReturnValue({ showError: mockShowError });
});

describe("CreateGroup screen", () => {
  it("requires a group name", async () => {
    await renderWithPaper(<CreateGroup />);

    await fireEvent.press(screen.getByText("Create Group"));

    expect(mockShowError).toHaveBeenCalledWith("Please enter a group name");
    expect(mockCreateAsync).not.toHaveBeenCalled();
  });

  it("rejects an invalid email format", async () => {
    await renderWithPaper(<CreateGroup />);

    await addEmail("not-an-email");

    expect(mockShowError).toHaveBeenCalledWith(
      "Please enter a valid email address"
    );
    expect(mockCheckAsync).not.toHaveBeenCalled();
  });

  it("rejects the current user's own email", async () => {
    await renderWithPaper(<CreateGroup />);

    await addEmail("me@x.com");

    expect(mockShowError).toHaveBeenCalledWith(
      "You're already a member of the group"
    );
  });

  it("rejects a duplicate email", async () => {
    await renderWithPaper(<CreateGroup />);

    await addEmail("bob@x.com");
    await waitFor(() => expect(screen.getByText("bob@x.com")).toBeTruthy());
    await addEmail("bob@x.com");

    expect(mockShowError).toHaveBeenCalledWith("This email is already added");
  });

  it("rejects an email with no Evenpot account", async () => {
    mockCheckAsync.mockResolvedValue(false);
    await renderWithPaper(<CreateGroup />);

    await addEmail("ghost@x.com");

    await waitFor(() =>
      expect(mockShowError).toHaveBeenCalledWith(
        "No Evenpot account found for ghost@x.com"
      )
    );
  });

  it("adds a valid email as a chip and can remove it", async () => {
    await renderWithPaper(<CreateGroup />);

    await addEmail("bob@x.com");
    await waitFor(() => expect(screen.getByText("bob@x.com")).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Close"));

    await waitFor(() =>
      expect(screen.queryByText("bob@x.com")).toBeNull()
    );
  });

  it("creates the group with the added members", async () => {
    await renderWithPaper(<CreateGroup />);

    await fireEvent.changeText(
      screen.getByPlaceholderText("e.g., Trip to Japan"),
      "Japan"
    );
    await addEmail("bob@x.com");
    await waitFor(() => expect(screen.getByText("bob@x.com")).toBeTruthy());

    await fireEvent.press(screen.getByText("Create Group"));

    await waitFor(() =>
      expect(mockCreateAsync).toHaveBeenCalledWith({
        name: "Japan",
        memberEmails: ["bob@x.com"],
        currency: "USD",
      })
    );
    expect(mockBack).toHaveBeenCalled();
  });

  it("surfaces an error when group creation fails", async () => {
    mockCreateAsync.mockRejectedValue({});
    await renderWithPaper(<CreateGroup />);

    await fireEvent.changeText(
      screen.getByPlaceholderText("e.g., Trip to Japan"),
      "Japan"
    );
    await fireEvent.press(screen.getByText("Create Group"));

    await waitFor(() =>
      expect(mockShowError).toHaveBeenCalledWith(
        "Couldn't create the group. Please try again."
      )
    );
    expect(mockBack).not.toHaveBeenCalled();
  });
});
