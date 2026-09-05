export interface GeneratedValidationError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

export interface GeneratedValidateFunction {
  (data: unknown, context?: unknown): boolean;
  errors?: GeneratedValidationError[] | null;
}

export const validateDashboardSchema: GeneratedValidateFunction;
