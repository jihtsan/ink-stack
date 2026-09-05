import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const widgets = ["text", "date", "todo", "codex-usage", "calendar", "image"];
const ajv = new Ajv({
  allErrors: true,
  strict: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  code: { source: true, esm: true }
});

const exports = {};
for (const type of widgets) {
  const schemaPath = resolve(packageRoot, `src/${type}/config.schema.json`);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const schemaId = `https://ink-stack.local/widgets/${type}/config.schema.json`;
  ajv.addSchema({ ...schema, $id: schemaId });
  exports[validatorName(type)] = schemaId;
}

const outputPath = resolve(packageRoot, "src/generated/config-validators.js");
const declarationsPath = resolve(packageRoot, "src/generated/config-validators.d.ts");
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${standaloneCode(ajv, exports)}\n`);
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

export const validateImageConfig: GeneratedValidateFunction;
export const validateTextConfig: GeneratedValidateFunction;
export const validateDateConfig: GeneratedValidateFunction;
export const validateTodoConfig: GeneratedValidateFunction;
export const validateCodexUsageConfig: GeneratedValidateFunction;
export const validateCalendarConfig: GeneratedValidateFunction;
`
);

function validatorName(type) {
  return `validate${type
    .split("-")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("")}Config`;
}
