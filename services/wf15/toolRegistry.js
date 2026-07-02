/*
 * services/wf15/toolRegistry.js
 * ----------------------------------------------------------------------------
 * WF15 — AI Brain tool registry.
 *
 * Turns the AI Brain from a text-only chatbot into an agent that ACTUALLY DOES
 * things: every tool here maps to an existing /webhook/* route so the internal
 * loopback + webhook-secret auth already works. No new backend surface.
 *
 * Exports:
 *   - TOOL_SCHEMAS : Anthropic tool defs (fed to callClaude via extra.extraTools)
 *   - TOOLS        : map keyed by tool name -> { approval, summarize(input) }
 *   - executeTool(name, input, ctx) : runs a tool via ctx.loopback, never throws
 *
 * ctx = { businessId, loopback, logger }
 *   loopback(method, path, body) -> parsed JSON (throws on non-2xx). Provided
 *   by the caller (services/wf15/index.js) so this module stays HTTP-agnostic
 *   and trivially testable with a fake loopback.
 * ----------------------------------------------------------------------------
 */

'use strict';

const VALID_TABS = [
  'overview',
  'paid-ads',
  'store',
  'wf1-daily-content',
  'studio',
  'wf4-reviews',
  'wf5-competitors',
  'wf2-leads',
  'wf7-email',
  'wf13-brief',
  'wf14-budget',
  'wf8-insights',
  'wf12-launch',
  'crm',
  'settings',
];

/*
 * Tool definitions. Each entry carries:
 *   schema     : the Anthropic tool def (name/description/input_schema)
 *   approval   : boolean — true = mutating, gated behind explicit user approval
 *   summarize  : (input) -> short human string for the tool card
 *   execute    : async (input, ctx) -> compact JSON-able result
 *
 * Descriptions are written so Claude asks the user for missing required params
 * itself rather than hallucinating them.
 */
const DEFS = {
  // ---------------------------------------------------------------- READ / SAFE
  get_performance: {
    approval: false,
    schema: {
      name: 'get_performance',
      description:
        'Get the latest marketing performance snapshot for this business (content, ads, engagement, revenue metrics). Use when the owner asks how things are doing, for a summary, or for numbers.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    summarize: () => 'Fetch performance snapshot',
    execute: (input, ctx) =>
      ctx.loopback('GET', `/webhook/analytics-get?business_id=${encodeURIComponent(ctx.businessId)}`),
  },

  run_forecast: {
    approval: false,
    schema: {
      name: 'run_forecast',
      description:
        'Forecast ROAS, spend and revenue 30/60/90 days out. Ask the owner for the horizon if they did not specify one.',
      input_schema: {
        type: 'object',
        properties: {
          horizonDays: { type: 'integer', enum: [30, 60, 90], description: 'Forecast horizon in days.' },
        },
        required: ['horizonDays'],
      },
    },
    summarize: (input) => `Run ${input?.horizonDays || 30}-day forecast`,
    execute: (input, ctx) =>
      ctx.loopback('POST', '/webhook/forecast', {
        businessId: ctx.businessId,
        horizonDays: input?.horizonDays || 30,
      }),
  },

  analyze_competitors: {
    approval: false,
    schema: {
      name: 'analyze_competitors',
      description:
        'Kick off a competitor intelligence scan for this business. Runs in the background; results are ready in about a minute.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    summarize: () => 'Start competitor scan',
    execute: async (input, ctx) => {
      await ctx.loopback('POST', '/webhook/competitor-analyze', { business_id: ctx.businessId });
      return { started: true, note: 'Competitor scan started, results ready in ~60s.' };
    },
  },

  customer_insights: {
    approval: false,
    schema: {
      name: 'customer_insights',
      description:
        'Generate a customer-insights report (personas, pain points, voice-of-customer signals) for this business.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    summarize: () => 'Generate customer insights',
    execute: (input, ctx) => ctx.loopback('POST', '/webhook/wf8-generate-report', { businessId: ctx.businessId }),
  },

  paid_ads_overview: {
    approval: false,
    schema: {
      name: 'paid_ads_overview',
      description: 'Get an overview of live paid ad campaigns (Meta + Google): spend, ROAS, status per campaign.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    summarize: () => 'Fetch paid-ads overview',
    execute: (input, ctx) =>
      ctx.loopback('GET', `/webhook/paid-ads-overview?business_id=${encodeURIComponent(ctx.businessId)}`),
  },

  budget_snapshot: {
    approval: false,
    schema: {
      name: 'budget_snapshot',
      description: 'Get the latest budget & ROI allocation snapshot across channels for this business.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    summarize: () => 'Fetch budget snapshot',
    execute: (input, ctx) =>
      ctx.loopback('GET', `/webhook/wf14-latest?business_id=${encodeURIComponent(ctx.businessId)}`),
  },

  navigate: {
    approval: false,
    schema: {
      name: 'navigate',
      description:
        'Take the owner to a specific dashboard tab. Use when they ask to open, go to, or show a section of the app.',
      input_schema: {
        type: 'object',
        properties: {
          tab: { type: 'string', enum: VALID_TABS, description: 'The dashboard tab to open.' },
        },
        required: ['tab'],
      },
    },
    summarize: (input) => `Open ${input?.tab || 'dashboard'} tab`,
    // No backend call — the frontend handles the navigation from the result.
    execute: async (input) => ({ navigate: input?.tab }),
  },

  // ----------------------------------------------------------------- MUTATING
  generate_content: {
    approval: true,
    schema: {
      name: 'generate_content',
      description:
        'Generate a new social/marketing content piece (caption + image) for this business. Optionally themed. This publishes into the content pipeline, so it needs approval.',
      input_schema: {
        type: 'object',
        properties: {
          theme: { type: 'string', description: 'Optional theme or angle for the content.' },
        },
        required: [],
      },
    },
    summarize: (input) => (input?.theme ? `Generate content: ${input.theme}` : 'Generate content'),
    execute: (input, ctx) =>
      ctx.loopback('POST', '/webhook/instant-content', {
        business_id: ctx.businessId,
        ...(input?.theme ? { theme: input.theme } : {}),
      }),
  },

  create_ad_campaign: {
    approval: true,
    schema: {
      name: 'create_ad_campaign',
      description:
        'Create a new Meta ad campaign. Ask the owner for objective, target audience and daily budget if missing before calling this — it spends real money, so it needs approval.',
      input_schema: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'Campaign objective, e.g. leads, sales, traffic, awareness.' },
          target_audience: { type: 'string', description: 'Who to target.' },
          daily_budget: { type: 'number', description: 'Daily budget in account currency.' },
          duration_days: { type: 'integer', description: 'Optional run length in days.' },
          offer: { type: 'string', description: 'Optional offer / promotion to feature.' },
        },
        required: ['objective', 'target_audience', 'daily_budget'],
      },
    },
    summarize: (input) => `Create ad campaign: ${input?.objective || '?'} @ ${input?.daily_budget || '?'}/day`,
    execute: (input, ctx) =>
      ctx.loopback('POST', '/webhook/meta-campaign-create', {
        business_id: ctx.businessId,
        wizard: {
          objective: input?.objective,
          target_audience: input?.target_audience,
          daily_budget: input?.daily_budget,
          ...(input?.duration_days ? { duration_days: input.duration_days } : {}),
          ...(input?.offer ? { offer: input.offer } : {}),
        },
      }),
  },

  optimize_ads: {
    approval: true,
    schema: {
      name: 'optimize_ads',
      description:
        'Run the ad optimizer now: audit every active campaign and execute scale/pause/budget decisions on Meta. Changes live ad spend, so it needs approval.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    summarize: () => 'Optimize live ads now',
    execute: (input, ctx) => ctx.loopback('POST', '/webhook/meta-campaign-optimize', { business_id: ctx.businessId }),
  },

  generate_studio_asset: {
    approval: true,
    schema: {
      name: 'generate_studio_asset',
      description:
        'Create a Higgsfield Studio image or video asset. Ask for the subject if missing. Consumes generation credits, so it needs approval.',
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['image', 'video'], description: 'Asset type.' },
          subject: { type: 'string', description: 'What the asset should depict.' },
          coreIdea: { type: 'string', description: 'Optional creative angle / core idea.' },
        },
        required: ['kind', 'subject'],
      },
    },
    summarize: (input) => `Generate studio ${input?.kind || 'asset'}: ${input?.subject || ''}`.trim(),
    execute: (input, ctx) =>
      ctx.loopback('POST', '/webhook/wf10-create-job', {
        businessId: ctx.businessId,
        request: {
          kind: input?.kind,
          subject: input?.subject,
          ...(input?.coreIdea ? { coreIdea: input.coreIdea } : {}),
        },
      }),
  },

  plan_launch: {
    approval: true,
    schema: {
      name: 'plan_launch',
      description:
        'Plan a product/feature launch. Ask for the launch name if missing. Creates a launch plan, so it needs approval.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Launch name.' },
          launchType: { type: 'string', description: 'Optional launch type (product, feature, promo, ...).' },
          launchDate: { type: 'string', description: 'Optional target launch date (ISO).' },
          description: { type: 'string', description: 'Optional description of what is launching.' },
        },
        required: ['name'],
      },
    },
    summarize: (input) => `Plan launch: ${input?.name || ''}`.trim(),
    execute: (input, ctx) =>
      ctx.loopback('POST', '/webhook/wf12-plan-launch', {
        businessId: ctx.businessId,
        request: {
          name: input?.name,
          ...(input?.launchType ? { launchType: input.launchType } : {}),
          ...(input?.launchDate ? { launchDate: input.launchDate } : {}),
          ...(input?.description ? { description: input.description } : {}),
        },
      }),
  },

  create_email_sequence: {
    approval: true,
    schema: {
      name: 'create_email_sequence',
      description:
        'Create a lifecycle email sequence. Ask for the name and trigger type if missing. Enrolls contacts, so it needs approval.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Sequence name.' },
          trigger_type: {
            type: 'string',
            description: 'What starts the sequence, e.g. signup, purchase, abandoned_cart, re_engagement.',
          },
          emails: {
            type: 'array',
            description: 'Optional array of email step objects.',
            items: { type: 'object' },
          },
        },
        required: ['name', 'trigger_type'],
      },
    },
    summarize: (input) => `Create email sequence: ${input?.name || ''}`.trim(),
    execute: (input, ctx) =>
      ctx.loopback('POST', '/webhook/email-sequence-create', {
        business_id: ctx.businessId,
        name: input?.name,
        trigger_type: input?.trigger_type,
        emails: Array.isArray(input?.emails) ? input.emails : [],
      }),
  },
};

// Anthropic tool schemas array — fed to callClaude via extra.extraTools.
const TOOL_SCHEMAS = Object.values(DEFS).map((d) => d.schema);

// name -> { approval, summarize } map for the caller (SSE tool cards + gating).
const TOOLS = Object.fromEntries(
  Object.entries(DEFS).map(([name, d]) => [
    name,
    {
      approval: d.approval,
      summarize: (input) => {
        try {
          return d.summarize(input) || name;
        } catch {
          return name;
        }
      },
    },
  ])
);

/**
 * Execute a tool by name. Never throws — errors become { error } so the agentic
 * loop can feed the failure back to Claude as a tool_result instead of crashing.
 */
async function executeTool(name, input, ctx) {
  const def = DEFS[name];
  if (!def) return { error: 'unknown_tool' };
  try {
    const result = await def.execute(input || {}, ctx);
    return result == null ? {} : result;
  } catch (e) {
    ctx?.logger?.warn?.('/wf15', ctx?.businessId, `tool ${name} failed`, { error: e?.message });
    return { error: e?.message || 'tool_execution_failed' };
  }
}

module.exports = { TOOL_SCHEMAS, TOOLS, executeTool, VALID_TABS };
