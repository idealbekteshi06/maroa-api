'use strict';

const productHero = require('./product-hero');
const productUgc = require('./product-ugc');
const lifestyle = require('./lifestyle');
const foodBeverage = require('./food-beverage');

const TEMPLATES = {
  product_hero: productHero,
  product_ugc: productUgc,
  lifestyle,
  food_beverage: foodBeverage
};

function pickTemplate(genreName) {
  if (genreName === 'food_beverage') return TEMPLATES.food_beverage;
  if (genreName === 'lifestyle_social') return TEMPLATES.lifestyle;
  if (genreName === 'testimonial_ugc' || genreName === 'founder_intro' || genreName === 'fashion_editorial') return TEMPLATES.product_ugc;
  return TEMPLATES.product_hero;
}

module.exports = { TEMPLATES, pickTemplate };
