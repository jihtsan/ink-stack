import type { DashboardDraft, DashboardValidationIssue, DashboardValidationResult } from "./dashboard.js";
import { validateDashboardLayout, type GridValidationOptions } from "./grid.js";
import dashboardDraftSchema from "./schemas/dashboard.schema.json" with { type: "json" };
import { validateDashboardSchema, type GeneratedValidationError } from "./generated/validators.js";

export { dashboardDraftSchema, validateDashboardSchema };

export function validateDashboardDraft(
  input: unknown,
  options: GridValidationOptions = {}
): DashboardValidationResult {
  const schemaOk = validateDashboardSchema(input);
  const schemaIssues = schemaOk ? [] : ajvErrorsToIssues(validateDashboardSchema.errors ?? []);
  if (!schemaOk) {
    return { ok: false, issues: schemaIssues };
  }

  const dashboard = input as DashboardDraft;
  const timeZoneIssue = validateTimeZone(dashboard.timeZone);
  const layout = validateDashboardLayout(dashboard.screen, dashboard.grid, dashboard.widgets, options);
  return {
    ok: schemaIssues.length === 0 && timeZoneIssue.length === 0 && layout.ok,
    issues: [...schemaIssues, ...timeZoneIssue, ...layout.issues]
  };
}

export const validateDashboard = validateDashboardDraft;

function ajvErrorsToIssues(errors: GeneratedValidationError[]): DashboardValidationIssue[] {
  return errors.map((error) => ({
    code: "schema",
    message: error.message ?? "Dashboard schema validation failed.",
    path: error.instancePath || error.schemaPath
  }));
}

function validateTimeZone(timeZone: string): DashboardValidationIssue[] {
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone }).format(new Date());
    return [];
  } catch {
    return [{ code: "invalid-time-zone", path: "/timeZone", message: `Invalid IANA time zone ${timeZone}.` }];
  }
}
