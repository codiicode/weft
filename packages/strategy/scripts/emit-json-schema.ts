// Emits the strategy JSON Schema used for structured LLM output and external validators.
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { Strategy } from "../src/strategy.ts";

const schema = z.toJSONSchema(Strategy, { io: "input", unrepresentable: "any" });
const out = new URL("../strategy.schema.json", import.meta.url);
writeFileSync(out, JSON.stringify(schema, null, 2) + "\n");
console.log(`wrote ${out.pathname}`);
