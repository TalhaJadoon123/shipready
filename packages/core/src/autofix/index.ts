/**
 * `@shipready/core` --fix support.
 *
 * Two pieces: the fixers (what to generate) and the applier (how to write it).
 * They are separate because planning is pure and testable, while applying
 * touches the filesystem and needs care.
 */
export { planFixes, FIXABLE_RULES, type FileFix, type FixContext, type FixPlanResult } from './fixers.js';
export { applyFixes, type ApplyResult } from './apply.js';
export { listTemplates, readTemplate, render, TEMPLATE_DIR, type TemplateVars } from './templates.js';