import { useState } from "react";
import { pickedDateParam } from "./dates";

// Form state for a DateField. `storedDate` is the row's date on edit screens.
// Until the user picks a day the field shows the stored date (or today) and
// `dateParam` is undefined, so an untouched edit never rewrites the stored
// timestamp.
export function useDayPick(storedDate?: string | null) {
  const [picked, setPicked] = useState<Date | null | undefined>(undefined);
  const stored = storedDate ? new Date(storedDate) : undefined;

  return {
    value: picked === undefined ? stored : picked,
    onChange: setPicked,
    isInvalid: picked === null,
    dateParam: pickedDateParam(picked ?? undefined, stored ?? new Date()),
  };
}
