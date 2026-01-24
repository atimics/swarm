/**
 * Stack exports
 */
// Legacy monolithic stack (backward compatibility)
export { SwarmStack, type SwarmStackProps } from './swarm-stack.js';

// New split stacks for parallel deployment
export { SharedInfraStack, type SharedInfraStackProps } from './shared-infra-stack.js';
export { AdminApiStack, type AdminApiStackProps } from './admin-api-stack.js';
export { AdminUiStack, type AdminUiStackProps } from './admin-ui-stack.js';
export { AvatarsStack, type AvatarsStackProps } from './avatars-stack.js';
