import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { APP_NAME } from "@/lib/app-name";
import { renderWithPaper } from "../helpers/testUtils";
import AddGroupMembers from "@/app/group-add-members";

const mockBack = jest.fn();
const mockAddAsync = jest.fn();
const mockLookupAsync = jest.fn();
const mockShowError = jest.fn();
const mockShowSuccess = jest.fn();

jest.mock("expo-router", () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => ({ groupId: "g1" }),
}));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useGroups", () => ({
  useGroup: jest.fn(),
  useAddGroupMembers: jest.fn(),
  useCheckGroupMemberEmail: jest.fn(),
}));
jest.mock("@/lib/snackbar", () => ({ useSnackbar: jest.fn() }));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";
import {
  useGroup,
  useAddGroupMembers,
  useCheckGroupMemberEmail,
} from "@/lib/queries/useGroups";
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
  mockAddAsync.mockResolvedValue(undefined);
  mockLookupAsync.mockResolvedValue("ok");
  (router as unknown as { back: jest.Mock }).back = mockBack;
  (useAuth as jest.Mock).mockReturnValue({ user: { email: "me@x.com" } });
  (useGroup as jest.Mock).mockReturnValue({
    data: {
      id: "g1",
      name: "Trip",
      group_members: [{ user_id: "u1", profiles: { full_name: "Me" } }],
    },
  });
  (useAddGroupMembers as jest.Mock).mockReturnValue({
    mutateAsync: mockAddAsync,
    isPending: false,
  });
  (useCheckGroupMemberEmail as jest.Mock).mockReturnValue({
    mutateAsync: mockLookupAsync,
    isPending: false,
  });
  (useSnackbar as jest.Mock).mockReturnValue({
    showError: mockShowError,
    showSuccess: mockShowSuccess,
  });
});

describe("AddGroupMembers screen", () => {
  it("adds members and navigates back on success", async () => {
    await renderWithPaper(<AddGroupMembers />);

    await addEmail("bob@x.com");
    await waitFor(() => expect(screen.getByText("bob@x.com")).toBeTruthy());

    await fireEvent.press(screen.getByText("Add Members"));

    await waitFor(() =>
      expect(mockAddAsync).toHaveBeenCalledWith({
        groupId: "g1",
        memberEmails: ["bob@x.com"],
      })
    );
    expect(mockShowSuccess).toHaveBeenCalledWith("Member added");
    expect(mockBack).toHaveBeenCalled();
  });

  it("requires at least one email before adding members", async () => {
    await renderWithPaper(<AddGroupMembers />);

    await fireEvent.press(screen.getByText("Add Members"));

    expect(mockShowError).toHaveBeenCalledWith("Add at least one email to invite");
    expect(mockAddAsync).not.toHaveBeenCalled();
  });

  it("blocks adding someone already in the group from the plus button", async () => {
    mockLookupAsync.mockResolvedValue("already_member");
    await renderWithPaper(<AddGroupMembers />);

    await addEmail("bob@x.com");

    await waitFor(() =>
      expect(mockShowError).toHaveBeenCalledWith(
        "This person is already a member of the group"
      )
    );
    expect(screen.queryByText("bob@x.com")).toBeNull();
    expect(mockAddAsync).not.toHaveBeenCalled();
  });

  it("blocks an email with no app account", async () => {
    mockLookupAsync.mockResolvedValue("not_registered");
    await renderWithPaper(<AddGroupMembers />);

    await addEmail("ghost@x.com");

    await waitFor(() =>
      expect(mockShowError).toHaveBeenCalledWith(
        `No ${APP_NAME} account found for ghost@x.com`
      )
    );
    expect(screen.queryByText("ghost@x.com")).toBeNull();
    expect(mockAddAsync).not.toHaveBeenCalled();
  });

  it("surfaces an error when adding members fails", async () => {
    mockAddAsync.mockRejectedValue({});
    await renderWithPaper(<AddGroupMembers />);

    await addEmail("bob@x.com");
    await waitFor(() => expect(screen.getByText("bob@x.com")).toBeTruthy());
    await fireEvent.press(screen.getByText("Add Members"));

    await waitFor(() =>
      expect(mockShowError).toHaveBeenCalledWith(
        "Couldn't add members. Please try again."
      )
    );
    expect(mockBack).not.toHaveBeenCalled();
  });
});
