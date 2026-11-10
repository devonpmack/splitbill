import fs from "fs";
import path from "path";
import { APP_NAME } from "@/lib/app-name";

const ROOT = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(rel);
    return /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });
}

describe("APP_NAME", () => {
  it("is the app's visible name", () => {
    expect(APP_NAME).toBe("Splitfox");
  });

  it("is the only place in the app's own code that spells a name out", () => {
    // A rename is one line in lib/app-name.ts. Hidden identifiers (the evenpot://
    // scheme, the @splitbill/ storage keys, the package) are not names a person sees,
    // so they are not checked here.
    const offenders = ["app", "components", "lib"]
      .flatMap(sourceFiles)
      .filter((f) => f !== path.join("lib", "app-name.ts"))
      .filter((f) => /Evenpot|Splitfox|SplitBill/.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
