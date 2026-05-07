import fs from "fs/promises";
import yaml from "js-yaml";
import type { PipelineDefinition } from "./types";

export async function parsePipelineFile(
  filePath: string,
): Promise<PipelineDefinition> {
  const raw = await fs.readFile(filePath, "utf-8");
  const doc = yaml.load(raw) as PipelineDefinition;
  if (!doc || !doc.name || !doc.stages) {
    throw new Error(`Invalid pipeline file: ${filePath}`);
  }
  return doc;
}

export async function loadAllPipelines(
  dir: string,
): Promise<PipelineDefinition[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const pipelines: PipelineDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const def = await parsePipelineFile(`${dir}/${entry.name}`);
    pipelines.push(def);
  }
  return pipelines;
}

export function validatePipeline(def: PipelineDefinition): string[] {
  const errors: string[] = [];
  const stageIds = new Set(def.stages.map((s) => s.id));

  for (const stage of def.stages) {
    if (stage.depends_on) {
      for (const dep of stage.depends_on) {
        if (!stageIds.has(dep)) {
          errors.push(`Stage "${stage.id}" depends on unknown stage "${dep}"`);
        }
      }
    }
  }

  // Check for circular dependencies via topological sort
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function hasCycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const stage = def.stages.find((s) => s.id === id);
    if (stage?.depends_on) {
      for (const dep of stage.depends_on) {
        if (stageIds.has(dep) && hasCycle(dep)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const stage of def.stages) {
    visited.clear();
    visiting.clear();
    if (hasCycle(stage.id)) {
      errors.push(
        `Pipeline has circular dependency involving stage "${stage.id}"`,
      );
      break;
    }
  }

  return errors;
}
