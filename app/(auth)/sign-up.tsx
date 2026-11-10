import { useState } from "react";
import { View, KeyboardAvoidingView, Platform } from "react-native";
import { router } from "expo-router";
import { Button, HelperText, Text, TextInput } from "react-native-paper";
import { useAuth } from "@/lib/auth";
import { useAppTheme } from "@/lib/theme";

export default function SignUp() {
  const theme = useAppTheme();
  const { signUp } = useAuth();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const handleSignUp = async () => {
    setError("");
    setSuccess("");
    if (!fullName || !email || !password) {
      setError("Please fill in all fields");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }
    setLoading(true);
    const { error: authError } = await signUp(email, password, fullName);
    setLoading(false);
    if (authError) {
      setError(authError.message);
    } else {
      setSuccess("Account created! Check your email to verify, or sign in now.");
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={{ flex: 1, backgroundColor: theme.colors.background }}
    >
      <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 32 }}>
        <View style={{ marginBottom: 48 }}>
          <Text
            variant="displaySmall"
            style={{ color: theme.colors.primary, textAlign: "center" }}
          >
            Splitfox
          </Text>
          <Text
            variant="bodyLarge"
            style={{
              color: theme.colors.onSurfaceVariant,
              textAlign: "center",
              marginTop: 8,
            }}
          >
            Create your account
          </Text>
        </View>

        {error ? (
          <HelperText type="error" visible style={{ textAlign: "center" }}>
            {error}
          </HelperText>
        ) : null}

        {success ? (
          <HelperText
            type="info"
            visible
            style={{ textAlign: "center", color: theme.colors.success }}
          >
            {success}
          </HelperText>
        ) : null}

        <View style={{ gap: 16 }}>
          <TextInput
            mode="outlined"
            label="Full Name"
            placeholder="John Doe"
            value={fullName}
            onChangeText={setFullName}
            autoComplete="name"
            left={<TextInput.Icon icon="account-outline" />}
          />

          <TextInput
            mode="outlined"
            label="Email"
            placeholder="you@example.com"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            left={<TextInput.Icon icon="email-outline" />}
          />

          <TextInput
            mode="outlined"
            label="Password"
            placeholder="At least 6 characters"
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!showPassword}
            autoComplete="new-password"
            left={<TextInput.Icon icon="lock-outline" />}
            right={
              <TextInput.Icon
                icon={showPassword ? "eye-off" : "eye"}
                onPress={() => setShowPassword((s) => !s)}
              />
            }
          />

          <Button
            mode="contained"
            onPress={handleSignUp}
            loading={loading}
            disabled={loading}
            contentStyle={{ paddingVertical: 6 }}
            style={{ marginTop: 8 }}
          >
            Create Account
          </Button>
        </View>

        <View style={{ flexDirection: "row", justifyContent: "center", alignItems: "center", marginTop: 32 }}>
          <Text style={{ color: theme.colors.onSurfaceVariant }}>
            Already have an account?{" "}
          </Text>
          <Button
            mode="text"
            compact
            onPress={() => router.push("/(auth)/sign-in")}
          >
            Sign In
          </Button>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
