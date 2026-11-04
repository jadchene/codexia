import { expect, it } from "vitest";
import { subscriptionPlanLabel } from "../src/shared/subscription-plan.ts";

it.each([
  ["prolite", "Pro 100"], ["pro", "Pro 200"], ["promax", "Pro 500"],
  ["plus", "Plus"], ["free", "Free"], ["go", "Go"], ["team", "Team"],
  ["enterprise", "Enterprise"], [" PROLITE ", "Pro 100"], ["", "未知"], [undefined, "未知"]
])("formats subscription plan %s as %s", (plan, label) => {
  expect(subscriptionPlanLabel(plan)).toBe(label);
});
