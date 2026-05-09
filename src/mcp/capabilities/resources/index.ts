/**
 * Resources Module
 *
 * Exports resource definition factories for zero-boilerplate registration.
 * Types should be imported directly from `mcp/types/`.
 *
 * @module mcp/capabilities/resources
 */

export { defineResource, defineResourceTemplate } from "./define-resource.js";

export {
  DynamicResourceRegistry,
  getDynamicResourceRegistry,
  configureDynamicResourceRegistry,
  resetDynamicResourceRegistry,
  defineDynamicResourceTemplate,
} from "./dynamic/index.js";

export type {
  DynamicResourceEntry,
  DynamicResourceRegistryOptions,
  RegisterDynamicResourceOptions,
  RegisterDynamicResourceResult,
  ReadDynamicResourceResult,
  DefineDynamicResourceTemplateOptions,
} from "./dynamic/index.js";
