import { View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Text } from "react-native-paper";
import { useAppTheme } from "@/lib/theme";

type EmptyStateProps = {
  icon?: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  title: string;
  subtitle?: string;
};

export function EmptyState({ icon, title, subtitle }: EmptyStateProps) {
  const theme = useAppTheme();

  return (
    <View
      style={{
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: 80,
        paddingHorizontal: 24,
      }}
    >
      {icon && (
        <MaterialCommunityIcons
          name={icon}
          size={64}
          color={theme.colors.onSurfaceDisabled}
        />
      )}
      <Text
        variant="titleMedium"
        style={{
          color: theme.colors.onSurfaceVariant,
          marginTop: icon ? 16 : 0,
          textAlign: "center",
        }}
      >
        {title}
      </Text>
      {subtitle && (
        <Text
          variant="bodySmall"
          style={{
            color: theme.colors.onSurfaceVariant,
            marginTop: 4,
            textAlign: "center",
          }}
        >
          {subtitle}
        </Text>
      )}
    </View>
  );
}
