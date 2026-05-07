type TemplateContext = Record<string, unknown>;

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function applyFilter(value: unknown, filter: string): unknown {
  const trimmed = filter.trim();

  if (trimmed === "slugify") {
    return String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }
  if (trimmed === "first") {
    return Array.isArray(value) ? value[0] : value;
  }
  if (trimmed === "last") {
    return Array.isArray(value) ? value[value.length - 1] : value;
  }

  const stripMatch = trimmed.match(/^strip_prefix\(['"](.+)['"]\)$/);
  if (stripMatch) {
    const prefix = stripMatch[1];
    const str = String(value);
    return str.startsWith(prefix) ? str.slice(prefix.length) : str;
  }

  return value;
}

function resolveSingleExpression(
  expr: string,
  context: TemplateContext,
): string {
  const trimmed = expr.trim();

  // Ternary: value if condition else other
  const ternaryMatch = trimmed.match(/^(.+?)\s+if\s+(.+?)\s+else\s+(.+)$/);
  if (ternaryMatch) {
    const [, trueVal, condition, falseVal] = ternaryMatch;
    const result = evaluateCondition(condition, context);
    const chosen = result ? trueVal.trim() : falseVal.trim();
    // Strip quotes from string literals
    const unquoted = chosen.replace(/^['"]|['"]$/g, "");
    return unquoted;
  }

  // Variable with optional filters: path | filter1 | filter2
  const parts = trimmed.split("|").map((p) => p.trim());
  const varPath = parts[0];
  let value = getNestedValue(context, varPath);

  for (let i = 1; i < parts.length; i++) {
    value = applyFilter(value, parts[i]);
  }

  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

export function resolveTemplate(
  template: string,
  context: TemplateContext,
): string {
  return template.replace(/\{\{\s*(.+?)\s*\}\}/g, (_, expr) => {
    return resolveSingleExpression(expr, context);
  });
}

export function evaluateCondition(
  condition: string,
  context: TemplateContext,
): boolean {
  // Handle: 'value' in path.to.array
  const inMatch = condition.match(/^['"](.+?)['"]\s+in\s+(.+)$/);
  if (inMatch) {
    const [, needle, hayPath] = inMatch;
    const haystack = getNestedValue(context, hayPath.trim());
    if (Array.isArray(haystack)) return haystack.includes(needle);
    if (typeof haystack === "string") return haystack.includes(needle);
    return false;
  }

  // Handle: path == 'value'
  const eqMatch = condition.match(/^(.+?)\s*==\s*['"](.+?)['"]$/);
  if (eqMatch) {
    const val = getNestedValue(context, eqMatch[1].trim());
    return String(val) === eqMatch[2];
  }

  // Handle: file_exists('path') — always false at plan time, evaluated at runtime
  if (condition.startsWith("file_exists(")) return false;

  return false;
}

export function resolveInputs(
  inputs: Record<string, string> | undefined,
  context: TemplateContext,
): Record<string, string> {
  if (!inputs) return {};
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    resolved[key] = resolveTemplate(value, context);
  }
  return resolved;
}
