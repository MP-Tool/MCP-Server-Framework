/**
 * Dynamic Resources — Public Surface
 *
 * @module mcp/capabilities/resources/dynamic
 */

export {
  DynamicResourceRegistry,
  getDynamicResourceRegistry,
  configureDynamicResourceRegistry,
  resetDynamicResourceRegistry,
} from "./dynamic-resource-registry.js";

export type {
  DynamicResourceEntry,
  DynamicResourceRegistryOptions,
  RegisterDynamicResourceOptions,
  RegisterDynamicResourceResult,
  ReadDynamicResourceResult,
} from "./dynamic-resource-registry.js";

export { defineDynamicResourceTemplate } from "./define-dynamic-resource-template.js";

export type { DefineDynamicResourceTemplateOptions } from "./define-dynamic-resource-template.js";
