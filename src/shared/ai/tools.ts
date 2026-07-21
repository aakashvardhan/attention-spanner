import { CONNECTORS } from './connector';
import type { Tool } from './connectors/base';

/**
 * Compatibility surface over the connector registry. Tool definitions live in
 * src/shared/ai/connectors/* (one file per integration/feature); the types
 * and validation/resolution helpers live in connectors/base.ts. Everything
 * historic importers of this module used is re-exported here unchanged.
 */

export type {
  TaskResolution,
  TextResolution,
  Tool,
  ToolParamSpec,
  ToolParamsSchema,
} from './connectors/base';
export {
  normalizeUrl,
  resolveByText,
  resolveTaskByText,
  validateToolCall,
} from './connectors/base';
export { activeTools, CONNECTORS, getActiveTools } from './connector';

/** Every tool from every connector — the unfiltered registry */
export const TOOLS: readonly Tool[] = CONNECTORS.flatMap((c) => [...c.tools]);

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
