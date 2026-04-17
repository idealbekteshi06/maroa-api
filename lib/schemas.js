const { z } = require('zod');

const uuidSchema = z.string().uuid();

const businessIdBody = z.object({
  business_id: uuidSchema,
});

const userIdBody = z.object({
  userId: uuidSchema.optional(),
  user_id: uuidSchema.optional(),
}).refine((d) => d.userId || d.user_id, { message: 'userId or user_id required' });

function zodValidate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: result.error.issues[0]?.message || 'Invalid input',
        },
      });
    }
    next();
  };
}

module.exports = { uuidSchema, businessIdBody, userIdBody, zodValidate };
