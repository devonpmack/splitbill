import { ScrollView, View } from "react-native";
import { List } from "react-native-paper";
import { useAppTheme } from "@/lib/theme";
import { FaqItem } from "@/components/account/FaqItem";

const FAQS: { question: string; answer: string }[] = [
  {
    question: "How are expenses split?",
    answer:
      "By default an expense is split equally between everyone in the group. When adding an expense you can switch to exact amounts or percentages to customize each person's share.",
  },
  {
    question: "How do I settle up?",
    answer:
      "Open a group and tap Settle Up. Evenpot simplifies who owes whom into the fewest payments, then records the payment so balances update for everyone.",
  },
  {
    question: "What does \"Simplify group debts\" do?",
    answer:
      "When simplify debts is on, Evenpot nets out chains of IOUs so the group settles in the fewest possible payments. For example, if Alice owes Bob $10 and Bob owes Carol $10, Evenpot collapses that into Alice paying Carol $10 directly \u2014 Bob no longer needs to be involved. Your net balance (the total you owe or are owed across the group) is exactly the same either way; simplification only changes who pays whom, not how much. Turn it off in a group's settings to see the exact person-to-person amounts from each individual expense.",
  },
  {
    question: "Can I add people who aren't on Evenpot?",
    answer:
      "Members are matched by the email address they signed up with. Invite friends to create an account with that email, then add them to your group.",
  },
  {
    question: "What happens when I leave a group?",
    answer:
      "You're removed from the group. If you were the owner, ownership passes to the longest-standing member. If you were the last member, the group and its history are deleted.",
  },
];

export default function HelpAndSupport() {
  const theme = useAppTheme();

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ paddingHorizontal: 24, paddingTop: 16, paddingBottom: 40 }}>
        <List.Subheader>Frequently Asked</List.Subheader>
        {FAQS.map((faq) => (
          <FaqItem
            key={faq.question}
            question={faq.question}
            answer={faq.answer}
          />
        ))}

      </View>
    </ScrollView>
  );
}
