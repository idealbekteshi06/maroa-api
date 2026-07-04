'use strict';

/**
 * lib/claudeAnthropicTools.js
 * Anthropic Messages API tool definitions (advisor, web search, web fetch,
 * code execution) for callClaude.
 *
 * Web tools: the _20260209 variants run built-in dynamic filtering (code
 * execution under the hood — do NOT also declare a standalone code_execution
 * tool alongside them) and need no beta header. They require Opus 4.6+/
 * Sonnet 4.6+/Sonnet 5; callClaude decides per-model via
 * modelUpgrades.supportsFilteredWebTools and passes dynamicFilter accordingly.
 */

const ADVISOR_TOOL_TYPE = 'advisor_20260301';
const WEB_SEARCH_BASIC = 'web_search_20250305';
const WEB_SEARCH_FILTERED = 'web_search_20260209';
const WEB_FETCH_BASIC = 'web_fetch_20250910';
const WEB_FETCH_FILTERED = 'web_fetch_20260209';

function buildAdvisorTool({ model = 'claude-opus-4-8', maxUses = 3 } = {}) {
  return {
    type: ADVISOR_TOOL_TYPE,
    name: 'advisor',
    model,
    max_uses: maxUses,
  };
}

function buildWebSearchTool({ maxUses = 5, dynamicFilter = false, allowedDomains, blockedDomains } = {}) {
  const tool = {
    type: dynamicFilter ? WEB_SEARCH_FILTERED : WEB_SEARCH_BASIC,
    name: 'web_search',
    max_uses: maxUses,
  };
  // allowed/blocked are mutually exclusive on the API — allowed wins here.
  if (Array.isArray(allowedDomains) && allowedDomains.length) tool.allowed_domains = allowedDomains;
  else if (Array.isArray(blockedDomains) && blockedDomains.length) tool.blocked_domains = blockedDomains;
  return tool;
}

function buildWebFetchTool({ maxUses = 5, dynamicFilter = false, citations, maxContentTokens } = {}) {
  const tool = {
    type: dynamicFilter ? WEB_FETCH_FILTERED : WEB_FETCH_BASIC,
    name: 'web_fetch',
    max_uses: maxUses,
  };
  if (citations) tool.citations = { enabled: true };
  if (Number.isFinite(maxContentTokens)) tool.max_content_tokens = maxContentTokens;
  return tool;
}

function buildCodeExecutionTool({ version = 'code_execution_20260120' } = {}) {
  return {
    type: version,
    name: 'code_execution',
  };
}

/**
 * Merge advisor + web search/fetch (+ caller tools) onto a Messages API body.
 */
function attachToolsToBody(body, { advisor, webSearch, webFetch, codeExecution, extraTools = [] } = {}) {
  const tools = [...(Array.isArray(extraTools) ? extraTools : [])];
  if (advisor) tools.push(buildAdvisorTool(advisor));
  if (webSearch) tools.push(buildWebSearchTool(webSearch));
  if (webFetch) tools.push(buildWebFetchTool(webFetch));
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
  WEB_FETCH_BASIC,
  WEB_FETCH_FILTERED,
  buildAdvisorTool,
  buildWebSearchTool,
  buildWebFetchTool,
  buildCodeExecutionTool,
  attachToolsToBody,
  cacheControlBlock,
};
