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

export const validateImageConfig: GeneratedValidateFunction;
export const validateTextConfig: GeneratedValidateFunction;
export const validateDateConfig: GeneratedValidateFunction;
export const validateTodoConfig: GeneratedValidateFunction;
export const validateCodexUsageConfig: GeneratedValidateFunction;
