'use strict';

/**
 * lib/claudeAnthropicTools.js
 * Anthropic Messages API tool definitions (advisor, web search) for callClaude.
 */

const ADVISOR_TOOL_TYPE = 'advisor_20260301';
const WEB_SEARCH_BASIC = 'web_search_20250305';
const WEB_SEARCH_FILTERED = 'web_search_20260209';

function buildAdvisorTool({ model = 'claude-opus-4-7', maxUses = 3 } = {}) {
  return {
    type: ADVISOR_TOOL_TYPE,
    name: 'advisor',
    model,
    max_uses: maxUses,
  };
}

function buildWebSearchTool({ maxUses = 5, dynamicFilter = false } = {}) {
  return {
    type: dynamicFilter ? WEB_SEARCH_FILTERED : WEB_SEARCH_BASIC,
    name: 'web_search',
    max_uses: maxUses,
  };
}

function buildCodeExecutionTool({ version = 'code_execution_20260120' } = {}) {
  return {
    type: version,
    name: 'code_execution',
  };
}

/**
 * Merge advisor + web search (+ caller tools) onto a Messages API body.
 */
function attachToolsToBody(body, { advisor, webSearch, codeExecution, extraTools = [] } = {}) {
  const tools = [...(Array.isArray(extraTools) ? extraTools : [])];
  if (advisor) tools.push(buildAdvisorTool(advisor));
  if (webSearch) tools.push(buildWebSearchTool(webSearch));
  if (codeExecution) tools.push(buildCodeExecutionTool(codeExecution));
  if (tools.length) body.tools = tools;
  return body;
}

function cacheControlBlock(ttl) {
  if (ttl === '1h') return { type: 'ephemeral', ttl: '1h' };
  return { type: 'ephemeral' };
}

module.exports = {
  ADVISOR_TOOL_TYPE,
  WEB_SEARCH_BASIC,
  WEB_SEARCH_FILTERED,
  buildAdvisorTool,
  buildWebSearchTool,
  buildCodeExecutionTool,
  attachToolsToBody,
  cacheControlBlock,
};
