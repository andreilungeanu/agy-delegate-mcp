// Config option ids differ per model and are known only once a model is selected.

// ACP marks a thinking-level selector with category "thought_level", as agy does. Categories are
// optional, so ids and names also classify. A match only nominates an option: the value must still
// be one it advertises.
const THOUGHT_LEVEL_IDS = new Set(["thinking", "reasoning", "effort", "reasoning_effort", "thought_level"]);
// Never effort; doctor reports them separately, so option lists leave them out.
const SELECTOR_IDS = new Set(["model", "mode"]);

export function isThoughtLevel(opt) {
  if (opt?.category === "thought_level") return true;
  const id = typeof opt?.id === "string" ? opt.id.toLowerCase() : "";
  if (THOUGHT_LEVEL_IDS.has(id)) return true;
  const name = typeof opt?.name === "string" ? opt.name.toLowerCase() : "";
  return /thinking|reasoning|thought|effort/.test(name);
}

export function optionsFrom(res) {
  return Array.isArray(res?.configOptions) ? res.configOptions : undefined;
}

export function allowedValues(opt) {
  return (Array.isArray(opt?.options) ? opt.options : [])
    .map((o) => o?.value)
    .filter((v) => typeof v === "string");
}

// A model's options besides model and mode, for doctor and the unrecognized-effort error.
export function describeOptions(options) {
  return (Array.isArray(options) ? options : [])
    .filter((o) => typeof o?.id === "string" && !SELECTOR_IDS.has(o.id))
    .map((o) => ({
      id: o.id,
      ...(typeof o.name === "string" ? { name: o.name } : {}),
      ...(typeof o.category === "string" ? { category: o.category } : {}),
      values: allowedValues(o),
      ...(typeof o.currentValue === "string" ? { currentValue: o.currentValue } : {}),
    }));
}

// Every recognized effort option's current value, keyed by id: a model can declare a thinking toggle
// beside a level, and either alone can mislead.
export function effortSettings(options) {
  const settings = {};
  for (const o of Array.isArray(options) ? options : []) {
    if (isThoughtLevel(o) && typeof o?.id === "string" && typeof o.currentValue === "string") {
      settings[o.id] = o.currentValue;
    }
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

// Exact advertised values only, so new level names need no aliases. No usable list is unavailable;
// a list with no recognized effort option is unrecognized, and the caller is shown the list.
export function resolveEffort(options, value) {
  if (!Array.isArray(options) || options.length === 0) return { status: "unavailable" };

  const candidates = options.filter(isThoughtLevel);
  if (candidates.length === 0) return { status: "unrecognized", advertised: describeOptions(options) };

  const usable = candidates.filter((o) => typeof o?.id === "string");
  const accepted = [...new Set(usable.flatMap(allowedValues))];
  if (usable.length === 0 || accepted.length === 0) return { status: "unavailable" };

  const pick = usable.find((o) => allowedValues(o).includes(value));
  if (pick === undefined) return { status: "invalid", accepted };
  return { status: "matched", id: pick.id, value };
}
