'use strict';

const { z } = require('zod');

const schemas = {
  userId: z.object({
    userId: z.string().uuid('Invalid userId format')
  }),

  waitlist: z.object({
    name: z.string().min(2).max(100),
    email: z.string().email(),
    plan: z.enum(['starter', 'growth', 'agency']).optional(),
    business_type: z.string().max(200).optional(),
    country: z.string().max(100).optional()
  }),

  campaign: z.object({
    userId: z.string().uuid(),
    goal: z.string().min(10).max(500),
    duration: z.coerce.number().min(1).max(90).optional()
  }),

  contentScore: z.object({
    contentId: z.string().uuid(),
    userId: z.string().min(1),
    action: z.enum(['approved', 'rejected', 'edited']),
    editedVersion: z.string().optional()
  }).refine(d => d.action !== 'edited' || (d.editedVersion && d.editedVersion.length > 0), {
    message: 'editedVersion required when action is edited',
    path: ['editedVersion']
  })
};

function validate(schemaName) {
  return (req, res, next) => {
    const sch = schemas[schemaName];
    if (!sch) {
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Invalid validation schema', details: null, timestamp: new Date().toISOString() }
      });
    }
    const result = sch.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details: result.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
          timestamp: new Date().toISOString()
        }
      });
    }
    req.validatedBody = result.data;
    next();
  };
}

module.exports = { validate, schemas };
