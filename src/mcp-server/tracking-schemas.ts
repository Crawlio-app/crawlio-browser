// Per-vendor, per-event parameter schemas for tracking event validation
// Facebook: the 18 standard events documented in Meta's Conversions API reference
// GA4: recommended ecommerce + engagement events (from Google docs)

export interface EventSchema {
  requiredParams: string[];
  recommendedParams: string[];
  paramTypes?: Record<string, 'string' | 'number' | 'currency'>;
}

// Facebook standard event schemas
// All 18 standard events, with the required and recommended parameters Meta documents
export const FACEBOOK_EVENT_SCHEMAS: Record<string, EventSchema> = {
  AddPaymentInfo: {
    requiredParams: [],
    recommendedParams: ['value', 'currency', 'content_ids', 'content_type', 'contents'],
    paramTypes: { value: 'number', currency: 'currency' },
  },
  AddToCart: {
    requiredParams: [],
    recommendedParams: ['value', 'currency', 'content_ids', 'content_type', 'contents'],
    paramTypes: { value: 'number', currency: 'currency' },
  },
  AddToWishlist: {
    requiredParams: [],
    recommendedParams: ['value', 'currency', 'content_ids', 'content_type'],
    paramTypes: { value: 'number', currency: 'currency' },
  },
  CompleteRegistration: {
    requiredParams: [],
    recommendedParams: ['value', 'currency', 'content_name', 'status'],
    paramTypes: { value: 'number', currency: 'currency' },
  },
  Contact: {
    requiredParams: [],
    recommendedParams: [],
  },
  CustomizeProduct: {
    requiredParams: [],
    recommendedParams: [],
  },
  Donate: {
    requiredParams: [],
    recommendedParams: ['value', 'currency'],
    paramTypes: { value: 'number', currency: 'currency' },
  },
  FindLocation: {
    requiredParams: [],
    recommendedParams: [],
  },
  InitiateCheckout: {
    requiredParams: [],
    recommendedParams: ['value', 'currency', 'content_ids', 'content_type', 'contents', 'num_items'],
    paramTypes: { value: 'number', currency: 'currency', num_items: 'number' },
  },
  Lead: {
    requiredParams: [],
    recommendedParams: ['value', 'currency', 'content_name', 'content_category'],
    paramTypes: { value: 'number', currency: 'currency' },
  },
  PageView: {
    requiredParams: [],
    recommendedParams: [],
  },
  Purchase: {
    requiredParams: ['value', 'currency'],
    recommendedParams: ['content_ids', 'content_type', 'contents', 'num_items'],
    paramTypes: { value: 'number', currency: 'currency', num_items: 'number' },
  },
  Schedule: {
    requiredParams: [],
    recommendedParams: [],
  },
  Search: {
    requiredParams: [],
    recommendedParams: ['search_string', 'value', 'currency', 'content_ids', 'content_category'],
    paramTypes: { value: 'number', currency: 'currency' },
  },
  StartTrial: {
    requiredParams: [],
    recommendedParams: ['value', 'currency', 'predicted_ltv'],
    paramTypes: { value: 'number', currency: 'currency', predicted_ltv: 'number' },
  },
  SubmitApplication: {
    requiredParams: [],
    recommendedParams: [],
  },
  Subscribe: {
    requiredParams: [],
    recommendedParams: ['value', 'currency', 'predicted_ltv'],
    paramTypes: { value: 'number', currency: 'currency', predicted_ltv: 'number' },
  },
  ViewContent: {
    requiredParams: [],
    recommendedParams: ['value', 'currency', 'content_ids', 'content_type', 'content_name'],
    paramTypes: { value: 'number', currency: 'currency' },
  },
};

// GA4 recommended event schemas
// Source: Google Analytics measurement protocol + recommended events documentation
export const GA4_EVENT_SCHEMAS: Record<string, EventSchema> = {
  purchase: {
    requiredParams: ['transaction_id', 'value', 'currency'],
    recommendedParams: ['items', 'coupon', 'shipping', 'tax'],
    paramTypes: { value: 'number', shipping: 'number', tax: 'number' },
  },
  add_to_cart: {
    requiredParams: [],
    recommendedParams: ['currency', 'value', 'items'],
    paramTypes: { value: 'number' },
  },
  begin_checkout: {
    requiredParams: [],
    recommendedParams: ['currency', 'value', 'items', 'coupon'],
    paramTypes: { value: 'number' },
  },
  add_payment_info: {
    requiredParams: [],
    recommendedParams: ['currency', 'value', 'items', 'payment_type'],
    paramTypes: { value: 'number' },
  },
  add_shipping_info: {
    requiredParams: [],
    recommendedParams: ['currency', 'value', 'items', 'shipping_tier'],
    paramTypes: { value: 'number' },
  },
  view_item: {
    requiredParams: [],
    recommendedParams: ['currency', 'value', 'items'],
    paramTypes: { value: 'number' },
  },
  view_item_list: {
    requiredParams: [],
    recommendedParams: ['item_list_id', 'item_list_name', 'items'],
  },
  select_item: {
    requiredParams: [],
    recommendedParams: ['item_list_id', 'item_list_name', 'items'],
  },
  generate_lead: {
    requiredParams: [],
    recommendedParams: ['currency', 'value'],
    paramTypes: { value: 'number' },
  },
  sign_up: {
    requiredParams: [],
    recommendedParams: ['method'],
  },
  login: {
    requiredParams: [],
    recommendedParams: ['method'],
  },
  view_search_results: {
    requiredParams: [],
    recommendedParams: ['search_term'],
  },
  select_promotion: {
    requiredParams: [],
    recommendedParams: ['promotion_id', 'promotion_name', 'items'],
  },
  view_promotion: {
    requiredParams: [],
    recommendedParams: ['promotion_id', 'promotion_name', 'items'],
  },
  remove_from_cart: {
    requiredParams: [],
    recommendedParams: ['currency', 'value', 'items'],
    paramTypes: { value: 'number' },
  },
  refund: {
    requiredParams: [],
    recommendedParams: ['currency', 'value', 'transaction_id', 'items'],
    paramTypes: { value: 'number' },
  },
  page_view: {
    requiredParams: [],
    recommendedParams: [],
  },
};

// Vendor → schema map for lookup
export const VENDOR_SCHEMAS: Record<string, Record<string, EventSchema>> = {
  facebook: FACEBOOK_EVENT_SCHEMAS,
  ga4: GA4_EVENT_SCHEMAS,
};

// ISO 4217 currency codes (top currencies for quick validation)
const CURRENCY_CODES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'AUD', 'CAD', 'CHF', 'HKD', 'NZD',
  'SEK', 'KRW', 'SGD', 'NOK', 'MXN', 'INR', 'RUB', 'ZAR', 'TRY', 'BRL',
  'TWD', 'DKK', 'PLN', 'THB', 'IDR', 'HUF', 'CZK', 'ILS', 'CLP', 'PHP',
  'AED', 'COP', 'SAR', 'MYR', 'RON', 'ARS', 'VND', 'EGP', 'PKR', 'NGN',
]);

export function isValidCurrency(value: string): boolean {
  return CURRENCY_CODES.has(value.toUpperCase());
}

export function isNumericParam(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return !isNaN(Number(trimmed)) && isFinite(Number(trimmed));
}
