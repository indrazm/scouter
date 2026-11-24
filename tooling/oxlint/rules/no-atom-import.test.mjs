import { describe, expect, it } from "bun:test";
import { lint } from "../testing/lint.mjs";

const rule = "no-atom-import";

describe(`aven/${rule}`, () => {
  it("refuses an atom import from a route or a component", () => {
    const code = 'import { threadsAtom } from "@/modules/threads/atoms/threads-atom";\n';
    expect(lint(rule, code, "apps/platform/src/routes/threads.tsx")).toHaveLength(1);
    expect(lint(rule, code, "apps/platform/src/modules/threads/components/row.tsx")).toHaveLength(1);
  });

  it("allows an atom import from a hook", () => {
    expect(
      lint(
        rule,
        'import { threadsAtom } from "../atoms/threads-atom";\n',
        "apps/platform/src/modules/threads/hooks/use-threads.ts",
      ),
    ).toHaveLength(0);
  });
});
