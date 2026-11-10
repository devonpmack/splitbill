import { Chip } from "react-native-paper";
import { useAppTheme } from "@/lib/theme";

// Marks a row dated in the future: it does not count toward balances yet.
export function UpcomingTag() {
  const theme = useAppTheme();

  return (
    <Chip
      compact
      mode="flat"
      style={{
        alignSelf: "flex-start",
        backgroundColor: theme.colors.primaryContainer,
      }}
      textStyle={{
        color: theme.colors.onPrimaryContainer,
        fontSize: 11,
        lineHeight: 14,
        marginVertical: 2,
      }}
    >
      Upcoming
    </Chip>
  );
}
