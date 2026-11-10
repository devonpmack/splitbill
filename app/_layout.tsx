import { Stack } from "expo-router";
import { type ComponentProps, useEffect } from "react";
import { Platform } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { PaperProvider } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AuthProvider } from "@/lib/auth";
import { SnackbarProvider } from "@/lib/snackbar";
import { ConfirmProvider } from "@/lib/confirm";
import { DisplayCurrencyProvider } from "@/lib/display-currency";
import {
  ThemePreferenceProvider,
  useThemePreference,
} from "@/lib/theme-preference";
import { StatusBar } from "expo-status-bar";
import { useRefetchOnForeground } from "@/lib/useRefetchOnForeground";
import { useMaterialiseOnForeground } from "@/lib/useMaterialiseOnForeground";

type MaterialIconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: 2,
    },
  },
});

function RefetchOnForeground() {
  useRefetchOnForeground();
  return null;
}

function MaterialiseOnForeground() {
  useMaterialiseOnForeground();
  return null;
}

function ThemedApp() {
  const { theme, isDark } = useThemePreference();

  // On web, Chrome/Safari paint autofilled inputs (email, password) with their
  // own near-white background and dark text via `!important`, ignoring the Paper
  // theme. Override it with a theme-aware inset box-shadow so inputs follow the
  // active light/dark theme instead of showing a white box.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const id = "autofill-theme-override";
    let styleEl = document.getElementById(id) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = id;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
      input:-webkit-autofill,
      input:-webkit-autofill:hover,
      input:-webkit-autofill:focus,
      input:-webkit-autofill:active,
      textarea:-webkit-autofill,
      select:-webkit-autofill {
        -webkit-text-fill-color: ${theme.colors.onSurface} !important;
        -webkit-box-shadow: 0 0 0 1000px ${theme.colors.background} inset !important;
        box-shadow: 0 0 0 1000px ${theme.colors.background} inset !important;
        caret-color: ${theme.colors.onSurface} !important;
        transition: background-color 9999s ease-in-out 0s;
      }
    `;
  }, [theme]);

  // Group action screens live at the root (above the tabs) so they present as
  // modals over whichever tab opened them and dismiss back to it — the group
  // detail is reachable from both the Home tab and the Groups tab.
  const modalScreenOptions = {
    presentation: "modal",
    headerShown: true,
    headerStyle: { backgroundColor: theme.colors.brand },
    headerTintColor: theme.colors.onBrand,
    headerTitleStyle: { fontWeight: "bold" },
  } as const;

  return (
    <PaperProvider
      theme={theme}
      settings={{
        icon: ({ name, ...props }) => (
          <MaterialCommunityIcons name={name as MaterialIconName} {...props} />
        ),
      }}
    >
      <QueryClientProvider client={queryClient}>
        <RefetchOnForeground />
        <AuthProvider>
          <MaterialiseOnForeground />
          <DisplayCurrencyProvider>
            <SnackbarProvider>
              <ConfirmProvider>
                <StatusBar style={isDark ? "light" : "dark"} />
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: theme.colors.background },
                  }}
                >
                  <Stack.Screen name="(auth)" />
                  <Stack.Screen name="(tabs)" />
                  <Stack.Screen
                    name="group-create"
                    options={{ ...modalScreenOptions, title: "Create Group" }}
                  />
                  <Stack.Screen
                    name="group-manage"
                    options={{ ...modalScreenOptions, title: "Group Settings" }}
                  />
                  <Stack.Screen
                    name="group-add-members"
                    options={{ ...modalScreenOptions, title: "Add Members" }}
                  />
                  <Stack.Screen
                    name="group-add-expense"
                    options={{ ...modalScreenOptions, title: "Add Expense" }}
                  />
                  <Stack.Screen
                    name="group-settle-up"
                    options={{ ...modalScreenOptions, title: "Settle Up" }}
                  />
                  <Stack.Screen
                    name="repeating"
                    options={{ ...modalScreenOptions, title: "Repeating" }}
                  />
                  <Stack.Screen
                    name="group-edit-payment"
                    options={{ ...modalScreenOptions, title: "Edit Payment" }}
                  />
                </Stack>
              </ConfirmProvider>
            </SnackbarProvider>
          </DisplayCurrencyProvider>
        </AuthProvider>
      </QueryClientProvider>
    </PaperProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemePreferenceProvider>
        <ThemedApp />
      </ThemePreferenceProvider>
    </SafeAreaProvider>
  );
}
