import { render } from "@testing-library/react-native";
import RootLayout from "@/app/_layout";

jest.mock("expo-router", () => {
  const Stack = () => null;
  (Stack as unknown as { Screen: () => null }).Screen = () => null;
  return { Stack };
});
// The real provider renders nothing until the native side reports insets.
jest.mock("react-native-safe-area-context", () => {
  const actual = jest.requireActual("react-native-safe-area-context");
  const React = require("react");
  return {
    ...actual,
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(actual.SafeAreaProvider, {
        initialMetrics: actual.initialWindowMetrics ?? {
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        },
        children,
      }),
  };
});
jest.mock("@/lib/auth", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@/lib/snackbar", () => ({
  SnackbarProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@/lib/confirm", () => ({
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@/lib/useRefetchOnForeground", () => ({
  useRefetchOnForeground: jest.fn(),
}));

import { useRefetchOnForeground } from "@/lib/useRefetchOnForeground";

describe("RootLayout", () => {
  it("refetches on app foreground for the whole app", async () => {
    await render(<RootLayout />);

    expect(useRefetchOnForeground).toHaveBeenCalled();
  });
});
