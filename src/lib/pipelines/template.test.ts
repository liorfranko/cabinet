import { describe, it, expect } from "vitest";
import { resolveTemplate, evaluateCondition } from "./template";

describe("resolveTemplate", () => {
  const context = {
    trigger: {
      title: "Feature: Add OAuth",
      body: "Add OAuth to the login page",
      task_id: "t-123",
    },
    stages: {
      decompose: {
        outputs: {
          components: ["backend", "frontend"],
          test_files: ["tests/auth.test.ts"],
        },
      },
      write_spec: { outputs: { spec_file: "docs/specs/add-oauth.md" } },
    },
    run: { id: "run-abc" },
    branch: "feature/t-123-add-oauth",
  };

  it("resolves simple variable", () => {
    expect(resolveTemplate("{{ trigger.title }}", context)).toBe(
      "Feature: Add OAuth",
    );
  });

  it("resolves nested dot path", () => {
    expect(
      resolveTemplate("{{ stages.write_spec.outputs.spec_file }}", context),
    ).toBe("docs/specs/add-oauth.md");
  });

  it("resolves slugify filter", () => {
    expect(resolveTemplate("{{ trigger.title | slugify }}", context)).toBe(
      "feature-add-oauth",
    );
  });

  it("resolves strip_prefix filter", () => {
    expect(
      resolveTemplate(
        "{{ trigger.title | strip_prefix('Feature: ') }}",
        context,
      ),
    ).toBe("Add OAuth");
  });

  it("resolves first filter on array", () => {
    expect(
      resolveTemplate(
        "{{ stages.decompose.outputs.components | first }}",
        context,
      ),
    ).toBe("backend");
  });

  it("resolves ternary expression", () => {
    const tpl =
      "{{ 'frontend-eng' if 'frontend' in stages.decompose.outputs.components else 'backend-eng' }}";
    expect(resolveTemplate(tpl, context)).toBe("frontend-eng");
  });

  it("passes through text without templates", () => {
    expect(resolveTemplate("no templates here", context)).toBe(
      "no templates here",
    );
  });
});

describe("evaluateCondition", () => {
  const context = {
    stages: { decompose: { outputs: { components: ["backend", "frontend"] } } },
  };

  it("evaluates 'in' expression as true", () => {
    expect(
      evaluateCondition(
        "'backend' in stages.decompose.outputs.components",
        context,
      ),
    ).toBe(true);
  });

  it("evaluates 'in' expression as false", () => {
    expect(
      evaluateCondition(
        "'mobile' in stages.decompose.outputs.components",
        context,
      ),
    ).toBe(false);
  });
});
