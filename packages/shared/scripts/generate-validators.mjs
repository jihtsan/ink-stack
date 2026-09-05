import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = resolve(packageRoot, "src/schemas/dashboard.schema.json");
const outputPath = resolve(packageRoot, "src/generated/validators.js");
const declarationsPath = resolve(packageRoot, "src/generated/validators.d.ts");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  code: { source: true, esm: true }
});

ajv.addSchema(schema);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${standaloneCode(ajv, { validateDashboardSchema: schema.$id })}\n`);
writeFileSync(
  declarationsPath,
  `export interface GeneratedValidationError {
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
`
);
