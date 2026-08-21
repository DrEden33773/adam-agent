import type { SkillCatalogDisplay } from "@adam-agent/presentation";
import { describe, expect, test } from "vitest";

import { SkillPalette } from "./skill-palette.js";
import { createAdamTuiTheme } from "./theme.js";

describe("SkillPalette", () => {
  test("renders untrusted source scopes and diagnostic identities as inert text", () => {
    const unsafeSequence = "\u001b]52;c;c2NvcGU=\u0007";
    const catalog: SkillCatalogDisplay = {
      revision: 1,
      items: [
        {
          qualifiedId: "skill:v1:project:unsafe:review",
          name: "review",
          description: "Review this project.",
          source: { type: "project", scope: `scope-${unsafeSequence}` },
          active: false,
        },
      ],
      diagnostics: [
        {
          code: "skill_package_invalid",
          source: "project",
          scope: `scope-${unsafeSequence}`,
          packagePath: `.agents/${unsafeSequence}/SKILL.md`,
        },
      ],
      overflow: { omittedCount: 0, shortenedCount: 0 },
      reloadAvailable: true,
    };
    const palette = new SkillPalette({
      catalog,
      onClose() {},
      onToggle: () => true,
      theme: createAdamTuiTheme(),
    });

    const rendered = palette.render(120).join("\n");
    expect(rendered).not.toContain(unsafeSequence);
    expect(rendered).toContain("skill_package_invalid");
    expect(rendered).toContain(".agents//SKILL.md");
  });
});
